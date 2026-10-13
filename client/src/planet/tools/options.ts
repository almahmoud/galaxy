/**
 * Options of select-like parameters (`get_options` of Galaxy's select, genome build, group tag, data column and drill
 * down parameters, and `DynamicOptions` with its filters) and the history items data parameters accept
 * (`DatasetMatcher` and the collection matchers).
 *
 * Planet has no installed reference data, so options from data tables start empty, as they do in a Galaxy whose
 * `.loc` files are empty. Options read from files, datasets or URLs and Python `dynamic_options` start empty too.
 */

import type { BundleDynamicOptions, BundleOptionsFilter, BundleParameter, DrillDownOption } from "./bundle";
import { InputError, isDict, type RequestContext, type StateContext } from "./context";
import { isValidInputState, matchesFormats } from "./datatypes";
import {
    type CollectionContent,
    collectionDatasets,
    type CollectionItem,
    type DatasetItem,
    isCollectionItem,
    isDatasetItem,
} from "./history";
import { pyStr, stringAsBool } from "./python";
import { compiledPattern, pythonMatch } from "./regex";

/** Galaxy's `ParameterOption`. */
export interface ParameterOption {
    name: string;
    value: string;
    selected: boolean;
}

/** `Registry.upload_file_formats`, the only `from_parameter` source Planet resolves. */
const UPLOAD_FORMATS_PARAMETER = "tool.app.datatypes_registry.upload_file_formats";
/** The `transform_lines` Galaxy's upload tool applies to it: each format becomes `format<separator>format`. */
const UPLOAD_FORMATS_TRANSFORM = '[ "%s%s%s" % ( line, self.separator, line ) for line in obj ]';

/** A row of option fields: strings from a source, or options a filter built. */
type Row = unknown[];

/** The value of a dataset's metadata element; `dbkey` falls back to the HDA's own. */
export function metadataValue(item: DatasetItem, key: string): unknown {
    if (Object.hasOwn(item.metadata, key)) {
        return item.metadata[key];
    }
    return key === "dbkey" ? item.dbkey : undefined;
}

/** `DatasetCollection.dataset_instances` of an HDCA. */
export function hdcaDatasets(item: CollectionItem): DatasetItem[] {
    return collectionDatasets(item.collection);
}

/** True when any dataset of a collection is deleted (`DatasetCollection.elements_deleted`). */
export function elementsDeleted(collection: CollectionContent): boolean {
    return collectionDatasets(collection).some((dataset) => dataset.deleted);
}

// ---------------------------------------------------------------------------------------------------------
// Dynamic options

/** `DynamicOptions.column_spec_to_index`, or undefined for specs Galaxy could not resolve. */
function columnIndex(columns: Readonly<Record<string, number>>, spec: unknown): number | undefined {
    const text = pyStr(spec);
    if (Object.hasOwn(columns, text)) {
        return columns[text];
    }
    return /^\d+$/.test(text) ? Number(text) : undefined;
}

function field(row: Row, index: number | undefined): string | undefined {
    if (index === undefined) {
        return undefined;
    }
    const value = Array.isArray(row) ? row[index] : undefined;
    return value === undefined || value === null ? undefined : String(value);
}

function attributeString(filter: BundleOptionsFilter, name: string): string | undefined {
    const value = filter[name];
    return typeof value === "string" ? value : undefined;
}

/** `_get_ref_data`: the datasets a reference names; throws when Galaxy would not filter. */
function refDatasets(context: StateContext, refName: string): DatasetItem[] {
    if (!context.has(refName)) {
        throw new InputError(`unknown reference ${refName}`);
    }
    const ref = context.get(refName);
    const unwrap = (item: unknown): DatasetItem[] => {
        if (isDatasetItem(item)) {
            return [item];
        }
        if (isCollectionItem(item)) {
            return hdcaDatasets(item);
        }
        throw new InputError(`${refName} is not a dataset`);
    };
    if (Array.isArray(ref)) {
        return ref.filter((item) => item !== null && item !== undefined).flatMap(unwrap);
    }
    return unwrap(ref);
}

/** A dataset attribute by name, for `param_value` filters with `ref_attribute`. */
function datasetAttribute(item: DatasetItem, name: string): unknown {
    switch (name) {
        case "ext":
        case "extension":
            return item.extension;
        case "dbkey":
            return item.dbkey;
        case "name":
            return item.name;
        case "hid":
            return item.hid;
        default:
            return undefined;
    }
}

