/**
 * Galaxy's tool parameter semantics (`galaxy.tools.parameters.basic`) for the parameter types tool bundles carry:
 * initial values, conversion and validation of submitted values (`from_json`, `validate`), the JSON form stored in
 * tool states (`value_to_basic`), display text and the string templates see (`to_param_dict_string`).
 */

import type { BundleParameter, BundleValidator } from "./bundle";
import {
    InputError,
    isDict,
    own,
    ParameterValueError,
    reprValue,
    type RequestContext,
    type StateContext,
} from "./context";
import {
    type CollectionItem,
    type DatasetItem,
    type HistoryItem,
    isCollectionItem,
    isDatasetItem,
    isHistoryItem,
} from "./history";
import {
    collectionMatch,
    columnList,
    dataFilterValues,
    drillDownOptions,
    elementsDeleted,
    hasTag,
    hdaMatch,
    hdcaDatasets,
    metadataValue,
    type ParameterOption,
    selectOptions,
} from "./options";
import {
    buildSanitizer,
    DEFAULT_SANITIZER,
    listify,
    pyFloat,
    pyFloatRepr,
    pyInt,
    pyRepr,
    pyStr,
    sanitizeParam,
    type Sanitizer,
    stringAsBool,
    stringAsBoolOrNone,
} from "./python";

const SELECT_TYPES = new Set(["select", "genomebuild", "group_tag", "data_column"]);
const DATA_TYPES = new Set(["data", "data_collection"]);

export function isSelectLike(param: BundleParameter): boolean {
    return SELECT_TYPES.has(param.type);
}

export function isDataParameter(param: BundleParameter): boolean {
    return DATA_TYPES.has(param.type);
}

