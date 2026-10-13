/**
 * Which history items a data parameter accepts: datatype matching by class (`Data.matches_any` over the registry's
 * class hierarchy) and Galaxy's collection type algebra (`CollectionTypeDescription.accepts` and `can_map_over`).
 * Planet has no converter tools yet, so implicit conversions never apply.
 */

import type { DatatypeInfo } from "@/planet/api/contents";
import type { DatasetState } from "@/planet/db";

/** `Dataset.valid_input_states`: every state except `error`, `discarded` and `failed_metadata`. */
const INVALID_INPUT_STATES: ReadonlySet<DatasetState> = new Set<DatasetState>([
    "error",
    "discarded",
    "failed_metadata",
]);

/** True when a dataset in `state` may be used as a tool input. */
export function isValidInputState(state: DatasetState): boolean {
    return !INVALID_INPUT_STATES.has(state);
}

/**
 * True when datasets of extension `extension` satisfy one of `formats` directly
 * (`Registry.find_conversion_destination_for_dataset_by_extensions`): the extension is registered and its class is
 * one of the formats' classes or a subclass of one. Unregistered formats are ignored, as Galaxy ignores them.
 */
export function matchesFormats(datatypes: DatatypeInfo, extension: string, formats: readonly string[]): boolean {
    if (!datatypes.has(extension)) {
        return false;
    }
    return formats.some((format) => datatypes.has(format) && datatypes.isA(extension, datatypes.className(format)));
}

/** `_normalize_collection_type`: sample sheets behave like lists. */
function normalize(collectionType: string): string {
    return collectionType.startsWith("sample_sheet")
        ? `list${collectionType.slice("sample_sheet".length)}`
        : collectionType;
}

/** `input_type.accepts(output_type)`: may a collection of `other` feed an input declaring `self`? */
export function collectionTypeAccepts(self: string, other: string): boolean {
    if (self.startsWith("sample_sheet") && !other.startsWith("sample_sheet")) {
        return false;
    }
    const declared = normalize(self);
    const given = normalize(other);
    if (declared === given) {
        return true;
    }
    if (given === "paired" && declared === "paired_or_unpaired") {
        return true;
    }
    if (declared.endsWith(":paired_or_unpaired")) {
        const plain = declared.slice(0, -":paired_or_unpaired".length);
        return given === plain || given === `${plain}:paired`;
    }
    return false;
}

/** `output_type.can_map_over(input_type)`: does `self` have proper subcollections of type `other`? */
export function collectionTypeCanMapOver(self: string, other: string): boolean {
    if (other.startsWith("sample_sheet") && !self.startsWith("sample_sheet")) {
        return false;
    }
    const collectionType = normalize(self);
    const otherType = normalize(other);
    if (collectionType === otherType) {
        return false;
    }
    if (collectionType.endsWith(`:${otherType}`)) {
        return true;
    }
    if (otherType === "paired_or_unpaired") {
        return collectionType !== "paired";
    }
    if (otherType.endsWith(":paired_or_unpaired")) {
        const required = otherType.slice(0, otherType.lastIndexOf(":"));
        const ranks = collectionType.endsWith(":paired")
            ? collectionType.slice(0, collectionType.lastIndexOf(":"))
            : collectionType;
        return ranks.endsWith(required) && ranks !== required;
    }
    return otherType === "single_datasets";
}

function dimension(collectionType: string): number {
    return collectionType.split(":").length + 1;
}

/**
 * `HistoryQuery.from_collection_types`: the accepted types, higher dimensions first, or null when any collection
 * type is accepted.
 */
export function orderedCollectionTypes(collectionTypes: readonly string[] | null | undefined): string[] | null {
    if (!collectionTypes || collectionTypes.length === 0) {
        return null;
    }
    return [...collectionTypes].sort((a, b) => dimension(b) - dimension(a));
}

/** `HistoryQuery.direct_match`. */
export function directMatch(accepted: readonly string[] | null, collectionType: string): boolean {
    return accepted === null || accepted.some((type) => collectionTypeAccepts(type, collectionType));
}

/** `HistoryQuery.can_map_over`: the accepted type the collection can be mapped over to feed, or null. */
export function mapOverType(accepted: readonly string[] | null, collectionType: string): string | null {
    if (accepted === null) {
        return null;
    }
    return accepted.find((type) => collectionTypeCanMapOver(collectionType, type)) ?? null;
}
