/**
 * Batch mode (`expand_meta_parameters` for the legacy input format): a submitted parameter of the form
 * `{"batch": true, "values": [...]}` runs the tool once per value. Batch parameters are linked by default (the n-th
 * values run together, so they must have the same length); `"linked": false` multiplies them instead.
 */

import { ApiError, ErrorCodes } from "@/planet/util/errors";

import type { ToolBundle } from "./bundle";
import { dictFrom, emptyDict, isDict, type RequestContext } from "./context";
import { flatToNested, visitInputValues } from "./state";

/** The most jobs one tool run may create. */
export const MAX_JOBS = 1000;

/** Collection map-over runs a tool over the elements of a collection, which Planet does not do yet. */
export const MAP_OVER_UNSUPPORTED =
    "Running a tool over the elements of a collection is not supported by Planet yet; select the datasets instead.";

type Incoming = Record<string, unknown>;

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

/** `__collection_multirun_parameter`: a batch over one collection, which maps the tool over its elements. */
function isCollectionMapOver(value: Record<string, unknown>): boolean {
    const values = Array.isArray(value.values) ? value.values : [value.values];
    if (values.length !== 1) {
        return false;
    }
    const first = values[0];
    return isDict(first) && (first.src === "hdca" || first.src === "dce");
}

/**
 * Expands the flat parameters of one tool run into the parameters of each job (`build_combos`).
 *
 * @throws ApiError 400 when linked batch parameters differ in length, or for collection map-over
 */
export function expandIncoming(tool: ToolBundle, incoming: Incoming, rc: RequestContext): Incoming[] {
    const filtered: Incoming = emptyDict();
    for (const [key, value] of Object.entries(incoming)) {
        if (!key.endsWith("|__identifier__")) {
            filtered[key] = value;
        }
    }
    const single: Incoming = emptyDict();
    const matched: [string, unknown[]][] = [];
    const multiplied: [string, unknown[]][] = [];
    for (const [key, value] of Object.entries(reorder(tool, filtered, rc))) {
        if (isDict(value) && "values" in value && value.batch) {
            if (isCollectionMapOver(value)) {
                throw ApiError.badRequest(MAP_OVER_UNSUPPORTED);
            }
            const values = Array.isArray(value.values) ? value.values : [];
            (value.linked === false ? multiplied : matched).push([key, values]);
        } else {
            single[key] = value;
        }
    }
    let combos: Incoming[] = [single];
    if (matched.length) {
        const [firstKey, firstValues] = matched[0]!;
        for (const [key, values] of matched.slice(1)) {
            if (values.length !== firstValues.length) {
                throw new ApiError(
                    400,
                    `Received ${values.length} inputs for '${key}' and ${firstValues.length} inputs for '${firstKey}', these should be of equal length`,
                    ErrorCodes.UNKNOWN,
                );
            }
        }
        combos = firstValues.map((_, index) =>
            dictFrom([...Object.entries(single), ...matched.map(([key, values]) => [key, values[index]] as const)]),
        );
    }
    const total = multiplied.reduce((count, [, values]) => count * values.length, combos.length);
    if (total > MAX_JOBS) {
        throw ApiError.badRequest(`This run would create ${total} jobs; Planet runs at most ${MAX_JOBS} jobs at once.`);
    }
    for (const [key, values] of multiplied) {
        combos = combos.flatMap((combo) => values.map((value) => dictFrom([...Object.entries(combo), [key, value]])));
    }
    return combos;
}