/** True when the tool profile (`23.0`, `18.09`) is older than `version`, comparing like `packaging.Version`. */
export function profileBefore(profile: string | null | undefined, version: string): boolean {
    const parts = (text: string) => text.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const own = parts(String(profile ?? "16.01"));
    const other = parts(version);
    for (let i = 0; i < Math.max(own.length, other.length); i++) {
        const difference = (own[i] ?? 0) - (other[i] ?? 0);
        if (difference !== 0) {
            return difference < 0;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------------------------------------
// Sanitization

const sanitizers = new WeakMap<BundleParameter, Sanitizer>();

/** The parameter's sanitizer, or null when the tool turns sanitization off (`<options sanitize="false">`). */
export function sanitizerFor(param: BundleParameter, rc: RequestContext): Sanitizer | null {
    if (rc.tool.options?.sanitize === false) {
        return null;
    }
    if (!param.sanitizer) {
        return DEFAULT_SANITIZER;
    }
    let sanitizer = sanitizers.get(param);
    if (!sanitizer) {
        sanitizer = buildSanitizer(param.sanitizer);
        sanitizers.set(param, sanitizer);
    }
    return sanitizer;
}

function sanitize<T>(param: BundleParameter, rc: RequestContext, value: T): T {
    const sanitizer = sanitizerFor(param, rc);
    return sanitizer ? sanitizeParam(value, sanitizer) : value;
}

// ---------------------------------------------------------------------------------------------------------
// Context helpers

/** `is_runtime_context`: a value in scope is a dataset that is not `ok` yet. */
export function isRuntimeContext(context: StateContext): boolean {
    for (const value of context.allValues()) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (isDatasetItem(item) && item.effectiveState !== "ok") {
                return true;
            }
        }
    }
    return false;
}

/** `unicodify`: the string Galaxy stores for scalar parameter values. */
export function unicodify(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    return pyStr(value);
}

// ---------------------------------------------------------------------------------------------------------
// Initial values

function selectInitial(options: readonly ParameterOption[], param: BundleParameter): unknown {
    if (options.length === 0) {
        return null;
    }
    const selected = options.filter((option) => option.selected).map((option) => option.value);
    if (selected.length === 0) {
        return !param.optional && !param.multiple ? options[0]!.value : null;
    }
    return param.multiple ? selected : selected[0];
}

function drillDownInitial(param: BundleParameter): unknown {
    const selected: string[] = [];
    const visit = (nodes: ReturnType<typeof drillDownOptions>) => {
        for (const node of nodes) {
            if (node.selected) {
                selected.push(node.value);
            }
            visit(node.options ?? []);
        }
    };
    const options = drillDownOptions(param);
    if (options.length === 0) {
        return null;
    }
    visit(options);
    if (selected.length === 0) {
        return null;
    }
    return param.multiple ? selected : selected[0];
}

/** Datasets of the history a data parameter offers, newest first, before pagination. */
export function matchingDatasets(param: BundleParameter, rc: RequestContext, context: StateContext): DatasetItem[] {
    const filterValues = dataFilterValues(param, rc, context);
    return rc.snapshot
        .activeVisibleDatasets()
        .filter((item) => (!param.tag || hasTag(item.tags, param.tag)) && hdaMatch(param, rc, item, filterValues));
}

/** Collections whose datasets a data parameter accepts, newest first, before type checks and pagination. */
export function matchingCollections(
    param: BundleParameter,
    rc: RequestContext,
    context: StateContext,
): CollectionItem[] {
    const filterValues = dataFilterValues(param, rc, context);
    return rc.snapshot
        .activeVisibleCollections()
        .filter(
            (item) =>
                (!param.tag || hasTag(item.tags, param.tag)) &&
                collectionMatch(param, rc, item.collection, filterValues),
        );
}

/** `get_initial_value`. */
export function initialValue(param: BundleParameter, rc: RequestContext, context: StateContext): unknown {
    switch (param.type) {
        case "integer": {
            if (param.value === null || param.value === undefined || param.value === "") {
                return null;
            }
            return pyInt(param.value) ?? null;
        }
        case "float":
            return param.value === null || param.value === undefined ? null : (pyFloat(param.value) ?? null);
        case "boolean":
            return param.checked ?? null;
        case "color":
            return (param.value ?? "#000000").toLowerCase();
        case "baseurl":
            return baseUrl(param, rc);
        case "hidden_data":
            return "None";
        case "file":
        case "ftpfile":
        case "rules":
        case "directory_uri":
            return null;
        case "select":
        case "genomebuild":
            return selectInitial(selectOptions(param, rc, context), param);
        case "group_tag":
        case "data_column":
            if (param.default_value !== null && param.default_value !== undefined) {
                return param.type === "data_column" ? stripColumnPrefix(param.default_value) : param.default_value;
            }
            return selectInitial(selectOptions(param, rc, context), param);
        case "drill_down":
            return drillDownInitial(param);
        case "data":
            return param.optional ? null : (matchingDatasets(param, rc, context)[0] ?? null);
        case "data_collection":
            return param.optional ? null : (matchingCollections(param, rc, context)[0] ?? null);
        default:
            return param.value ?? null;
    }
}

function baseUrl(param: BundleParameter, rc: RequestContext): string {
    const value = param.value ?? "";
    return value.startsWith("/") ? `${rc.origin}${value}` : value;
}

/** `ColumnListParameter._strip_c`: `c3` becomes `3`. */
export function stripColumnPrefix(column: unknown): string {
    const text = pyStr(column).trim();
    return /^c\d+$/.test(text) ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------------------------------------
// Validators

const METADATA_VALIDATORS = new Set([
    "metadata",
    "dataset_metadata_equal",
    "unspecified_build",
    "dataset_metadata_in_range",
    "dataset_metadata_in_data_table",
    "dataset_metadata_not_in_data_table",
    "dataset_metadata_in_file",
]);

const DEFAULT_VALIDATOR_MESSAGE = "Parameter validation error.";

function fail(validator: BundleValidator, passed: boolean, shown?: unknown, message?: string): void {
    let text = message ?? validator.message ?? DEFAULT_VALIDATOR_MESSAGE;
    if (
        shown !== undefined &&
        shown !== null &&
        shown !== "" &&
        shown !== false &&
        shown !== 0 &&
        text.includes("%s")
    ) {
        text = text.replace("%s", pyStr(shown));
    }
    if (passed === validator.negate) {
        throw new InputError(text);
    }
}

function rangeCheck(validator: BundleValidator, value: unknown, shown: unknown): void {
    const number = pyFloat(value);
    const min = validator.min ?? -Infinity;
    const max = validator.max ?? Infinity;
    if (number === undefined) {
        const low = validator.min === null || validator.min === undefined ? "-inf" : pyStr(validator.min);
        const high = validator.max === null || validator.max === undefined ? "inf" : pyStr(validator.max);
        const op1 = validator.exclude_min ? "<" : "<=";
        const op2 = validator.exclude_max ? "<" : "<=";
        const expression = `float('${low}') ${op1} float(value) ${op2} float('${high}')`;
        fail(validator, false, shown, `Validator '${expression}' could not be evaluated on '${pyStr(value)}'`);
        return;
    }
    const aboveMin = validator.exclude_min ? number > min : number >= min;
    const belowMax = validator.exclude_max ? number < max : number <= max;
    fail(validator, aboveMin && belowMax, shown);
}

/** Runs one validator on a single value; validators Planet cannot evaluate pass. */
function runValidator(validator: BundleValidator, value: unknown): void {
    switch (validator.type) {
        case "regex": {
            let pattern: RegExp;
            try {
                pattern = new RegExp(validator.expression ?? "", "y");
            } catch {
                return;
            }
            for (const item of Array.isArray(value) ? value : [value]) {
                pattern.lastIndex = 0;
                fail(validator, pattern.test(item === null || item === undefined ? "" : pyStr(item)), item);
            }
            return;
        }
        case "in_range":
            rangeCheck(validator, value, value);
            return;
        case "length": {
            if (value === null || value === undefined) {
                throw new InputError("No value provided");
            }
            const length =
                typeof value === "string" ? Array.from(value).length : Array.isArray(value) ? value.length : 0;
            rangeCheck(validator, length, length);
            return;
        }
        case "empty_field":
            fail(validator, value !== "" && value !== null && value !== undefined);
            return;
        case "no_options":
            fail(validator, value !== null && value !== undefined);
            return;
        case "dataset_ok_validator":
            if (isDatasetItem(value)) {
                fail(validator, value.effectiveState === "ok");
            }
            return;
        case "empty_dataset":
            if (isDatasetItem(value)) {
                fail(validator, (value.fileSize ?? 0) !== 0);
            }
            return;
        case "empty_extra_files_path":
            if (isDatasetItem(value)) {
                fail(validator, (value.totalSize ?? 0) !== (value.fileSize ?? 0));
            }
            return;
        case "unspecified_build":
            if (isDatasetItem(value)) {
                let dbkey = metadataValue(value, "dbkey");
                if (Array.isArray(dbkey)) {
                    dbkey = dbkey[0];
                }
                fail(validator, dbkey !== "?");
            }
            return;
        case "dataset_metadata_equal":
            if (isDatasetItem(value) && validator.metadata_name) {
                const metadata = metadataValue(value, validator.metadata_name);
                fail(validator, JSON.stringify(metadata ?? null) === JSON.stringify(validator.value ?? null), metadata);
            }
            return;
        case "dataset_metadata_in_range":
            if (isDatasetItem(value) && validator.metadata_name) {
                const metadata = metadataValue(value, validator.metadata_name);
                rangeCheck(validator, metadata, metadata);
            }
            return;
        default:
            // `expression` validators run in the job's stage-in container; the metadata check needs the datatype's
            // metadata specification and data table validators need reference data Planet does not have.
            return;
    }
}

function validateSingle(param: BundleParameter, value: unknown): void {
    if ((value === "" || value === null || value === undefined) && param.optional) {
        return;
    }
    for (const validator of param.validators ?? []) {
        try {
            runValidator(validator, value);
        } catch (error) {
            if (error instanceof InputError) {
                throw new ParameterValueError(error.message, param.name, value);
            }
            throw error;
        }
    }
}

function validateDatasets(param: BundleParameter, value: unknown): void {
    let count = 0;
    const check = (dataset: DatasetItem) => {
        count++;
        for (const validator of param.validators ?? []) {
            if (METADATA_VALIDATORS.has(validator.type) && dataset.state !== "ok") {
                return;
            }
            try {
                runValidator(validator, dataset);
            } catch (error) {
                if (error instanceof InputError) {
                    throw new ParameterValueError(error.message, param.name, dataset);
                }
                throw error;
            }
        }
    };
    if (value) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (isCollectionItem(item)) {
                hdcaDatasets(item).forEach(check);
            } else if (isDatasetItem(item)) {
                check(item);
            }
        }
    }
    if (param.min !== null && param.min !== undefined && param.min > count) {
        throw new ParameterValueError(`at least ${param.min} datasets are required`, param.name);
    }
    if (param.max !== null && param.max !== undefined && param.max < count) {
        throw new ParameterValueError(`at most ${param.max} datasets are required`, param.name);
    }
}

