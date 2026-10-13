/**
 * Dataset collections: POST /api/dataset_collections, GET /api/dataset_collections/{hdca_id},
 * /api/dataset_collections/{hdca_id}/contents/{parent_id}, /api/dataset_collections/{hdca_id}/attributes,
 * /api/dataset_collections/{hdca_id}/suitable_converters and /api/dataset_collection_element/{dce_id}.
 *
 * Creation follows Galaxy's `DatasetCollectionManager.create`: elements are HDAs (copied into the target history as
 * hidden datasets unless `copy_elements` is false), existing collections, or nested `new_collection` definitions;
 * the rank type (`list`, `paired`, `paired_or_unpaired`, `record`) decides which elements are kept and in what order.
 */

import type { components } from "@/api/schema";
import {
    type CollectionRecord,
    collections,
    CONTENT_STORES,
    type DceRecord,
    type HdaRecord,
    hdas,
    histories,
    type ReadTx,
    readTx,
    withTransaction,
    type WriteTx,
} from "@/planet/db";
import { json, passthrough } from "@/planet/sw/responses";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { queryInt } from "@/planet/util/query";

import { ContentLoader, loadDatatypeInfo, normalizeTags, serializeHdcaInstance } from "./contents";

type DCESummary = components["schemas"]["DCESummary"];
type DatasetCollectionAttributesResult = components["schemas"]["DatasetCollectionAttributesResult"];
type NewCollectionTree = collections.NewCollectionTree;
type NewElement = collections.NewElement;

const SERIALIZER_STORES = [...CONTENT_STORES, "jobs"] as const;

/** Galaxy's `DEFAULT_COLLECTION_NAME`, used when a request names no collection. */
export const DEFAULT_COLLECTION_NAME = "Unnamed Collection";

const SOURCES = new Set(["hda", "hdca", "ldda", "new_collection"]);
const RANK_TYPES = new Set(["list", "paired", "paired_or_unpaired", "record"]);

// ---------------------------------------------------------------------------------------------------------
// Creation

/** One entry of `element_identifiers`, as received (untrusted). */
type ElementIdentifier = Record<string, unknown>;

interface CreateOptions {
    historyId: string;
    copyElements: boolean;
    hideSourceItems: boolean;
}

function invalid(message: string): ApiError {
    return ApiError.badRequest(message);
}

