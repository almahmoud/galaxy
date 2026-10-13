/**
 * The parameter summary of a job (`summarize_job_parameters`): one row per tool input as the job ran it, nested by
 * depth, with the labels of its outputs.
 */

import type { JobRecord } from "@/planet/db";

import {
    type BundleConditional,
    type BundleInput,
    type BundleOutput,
    isConditional,
    isParameter,
    isRepeat,
    isSection,
    isUploadDataset,
} from "./bundle";
import { emptyDict, isDict, own, type RequestContext, StateContext, type StateDict } from "./context";
import { isCollectionItem, isDatasetItem } from "./history";
import { checkParam, isDataParameter, toText } from "./parameters";
import { listify, pyStr } from "./python";
import { caseInputs, stateFromBasic, testParameter } from "./state";
import { renderTemplate } from "./templates";

/** A row of the parameter table. */
export interface ParameterRow {
    text: string | null;
    depth: number;
    value?: unknown;
    notes?: string;
    error?: boolean;
}

/** `JobDisplayParametersSummary`. */
export interface ParameterSummary {
    parameters: ParameterRow[];
    has_parameter_errors: boolean;
    outputs: Record<string, { label: string | null; value: { src: string; id: string } }[]>;
}

const ADDED_LATER = "not used (parameter was added after this job was run)";

/** True when the stored state names a case or dataset the tool or the database no longer has. */
function hasStoredErrors(
    inputs: readonly BundleInput[],
    stored: unknown,
    values: unknown,
    rc: RequestContext,
): boolean {
    if (!isDict(stored)) {
        return false;
    }
    for (const input of inputs) {
        if (!Object.hasOwn(stored, input.name)) {
            continue;
        }
        const raw = stored[input.name];
        const value = own(values, input.name);
        if (isParameter(input)) {
            if (isDataParameter(input) && raw !== null && raw !== undefined) {
                const resolved = Array.isArray(value) ? value : [value];
                if (resolved.some((item) => item !== null && !isDatasetItem(item) && !isCollectionItem(item))) {
                    return true;
                }
            }
        } else if (isRepeat(input) || isUploadDataset(input)) {
            const storedList = Array.isArray(raw) ? raw : [];
            const valueList = Array.isArray(value) ? value : [];
            if (storedList.some((item, index) => hasStoredErrors(input.inputs, item, valueList[index], rc))) {
                return true;
            }
        } else if (isSection(input)) {
            if (hasStoredErrors(input.inputs, raw, value, rc)) {
                return true;
            }
        } else {
            const test = testParameter(input, inputs);
            if (!test || !isDict(value) || !Object.hasOwn(value, "__current_case__")) {
                return true;
            }
            const selected = caseInputs(input, test, own(value, test.name) ?? null, rc);
            if (selected && hasStoredErrors(selected.inputs, raw, value, rc)) {
                return true;
            }
        }
    }
    return false;
}

function dataRow(value: unknown): unknown[] {
    return listify(value).map((item) => {
        if (isDatasetItem(item)) {
            return { src: "hda", id: item.id, hid: item.hid, name: item.name };
        }
        if (isCollectionItem(item)) {
            return { src: "hdca", id: item.id, hid: item.hid, name: item.name };
        }
        return null;
    });
}

function uploadTitle(input: Extract<BundleInput, { type: "upload_dataset" }>, values: StateDict): string {
    const fileType = Object.hasOwn(values, input.file_type_name)
        ? values[input.file_type_name]
        : input.default_file_type;
    return `${input.title} (${pyStr(fileType)})`;
}

function rows(
    inputs: readonly BundleInput[],
    values: StateDict,
    rc: RequestContext,
    depth: number,
    messages: Readonly<Record<string, string>>,
): ParameterRow[] {
    const out: ParameterRow[] = [];
    for (const input of inputs) {
        if (!Object.hasOwn(values, input.name)) {
            const label = isConditional(input)
                ? (testParameter(input, inputs)?.label ?? null)
                : isParameter(input)
                  ? input.label || input.name
                  : ("title" in input && input.title) || input.name;
            out.push({ text: label, depth, notes: ADDED_LATER });
            continue;
        }
        const value = values[input.name];
        if (isRepeat(input)) {
            for (const instance of Array.isArray(value) ? value : []) {
                out.push(...rows(input.inputs, isDict(instance) ? instance : emptyDict(), rc, depth + 1, {}));
            }
        } else if (isSection(input)) {
            out.push({ text: input.name, depth });
            out.push(...rows(input.inputs, isDict(value) ? value : emptyDict(), rc, depth + 1, {}));
        } else if (isConditional(input)) {
            out.push(...conditionalRows(input, inputs, value, rc, depth));
        } else if (isUploadDataset(input)) {
            out.push({
                text: uploadTitle(input, values),
                depth,
                value: `${Array.isArray(value) ? value.length : 0} uploaded datasets`,
            });
        } else if (isDataParameter(input) || isDatasetItem(value)) {
            out.push({ text: input.label || input.name, depth, value: dataRow(value) });
        } else if (input.type !== "ftpfile") {
            out.push({
                text: input.label || input.name,
                depth,
                value: toText(input, value),
                notes: messages[input.name] ?? "",
            });
        }
    }
    return out;
}