/** `validate`: runs the parameter's validators on a converted value. */
export function validateValue(param: BundleParameter, value: unknown): void {
    if (isDataParameter(param)) {
        validateDatasets(param, value);
        return;
    }
    if (isSelectLike(param) || param.type === "drill_down") {
        if (!value || (Array.isArray(value) && value.length === 0)) {
            validateSingle(param, value);
        }
        for (const item of param.multiple && Array.isArray(value) ? value : [value]) {
            validateSingle(param, item);
        }
        return;
    }
    validateSingle(param, value);
}

// ---------------------------------------------------------------------------------------------------------
// Conversion of submitted values (`from_json`)

function integerFromJson(param: BundleParameter, value: unknown): unknown {
    const parsed = pyInt(value);
    if (parsed !== undefined) {
        return parsed;
    }
    if (!pyTruthyScalar(value) && param.optional) {
        return "";
    }
    throw new ParameterValueError("the attribute 'value' must be set for non optional parameters", param.name, value);
}

function floatFromJson(param: BundleParameter, value: unknown): unknown {
    const parsed = pyFloat(value);
    if (parsed !== undefined) {
        return parsed;
    }
    if (!pyTruthyScalar(value) && param.optional) {
        return "";
    }
    throw new ParameterValueError("the attribute 'value' must be set for non optional parameters", param.name, value);
}