function describe(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** Galaxy's `validate_input_element_identifiers`. */
export function validateElementIdentifiers(identifiers: unknown): ElementIdentifier[] {
    if (!Array.isArray(identifiers)) {
        throw invalid("element_identifiers must be a list.");
    }
    const names = new Set<string>();
    for (const identifier of identifiers) {
        if (typeof identifier !== "object" || identifier === null || Array.isArray(identifier)) {
            throw new ApiError(
                400,
                `Dataset collection element definition (${describe(identifier)}) not dictionary-like.`,
            );
        }
        const entry = identifier as ElementIdentifier;
        if ("__object__" in entry) {
            throw invalid(`Found invalid parameter __object__ in element identifier description ${describe(entry)}.`);
        }
        if (typeof entry.name !== "string") {
            throw invalid(`Cannot load invalid dataset identifier - missing name - ${describe(entry)}`);
        }
        if (names.has(entry.name)) {
            throw invalid(`Found duplicated element identifier name ${entry.name}.`);
        }
        names.add(entry.name);
        const src = entry.src ?? "hda";
        if (typeof src !== "string" || !SOURCES.has(src)) {
            throw invalid(`Unknown dataset source (src) ${String(src)}.`);
        }
        if (src === "new_collection") {
            if (!("element_identifiers" in entry)) {
                throw invalid("No nested element identifiers defined for nested collection.");
            }
            if (!("collection_type" in entry)) {
                throw invalid(`No collection_type define for nested collection ${describe(entry)}.`);
            }
            validateElementIdentifiers(entry.element_identifiers);
        }
    }
    return identifiers as ElementIdentifier[];
}

function checkCollectionType(collectionType: string): void {
    const ranks = collectionType.split(":");
    if (ranks.some((rank) => rank.startsWith("sample_sheet"))) {
        throw invalid("Sample sheet collections are not available in Planet yet.");
    }
    for (const rank of ranks) {
        if (!RANK_TYPES.has(rank)) {
            throw invalid(`Invalid collection type ${collectionType}`);
        }
    }
}

/** Orders and filters elements the way the rank type's plugin builds a collection. */
function rankElements(rankType: string, elements: NewElement[], fields: unknown): NewElement[] {
    const byName = new Map(elements.map((element) => [element.identifier, element]));
    switch (rankType) {
        case "paired":
            return ["forward", "reverse"].map((name) => byName.get(name)).filter((item) => item !== undefined);
        case "paired_or_unpaired": {
            if (elements.length < 1 || elements.length > 2) {
                throw invalid(
                    "Incorrect number of datasets - 1 or 2 datasets is required to create a paired_or_unpaired collection",
                );
            }
            const names = elements.length === 2 ? ["forward", "reverse"] : ["unpaired"];
            return names.map((name) => byName.get(name)).filter((item) => item !== undefined);
        }
        case "record": {
            if (!Array.isArray(fields)) {
                throw ApiError.missingParameter("Missing or null parameter 'fields' required for record types.");
            }
            if (fields.length !== elements.length) {
                throw invalid("Supplied element do not match fields.");
            }
            elements.forEach((element, index) => {
                const field = fields[index] as { name?: unknown } | null;
                if (!field || field.name !== element.identifier) {
                    throw invalid("Supplied element do not match fields.");
                }
            });
            return elements;
        }
        default:
            return elements;
    }
}

async function loadHda(id: unknown, tx: ReadTx): Promise<HdaRecord> {
    if (typeof id !== "string" || !id) {
        throw invalid("Problem decoding element identifier - must contain a 'src' and a 'id'.");
    }
    const hda = await tx.store("hdas").get(id);
    if (!hda) {
        throw ApiError.notFound("Dataset not found");
    }
    return hda;
}

/** Copies an existing collection's structure; its datasets are shared, as Galaxy shares the collection itself. */
async function treeOf(collection: CollectionRecord, tx: ReadTx, depth = 0): Promise<NewCollectionTree> {
    if (depth > 32) {
        throw new ApiError(500, "Collection nesting is too deep", ErrorCodes.INCONSISTENT_DATABASE);
    }
    const elements: NewElement[] = [];
    for (const element of await collections.elements(collection.id, tx)) {
        if (element.hda_id) {
            elements.push({ identifier: element.element_identifier, hda_id: element.hda_id, columns: element.columns });
        } else if (element.child_collection_id) {
            const child = await tx.store("collections").get(element.child_collection_id);
            if (child) {
                elements.push({
                    identifier: element.element_identifier,
                    collection: await treeOf(child, tx, depth + 1),
                    columns: element.columns,
                });
            }
        }
    }
    return {
        collection_type: collection.collection_type,
        populated_state: collection.populated_state,
        populated_state_message: collection.populated_state_message,
        fields: collection.fields,
        column_definitions: collection.column_definitions,
        elements,
    };
}

async function hdaElement(identifier: ElementIdentifier, options: CreateOptions, tx: WriteTx): Promise<string> {
    const source = await loadHda(identifier.id, tx);
    const tags = Array.isArray(identifier.tags) ? identifier.tags.map(String) : [];
    let elementId = source.id;
    if (options.copyElements) {
        const copy = await hdas.create(
            {
                ...source,
                id: undefined,
                hid: undefined,
                visible: false,
                history_id: options.historyId,
                copied_from: { src: "hda", id: source.id },
            },
            tx,
        );
        elementId = copy.id;
    }
    if (options.hideSourceItems && source.history_id === options.historyId && source.visible) {
        await hdas.update(source.id, { visible: false }, tx);
    }
    if (tags.length) {
        const element = await loadHda(elementId, tx);
        await hdas.update(elementId, { tags: normalizeTags([...element.tags, ...tags]) }, tx);
    }
    return elementId;
}

/** Builds the collection tree for `collectionType` from request identifiers, creating HDA copies as needed. */
async function buildTree(
    collectionType: string,
    identifiers: ElementIdentifier[],
    fields: unknown,
    options: CreateOptions,
    tx: WriteTx,
    depth = 0,
): Promise<NewCollectionTree> {
    if (depth > 32) {
        throw invalid("Collection nesting is too deep.");
    }
    const [rankType, ...rest] = collectionType.split(":");
    const subType = rest.join(":");
    const flattened = identifiers.find((item) => item.src === "new_collection" && item.collection_type === "");
    const source = flattened ? (flattened.element_identifiers as ElementIdentifier[]) : identifiers;
    const elements: NewElement[] = [];
    for (const identifier of source) {
        const identifierName = identifier.name as string;
        const src = (identifier.src as string | undefined) ?? "hda";
        if (src === "new_collection") {
            const nestedType = String(identifier.collection_type ?? "");
            if (subType && nestedType !== subType) {
                throw invalid(
                    `Element '${identifierName}' of collection type '${collectionType}' must be a sub-collection of type '${subType}', got a collection of type '${nestedType}'.`,
                );
            }
            checkCollectionType(nestedType);
            const tree = await buildTree(
                nestedType,
                identifier.element_identifiers as ElementIdentifier[],
                identifier.fields,
                options,
                tx,
                depth + 1,
            );
            elements.push({ identifier: identifierName, collection: tree });
        } else if (src === "hdca") {
            const hdca = await tx.store("hdcas").get(String(identifier.id ?? ""));
            const collection = hdca && (await tx.store("collections").get(hdca.collection_id));
            if (!collection) {
                throw ApiError.notFound("Collection not found");
            }
            if (subType && collection.collection_type !== subType) {
                throw invalid(
                    `Element '${identifierName}' of collection type '${collectionType}' must be a sub-collection of type '${subType}', got a collection of type '${collection.collection_type}'.`,
                );
            }
            elements.push({ identifier: identifierName, collection: await treeOf(collection, tx) });
        } else if (src === "ldda") {
            throw invalid("Library datasets are not available in Planet.");
        } else {
            if (subType) {
                throw invalid(
                    `Element '${identifierName}' of collection type '${collectionType}' must be a sub-collection of type '${subType}', got a dataset.`,
                );
            }
            elements.push({ identifier: identifierName, hda_id: await hdaElement(identifier, options, tx) });
        }
    }
    return {
        collection_type: collectionType,
        fields: Array.isArray(fields) ? fields : null,
        elements: rankElements(rankType!, elements, fields),
    };
}

function boolField(payload: Record<string, unknown>, name: string, fallback: boolean): boolean {
    const value = payload[name];
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value === "boolean") {
        return value;
    }
    return ["true", "yes", "on", "1"].includes(String(value).toLowerCase());
}