function conditionalRows(
    input: BundleConditional,
    siblings: readonly BundleInput[],
    value: unknown,
    rc: RequestContext,
    depth: number,
): ParameterRow[] {
    const test = testParameter(input, siblings);
    const groupValues = isDict(value) ? value : emptyDict();
    const selected = test ? caseInputs(input, test, own(groupValues, test.name) ?? null, rc) : null;
    if (!test || !selected || !Object.hasOwn(groupValues, "__current_case__")) {
        return [{ text: input.name, depth, notes: "The previously used value is no longer valid.", error: true }];
    }
    const caseValue = (input.cases[selected.index] ?? { value: pyStr(own(groupValues, test.name)) }).value;
    return [
        { text: test.label || test.name, depth, value: caseValue },
        ...rows(selected.inputs, groupValues, rc, depth + 1, {}),
    ];
}

/** `check_and_update_param_values(update_values=False)` for the top-level parameters. */
function upgradeMessages(rc: RequestContext, values: StateDict): Record<string, string> {
    const messages = emptyDict() as Record<string, string>;
    const context = new StateContext(values);
    for (const input of rc.tool.inputs) {
        if (isParameter(input) && Object.hasOwn(values, input.name)) {
            const { error } = checkParam(input, values[input.name], rc, context);
            if (error) {
                messages[input.name] = error.message;
            }
        }
    }
    return messages;
}

/** A label as `get_output_name` renders it for the summary: Python's `str` of each value, null when unknown. */
function outputLabel(rc: RequestContext, output: BundleOutput | undefined, values: StateDict): string | null {
    if (!output) {
        return null;
    }
    if (!output.label) {
        return rc.tool.name;
    }
    const rendered = renderTemplate(output.label, (path) => {
        const [first = "", ...rest] = path;
        if (first === "on_string" && rest.length === 0) {
            return { status: "value", text: "None" };
        }
        if (first === "tool") {
            return rest.length === 1 && rest[0] === "name"
                ? { status: "value", text: rc.tool.name }
                : { status: "undecided" };
        }
        let current: unknown = values;
        for (const name of path) {
            if (!isDict(current)) {
                return { status: "undecided" };
            }
            if (!Object.hasOwn(current, name)) {
                return { status: "missing" };
            }
            current = current[name];
        }
        if (isDatasetItem(current) || isCollectionItem(current) || isDict(current) || Array.isArray(current)) {
            return { status: "undecided" };
        }
        return { status: "value", text: pyStr(current) };
    });
    return rendered.status === "value" ? rendered.text : null;
}

/** Galaxy's job parameter summary for a job of the tool in `rc`; `rc.snapshot` must hold the job's items. */
export function summarizeJob(rc: RequestContext, job: JobRecord): ParameterSummary {
    const stored = isDict(job.params) ? job.params : emptyDict();
    const values = stateFromBasic(rc.tool.inputs, stored, rc);
    const hasErrors = hasStoredErrors(rc.tool.inputs, stored, values, rc);
    const messages = hasErrors ? upgradeMessages(rc, values) : {};
    const outputs: ParameterSummary["outputs"] = {};
    const byName = new Map(rc.tool.outputs.map((output) => [output.name, output]));
    for (const output of job.outputs) {
        (outputs[output.name] ??= []).push({
            label: outputLabel(rc, byName.get(output.name), values),
            value: { src: "hda", id: output.id },
        });
    }
    for (const output of job.output_collections) {
        if (output.src === "hdca") {
            (outputs[output.name] ??= []).push({
                label: outputLabel(rc, byName.get(output.name), values),
                value: { src: "hdca", id: output.id },
            });
        }
    }
    return { parameters: rows(rc.tool.inputs, values, rc, 1, messages), has_parameter_errors: hasErrors, outputs };
}
