/**
 * Galaxy's collection operation tools (`DatabaseOperationTool` subclasses run by `ModelOperationToolAction`): they
 * rearrange collections and copy history datasets without running anything, so the Service Worker carries them out
 * when the run is submitted and their jobs are `ok` at once. Operations that read dataset contents (relabel, filter
 * or tag from a file, apply rules, ...) are refused.
 */

import { ApiError, ErrorCodes } from "@/planet/util/errors";

import type { BundleOutput } from "./bundle";
import { own, type RequestContext, type StateDict } from "./context";
import {
    type CollectionContent,
    collectionDatasets,
    type CollectionItem,
    type DatasetItem,
    isCollectionItem,
    isDatasetItem,
} from "./history";
import { outputName, type OutputPlan, type PlannedElement, startPlan } from "./outputs";
import { pyStr } from "./python";

/** `Dataset.non_ready_states`. */
const NON_READY_STATES = new Set(["upload", "new", "queued", "running", "setting_metadata"]);
/** Compressed datasets up to this size may hold nothing once decompressed. */
const SMALL_COMPRESSED_SIZE = 1024;

/** What `DatabaseOperationTool.check_inputs_ready` requires of the inputs' datasets. */
interface Readiness {
    terminal: boolean;
    ok: boolean;
    terminalOrPaused: boolean;
}

interface OperationContext {
    rc: RequestContext;
    state: StateDict;
    plan: OutputPlan;
    output: (name: string) => BundleOutput;
    /** Plans a hidden copy of `source`; returns its index in `plan.datasets`. */
    copy: (name: string, source: DatasetItem, element: boolean) => number;
    /** Plans an output collection, named by its label. */
    collection: (
        output: string,
        collectionType: string,
        elements: PlannedElement[],
        columns?: unknown[] | null,
    ) => void;
}

interface Operation {
    readiness: Readiness;
    produce: (context: OperationContext) => void;
}

const ANY: Readiness = { terminal: false, ok: false, terminalOrPaused: false };
const TERMINAL: Readiness = { terminal: true, ok: false, terminalOrPaused: false };
const OK: Readiness = { terminal: true, ok: true, terminalOrPaused: false };
const TERMINAL_OR_PAUSED: Readiness = { terminal: false, ok: false, terminalOrPaused: true };

function invalid(message: string): ApiError {
    return ApiError.badRequest(message);
}

function collectionInput(state: StateDict, name: string): CollectionItem {
    const value = own(state, name);
    if (!isCollectionItem(value)) {
        throw invalid(`Parameter '${name}': a dataset collection is required.`);
    }
    return value;
}

function datasetInput(state: StateDict, name: string): DatasetItem {
    const value = own(state, name);
    if (!isDatasetItem(value)) {
        throw invalid(`Parameter '${name}': a dataset is required.`);
    }
    return value;
}

/** Python's `str` ordering: by code point. */
function compareCodePoints(a: string, b: string): number {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
        if (difference !== 0) {
            return difference;
        }
    }
    return left.length - right.length;
}

/** The elements of a collection copied for a new collection: datasets copied, nested collections re-created. */
function copiedElements(context: OperationContext, content: CollectionContent, prefix: string): PlannedElement[] {
    return content.elements.map((element) => {
        if (element.dataset) {
            const index = context.copy(`${prefix}|__part__|${element.identifier}`, element.dataset, true);
            return { identifier: element.identifier, dataset: index, columns: element.columns };
        }
        return {
            identifier: element.identifier,
            collectionType: element.collection?.collectionType ?? "list",
            elements: nestedReferences(element.collection),
            columns: element.columns,
        };
    });
}

/** `DatasetCollection.copy()` without a destination: a new collection over the same datasets. */
function nestedReferences(content: CollectionContent | null): PlannedElement[] {
    return (content?.elements ?? []).map((element) =>
        element.dataset
            ? { identifier: element.identifier, hdaId: element.dataset.id, columns: element.columns }
            : {
                  identifier: element.identifier,
                  collectionType: element.collection?.collectionType ?? "list",
                  elements: nestedReferences(element.collection),
                  columns: element.columns,
              },
    );
}