function pyTruthyScalar(value: unknown): boolean {
    return !(value === null || value === undefined || value === "" || value === 0 || value === false);
}

/** `BooleanToolParameter.to_python`. */
export function booleanValue(param: BundleParameter, value: unknown): boolean | null {
    return param.optional ? stringAsBoolOrNone(value) : stringAsBool(value);
}

function legalValues(param: BundleParameter, rc: RequestContext, context: StateContext, value: unknown): string[] {
    if (param.type === "genomebuild") {
        return rc.genomes.map(([, dbkey = ""]) => dbkey);
    }
    if (param.type === "group_tag") {
        if (param.data_ref && !context.has(param.data_ref)) {
            throw new InputError("Value for associated data reference not found (data_ref).");
        }
        return selectOptions(param, rc, context).map((option) => option.value);
    }
    if (param.type === "data_column") {
        if (!param.data_ref || !context.has(param.data_ref)) {
            throw new InputError("Value for associated data reference not found (data_ref).");
        }
        const legal = columnList(param, context);
        if (value !== null && value !== undefined) {
            const values = listify(value, true).map((item) => pyStr(item));
            if (!values.every((item) => legal.includes(item)) && fileIsEmpty(param, context)) {
                legal.push(...values);
            }
        }
        return legal;
    }
    return selectOptions(param, rc, context).map((option) => option.value);
}

/** `ColumnListParameter.is_file_empty`. */
function fileIsEmpty(param: BundleParameter, context: StateContext): boolean {
    for (const item of listify(context.get(param.data_ref ?? ""))) {
        if (isCollectionItem(item)) {
            if (!item.collection.populated) {
                return true;
            }
            const first = hdcaDatasets(item)[0];
            return !first || !((first.fileSize ?? 0) > 0);
        }
        if (isDatasetItem(item)) {
            return !((item.fileSize ?? 0) > 0);
        }
        throw new ParameterValueError(
            `Dataset '${pyStr(item)}' for data_ref attribute '${param.data_ref}' of parameter '${param.name}' is not a DatasetInstance`,
            param.name,
        );
    }
    return false;
}

