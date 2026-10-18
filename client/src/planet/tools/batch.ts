/**
 * Batch mode (`expand_meta_parameters` for the legacy input format): a submitted parameter of the form
 * `{"batch": true, "values": [...]}` runs the tool once per value. Batch parameters are linked by default (the n-th
 * values run together, so they must have the same length); `"linked": false` multiplies them instead. A batch over
 * one collection maps the tool over its elements (`./mapover`).
 */

import { ApiError, ErrorCodes } from "@/planet/util/errors";

import type { ToolBundle } from "./bundle";
import { dictFrom, emptyDict, isDict, type RequestContext } from "./context";
import {
    expandCollection,
    isCollectionMapOver,
    leafCount,
    type MapOver,
    type MappedInput,
    matchCollections,
} from "./mapover";
import { flatToNested, visitInputValues } from "./state";

/** The most jobs one tool run may create. */
export const MAX_JOBS = 1000;

type Incoming = Record<string, unknown>;

/** The parameters of each job of a run, and the collections it maps over. */
export interface Expansion {
    combos: Incoming[];
    mapOver: MapOver | null;
}

/** `reorder_parameters`: the flat keys in the order of the tool's inputs, then the others. */
function reorder(tool: ToolBundle, incoming: Incoming, rc: RequestContext): Incoming {
    const ordered: Incoming = emptyDict();
    visitInputValues(tool.inputs, flatToNested(incoming), rc, ({ prefixedName }) => {
        if (Object.hasOwn(incoming, prefixedName) && !Object.hasOwn(ordered, prefixedName)) {
            ordered[prefixedName] = incoming[prefixedName];
        }
    });
    for (const [key, value] of Object.entries(incoming)) {
        if (!Object.hasOwn(ordered, key)) {
            ordered[key] = value;
        }
    }
    return ordered;
}

/**
 * Expands the flat parameters of one tool run into the parameters of each job (`build_combos`); a mapped-over
 * parameter holds the element (dataset or nested collection) of its job.
 *
 * @throws ApiError 400 when linked batch parameters differ in length, collections cannot be matched, or a run
 *   would create too many jobs
 */
export function expandIncoming(tool: ToolBundle, incoming: Incoming, rc: RequestContext): Expansion {
    const filtered: Incoming = emptyDict();
    for (const [key, value] of Object.entries(incoming)) {
        if (!key.endsWith("|__identifier__")) {
            filtered[key] = value;
        }
    }
    const single: Incoming = emptyDict();
    const matched: [string, unknown[]][] = [];
    const multiplied: [string, unknown[]][] = [];
    const mapped: MappedInput[] = [];
    for (const [key, value] of Object.entries(reorder(tool, filtered, rc))) {
        if (isDict(value) && "values" in value && value.batch) {
            const linked = value.linked !== false;
            let values: unknown[];
            if (isCollectionMapOver(value)) {
                const input = expandCollection(rc, key, value, linked);
                mapped.push(input);
                values = input.values;
            } else {
                values = Array.isArray(value.values) ? value.values : [];
            }
            (linked ? matched : multiplied).push([key, values]);
        } else {
            single[key] = value;
        }
    }
    const [firstKey, firstValues] = matched[0] ?? ["", [undefined]];
    for (const [key, values] of matched.slice(1)) {
        if (values.length !== firstValues.length) {
            throw new ApiError(
                400,
                `Received ${values.length} inputs for '${key}' and ${firstValues.length} inputs for '${firstKey}', these should be of equal length`,
                ErrorCodes.UNKNOWN,
            );
        }
    }
    const total = multiplied.reduce((count, [, values]) => count * values.length, firstValues.length);
    if (total > MAX_JOBS) {
        throw ApiError.badRequest(`This run would create ${total} jobs; Planet runs at most ${MAX_JOBS} jobs at once.`);
    }
    let combos: Incoming[] = [single];
    if (matched.length) {
        combos = firstValues.map((_, index) =>
            dictFrom([...Object.entries(single), ...matched.map(([key, values]) => [key, values[index]] as const)]),
        );
    }
    for (const [key, values] of multiplied) {
        combos = combos.flatMap((combo) => values.map((value) => dictFrom([...Object.entries(combo), [key, value]])));
    }
    if (mapped.length === 0) {
        return { combos, mapOver: null };
    }
    const structure = matchCollections(mapped);
    if (leafCount(structure) !== combos.length) {
        throw ApiError.badRequest(
            "Planet cannot run a tool over a collection together with an unlinked batch of datasets.",
        );
    }
    return { combos, mapOver: { inputs: mapped, structure } };
}