const FILTERED_TYPES = new Set(["list", "list:paired", "sample_sheet", "sample_sheet:paired"]);

/** `FilterDatasetsTool.produce_outputs` with the operation's `element_is_valid`. */
function filterDatasets(context: OperationContext, valid: (dataset: DatasetItem) => boolean): void {
    const input = collectionInput(context.state, "input");
    const replacementValue = own(context.state, "replacement");
    const replacement = isDatasetItem(replacementValue) ? replacementValue : null;
    const content = input.collection;
    const type = content.collectionType;
    if (!FILTERED_TYPES.has(type)) {
        throw invalid(`Input collection has type ${type}, but this tool filters lists and lists of pairs only.`);
    }
    const flat = type === "list" || type === "sample_sheet";
    if (!flat && replacement) {
        throw invalid(
            `Input collection has type ${type}, but replacing invalid elements with another dataset is only supported for simple list collections`,
        );
    }
    const elements: PlannedElement[] = [];
    for (const element of content.elements) {
        if (flat) {
            const dataset = element.dataset;
            if (!dataset) {
                continue;
            }
            if (valid(dataset)) {
                const index = context.copy(`output|__part__|${element.identifier}`, dataset, true);
                elements.push({ identifier: element.identifier, dataset: index, columns: element.columns });
            } else if (replacement) {
                const index = context.copy(`output|__part__|${element.identifier}`, replacement, true);
                context.plan.datasets[index]!.tags = [...dataset.tags];
                elements.push({ identifier: element.identifier, dataset: index, columns: element.columns });
            }
        } else if (element.collection && collectionDatasets(element.collection).every(valid)) {
            elements.push({
                identifier: element.identifier,
                collectionType: element.collection.collectionType,
                elements: nestedReferences(element.collection),
                columns: element.columns,
            });
        }
    }
    context.collection("output", type, elements, content.columnDefinitions);
}

/** Whether a dataset holds data (`FilterEmptyDatasetsTool.element_is_valid`), decided without reading it. */
function holdsData(rc: RequestContext, dataset: DatasetItem): boolean {
    const size = dataset.fileSize ?? 0;
    if (size <= 0) {
        return false;
    }
    const compressed =
        /(^|\.)(gz|bz2|zip)$/.test(dataset.extension) ||
        rc.datatypes.isA(dataset.extension, "galaxy.datatypes.binary.Binary");
    if (compressed && size <= SMALL_COMPRESSED_SIZE) {
        throw invalid(
            `Dataset ${dataset.hid} (${dataset.name}) may be compressed and empty; deciding needs its content, which Planet does not read in the browser.`,
        );
    }
    return true;
}