/** `SelectToolParameter._select_from_json`. */
function selectFromJson(
    param: BundleParameter,
    input: unknown,
    rc: RequestContext,
    context: StateContext,
    requireLegalValue: boolean,
): unknown {
    let value = input;
    const legal = legalValues(param, rc, context, value);
    const fallback = new Map(selectOptions(param, rc, context).map((option) => [option.name, option.value]));
    const dynamic = param.is_dynamic;
    if ((legal.length === 0 || !requireLegalValue) && isRuntimeContext(context)) {
        if (param.multiple) {
            if (value === "") {
                value = null;
            } else if (typeof value === "string") {
                value = value.split(/\s+/).filter(Boolean);
            }
        }
        return value;
    }
    if (value === null || value === undefined) {
        if (param.optional) {
            return null;
        }
        throw new ParameterValueError(
            "an invalid option (None) was selected, please verify",
            param.name,
            null,
            dynamic,
        );
    }
    if (legal.length === 0) {
        if (param.optional && profileBefore(rc.tool.profile, "18.09")) {
            return null;
        }
        throw new ParameterValueError("requires a value, but no legal values defined", param.name, undefined, dynamic);
    }
    const legalSet = new Set(legal);
    if (Array.isArray(value)) {
        if (!param.multiple) {
            throw new ParameterValueError(
                "multiple values provided but parameter is not expecting multiple values",
                param.name,
                undefined,
                dynamic,
            );
        }
        const values = value.map((item) => pyStr(item));
        if (values.every((item) => legalSet.has(item))) {
            return values;
        }
        if (values.every((item) => fallback.has(item))) {
            return values.map((item) => fallback.get(item)!);
        }
        const invalid = [...new Set(values.filter((item) => !legalSet.has(item)))];
        throw new ParameterValueError(
            `invalid options (${pyRepr(invalid.join(","))}) were selected (valid options: ${legal.join(",")})`,
            param.name,
            undefined,
            dynamic,
        );
    }
    const isNone = value === "None" && !legalSet.has("None");
    if ((isNone || !pyTruthyScalar(value)) && param.multiple) {
        if (param.optional) {
            return [];
        }
        throw new ParameterValueError(
            "no option was selected for non optional parameter",
            param.name,
            undefined,
            dynamic,
        );
    }
    if (isDict(value) || isHistoryItem(value)) {
        throw new ParameterValueError(
            `an invalid option (${reprValue(value)}) was selected (valid options: ${legal.join(",")})`,
            param.name,
            value,
            dynamic,
        );
    }
    const text = typeof value === "string" ? value : pyStr(value);
    if (legalSet.has(text)) {
        return text;
    }
    if (fallback.has(text)) {
        return fallback.get(text);
    }
    if (!requireLegalValue) {
        return value;
    }
    throw new ParameterValueError(
        `an invalid option (${pyRepr(value)}) was selected (valid options: ${legal.join(",")})`,
        param.name,
        value,
        dynamic,
    );
}

/** `multiple_select_value_split`: values split on newlines and commas. */
function splitMultiple(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [value];
    return items
        .flatMap((item) => pyStr(item).split(/[\n,]/))
        .map((item) => item.trim())
        .filter(Boolean);
}

function columnFromJson(param: BundleParameter, input: unknown, rc: RequestContext, context: StateContext): unknown {
    let value: unknown = input;
    if (param.multiple) {
        if (Array.isArray(value) || typeof value === "string") {
            const columns = splitMultiple(value);
            value = columns.length ? columns.map(stripColumnPrefix) : null;
        } else {
            value = null;
        }
    } else {
        value = pyTruthyScalar(value) ? stripColumnPrefix(value) : null;
    }
    if (!pyTruthyScalar(value) && param.accept_default) {
        const fallback = param.default_value ?? "1";
        return param.multiple ? [fallback] : fallback;
    }
    return selectFromJson(param, value, rc, context, true);
}

function groupTagFromJson(param: BundleParameter, input: unknown, rc: RequestContext, context: StateContext): unknown {
    let value: unknown = input;
    if (param.multiple) {
        const tags = Array.isArray(value) || typeof value === "string" ? splitMultiple(value) : [];
        value = tags.length ? tags : null;
    } else if (!pyTruthyScalar(value)) {
        value = null;
    }
    return selectFromJson(param, value, rc, context, false);
}

function drillDownFromJson(param: BundleParameter, input: unknown): unknown {
    const legal: string[] = [];
    const visit = (nodes: ReturnType<typeof drillDownOptions>) => {
        for (const node of nodes) {
            legal.push(node.value);
            visit(node.options ?? []);
        }
    };
    visit(drillDownOptions(param));
    if (input === null || input === undefined) {
        if (param.optional) {
            return null;
        }
        throw new ParameterValueError(`an invalid option (${pyRepr(input)}) was selected`, param.name, input);
    }
    if (legal.length === 0) {
        throw new ParameterValueError("requires a value, but no legal values defined", param.name);
    }
    const values = Array.isArray(input) ? input : [input];
    if (values.length > 1 && !param.multiple) {
        throw new ParameterValueError(
            "multiple values provided but parameter is not expecting multiple values",
            param.name,
        );
    }
    for (const item of values) {
        if (!legal.includes(pyStr(item))) {
            throw new ParameterValueError(
                `an invalid option (${pyRepr(item)}) was selected (valid options: ${legal.join(",")})`,
                param.name,
                item,
            );
        }
    }
    const out = values.map((item) => pyStr(item));
    return param.multiple ? out : (out[0] ?? null);
}