interface OptionsState {
    columns: Record<string, number>;
    largestIndex: number;
}

function applyFilter(
    filter: BundleOptionsFilter,
    rows: Row[],
    state: OptionsState,
    context: StateContext,
    tableNames: ReadonlySet<string>,
): Row[] {
    const column = () => columnIndex(state.columns, filter.column);
    const keep = stringAsBool(attributeString(filter, "keep") ?? "True");
    switch (filter.type) {
        case "static_value": {
            const value = attributeString(filter, "value");
            const index = column();
            return index === undefined ? rows : rows.filter((row) => keep === (value === field(row, index)));
        }
        case "regexp": {
            const index = column();
            const pattern = compiledPattern(attributeString(filter, "value") ?? "");
            // Rows the pattern cannot decide are left out: no option the tool may refuse is offered.
            return index === undefined
                ? rows
                : rows.filter((row) => {
                      const matched = pythonMatch(pattern, field(row, index) ?? "");
                      return matched !== undefined && keep === matched;
                  });
        }
        case "data_meta": {
            const refName = attributeString(filter, "ref") ?? "";
            const key = attributeString(filter, "key") ?? "";
            const multiple = stringAsBool(attributeString(filter, "multiple") ?? "False");
            const separator = attributeString(filter, "separator") ?? ",";
            let datasets: DatasetItem[];
            try {
                datasets = refDatasets(context, refName);
            } catch {
                return [...rows];
            }
            const metaValues = new Set<string>();
            for (const dataset of datasets) {
                const value = metadataValue(dataset, key);
                if (value === undefined || value === null) {
                    continue;
                }
                if (Array.isArray(value)) {
                    value.forEach((item) => metaValues.add(pyStr(item)));
                } else if (isDict(value)) {
                    Object.entries(value).forEach(([k, v]) => metaValues.add(`${k},${pyStr(v)}`));
                } else {
                    metaValues.add(pyStr(value));
                }
            }
            if (metaValues.size === 0) {
                return [...rows];
            }
            if (filter.column !== undefined && filter.column !== null) {
                const index = column();
                if (index === undefined) {
                    return rows;
                }
                return rows.filter((row) => {
                    const value = field(row, index) ?? "";
                    if (multiple) {
                        const parts = value.split(separator);
                        return [...metaValues].every((meta) => parts.includes(meta));
                    }
                    return metaValues.has(value);
                });
            }
            if (Object.keys(state.columns).length === 0) {
                state.columns = { name: 0, value: 1, selected: 2 };
                state.largestIndex = 2;
            }
            return [...rows, ...[...metaValues].map((value) => [value, value, false])];
        }
        case "param_value": {
            const index = column();
            let ref = context.get(attributeString(filter, "ref") ?? "");
            const chain = (attributeString(filter, "ref_attribute") ?? "").split(".").filter(Boolean);
            if (ref === null || ref === undefined) {
                ref = [];
            } else if (isCollectionItem(ref)) {
                ref = hdcaDatasets(ref);
            } else if (!Array.isArray(ref)) {
                ref = [ref];
            }
            const values = (ref as unknown[]).map((item) => {
                let current = item;
                for (const name of chain) {
                    if (!isDatasetItem(current)) {
                        break;
                    }
                    current = datasetAttribute(current, name);
                }
                return pyStr(current);
            });
            return index === undefined ? rows : rows.filter((row) => keep === values.includes(field(row, index)!));
        }
        case "unique_value": {
            const index = column();
            const seen = new Set<string | undefined>();
            return rows.filter((row) => {
                const value = field(row, index);
                if (seen.has(value)) {
                    return false;
                }
                seen.add(value);
                return true;
            });
        }
        case "multiple_splitter": {
            const separator = attributeString(filter, "separator") ?? ",";
            const indexes = pyStr(filter.column)
                .split(",")
                .map((spec) => columnIndex(state.columns, spec));
            const out: Row[] = [];
            for (const row of rows) {
                for (const index of indexes) {
                    const value = index === undefined ? undefined : row[index];
                    if (typeof value === "string") {
                        for (const part of value.split(separator)) {
                            out.push([...row.slice(0, index), part, ...row.slice(index! + 1)]);
                        }
                    }
                }
            }
            return out;
        }
        case "attribute_value_splitter": {
            const pairSeparator = attributeString(filter, "pair_separator") ?? ",";
            const nameValueSeparator = attributeString(filter, "name_val_separator");
            const indexes = pyStr(filter.column)
                .split(",")
                .map((spec) => columnIndex(state.columns, spec));
            const names = new Set<string>();
            const out: Row[] = [];
            for (const row of rows) {
                for (const index of indexes) {
                    for (const pair of (field(row, index) ?? "").split(pairSeparator)) {
                        const parts =
                            nameValueSeparator === undefined
                                ? pair.trim().split(/\s+/)
                                : pair.split(nameValueSeparator);
                        if (parts.length === 2 && !names.has(parts[0]!)) {
                            out.push([...row.slice(0, index), parts[0], ...row.slice(index)]);
                            names.add(parts[0]!);
                        }
                    }
                }
            }
            return out;
        }
        case "add_value": {
            const value = attributeString(filter, "value") ?? "";
            const name = attributeString(filter, "name") ?? value;
            const row: unknown[] = Array.from({ length: state.largestIndex + 1 }, () => "");
            const valueColumn = state.columns.value ?? 0;
            const nameColumn = state.columns.name ?? valueColumn;
            row[nameColumn] = name;
            row[valueColumn] = value;
            const out = [...rows];
            const index = attributeString(filter, "index");
            if (index !== undefined && /^-?\d+$/.test(index)) {
                const position = Number(index);
                out.splice(position < 0 ? Math.max(0, out.length + position) : position, 0, row);
            } else {
                out.push(row);
            }
            return out;
        }
        case "remove_value": {
            const multiple = stringAsBool(attributeString(filter, "multiple") ?? "False");
            const separator = attributeString(filter, "separator") ?? ",";
            let value: unknown = attributeString(filter, "value");
            if (value === undefined) {
                const ref = attributeString(filter, "ref");
                if (ref !== undefined) {
                    value = context.get(ref);
                } else {
                    let dataset = context.get(attributeString(filter, "meta_ref") ?? "");
                    if (isCollectionItem(dataset)) {
                        dataset = hdcaDatasets(dataset)[0];
                    }
                    if (!isDatasetItem(dataset)) {
                        return rows;
                    }
                    value = metadataValue(dataset, attributeString(filter, "key") ?? "") ?? null;
                }
            }
            const valueColumn = state.columns.value ?? 1;
            const matches = (option: string): boolean => {
                if (Array.isArray(value)) {
                    if (multiple) {
                        const parts = option.split(separator);
                        return value.every((item) => parts.includes(pyStr(item)));
                    }
                    return value.map(pyStr).includes(option);
                }
                if (multiple) {
                    return option.split(separator).includes(pyStr(value));
                }
                return option === value;
            };
            return rows.filter((row) => !matches(field(row, valueColumn) ?? ""));
        }
        case "sort_by": {
            const index = column();
            if (index === undefined) {
                return rows;
            }
            const reverse = stringAsBool(attributeString(filter, "reverse_sort_order") ?? "False");
            const sorted = [...rows].sort((a, b) => {
                const left = field(a, index) ?? "";
                const right = field(b, index) ?? "";
                return left < right ? -1 : left > right ? 1 : 0;
            });
            return reverse ? sorted.reverse() : sorted;
        }
        case "data_table": {
            const index = column();
            const table = attributeString(filter, "table_name") ?? "";
            if (!tableNames.has(table) || index === undefined) {
                return rows;
            }
            // Planet's data tables have no entries.
            return rows.filter(() => !keep);
        }
        default:
            return rows;
    }
}

