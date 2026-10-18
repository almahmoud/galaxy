/**
 * Collection map-over: a batch parameter holding one collection runs the tool once per element
 * (`expand_meta_parameters` with `__collection_multirun_parameter`). A data parameter takes each dataset of the
 * collection; with `map_over_type` (a data collection parameter given a deeper collection) each subcollection of that
 * type (`subcollections._split_dataset_collection`). Linked collections must have the same shape and run together
 * (`MatchingCollections`); unlinked ones multiply. The structure (`structure.Tree`) gives the shape of the
 * collections the run creates for its outputs.
 */

import { ApiError, ErrorCodes } from "@/planet/util/errors";

import { isDict, type RequestContext } from "./context";
import { collectionTypeAccepts, collectionTypeCanMapOver } from "./datatypes";
import {
    type CollectionContent,
    type CollectionElementItem,
    type CollectionItem,
    elementCollection,
    type HistoryItem,
    isCollectionItem,
    mappedDataset,
} from "./history";

/** Galaxy's `USER_TOOL_META_PARAMETER_PROBLEM`. */
const META_PARAMETER_PROBLEM = 400012;
/** `CANNOT_MATCH_ERROR_MESSAGE`. */
const CANNOT_MATCH = "Cannot match collection types.";
const CANNOT_SPLIT = "Cannot split collection in desired fashion.";
/** Galaxy wraps such elements in collection adapters, which Planet's job protocol does not carry. */
const SINGLE_DATASETS_UNSUPPORTED =
    "Running a tool that takes a collection over each dataset of a list is not supported by Planet yet.";

/** A collection's shape down to the level a run maps over; a null child is a leaf (one job). */
export interface Structure {
    collectionType: string;
    columnDefinitions: unknown[] | null;
    children: StructureChild[];
}

export interface StructureChild {
    identifier: string;
    child: Structure | null;
    columns: unknown[] | null;
}

/** One mapped-over parameter. */
export interface MappedInput {
    /** The flat parameter name (`cond|input`). */
    key: string;
    item: CollectionItem;
    /** `map_over_type`, or null when the parameter takes each dataset. */
    subcollectionType: string | null;
    linked: boolean;
    /** What each job's parameter receives, in structure order. */
    values: HistoryItem[];
    structure: Structure;
}

/** The collections a run maps over and the shape of what it creates. */
export interface MapOver {
    inputs: MappedInput[];
    structure: Structure;
}

function mapOverError(message: string, errCode: number = ErrorCodes.UNKNOWN): ApiError {
    return new ApiError(400, message, errCode);
}

// ---------------------------------------------------------------------------------------------------------
// Structures

/** `Tree.for_dataset_collection`: the elements of `content` down to the depth of `collectionType`. */
export function structureOf(content: CollectionContent, collectionType: string): Structure {
    const childType = collectionType.includes(":") ? collectionType.slice(collectionType.indexOf(":") + 1) : null;
    return {
        collectionType,
        columnDefinitions: content.columnDefinitions,
        children: content.elements.map((element) => {
            if (childType === null) {
                return { identifier: element.identifier, child: null, columns: element.columns };
            }
            if (!element.collection) {
                throw mapOverError(CANNOT_SPLIT);
            }
            return {
                identifier: element.identifier,
                child: structureOf(element.collection, childType),
                columns: element.columns,
            };
        }),
    };
}

/** The number of jobs a structure stands for. */
export function leafCount(structure: Structure): number {
    return structure.children.reduce((count, { child }) => count + (child ? leafCount(child) : 1), 0);
}

/** `CollectionTypeDescription.compatible`. */
function compatibleTypes(a: string, b: string): boolean {
    return collectionTypeAccepts(a, b) || collectionTypeAccepts(b, a);
}

/** `Tree.compatible_shape`. */
export function compatibleShape(a: Structure, b: Structure): boolean {
    if (!compatibleTypes(a.collectionType, b.collectionType) || a.children.length !== b.children.length) {
        return false;
    }
    return a.children.every((mine, index) => {
        const other = b.children[index]!;
        if ((mine.child === null) !== (other.child === null)) {
            return false;
        }
        return mine.child === null || compatibleShape(mine.child, other.child!);
    });
}

/** `Tree.multiply`: every leaf of `outer` holds a copy of `inner`. */
export function multiply(outer: Structure, inner: Structure): Structure {
    return {
        collectionType: `${outer.collectionType}:${inner.collectionType}`,
        columnDefinitions: outer.columnDefinitions,
        children: outer.children.map(({ identifier, child, columns }) => ({
            identifier,
            child: child ? multiply(child, inner) : inner,
            columns,
        })),
    };
}

/** `CollectionTypeDescription.effective_collection_type`: the type left once `subcollectionType` is mapped over. */
export function effectiveCollectionType(collectionType: string, subcollectionType: string): string {
    if (subcollectionType === "single_datasets") {
        return collectionType;
    }
    const normalized = normalize(collectionType);
    if (subcollectionType === "paired_or_unpaired") {
        if (collectionType.endsWith(":paired")) {
            return collectionType.slice(0, -":paired".length);
        }
        if (normalized.endsWith("list")) {
            return collectionType;
        }
        return collectionType.slice(0, collectionType.lastIndexOf(":"));
    }
    if (normalize(subcollectionType).endsWith(":paired_or_unpaired")) {
        let current = collectionType;
        let other = subcollectionType;
        while (other.includes(":")) {
            other = other.slice(0, other.lastIndexOf(":"));
            current = current.slice(0, current.lastIndexOf(":"));
        }
        if (normalized.endsWith(":paired")) {
            current = current.slice(0, current.lastIndexOf(":"));
        }
        return current;
    }
    return collectionType.slice(0, -(subcollectionType.length + 1));
}