function ftpFromJson(param: BundleParameter, input: unknown): unknown {
    const files: string[] = [];
    for (const item of Array.isArray(input) ? input : [input]) {
        if (item === null || item === undefined || item === "") {
            files.length = 0;
            break;
        }
        files.push(isDict(item) ? pyStr(own(item, "name")) : pyStr(item));
    }
    if (files.length === 0) {
        if (!param.optional) {
            throw new InputError("Please select a valid FTP file.");
        }
        return null;
    }
    throw new InputError("The FTP directory is not configured.");
}

/** Resolves a `{src, id}` reference or an id to a history item (`src_id_to_item`). */
function resolveReference(rc: RequestContext, value: unknown, paramName: string): HistoryItem {
    if (isHistoryItem(value)) {
        return value;
    }
    if (isDict(value) && typeof value.src === "string" && "id" in value) {
        const src = value.src;
        if (!["hda", "ldda", "dce", "hdca"].includes(src)) {
            throw new InputError(`Unknown input source ${src} passed to job submission API.`);
        }
        const item = rc.snapshot.get(src, pyStr(value.id));
        if (!item) {
            throw new InputError("Invalid input id passed to job submission API.");
        }
        return item;
    }
    if (typeof value === "string" || typeof value === "number") {
        const item = rc.snapshot.get("hda", String(value));
        if (!item) {
            throw new ParameterValueError(`invalid dataset id ${pyRepr(value)}`, paramName);
        }
        return item;
    }
    throw new ParameterValueError(`Invalid value ${reprValue(value)}`, paramName);
}

/** The items of a `{"values": [...]}` wrapper (`BaseDataToolParameter.to_python`). */
function wrapperItems(value: StateDictLike): unknown[] {
    return Array.isArray(value.values) ? value.values : [];
}

type StateDictLike = { values?: unknown; batch?: unknown };

function dataFromJson(param: BundleParameter, input: unknown, rc: RequestContext): unknown {
    let value = input;
    const empty =
        value === null ||
        value === undefined ||
        value === "" ||
        value === "None" ||
        (Array.isArray(value) && value.length === 0) ||
        (isDict(value) && "values" in value && wrapperItems(value).length === 0);
    if (empty) {
        if (!param.optional) {
            throw new ParameterValueError("specify a dataset of the required format / build for parameter", param.name);
        }
        return null;
    }
    let batch = false;
    if (isDict(value) && "values" in value) {
        batch = Boolean(value.batch);
        const items = wrapperItems(value);
        value = param.multiple ? items : items[0];
    }
    const resolved: HistoryItem[] = [];
    if (Array.isArray(value)) {
        const sources = new Set<string>();
        for (const item of value) {
            if (item === null || item === undefined || item === "None" || item === "") {
                continue;
            }
            const found = resolveReference(rc, item, param.name);
            sources.add(found.src);
            resolved.push(found);
            if (sources.size > 1 && sources.has("hdca")) {
                throw new ParameterValueError(
                    "if collections are supplied to multiple data input parameter, only collections may be used",
                    param.name,
                );
            }
        }
    } else {
        resolved.push(resolveReference(rc, value, param.name));
    }
    for (const item of resolved) {
        if (isDatasetItem(item)) {
            if (item.deleted) {
                throw new ParameterValueError("the previously selected dataset has been deleted.", param.name, item);
            }
            if (item.state === "error" || item.state === "discarded") {
                throw new ParameterValueError(
                    "the previously selected dataset has entered an unusable state",
                    param.name,
                );
            }
        } else {
            if (item.deleted) {
                throw new ParameterValueError(
                    "the previously selected dataset collection has been deleted.",
                    param.name,
                    item,
                );
            }
            if (elementsDeleted(item.collection)) {
                throw new ParameterValueError(
                    "the previously selected dataset collection has elements that are deleted.",
                    param.name,
                );
            }
        }
    }
    if (param.multiple) {
        return resolved;
    }
    if (resolved.length > 1) {
        throw new ParameterValueError("more than one dataset supplied to single input dataset parameter", param.name);
    }
    const single = resolved[0];
    if (!single) {
        throw new ParameterValueError("invalid dataset supplied to single input dataset parameter", param.name);
    }
    if (isCollectionItem(single) && !batch) {
        throw new ParameterValueError(
            "dataset collection supplied to single input dataset parameter; to run the tool over each element of the collection, use the map-over option",
            param.name,
        );
    }
    return single;
}