/** `POST /api/dataset_collections`: creates the HDCA and returns it as `dictify_dataset_collection_instance`. */
export async function createCollection(body: unknown): Promise<Record<string, unknown>> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw invalid("The request body must be a JSON object.");
    }
    const payload = body as Record<string, unknown>;
    const missing = ["collection_type", "element_identifiers"].filter((key) => !(key in payload));
    if (missing.length) {
        throw new ApiError(
            400,
            `Missing required parameters [${missing.map((key) => `'${key}'`).join(", ")}]`,
            ErrorCodes.USER_OBJECT_ATTRIBUTE_MISSING,
        );
    }
    if ((payload.instance_type ?? "history") !== "history") {
        throw invalid("Library collections are not available in Planet.");
    }
    if (typeof payload.history_id !== "string" || !payload.history_id) {
        throw invalid("Parameter history_id is required.");
    }
    const collectionType = payload.collection_type;
    if (typeof collectionType !== "string" || !collectionType) {
        throw invalid("Create called without specifying a collection type.");
    }
    checkCollectionType(collectionType);
    const identifiers = validateElementIdentifiers(payload.element_identifiers);
    const options: CreateOptions = {
        historyId: payload.history_id,
        copyElements: boolField(payload, "copy_elements", true),
        hideSourceItems: boolField(payload, "hide_source_items", false),
    };
    const name = typeof payload.name === "string" && payload.name ? payload.name : DEFAULT_COLLECTION_NAME;

    const hdca = await withTransaction(CONTENT_STORES, "readwrite", async (tx) => {
        const history = await histories.getOrThrow(options.historyId, tx);
        if (history.purged || history.archived) {
            throw ApiError.forbidden("History is immutable", ErrorCodes.ITEM_IS_IMMUTABLE);
        }
        const tree = await buildTree(collectionType, identifiers, payload.fields, options, tx);
        const created = await collections.createHdca({ hdca: { history_id: history.id, name }, collection: tree }, tx);
        return created.hdca;
    });

    const datatypes = await loadDatatypeInfo();
    return readTx(SERIALIZER_STORES, async (tx) =>
        serializeHdcaInstance(hdca, "element", new ContentLoader(tx), datatypes),
    );
}

