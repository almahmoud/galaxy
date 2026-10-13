/**
 * Tool states (`galaxy.tools.parameters`): building the nested state from the flat parameters the tool form submits
 * (`populate_state` in its legacy input format), walking it (`visit_input_values`) and converting it to and from its
 * stored JSON forms (`params_to_strings`, `params_from_strings`, `params_to_incoming`).
 */

import { ApiError } from "@/planet/util/errors";

import {
    type BundleConditional,
    type BundleInput,
    type BundleParameter,
    type BundleRepeat,
    type BundleUploadDataset,
    isConditional,
    isParameter,
    isRepeat,
    isSection,
    isUploadDataset,
} from "./bundle";
import { emptyDict, InputError, isDict, own, type RequestContext, StateContext, type StateDict } from "./context";
import {
    checkParam,
    dataJobValue,
    initialValue,
    isDataParameter,
    paramDictString,
    valueFromBasic,
    valueToBasic,
} from "./parameters";
import { pyInt } from "./python";

/** Parameter errors by flat parameter name (`cond|param`, `rep_0|param`). */
export type StateErrors = Record<string, Error>;

/** Repeat indexes in flat keys above this are rejected. */
const MAX_REPEAT_INDEX = 10_000;
const CASE_ERROR = "The selected case is unavailable/invalid.";

// ---------------------------------------------------------------------------------------------------------
// Conditionals

/**
 * The test parameter of a conditional. Conditionals whose cases Galaxy computes in Python (`value_from`, used by the
 * upload tool) refer to a sibling parameter; their cases are the values of that parameter, without inputs.
 */
export function testParameter(
    conditional: BundleConditional,
    siblings: readonly BundleInput[],
): BundleParameter | null {
    if (conditional.test_param) {
        return conditional.test_param;
    }
    const sibling = siblings.find((input) => input.name === conditional.value_ref);
    return sibling && isParameter(sibling) ? sibling : null;
}

/**
 * The cases of a conditional; see {@link testParameter}. A conditional whose cases Galaxy computes has one case
 * without inputs, for the test parameter's current value.
 */
export function conditionalCases(
    conditional: BundleConditional,
    test: BundleParameter,
    value: unknown,
    rc: RequestContext,
): BundleConditional["cases"] {
    if (conditional.cases.length || !conditional.value_from) {
        return conditional.cases;
    }
    return [{ value: paramDictString(test, value, rc) ?? "", inputs: [] }];
}

/** `Conditional.get_current_case`: the index of the case matching the test value; throws when none does. */
export function currentCase(
    conditional: BundleConditional,
    test: BundleParameter,
    value: unknown,
    rc: RequestContext,
): number {
    const text = paramDictString(test, value, rc);
    const index = conditionalCases(conditional, test, value, rc).findIndex(
        (candidate) => (candidate.value ?? "") === text,
    );
    if (index < 0) {
        throw new InputError(`No case matched value: ${conditional.name} ${String(text)}`);
    }
    return index;
}

/** The inputs of the case selected by `value`, or null when no case matches. */
export function caseInputs(
    conditional: BundleConditional,
    test: BundleParameter,
    value: unknown,
    rc: RequestContext,
): { index: number; inputs: BundleInput[] } | null {
    let index: number;
    try {
        index = currentCase(conditional, test, value, rc);
    } catch {
        return null;
    }
    return { index, inputs: conditionalCases(conditional, test, value, rc)[index]!.inputs };
}

// ---------------------------------------------------------------------------------------------------------
// Initial values

function uploadFileCount(input: BundleUploadDataset, rc: RequestContext, context: StateContext): number {
    const count = context.get("file_count") ?? "auto";
    if (count !== "auto") {
        return Math.min(Math.max(pyInt(count) ?? 1, 0), MAX_REPEAT_INDEX);
    }
    let extension = String(context.get(input.file_type_name) ?? input.default_file_type);
    if (extension === "auto" || extension === "") {
        extension = input.default_file_type;
    }
    const details = Object.hasOwn(rc.datatypeDetails, extension) ? rc.datatypeDetails[extension] : undefined;
    return details?.composite_files?.length || 1;
}