/** The rows of the options' source, or null when the options have no source (`DynamicOptions.get_fields`). */
function sourceRows(options: BundleDynamicOptions, rc: RequestContext, state: OptionsState): Row[] | null {
    if (options.from_data_table) {
        const table = (rc.tool.data_tables ?? []).find((candidate) => candidate.name === options.from_data_table);
        if (!table) {
            return null;
        }
        if (Object.keys(state.columns).length === 0) {
            table.columns.forEach((name, index) => {
                state.columns[name] = index;
            });
            state.largestIndex = Math.max(0, table.columns.length - 1);
        }
        return [];
    }
    if (options.from_parameter) {
        const transform = (options.transform_lines ?? "").replace(/\s+/g, "");
        if (
            options.from_parameter === UPLOAD_FORMATS_PARAMETER &&
            (!options.transform_lines || transform === UPLOAD_FORMATS_TRANSFORM.replace(/\s+/g, ""))
        ) {
            return rc.uploadFormats.map((format) => (options.transform_lines ? [format, format] : [format]));
        }
        return [];
    }
    if (options.from_dataset || options.from_file) {
        return [];
    }
    return null;
}

/** `DynamicOptions.get_options`. */
export function dynamicOptions(
    options: BundleDynamicOptions,
    rc: RequestContext,
    context: StateContext,
): ParameterOption[] {
    const columns: Record<string, number> = Object.assign(
        Object.create(null) as Record<string, number>,
        options.columns ?? {},
    );
    const state: OptionsState = {
        columns,
        largestIndex: Math.max(0, ...Object.values(columns)),
    };
    if (Object.keys(columns).length && !Object.hasOwn(columns, "name") && Object.hasOwn(columns, "value")) {
        state.columns.name = columns.value!;
    }
    const tableNames = new Set((rc.tool.data_tables ?? []).map((table) => table.name));
    const rows = sourceRows(options, rc, state);
    let current: Row[] = rows ?? [];
    for (const filter of options.filters ?? []) {
        current = applyFilter(filter, current, state, context, tableNames);
    }
    if (rows !== null) {
        const valueColumn = state.columns.value;
        const nameColumn = state.columns.name ?? valueColumn;
        if (valueColumn === undefined) {
            return [];
        }
        return current
            .filter((row) => field(row, valueColumn) !== undefined)
            .map((row) => ({
                name: field(row, nameColumn) ?? field(row, valueColumn)!,
                value: field(row, valueColumn)!,
                selected: false,
            }));
    }
    return current.map((row) =>
        row.length === 1
            ? { name: pyStr(row[0]), value: pyStr(row[0]), selected: false }
            : { name: pyStr(row[0]), value: pyStr(row[1]), selected: Boolean(row[2]) },
    );
}