function collectionFromJson(param: BundleParameter, input: unknown, rc: RequestContext): unknown {
    let value = input;
    if (!pyTruthyScalar(value) || (Array.isArray(value) && value.length === 0)) {
        if (!param.optional) {
            throw new ParameterValueError("specify a dataset collection of the correct type", param.name);
        }
        return null;
    }
    if (value === "None") {
        return null;
    }
    if (isDict(value) && "values" in value) {
        value = wrapperItems(value)[0];
    } else if (Array.isArray(value)) {
        value = value[0];
    }
    if (value === null || value === undefined) {
        return null;
    }
    const item = resolveReference(rc, value, param.name);
    if (!isCollectionItem(item)) {
        throw new InputError("Expected to find collection, but got single dataset wrapper");
    }
    if (item.deleted) {
        throw new ParameterValueError("the previously selected dataset collection has been deleted", param.name, item);
    }
    if (elementsDeleted(item.collection)) {
        throw new ParameterValueError(
            "the previously selected dataset collection has elements that are deleted.",
            param.name,
        );
    }
    return item;
}

/** `from_json`: converts a submitted value to the parameter's value. Throws {@link ParameterValueError}s. */
export function fromJson(param: BundleParameter, value: unknown, rc: RequestContext, context: StateContext): unknown {
    switch (param.type) {
        case "integer":
            return integerFromJson(param, value);
        case "float":
            return floatFromJson(param, value);
        case "boolean":
            return booleanValue(param, value);
        case "baseurl":
            return baseUrl(param, rc);
        case "ftpfile":
            return ftpFromJson(param, value);
        case "select":
        case "genomebuild":
            return selectFromJson(param, value, rc, context, true);
        case "data_column":
            return columnFromJson(param, value, rc, context);
        case "group_tag":
            return groupTagFromJson(param, value, rc, context);
        case "drill_down":
            return drillDownFromJson(param, value);
        case "data":
            return dataFromJson(param, value, rc);
        case "data_collection":
            return collectionFromJson(param, value, rc);
        default:
            return value;
    }
}