// ---------------------------------------------------------------------------------------------------------
// Reading

function checkInstanceType(query: URLSearchParams): void {
    const instanceType = query.get("instance_type") ?? "history";
    if (instanceType !== "history") {
        throw invalid("Parameter instance_type not being 'history' is not yet implemented.");
    }
}

/** True when `collectionId` is the HDCA's collection or nested inside it (`contains_collection`). */
async function containsCollection(rootId: string, collectionId: string, tx: ReadTx): Promise<boolean> {
    const queue = [rootId];
    const seen = new Set<string>();
    while (queue.length) {
        const current = queue.shift()!;
        if (current === collectionId) {
            return true;
        }
        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        for (const element of await collections.elements(current, tx)) {
            if (element.child_collection_id) {
                queue.push(element.child_collection_id);
            }
        }
    }
    return false;
}

/** Galaxy's `dictify_element_reference` with `recursive=False`. */
async function elementReference(element: DceRecord, hdcaId: string | null, loader: ContentLoader): Promise<DCESummary> {
    let object: Record<string, unknown> | null = null;
    if (element.hda_id) {
        const hda = await loader.tx.store("hdas").get(element.hda_id);
        const dataset = hda && (await loader.tx.store("datasets").get(hda.dataset_id));
        if (hda && dataset) {
            object = {
                id: hda.id,
                model_class: "HistoryDatasetAssociation",
                state: hdas.effectiveState(hda, dataset),
                hda_ldda: "hda",
                purged: hda.purged,
                history_id: hda.history_id,
                tags: [...hda.tags],
                accessible: true,
                copied_from_ldda_id: null,
            };
        }
    } else if (element.child_collection_id) {
        const child = await loader.tx.store("collections").get(element.child_collection_id);
        if (child) {
            const summary = await loader.summary(child.id);
            object = {
                id: child.id,
                model_class: "DatasetCollection",
                collection_type: child.collection_type,
                element_count: child.element_count,
                populated: await loader.populated(child),
                elements_states: { ...summary.states },
                elements_deleted: summary.deleted,
                elements_datatypes: [...summary.extensions],
                column_definitions: child.column_definitions,
                elements: [],
                contents_url: hdcaId ? `/api/dataset_collections/${hdcaId}/contents/${child.id}` : null,
            };
        }
    }
    return {
        model_class: "DatasetCollectionElement",
        id: element.id,
        element_type: element.element_type,
        element_index: element.element_index,
        element_identifier: element.element_identifier,
        columns: element.columns as DCESummary["columns"],
        object,
    } as DCESummary;
}