// ---------------------------------------------------------------------------------------------------------
// Select-like parameters

function isDynamicOptions(options: BundleParameter["options"]): options is BundleDynamicOptions {
    return isDict(options) && Array.isArray((options as { filters?: unknown }).filters);
}

/** `ColumnListParameter.get_column_list`: column numbers of the referenced datasets, or [] when unknown. */
export function columnList(param: BundleParameter, context: StateContext): string[] {
    const ref = param.data_ref ? context.get(param.data_ref) : undefined;
    if (!ref || (Array.isArray(ref) && ref.length === 0)) {
        return [];
    }
    let columns: string[] | null = null;
    for (let dataset of Array.isArray(ref) ? ref : [ref]) {
        if (isCollectionItem(dataset)) {
            dataset = hdcaDatasets(dataset)[0];
        }
        if (!isDatasetItem(dataset)) {
            return [];
        }
        const count = metadataValue(dataset, "columns");
        if (typeof count !== "number" || count <= 0) {
            return [];
        }
        let own: string[];
        if (param.numerical) {
            const types = metadataValue(dataset, "column_types");
            own = (Array.isArray(types) ? types : [])
                .map((type, index) => (type === "int" || type === "float" ? String(index + 1) : null))
                .filter((value): value is string => value !== null);
        } else {
            own = Array.from({ length: count }, (_, index) => String(index + 1));
        }
        columns = columns === null ? own : columns.filter((column) => own.includes(column));
    }
    return columns ?? [];
}

function columnOptions(param: BundleParameter, context: StateContext): ParameterOption[] {
    const columns = columnList(param, context);
    if (columns.length === 0) {
        return [];
    }
    if (param.usecolnames) {
        let dataset = param.data_ref ? context.get(param.data_ref) : undefined;
        if (isCollectionItem(dataset)) {
            dataset = hdcaDatasets(dataset)[0];
        }
        const names = isDatasetItem(dataset) ? metadataValue(dataset, "column_names") : undefined;
        if (Array.isArray(names) && columns.every((column) => Number(column) - 1 < names.length)) {
            return columns.map((column) => ({
                name: `c${column}: ${pyStr(names[Number(column) - 1])}`,
                value: column,
                selected: false,
            }));
        }
    }
    return columns.map((column) => ({ name: `Column: ${column}`, value: column, selected: false }));
}

