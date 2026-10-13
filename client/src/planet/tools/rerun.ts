/**
 * The tool form of an existing job (`Tool.to_json` with `job`): the job's parameters, checked against the tool as it
 * is now, with its datasets mapped to their copies in the current history.
 */

import type { JobRecord } from "@/planet/db";

import { emptyDict, isDict, type RequestContext, type StateDict } from "./context";
import { buildToolForm } from "./form";
import { type CollectionItem, type DatasetItem, isCollectionItem, isDatasetItem } from "./history";
import { checkParam, initialValue, isDataParameter } from "./parameters";
import { pyStr } from "./python";
import { stateFromBasic, stateToIncoming, visitInputValues } from "./state";

/** A replacement value as the rerun warning names it. */
function describe(value: unknown): string {
    if (isDatasetItem(value) || isCollectionItem(value)) {
        return `${value.hid}: ${value.name}`;
    }
    return pyStr(value);
}

/**
 * `check_and_update_param_values(update_values=True)`: values the tool no longer accepts are replaced by their
 * defaults. Returns the messages by flat parameter name.
 */
export function checkAndUpdate(rc: RequestContext, values: StateDict): Record<string, string> {
    const messages = emptyDict() as Record<string, string>;
    visitInputValues(
        rc.tool.inputs,
        values,
        rc,
        ({ input, parent, value, prefixedName, prefixedLabel, context, error }) => {
            let problem = error;
            if (!problem) {
                problem = checkParam(input, value, rc, context).error?.message ?? null;
            }
            if (!problem) {
                return;
            }
            if (input.type === "data_column" || input.type === "group_tag") {
                messages[prefixedName] = problem;
                return;
            }
            try {
                const replacement = initialValue(input, rc, context);
                if (!prefixedName.startsWith("__")) {
                    messages[prefixedName] =
                        replacement === value || JSON.stringify(replacement ?? null) === JSON.stringify(value ?? null)
                            ? problem
                            : `${problem} Using default: '${describe(replacement)}'.`;
                }
                parent[input.name] = replacement;
            } catch {
                messages[prefixedName] = `Attempt to replace invalid value for '${prefixedLabel}' failed.`;
            }
        },
    );
    return messages;
}

/** `_map_source_to_history`: datasets and collections of other histories become their copies in this one. */
function mapSourceToHistory(rc: RequestContext, values: StateDict): void {
    const datasets = new Map<string, DatasetItem>();
    for (const item of rc.snapshot.datasets) {
        datasets.set(item.datasetId, item);
        datasets.set(`${item.hid}_${item.datasetId}`, item);
    }
    const collections = new Map<string, CollectionItem>();
    for (const item of rc.snapshot.collections) {
        collections.set(item.collection.id, item);
        collections.set(`${item.hid}_${item.collection.id}`, item);
    }
    const map = (value: unknown): unknown => {
        if (isDatasetItem(value)) {
            return datasets.get(`${value.hid}_${value.datasetId}`) ?? datasets.get(value.datasetId) ?? null;
        }
        if (isCollectionItem(value)) {
            return (
                collections.get(`${value.hid}_${value.collection.id}`) ?? collections.get(value.collection.id) ?? null
            );
        }
        return null;
    };
    visitInputValues(rc.tool.inputs, values, rc, ({ input, parent, value }) => {
        if (!isDataParameter(input)) {
            return;
        }
        if (Array.isArray(value)) {
            if (input.type === "data") {
                parent[input.name] = value.map((item) => map(item) ?? item);
            }
            return;
        }
        const mapped = map(value);
        if (mapped) {
            parent[input.name] = mapped;
        }
    });
}

/** `_compare_tool_version`: the message shown when the job ran another version than the form's. */
export function versionMessage(rc: RequestContext, job: JobRecord, versions: readonly string[]): string {
    const { tool } = rc;
    if ((tool.id === job.tool_id || tool.old_id === job.tool_id) && tool.version === job.tool_version) {
        return "";
    }
    let message = `This job was run with tool version "${job.tool_version}", which is not available. `;
    message +=
        versions.length > 1
            ? "You can re-run the job with the selected tool or choose another version of the tool. "
            : "You can re-run the job with this tool version, which is a different version of the original tool. ";
    return message;
}

/** The form of `job` for the tool in `rc` (which must cover the job's items and the current history). */
export function buildRerunForm(
    rc: RequestContext,
    job: JobRecord,
    versions: readonly string[],
): Record<string, unknown> {
    const stored = isDict(job.params) ? job.params : {};
    const values = stateFromBasic(rc.tool.inputs, stored as StateDict, rc);
    const warnings = checkAndUpdate(rc, values);
    mapSourceToHistory(rc, values);
    const incoming = stateToIncoming(rc.tool.inputs, values, rc);
    return buildToolForm(rc, incoming, {
        versions,
        job: {
            jobId: job.id,
            remap: false,
            message: versionMessage(rc, job, versions),
            warnings,
        },
    });
}