/** `check_param`: converts and validates a submitted value; the error is returned, not thrown. */
export function checkParam(
    param: BundleParameter,
    value: unknown,
    rc: RequestContext,
    context: StateContext,
): { value: unknown; error: Error | null } {
    try {
        const converted = fromJson(param, value, rc, context);
        validateValue(param, converted);
        return { value: converted, error: null };
    } catch (error) {
        if (error instanceof ParameterValueError || error instanceof InputError) {
            return { value, error };
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Stored forms

function itemReference(item: unknown): unknown {
    if (isHistoryItem(item)) {
        return { id: item.id, src: item.src };
    }
    if (isDict(item) && typeof item.src === "string" && "id" in item) {
        return item;
    }
    return null;
}

/** `value_to_basic`: the JSON form of a value in tool states and form models. */
export function valueToBasic(param: BundleParameter, value: unknown): unknown {
    switch (param.type) {
        case "boolean":
            return booleanValue(param, value);
        case "integer":
            return param.multiple && Array.isArray(value) ? value : unicodify(value);
        case "float":
            return typeof value === "number" ? pyFloatRepr(value) : unicodify(value);
        case "select":
        case "genomebuild":
        case "group_tag":
        case "drill_down":
        case "rules":
            return value ?? null;
        case "data_column":
            return typeof value === "string" ? value.trim() : (value ?? null);
        case "ftpfile":
            return value ?? null;
        case "file":
            return value === "" || value === undefined ? null : value;
        case "data":
        case "data_collection":
        case "hidden_data": {
            if (value === null || value === undefined || value === "" || value === "None") {
                return null;
            }
            const items = Array.isArray(value) ? value : [value];
            if (items.length === 0) {
                return null;
            }
            return { values: items.map(itemReference) };
        }
        default:
            return unicodify(value);
    }
}

/** The data value of a job parameter: an item reference, a list of them, or null. */
export function dataJobValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(itemReference);
    }
    return value === null || value === undefined || value === "" ? null : itemReference(value);
}

/** `value_from_basic` / `to_python` for stored values; data references resolve through `rc`. */
export function valueFromBasic(param: BundleParameter, value: unknown, rc: RequestContext): unknown {
    switch (param.type) {
        case "integer": {
            if (param.multiple && Array.isArray(value)) {
                return value.map((item) => pyInt(item) ?? item);
            }
            const parsed = pyInt(value);
            return parsed ?? (pyTruthyScalar(value) ? value : null);
        }
        case "float": {
            const parsed = pyFloat(value);
            return parsed ?? (pyTruthyScalar(value) ? value : null);
        }
        case "boolean":
            return booleanValue(param, value);
        case "data":
        case "data_collection":
        case "hidden_data": {
            const refs = isDict(value) && "values" in value ? wrapperItems(value) : value;
            if (refs === null || refs === undefined || refs === "" || refs === "None") {
                return null;
            }
            const resolve = (ref: unknown) => {
                try {
                    return resolveReference(rc, ref, param.name);
                } catch {
                    return ref;
                }
            };
            if (Array.isArray(refs)) {
                const items = refs.map(resolve);
                if (param.multiple) {
                    return items.length === 1 && isCollectionItem(items[0]) ? items[0] : items;
                }
                return items[0] ?? null;
            }
            return resolve(refs);
        }
        default:
            return value;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Display

/** `to_text`: the value as the job parameters page shows it. */
export function toText(param: BundleParameter, value: unknown): string {
    if (param.type === "data") {
        const items = value ? (Array.isArray(value) ? value : [value]) : [];
        if (items.length && items.every(isDatasetItem)) {
            return (items as DatasetItem[]).map((item) => `${item.hid}: ${item.name}`).join(", ");
        }
        return "No dataset.";
    }
    if (param.type === "data_collection") {
        return isCollectionItem(value) ? `${value.hid}: ${value.name}` : "No dataset collection.";
    }
    if (isSelectLike(param)) {
        const values = Array.isArray(value) ? value : [value];
        let out: string[];
        if (param.is_dynamic) {
            out = values.map((item) => pyStr(item));
        } else {
            const wanted = new Set(values.map((item) => pyStr(item)));
            out = (param.static_options ?? [])
                .filter(([, optionValue]) => wanted.has(optionValue ?? ""))
                .map(([name]) => name ?? "");
        }
        return out.length ? out.join("\n") : "Nothing selected.";
    }
    if (param.type === "drill_down") {
        const values = !value ? [] : Array.isArray(value) ? value : [value];
        const names: string[] = [];
        const find = (nodes: ReturnType<typeof drillDownOptions>, wanted: string): string | null => {
            for (const node of nodes) {
                if (node.value === wanted) {
                    return node.name;
                }
                const nested = find(node.options ?? [], wanted);
                if (nested !== null) {
                    return nested;
                }
            }
            return null;
        };
        for (const item of values) {
            names.push(find(drillDownOptions(param), pyStr(item)) ?? pyStr(item));
        }
        return names.length ? names.join("\n") : "Nothing selected.";
    }
    if (value === null || value === undefined) {
        return "Not available.";
    }
    const text = pyStr(value);
    return text ? text : "Empty.";
}

/** `to_param_dict_string`: what Cheetah prints for the value, or undefined when it is a file path. */
export function paramDictString(param: BundleParameter, value: unknown, rc: RequestContext): string | undefined {
    switch (param.type) {
        case "boolean":
            return booleanValue(param, value) ? (param.truevalue ?? "true") : (param.falsevalue ?? "false");
        case "data":
        case "data_collection":
        case "hidden_data":
        case "file":
        case "ftpfile":
            return undefined;
        case "select":
        case "genomebuild":
        case "group_tag":
        case "data_column":
        case "drill_down": {
            if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
                return "None";
            }
            if (param.type === "drill_down" && param.hierarchy === "recurse") {
                return undefined;
            }
            if (Array.isArray(value)) {
                return sanitize(
                    param,
                    rc,
                    value.map((item) => pyStr(item)),
                ).join(param.separator ?? ",");
            }
            return sanitize(param, rc, pyStr(value));
        }
        case "color":
            return param.rgb ? undefined : pyStr(value);
        case "float":
            return value === null || value === undefined
                ? ""
                : typeof value === "number"
                  ? pyFloatRepr(value)
                  : pyStr(value);
        default:
            return sanitize(param, rc, value === null || value === undefined ? "" : pyStr(value));
    }
}