/** `get_initial_value` of a parameter or group. */
export function initialInputValue(
    input: BundleInput,
    siblings: readonly BundleInput[],
    rc: RequestContext,
    context: StateContext,
): unknown {
    if (isParameter(input)) {
        return initialValue(input, rc, context);
    }
    if (isRepeat(input)) {
        const out: StateDict[] = [];
        for (let index = 0; index < input.default; index++) {
            const values = emptyDict();
            values.__index__ = index;
            const child = new StateContext(values, context);
            for (const nested of input.inputs) {
                values[nested.name] = initialInputValue(nested, input.inputs, rc, child);
            }
            out.push(values);
        }
        return out;
    }
    if (isSection(input)) {
        const values = emptyDict();
        const child = new StateContext(values, context);
        for (const nested of input.inputs) {
            values[nested.name] = initialInputValue(nested, input.inputs, rc, child);
        }
        return values;
    }
    if (isUploadDataset(input)) {
        const out: StateDict[] = [];
        for (let index = 0; index < uploadFileCount(input, rc, context); index++) {
            const values = emptyDict();
            values.__index__ = index;
            for (const nested of input.inputs) {
                values[nested.name] = initialInputValue(nested, input.inputs, rc, context);
            }
            out.push(values);
        }
        return out;
    }
    const values = emptyDict();
    const test = testParameter(input, siblings);
    if (!test) {
        return values;
    }
    const testValue = initialValue(test, rc, context);
    values[test.name] = testValue;
    const selected = caseInputs(input, test, testValue, rc);
    if (!selected) {
        return values;
    }
    values.__current_case__ = selected.index;
    const child = new StateContext(values, context);
    for (const nested of selected.inputs) {
        values[nested.name] = initialInputValue(nested, selected.inputs, rc, child);
    }
    return values;
}

// ---------------------------------------------------------------------------------------------------------
// populate_state (legacy input format)

/** `process_key`: places a flat key's value into a nested dictionary. */
function processKey(key: string, value: unknown, target: StateDict): void {
    const parts = key.split("|");
    const head = parts[0]!;
    if (parts.length === 1) {
        if (Object.hasOwn(target, key) && !value) {
            return;
        }
        target[key] = value;
        return;
    }
    const rest = parts.slice(1).join("|");
    const repeat = /^(.*)_(\d+)$/.exec(head);
    if (repeat) {
        const index = Number(repeat[2]);
        if (index > MAX_REPEAT_INDEX) {
            throw ApiError.badRequest(`Parameter '${key}' has an invalid key structure.`);
        }
        const name = repeat[1]!;
        const existing = Object.hasOwn(target, name) ? target[name] : [];
        if (!Array.isArray(existing)) {
            throw ApiError.badRequest(`Parameter '${key}' received conflicting value.`);
        }
        while (existing.length <= index) {
            existing.push(emptyDict());
        }
        target[name] = existing;
        processKey(rest, value, existing[index] as StateDict);
        return;
    }
    if (!head || /^\d+$/.test(head)) {
        throw ApiError.badRequest(`Parameter '${key}' has an invalid key structure.`);
    }
    const existing = Object.hasOwn(target, head) ? target[head] : emptyDict();
    if (!isDict(existing)) {
        throw ApiError.badRequest(`Parameter '${key}' received conflicting value.`);
    }
    target[head] = existing;
    processKey(rest, value, existing);
}

/** `flat_to_nested_state`. */
export function flatToNested(incoming: Readonly<Record<string, unknown>>): StateDict {
    const nested = emptyDict();
    for (const [key, value] of Object.entries(incoming)) {
        processKey(key, value, nested);
    }
    return nested;
}

function incomingValue(incoming: Readonly<Record<string, unknown>>, key: string, fallback: unknown): unknown {
    return Object.hasOwn(incoming, key) ? incoming[key] : fallback;
}

function populateRepeat(
    input: BundleRepeat,
    incoming: Readonly<Record<string, unknown>>,
    key: string,
    rc: RequestContext,
    errors: StateErrors,
    context: StateContext,
): StateDict[] {
    const instances: StateDict[] = [];
    const keys = Object.keys(incoming);
    const minimum = input.default > input.min ? input.default : input.min;
    const maximum = input.max ?? Infinity;
    for (let index = 0; ; index++) {
        const prefix = `${key}_${index}`;
        if (index >= minimum && !keys.some((candidate) => candidate.startsWith(prefix))) {
            break;
        }
        if (index > MAX_REPEAT_INDEX) {
            throw ApiError.badRequest(`Too many repeats of '${key}'.`);
        }
        if (index < maximum) {
            const values = emptyDict();
            values.__index__ = index;
            instances.push(values);
            populateLevel(input.inputs, incoming, values, rc, errors, `${prefix}|`, context);
        }
    }
    return instances;
}