function groupTagOptions(param: BundleParameter, context: StateContext): ParameterOption[] {
    const ref = param.data_ref ? context.get(param.data_ref) : undefined;
    if (!ref) {
        return [];
    }
    const tags = new Set<string>();
    for (const item of Array.isArray(ref) ? ref : [ref]) {
        const datasets = isCollectionItem(item) ? hdcaDatasets(item) : isDatasetItem(item) ? [item] : [];
        for (const dataset of datasets) {
            for (const tag of dataset.tags) {
                if (tag.startsWith("group:")) {
                    tags.add(tag.slice("group:".length));
                }
            }
        }
    }
    return [...tags].map((tag) => ({ name: `Tags: ${tag}`, value: tag, selected: false }));
}

/** `get_options` of select, genome build, group tag and data column parameters. */
export function selectOptions(param: BundleParameter, rc: RequestContext, context: StateContext): ParameterOption[] {
    switch (param.type) {
        case "genomebuild": {
            const current = rc.snapshot.history?.genome_build;
            return rc.genomes.map(([name = "", dbkey = ""]) => ({ name, value: dbkey, selected: dbkey === current }));
        }
        case "data_column":
            return columnOptions(param, context);
        case "group_tag":
            return groupTagOptions(param, context);
    }
    if (isDynamicOptions(param.options)) {
        return dynamicOptions(param.options, rc, context);
    }
    if (param.dynamic_options) {
        return [];
    }
    return (param.static_options ?? []).map(([name, value, selected]) => ({
        name: name ?? "",
        value: value ?? "",
        selected: Boolean(selected),
    }));
}

/** The static option tree of a drill down parameter. */
export function drillDownOptions(param: BundleParameter): DrillDownOption[] {
    return Array.isArray(param.options) ? param.options : [];
}

// ---------------------------------------------------------------------------------------------------------
// Data parameters

/** `DatasetMatcher.filter_values`: option names of a data parameter's `<options>`, or null without options. */
export function dataFilterValues(
    param: BundleParameter,
    rc: RequestContext,
    context: StateContext,
): Set<string> | null {
    if (!isDynamicOptions(param.options)) {
        return null;
    }
    if (!context.truthy) {
        return new Set();
    }
    return new Set(dynamicOptions(param.options, rc, context).map((option) => option.name));
}

/** `get_options_filter_attribute`: the dataset attribute compared with the filter values (dbkey by default). */
function filterAttribute(param: BundleParameter, item: DatasetItem): string {
    const attribute = (param.options_filter_attribute ?? "").replace(/\(\)$/, "");
    if (!attribute) {
        return item.dbkey;
    }
    const [first, ...rest] = attribute.split(".");
    if (first === "metadata" && rest.length === 1) {
        return pyStr(metadataValue(item, rest[0]!));
    }
    return pyStr(datasetAttribute(item, attribute));
}

/** The formats a data parameter accepts (`format` defaults to `data`). */
export function parameterFormats(param: BundleParameter): string[] {
    return param.extensions && param.extensions.length ? param.extensions : ["data"];
}

/** `DatasetMatcher.hda_match`. */
export function hdaMatch(
    param: BundleParameter,
    rc: RequestContext,
    item: DatasetItem,
    filterValues: Set<string> | null,
    ensureVisible = true,
): boolean {
    if (!isValidInputState(item.state) || (ensureVisible && !item.visible)) {
        return false;
    }
    if (!matchesFormats(rc.datatypes, item.extension, parameterFormats(param))) {
        return false;
    }
    return filterValues === null || filterValues.has(filterAttribute(param, item));
}

/** The dataset collection matchers: populated, with every dataset in a valid state and of an accepted format. */
export function collectionMatch(
    param: BundleParameter,
    rc: RequestContext,
    collection: CollectionContent,
    filterValues: Set<string> | null,
): boolean {
    if (!collection.populated) {
        return false;
    }
    return collectionDatasets(collection).every((dataset) => hdaMatch(param, rc, dataset, filterValues, false));
}

/** True when `tag` (a `name:value` string) is on `tags`, with `#value` read as `name:value`. */
export function hasTag(tags: readonly string[], tag: string): boolean {
    const normalize = (value: string) => (value.startsWith("#") ? `name:${value.slice(1)}` : value);
    const wanted = normalize(tag);
    return tags.some((candidate) => normalize(candidate) === wanted);
}
