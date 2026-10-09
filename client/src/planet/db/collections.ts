/** Dataset collections, their elements and history dataset collection associations (HDCAs). */

import { ApiError } from "@/planet/util/errors";

import { allocateHids } from "./histories";
import { bumpCollections, touchHistory } from "./propagation";
import { buildCollection, buildDce, buildHdca, type NewCollection, type NewHdca } from "./records";
import { CONTENT_STORES, type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { CollectionRecord, DceRecord, HdcaRecord } from "./types";

export type { NewCollection, NewHdca };

/** Fields an HDCA update may change. */
export type HdcaPatch = Partial<Omit<HdcaRecord, "id" | "history_id" | "hid" | "create_time" | "update_time">>;

/** Fields a collection update may change. */
export type CollectionPatch = Partial<Omit<CollectionRecord, "id" | "create_time" | "update_time">>;

/** An element to create: an existing HDA, or a nested collection built from its own elements. */
export type NewElement =
    | { identifier: string; hda_id: string; columns?: unknown[] | null }
    | { identifier: string; collection: NewCollectionTree; columns?: unknown[] | null };

/**
 * A collection with its elements. `populated_state` defaults to `ok`; `element_count` is the number of
 * elements for populated collections and null otherwise.
 */
export interface NewCollectionTree extends Omit<NewCollection, "element_count"> {
    elements: NewElement[];
}

/** Returns the collection, or undefined. */
export function getCollection(id: string, tx?: ReadTx): Promise<CollectionRecord | undefined> {
    return useRead(tx, ["collections"], (t) => t.store("collections").get(id));
}

/** Returns the HDCA, or undefined. */
export function getHdca(id: string, tx?: ReadTx): Promise<HdcaRecord | undefined> {
    return useRead(tx, ["hdcas"], (t) => t.store("hdcas").get(id));
}

/** Returns the HDCA or throws a 404 {@link ApiError}. */
export async function getHdcaOrThrow(id: string, tx?: ReadTx): Promise<HdcaRecord> {
    const hdca = await getHdca(id, tx);
    if (!hdca) {
        throw ApiError.notFound("Collection not found");
    }
    return hdca;
}

/** Returns the HDCA with its collection, or undefined. */
export function getHdcaWithCollection(
    id: string,
    tx?: ReadTx,
): Promise<{ hdca: HdcaRecord; collection: CollectionRecord } | undefined> {
    return useRead(tx, ["hdcas", "collections"], async (t) => {
        const hdca = await t.store("hdcas").get(id);
        if (!hdca) {
            return undefined;
        }
        const collection = await t.store("collections").get(hdca.collection_id);
        if (!collection) {
            throw new ApiError(500, "Collection record missing for history collection", 500002);
        }
        return { hdca, collection };
    });
}

/** Returns the HDCA with this hid in the history, or undefined. */
export function getHdcaByHid(historyId: string, hid: number, tx?: ReadTx): Promise<HdcaRecord | undefined> {
    return useRead(tx, ["hdcas"], (t) => t.store("hdcas").index("history_hid").get([historyId, hid]));
}

/** Returns the HDCAs whose job source is `jobSourceId` (a job or an implicit-collection-jobs id). */
export function listHdcasForJobSource(jobSourceId: string, tx?: ReadTx): Promise<HdcaRecord[]> {
    return useRead(tx, ["hdcas"], (t) => t.store("hdcas").index("job_source_id").getAll(jobSourceId));
}

/** Returns a collection's elements ordered by `element_index`. */
export function elements(collectionId: string, tx?: ReadTx): Promise<DceRecord[]> {
    return useRead(tx, ["dces"], (t) =>
        t
            .store("dces")
            .index("collection_index")
            .getAll(IDBKeyRange.bound([collectionId, -Infinity], [collectionId, Infinity])),
    );
}

/** Returns the ids of the HDAs at the leaves of a collection, depth first in element order. */
export function leafHdaIds(collectionId: string, tx?: ReadTx): Promise<string[]> {
    return useRead(tx, ["dces"], async (t) => {
        const out: string[] = [];
        const visit = async (id: string, depth: number): Promise<void> => {
            if (depth > 32) {
                throw new ApiError(500, "Collection nesting is too deep", 500002);
            }
            for (const element of await elements(id, t)) {
                if (element.hda_id) {
                    out.push(element.hda_id);
                } else if (element.child_collection_id) {
                    await visit(element.child_collection_id, depth + 1);
                }
            }
        };
        await visit(collectionId, 0);
        return out;
    });
}

async function insertTree(tree: NewCollectionTree, tx: WriteTx): Promise<CollectionRecord> {
    const { elements: items, ...fields } = tree;
    const populatedState = fields.populated_state ?? "ok";
    const collection = buildCollection(
        {
            ...fields,
            populated_state: populatedState,
            element_count: populatedState === "ok" ? items.length : null,
        },
        tx.now,
    );
    await tx.store("collections").add(collection);
    let index = 0;
    for (const item of items) {
        const columns = item.columns ?? null;
        if ("hda_id" in item) {
            if (!(await tx.store("hdas").get(item.hda_id))) {
                throw ApiError.notFound("Dataset not found");
            }
            await tx.store("dces").add(
                buildDce({
                    collection_id: collection.id,
                    element_index: index,
                    element_identifier: item.identifier,
                    element_type: "hda",
                    hda_id: item.hda_id,
                    columns,
                }),
            );
        } else {
            const child = await insertTree(item.collection, tx);
            await tx.store("dces").add(
                buildDce({
                    collection_id: collection.id,
                    element_index: index,
                    element_identifier: item.identifier,
                    element_type: "dataset_collection",
                    child_collection_id: child.id,
                    columns,
                }),
            );
        }
        index++;
    }
    return collection;
}

/** Creates a collection with its elements (and nested collections) without placing it in a history. */
export function createCollection(tree: NewCollectionTree, tx?: WriteTx): Promise<CollectionRecord> {
    return useWrite(tx, CONTENT_STORES, (t) => insertTree(tree, t));
}

/**
 * Creates an HDCA. Pass `collection` to build a new collection, or `collection_id` in `hdca` to reuse
 * one. A missing or zero `hid` is allocated from the history in the same transaction.
 */
export function createHdca(
    input: { hdca: Omit<NewHdca, "collection_id"> & { collection_id?: string }; collection?: NewCollectionTree },
    tx?: WriteTx,
): Promise<{ hdca: HdcaRecord; collection: CollectionRecord }> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        let collection: CollectionRecord | undefined;
        if (input.collection) {
            collection = await insertTree(input.collection, t);
        } else if (input.hdca.collection_id) {
            collection = await t.store("collections").get(input.hdca.collection_id);
        }
        if (!collection) {
            throw ApiError.notFound("Collection not found");
        }
        const hdca = buildHdca({ ...input.hdca, collection_id: collection.id }, t.now);
        if (!hdca.hid) {
            hdca.hid = await allocateHids(hdca.history_id, 1, t);
        }
        await t.store("hdcas").add(hdca);
        await touchHistory(hdca.history_id, t);
        return { hdca, collection };
    });
}

/** Applies `patch` to an HDCA, bumps `update_time` and touches its history. */
export function updateHdca(id: string, patch: HdcaPatch, tx?: WriteTx): Promise<HdcaRecord> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        const store = t.store("hdcas");
        const hdca = await store.get(id);
        if (!hdca) {
            throw ApiError.notFound("Collection not found");
        }
        const next: HdcaRecord = { ...hdca, ...patch, update_time: t.now };
        await store.put(next);
        await touchHistory(next.history_id, t);
        return next;
    });
}

/** Applies `patch` to a collection and bumps every HDCA that contains it. */
export function updateCollection(id: string, patch: CollectionPatch, tx?: WriteTx): Promise<CollectionRecord> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        const store = t.store("collections");
        const collection = await store.get(id);
        if (!collection) {
            throw ApiError.notFound("Collection not found");
        }
        const next: CollectionRecord = { ...collection, ...patch, update_time: t.now };
        await store.put(next);
        await bumpCollections([id], t);
        return next;
    });
}