function populateLevel(
    inputs: readonly BundleInput[],
    incoming: Readonly<Record<string, unknown>>,
    state: StateDict,
    rc: RequestContext,
    errors: StateErrors,
    prefix: string,
    parent: StateContext,
): void {
    const context = new StateContext(state, parent);
    for (const input of inputs) {
        state[input.name] = initialInputValue(input, inputs, rc, context);
        const key = prefix + input.name;
        const groupPrefix = `${key}|`;
        if (isRepeat(input)) {
            state[input.name] = populateRepeat(input, incoming, key, rc, errors, context);
        } else if (isConditional(input)) {
            const test = testParameter(input, inputs);
            if (!test) {
                continue;
            }
            const testKey = input.value_ref && !input.value_ref_in_group ? prefix + test.name : groupPrefix + test.name;
            const initial = state[input.name] as StateDict;
            const { value, error } = checkParam(
                test,
                incomingValue(incoming, testKey, own(initial, test.name)),
                rc,
                context,
            );
            let groupState = initial;
            if (error) {
                errors[testKey] = error;
            } else {
                const selected = caseInputs(input, test, value, rc);
                if (selected) {
                    groupState = emptyDict();
                    state[input.name] = groupState;
                    populateLevel(selected.inputs, incoming, groupState, rc, errors, groupPrefix, context);
                    groupState.__current_case__ = selected.index;
                } else {
                    errors[testKey] = new InputError(CASE_ERROR);
                }
            }
            groupState[test.name] = value;
        } else if (isSection(input)) {
            populateLevel(input.inputs, incoming, state[input.name] as StateDict, rc, errors, groupPrefix, context);
        } else if (isUploadDataset(input)) {
            const instances = state[input.name] as StateDict[];
            for (const [position, values] of instances.entries()) {
                const index = (own(values, "__index__") as number | undefined) ?? position;
                populateLevel(input.inputs, incoming, values, rc, errors, `${key}_${index}|`, context);
            }
        } else {
            const { value, error } = checkParam(input, incomingValue(incoming, key, state[input.name]), rc, context);
            if (error) {
                errors[key] = error;
            }
            state[input.name] = value;
        }
    }
}

/**
 * `populate_state` with the legacy input format: builds the nested tool state from flat parameters
 * (`cond|param`, `rep_0|param`), filling in defaults, and collects the errors of rejected values.
 */
export function populateState(
    inputs: readonly BundleInput[],
    incoming: Readonly<Record<string, unknown>>,
    rc: RequestContext,
): { state: StateDict; errors: StateErrors } {
    const state = emptyDict();
    const errors: StateErrors = {};
    const root = new StateContext(flatToNested(incoming));
    populateLevel(inputs, incoming, state, rc, errors, "", root);
    return { state, errors };
}

// ---------------------------------------------------------------------------------------------------------
// Walking states

/** Arguments of a {@link visitInputValues} callback. */
export interface VisitArguments {
    input: BundleParameter;
    /** The state level holding the parameter. */
    parent: StateDict;
    value: unknown;
    /** The flat name, such as `cond|param` or `rep_0|param`. */
    prefixedName: string;
    /** Galaxy's legacy name: repeat prefixes only, without conditional and section names. */
    legacyName: string;
    /** The label path, such as `Queries 1 > param`. */
    prefixedLabel: string;
    /** The scope of the parameter's level. */
    context: StateContext;
    /** Why the value cannot be used: it is missing, or no case of its conditional matches it. */
    error: string | null;
}

/**
 * `visit_input_values`: calls `callback` for every parameter of the state's active branches. Conditionals without a
 * valid case are visited up to their test parameter.
 */