function normalize(collectionType: string): string {
    return collectionType.startsWith("sample_sheet")
        ? `list${collectionType.slice("sample_sheet".length)}`
        : collectionType;
}

// ---------------------------------------------------------------------------------------------------------
// Expansion

/** `_split_dataset_collection`: the elements of `content` whose nested collections have `collectionType`. */
function splitCollection(
    content: CollectionContent,
    collectionType: string,
): (CollectionElementItem & { collection: CollectionContent })[] {
    const own = content.collectionType;
    const isSubcollection =
        collectionType === "single_datasets" || (own.endsWith(collectionType) && own !== collectionType);
    if (!isSubcollection) {
        throw mapOverError(CANNOT_SPLIT);
    }
    if (collectionType === "single_datasets") {
        throw mapOverError(SINGLE_DATASETS_UNSUPPORTED);
    }
    const out: (CollectionElementItem & { collection: CollectionContent })[] = [];
    for (const element of content.elements) {
        const child = element.collection;
        if (!child) {
            throw mapOverError(CANNOT_SPLIT);
        }
        if (child.collectionType === collectionType) {
            out.push({ ...element, collection: child });
        } else {
            out.push(...splitCollection(child, collectionType));
        }
    }
    return out;
}

/** `DatasetCollection.dataset_elements` with each dataset carrying its element identifier. */
function datasetElements(content: CollectionContent): HistoryItem[] {
    const out: HistoryItem[] = [];
    for (const element of content.elements) {
        if (element.collection) {
            out.push(...datasetElements(element.collection));
        } else if (element.dataset) {
            out.push(mappedDataset(element.dataset, element.identifier));
        } else {
            throw mapOverError(`Collection element '${element.identifier}' has no dataset.`);
        }
    }
    return out;
}

/** `__collection_multirun_parameter`: a batch over one collection or collection element. */
export function isCollectionMapOver(value: Record<string, unknown>): boolean {
    const values = Array.isArray(value.values) ? value.values : [value.values];
    if (values.length !== 1) {
        return false;
    }
    const first = values[0];
    return isDict(first) && (first.src === "hdca" || first.src === "dce");
}

/**
 * `__expand_collection_parameter`: the values the jobs of a map-over receive for the parameter `key`, and the
 * collection's structure down to the mapped level.
 *
 * @throws ApiError 400 for unknown or unpopulated collections and subcollection types they do not have
 */
export function expandCollection(
    rc: RequestContext,
    key: string,
    value: Record<string, unknown>,
    linked: boolean,
): MappedInput {
    const reference = (Array.isArray(value.values) ? value.values[0] : value.values) as Record<string, unknown>;
    const src = String(reference.src);
    const item = rc.snapshot.get(src, String(reference.id));
    if (!item) {
        throw ApiError.badRequest("Invalid input id passed to job submission API.");
    }
    if (!isCollectionItem(item)) {
        throw mapOverError(`DCE ${String(reference.id)} does not contain a child collection`, META_PARAMETER_PROBLEM);
    }
    const content = item.collection;
    if (!content.populated) {
        throw mapOverError("An input collection is not populated.", ErrorCodes.TOOL_INPUTS_NOT_READY);
    }
    const mapOverType =
        typeof reference.map_over_type === "string" && reference.map_over_type ? reference.map_over_type : null;
    if (mapOverType === null) {
        return {
            key,
            item,
            subcollectionType: null,
            linked,
            values: datasetElements(content),
            structure: structureOf(content, content.collectionType),
        };
    }
    const elements = splitCollection(content, mapOverType);
    if (!collectionTypeCanMapOver(content.collectionType, mapOverType)) {
        throw mapOverError(CANNOT_SPLIT);
    }
    const structure = structureOf(content, effectiveCollectionType(content.collectionType, mapOverType));
    if (leafCount(structure) !== elements.length) {
        throw mapOverError(CANNOT_SPLIT);
    }
    return {
        key,
        item,
        subcollectionType: mapOverType,
        linked,
        values: elements.map((element) => elementCollection(element, item.historyId)),
        structure,
    };
}

/**
 * `MatchingCollections.for_collections` and `.structure`: linked collections must have compatible shapes (the first
 * by parameter name gives the identifiers); unlinked ones nest inside them in `inputs` order, as their jobs do.
 *
 * @throws ApiError 400 when linked collections cannot be matched
 */
export function matchCollections(inputs: readonly MappedInput[]): Structure {
    const linked = inputs.filter((input) => input.linked).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let structure: Structure | null = null;
    for (const input of linked) {
        if (structure === null) {
            structure = input.structure;
        } else if (!compatibleShape(structure, input.structure)) {
            throw mapOverError(CANNOT_MATCH);
        }
    }
    for (const input of inputs.filter((each) => !each.linked)) {
        structure = structure === null ? input.structure : multiply(structure, input.structure);
    }
    if (structure === null) {
        throw new Error("matchCollections needs at least one collection");
    }
    return structure;
}