async function collectionContents(hdcaId: string, parentId: string, query: URLSearchParams): Promise<DCESummary[]> {
    checkInstanceType(query);
    const limit = queryInt(query, "limit", null);
    const offset = queryInt(query, "offset", null);
    return readTx(SERIALIZER_STORES, async (tx) => {
        const hdca = await collections.getHdcaOrThrow(hdcaId, tx);
        if (!(await containsCollection(hdca.collection_id, parentId, tx))) {
            throw ApiError.notFound("Requested dataset collection is not contained within indicated history content");
        }
        const start = Math.max(0, offset ?? 0);
        const elements = (await collections.elements(parentId, tx)).slice(
            start,
            limit === null ? undefined : start + Math.max(0, limit),
        );
        const loader = new ContentLoader(tx);
        const out: DCESummary[] = [];
        for (const element of elements) {
            out.push(await elementReference(element, hdca.id, loader));
        }
        return out;
    });
}

/** `GET /api/dataset_collections/{hdca_id}/attributes` (`to_dict(view="dbkeysandextensions")`). */
async function collectionAttributes(
    hdcaId: string,
    query: URLSearchParams,
): Promise<DatasetCollectionAttributesResult> {
    checkInstanceType(query);
    return readTx(CONTENT_STORES, async (tx) => {
        const hdca = await collections.getHdcaOrThrow(hdcaId, tx);
        const dbkeys = new Set<string>();
        const extensions = new Set<string>();
        for (const id of await collections.leafHdaIds(hdca.collection_id, tx)) {
            const hda = await tx.store("hdas").get(id);
            if (hda) {
                dbkeys.add(hda.dbkey);
                if (hda.extension) {
                    extensions.add(hda.extension);
                }
            }
        }
        return {
            model_class: "HistoryDatasetCollectionAssociation",
            dbkeys: null,
            extensions: null,
            tags: [...hdca.tags],
            dbkey: dbkeys.size === 1 ? [...dbkeys][0]! : "?",
            extension: extensions.size === 1 ? [...extensions][0]! : "auto",
        };
    });
}

async function showCollection(hdcaId: string, query: URLSearchParams): Promise<Record<string, unknown>> {
    checkInstanceType(query);
    const view = query.get("view") || "element";
    const datatypes = await loadDatatypeInfo();
    return readTx(SERIALIZER_STORES, async (tx) => {
        const hdca = await collections.getHdcaOrThrow(hdcaId, tx);
        return serializeHdcaInstance(hdca, view, new ContentLoader(tx), datatypes);
    });
}

export function register(router: Router): void {
    router.route("/api/dataset_collections", "post", async ({ json: body }: PlanetRequest) =>
        passthrough(json(await createCollection(await body()))),
    );

    router.route("/api/dataset_collections/{hdca_id}", "get", async ({ params, query }) =>
        passthrough(json(await showCollection(params.hdca_id, query))),
    );

    router.route("/api/dataset_collections/{hdca_id}/contents/{parent_id}", "get", ({ params, query }) =>
        collectionContents(params.hdca_id, params.parent_id, query),
    );

    router.route("/api/dataset_collections/{hdca_id}/attributes", "get", ({ params, query }) =>
        collectionAttributes(params.hdca_id, query),
    );

    router.route("/api/dataset_collections/{hdca_id}/suitable_converters", "get", async ({ params }) => {
        await collections.getHdcaOrThrow(params.hdca_id);
        return [];
    });

    router.route("/api/dataset_collection_element/{dce_id}", "get", ({ params }) =>
        readTx(SERIALIZER_STORES, async (tx) => {
            const element = await tx.store("dces").get(params.dce_id);
            if (!element) {
                throw ApiError.notFound("No DatasetCollectionElement found");
            }
            return elementReference(element, null, new ContentLoader(tx));
        }),
    );
}