export function visitInputValues(
    inputs: readonly BundleInput[],
    values: StateDict,
    rc: RequestContext,
    callback: (args: VisitArguments) => void,
    namePrefix = "",
    labelPrefix = "",
    legacyPrefix = "",
    parentContext: StateContext | null = null,
): void {
    const context = new StateContext(values, parentContext);
    const visit = (
        input: BundleParameter,
        parent: StateDict,
        name: string,
        legacy: string,
        label: string,
        caseError: string | null,
    ) => {
        const present = Object.hasOwn(parent, input.name);
        callback({
            input,
            parent,
            value: present ? parent[input.name] : null,
            prefixedName: name,
            legacyName: legacy,
            prefixedLabel: label,
            context,
            error: present ? caseError : `No value found for '${label}'.`,
        });
    };
    for (const input of inputs) {
        if (isRepeat(input) || isUploadDataset(input)) {
            const instances = own(values, input.name);
            const list = Array.isArray(instances) ? instances : [];
            values[input.name] = list;
            list.forEach((instance, index) => {
                if (!isDict(instance)) {
                    return;
                }
                instance.__index__ = index;
                const prefix = `${namePrefix}${input.name}_${index}|`;
                const label = `${labelPrefix}${input.title || input.name} ${index + 1} > `;
                visitInputValues(input.inputs, instance, rc, callback, prefix, label, prefix, context);
            });
        } else if (isConditional(input)) {
            const test = testParameter(input, inputs);
            const group = own(values, input.name);
            const groupValues = isDict(group) ? group : emptyDict();
            values[input.name] = groupValues;
            if (!test) {
                continue;
            }
            const prefix = `${namePrefix}${input.name}|`;
            const selected = caseInputs(input, test, own(groupValues, test.name) ?? null, rc);
            visit(
                test,
                groupValues,
                prefix + test.name,
                legacyPrefix + test.name,
                labelPrefix + (test.label || test.name),
                selected ? null : CASE_ERROR,
            );
            if (!selected) {
                continue;
            }
            groupValues.__current_case__ = selected.index;
            visitInputValues(selected.inputs, groupValues, rc, callback, prefix, labelPrefix, legacyPrefix, context);
        } else if (isSection(input)) {
            const group = own(values, input.name);
            const groupValues = isDict(group) ? group : emptyDict();
            values[input.name] = groupValues;
            const prefix = `${namePrefix}${input.name}|`;
            visitInputValues(input.inputs, groupValues, rc, callback, prefix, labelPrefix, legacyPrefix, context);
        } else {
            visit(
                input,
                values,
                namePrefix + input.name,
                legacyPrefix + input.name,
                labelPrefix + (input.label || input.name),
                null,
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Stored forms

function groupToBasic(
    input: BundleInput,
    siblings: readonly BundleInput[],
    value: unknown,
    rc: RequestContext,
    leaf: (param: BundleParameter, value: unknown) => unknown,
): unknown {
    if (isParameter(input)) {
        return leaf(input, value);
    }
    if (isRepeat(input) || isUploadDataset(input)) {
        return (Array.isArray(value) ? value : []).map((instance) => {
            const out = emptyDict();
            if (isDict(instance) && Object.hasOwn(instance, "__index__")) {
                out.__index__ = instance.__index__;
            }
            for (const nested of input.inputs) {
                if (isDict(instance) && Object.hasOwn(instance, nested.name)) {
                    out[nested.name] = groupToBasic(nested, input.inputs, instance[nested.name], rc, leaf);
                }
            }
            return out;
        });
    }
    const out = emptyDict();
    if (!isDict(value)) {
        return out;
    }
    if (isSection(input)) {
        for (const nested of input.inputs) {
            if (Object.hasOwn(value, nested.name)) {
                out[nested.name] = groupToBasic(nested, input.inputs, value[nested.name], rc, leaf);
            }
        }
        return out;
    }
    const test = testParameter(input, siblings);
    if (!test) {
        return out;
    }
    out[test.name] = valueToBasic(test, own(value, test.name) ?? null);
    const selected = caseInputs(input, test, own(value, test.name) ?? null, rc);
    if (!selected) {
        return out;
    }
    out.__current_case__ = selected.index;
    for (const nested of selected.inputs) {
        if (Object.hasOwn(value, nested.name)) {
            out[nested.name] = groupToBasic(nested, selected.inputs, value[nested.name], rc, leaf);
        }
    }
    return out;
}

function stateToBasicWith(
    inputs: readonly BundleInput[],
    state: StateDict,
    rc: RequestContext,
    leaf: (param: BundleParameter, value: unknown) => unknown,
): StateDict {
    const out = emptyDict();
    for (const [key, value] of Object.entries(state)) {
        const input = inputs.find((candidate) => candidate.name === key);
        out[key] = input ? groupToBasic(input, inputs, value, rc, leaf) : value;
    }
    return out;
}

/** `params_to_json`: the state in Galaxy's basic JSON form (`state_inputs` of tool forms). */
export function stateToJson(inputs: readonly BundleInput[], state: StateDict, rc: RequestContext): StateDict {
    return stateToBasicWith(inputs, state, rc, valueToBasic);
}

/**
 * The state as a job stores it (Planet's `Job.params`): Galaxy's basic form, except that data values are
 * `{src, id}` references (lists for multiple data parameters) as the job protocol expects.
 */
export function stateToJobParams(inputs: readonly BundleInput[], state: StateDict, rc: RequestContext): StateDict {
    return stateToBasicWith(inputs, state, rc, (param, value) =>
        isDataParameter(param) || param.type === "hidden_data" ? dataJobValue(value) : valueToBasic(param, value),
    );
}

function groupFromBasic(
    input: BundleInput,
    siblings: readonly BundleInput[],
    value: unknown,
    rc: RequestContext,
): unknown {
    if (isParameter(input)) {
        return valueFromBasic(input, value, rc);
    }
    if (isRepeat(input) || isUploadDataset(input)) {
        return (Array.isArray(value) ? value : []).map((instance, position) => {
            const out = emptyDict();
            out.__index__ = own(instance, "__index__") ?? position;
            for (const nested of input.inputs) {
                if (isDict(instance) && Object.hasOwn(instance, nested.name)) {
                    out[nested.name] = groupFromBasic(nested, input.inputs, instance[nested.name], rc);
                }
            }
            return out;
        });
    }
    const out = emptyDict();
    const source = isDict(value) ? value : emptyDict();
    if (isSection(input)) {
        for (const nested of input.inputs) {
            if (Object.hasOwn(source, nested.name)) {
                out[nested.name] = groupFromBasic(nested, input.inputs, source[nested.name], rc);
            }
        }
        return out;
    }
    const test = testParameter(input, siblings);
    if (!test) {
        return out;
    }
    out[test.name] = valueFromBasic(test, own(source, test.name) ?? null, rc);
    const selected = caseInputs(input, test, out[test.name], rc);
    if (!selected) {
        return out;
    }
    out.__current_case__ = selected.index;
    for (const nested of selected.inputs) {
        if (Object.hasOwn(source, nested.name)) {
            out[nested.name] = groupFromBasic(nested, selected.inputs, source[nested.name], rc);
        }
    }
    return out;
}

/** `params_from_strings` with `ignore_errors`: a stored state back as parameter values. */
export function stateFromBasic(inputs: readonly BundleInput[], stored: StateDict, rc: RequestContext): StateDict {
    const out = emptyDict();
    for (const [key, value] of Object.entries(stored)) {
        const input = inputs.find((candidate) => candidate.name === key);
        out[key] = input ? groupFromBasic(input, inputs, value, rc) : value;
    }
    return out;
}

/** `params_to_incoming`: a state as the flat parameters a form submits, for rebuilding the form of a job. */
export function stateToIncoming(
    inputs: readonly BundleInput[],
    values: StateDict,
    rc: RequestContext,
    incoming: StateDict = emptyDict(),
    prefix = "",
): StateDict {
    for (const input of inputs) {
        const value = own(values, input.name);
        if (isRepeat(input) || isUploadDataset(input)) {
            (Array.isArray(value) ? value : []).forEach((instance, position) => {
                if (isDict(instance)) {
                    const index = own(instance, "__index__") ?? position;
                    stateToIncoming(input.inputs, instance, rc, incoming, `${prefix}${input.name}_${String(index)}|`);
                }
            });
        } else if (isConditional(input)) {
            const test = testParameter(input, inputs);
            if (!test || !isDict(value)) {
                continue;
            }
            const groupPrefix = `${prefix}${input.name}|`;
            incoming[groupPrefix + test.name] = own(value, test.name) ?? null;
            const selected = caseInputs(input, test, own(value, test.name) ?? null, rc);
            if (selected) {
                stateToIncoming(selected.inputs, value, rc, incoming, groupPrefix);
            }
        } else if (isSection(input)) {
            stateToIncoming(input.inputs, isDict(value) ? value : emptyDict(), rc, incoming, `${prefix}${input.name}|`);
        } else {
            incoming[prefix + input.name] = value ?? null;
        }
    }
    return incoming;
}