const OPERATIONS: Readonly<Record<string, Operation>> = {
    unzip_collection: {
        readiness: ANY,
        produce(context) {
            const input = collectionInput(context.state, "input");
            if (input.collection.collectionType !== "paired") {
                throw invalid("Unzipping needs a paired collection.");
            }
            const [forward, reverse] = collectionDatasets(input.collection);
            if (!forward || !reverse) {
                throw invalid("The paired collection is missing its forward or reverse dataset.");
            }
            context.copy("forward", forward, false);
            context.copy("reverse", reverse, false);
        },
    },
    zip_collection: {
        readiness: ANY,
        produce(context) {
            const forward = context.copy("output|__part__|forward", datasetInput(context.state, "input_forward"), true);
            const reverse = context.copy("output|__part__|reverse", datasetInput(context.state, "input_reverse"), true);
            context.collection("output", "paired", [
                { identifier: "forward", dataset: forward },
                { identifier: "reverse", dataset: reverse },
            ]);
        },
    },
    flatten_collection: {
        readiness: ANY,
        produce(context) {
            const input = collectionInput(context.state, "input");
            const join = pyStr(own(context.state, "join_identifier") ?? "_");
            const elements: PlannedElement[] = [];
            const visit = (content: CollectionContent, prefix: string) => {
                for (const element of content.elements) {
                    const identifier = prefix ? `${prefix}${join}${element.identifier}` : element.identifier;
                    if (element.collection) {
                        visit(element.collection, identifier);
                    } else if (element.dataset) {
                        const index = context.copy(`output|__part__|${identifier}`, element.dataset, true);
                        elements.push({ identifier, dataset: index, columns: element.columns });
                    }
                }
            };
            visit(input.collection, "");
            context.collection("output", "list", elements, input.collection.columnDefinitions);
        },
    },
    filter_failed_datasets_collection: {
        readiness: TERMINAL,
        produce(context) {
            filterDatasets(context, (dataset) => dataset.effectiveState === "ok");
        },
    },
    keep_success_datasets_collection: {
        readiness: TERMINAL_OR_PAUSED,
        produce(context) {
            filterDatasets(context, (dataset) => {
                if (NON_READY_STATES.has(dataset.effectiveState)) {
                    throw readinessError("An input dataset is pending.");
                }
                return dataset.effectiveState === "ok";
            });
        },
    },
    filter_empty_datasets_collection: {
        readiness: OK,
        produce(context) {
            filterDatasets(context, (dataset) => holdsData(context.rc, dataset));
        },
    },
    sort_collection: {
        readiness: TERMINAL,
        produce(context) {
            const input = collectionInput(context.state, "input");
            const sortType = pyStr(own(own(context.state, "sort_type"), "sort_type") ?? "");
            const elements = [...input.collection.elements];
            if (sortType === "alpha") {
                elements.sort((a, b) => compareCodePoints(a.identifier, b.identifier));
            } else if (sortType === "numeric") {
                const keys = new Map(
                    elements.map((element) => {
                        const digits = element.identifier.replace(/[^0-9]/g, "");
                        if (!digits) {
                            throw invalid(
                                `Numeric sorting needs a number in every element identifier; '${element.identifier}' has none.`,
                            );
                        }
                        return [element, BigInt(digits)] as const;
                    }),
                );
                elements.sort((a, b) => {
                    const difference = keys.get(a)! - keys.get(b)!;
                    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
                });
            } else if (sortType === "file") {
                throw invalid(
                    "Sorting by the lines of a dataset needs the dataset's content, which Planet does not read in the browser; sort alphabetically or numerically instead.",
                );
            } else {
                throw invalid(`Unknown sort_type '${sortType}'`);
            }
            const sorted = { ...input.collection, elements };
            context.collection(
                "output",
                input.collection.collectionType,
                copiedElements(context, sorted, "output"),
                input.collection.columnDefinitions,
            );
        },
    },
};

/** `tool_type`s of Galaxy's collection operation tools that Planet does not carry out. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
    relabel_from_file: "reads new identifiers from a dataset",
    filter_from_file: "reads the identifiers to keep from a dataset",
    tag_from_file: "reads tags from a dataset",
    apply_rules: "applies rules Planet does not evaluate",
    filter_null: "reads dataset contents",
    merge_collection: "is not supported yet",
    build_list: "is not supported yet",
    extract_dataset: "is not supported yet",
    nest_collection: "is not supported yet",
    harmonize_list: "is not supported yet",
    cross_product_flat: "is not supported yet",
    cross_product_nested: "is not supported yet",
    duplicate_file_to_collection: "is not supported yet",
    split_paired_and_unpaired: "is not supported yet",
    convert_sample_sheet: "is not supported yet",
};

/** True for Galaxy's collection operation tools, which Planet runs in the Service Worker or refuses. */
export function isCollectionOperation(rc: Pick<RequestContext, "tool">): boolean {
    const type = rc.tool.tool_type ?? "";
    return Object.hasOwn(OPERATIONS, type) || Object.hasOwn(UNAVAILABLE, type);
}

/**
 * Refuses collection operations Planet does not carry out.
 *
 * @throws ApiError 400 naming what the operation would need
 */
export function checkOperationAvailable(rc: Pick<RequestContext, "tool">): void {
    const type = rc.tool.tool_type ?? "";
    if (Object.hasOwn(UNAVAILABLE, type)) {
        throw new ApiError(
            400,
            `Planet cannot run '${rc.tool.name}': this collection operation ${UNAVAILABLE[type]}.`,
            ErrorCodes.USER_REQUEST_INVALID_PARAMETER,
        );
    }
}

function readinessError(message: string, notOk?: { item: DatasetItem; input: string }): ApiError {
    return notOk
        ? new ApiError(400, message, ErrorCodes.TOOL_INPUTS_NOT_OK, {
              src: "hda",
              id: notOk.item.id,
              input_name: notOk.input,
          })
        : new ApiError(400, message, ErrorCodes.TOOL_INPUTS_NOT_READY);
}

/** `DatabaseOperationTool.check_inputs_ready`. */
function checkReady(readiness: Readiness, plan: OutputPlan): void {
    const check = (input: string, item: DatasetItem) => {
        const state = item.effectiveState;
        if (readiness.terminal && NON_READY_STATES.has(state)) {
            throw readinessError("An input dataset is pending.");
        }
        if (state === "paused" && !readiness.terminalOrPaused) {
            throw readinessError(`Input '${input}' is paused; the file is not yet available.`);
        }
        if (readiness.ok && state !== "ok") {
            throw readinessError(
                `Tool requires inputs to be in valid state, but dataset with hid ${item.hid} is in state '${state}'`,
                { item, input },
            );
        }
    };
    for (const input of plan.inputDatasets) {
        if (input.item) {
            check(input.name, input.item);
        }
    }
    for (const input of plan.inputCollections) {
        if (!input.item.collection.populated) {
            throw readinessError("An input collection is not populated.");
        }
        collectionDatasets(input.item.collection).forEach((item) => check(input.name, item));
    }
}

/**
 * Plans what a collection operation creates for one job: copies of history datasets (hidden, as Galaxy adds them)
 * and new collections over them.
 *
 * @throws ApiError 400 when the inputs are not ready or not what the operation takes
 */
export function planOperation(rc: RequestContext, state: StateDict): OutputPlan {
    const type = rc.tool.tool_type ?? "";
    const operation = OPERATIONS[type];
    if (!operation) {
        checkOperationAvailable(rc);
        throw invalid(`Planet cannot run '${rc.tool.name}'.`);
    }
    const { plan, lookup } = startPlan(rc, state);
    checkReady(operation.readiness, plan);
    // Collections propagate only the tags of input collections (`propagate_hda_tags=False`).
    plan.tags = plan.inputCollections
        .flatMap((input) => input.item.tags)
        .map((tag) => (tag.startsWith("#") ? `name:${tag.slice(1)}` : tag))
        .filter((tag, index, all) => tag.startsWith("name:") && all.indexOf(tag) === index);
    const datasetOrder: number[] = [];
    const context: OperationContext = {
        rc,
        state,
        plan,
        output(name) {
            const output = rc.tool.outputs.find((candidate) => candidate.name === name);
            if (!output) {
                throw new ApiError(500, `The tool has no output '${name}'.`, ErrorCodes.TOOL_EXECUTION_ERROR);
            }
            return output;
        },
        copy(name, source, element) {
            plan.datasets.push({
                name,
                hdaName: source.name,
                extension: source.extension,
                visible: false,
                dbkey: source.dbkey,
                metadata: { ...source.metadata },
                createdFromBasename: null,
                element,
                copyOf: source.id,
                tags: [...source.tags],
            });
            const index = plan.datasets.length - 1;
            datasetOrder.push(index);
            return index;
        },
        collection(name, collectionType, elements, columns = null) {
            plan.collections.push({
                name,
                hdcaName: outputName(rc, context.output(name), lookup, plan.onText),
                collectionType,
                populated: true,
                elements,
                columnDefinitions: columns,
            });
        },
    };
    operation.produce(context);
    for (const index of datasetOrder) {
        plan.hidOrder.push({ kind: "dataset", index });
    }
    plan.collections.forEach((_, index) => plan.hidOrder.push({ kind: "collection", index }));
    return plan;
}
