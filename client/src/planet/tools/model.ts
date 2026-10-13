/**
 * The tool form model (`populate_model` and the parameters' `to_dict`): the input tree Galaxy's `FormDisplay` renders,
 * with options, current and default values, and the data options of the current history in Galaxy's paginated shape.
 */

import type { BundleConditional, BundleInput, BundleParameter, BundleRepeat, BundleSection } from "./bundle";
import { isParameter, isRepeat, isSection, isUploadDataset } from "./bundle";
import { emptyDict, isDict, own, type RequestContext, StateContext, type StateDict } from "./context";
import { directMatch, mapOverType, orderedCollectionTypes } from "./datatypes";
import { type CollectionItem, type DatasetItem, isCollectionItem, isDatasetItem } from "./history";
import { collectionMatch, dataFilterValues, drillDownOptions, hasTag, hdaMatch, selectOptions } from "./options";
import {
    initialValue,
    isRuntimeContext,
    matchingCollections,
    matchingDatasets,
    toText,
    valueToBasic,
} from "./parameters";
import { conditionalCases, testParameter } from "./state";

/** `DEFAULT_OPTIONS_PAGE_SIZE` and `MAX_OPTIONS_PAGE_SIZE`. */
export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** Pagination of one parameter's data options by source (`hda`, `hdca`): offset, limit and search text. */
export type ParameterPagination = Readonly<Record<string, unknown>>;
/** Pagination by full parameter name (`cond|input1`). */
export type OptionsPagination = Readonly<Record<string, ParameterPagination>>;

type Model = Record<string, unknown>;

interface Page {
    offset: number;
    limit: number;
    search: string | null;
}

/** `normalize_pagination`. */
function page(pagination: ParameterPagination | undefined, src: string): Page {
    const spec = isDict(pagination?.[src]) ? (pagination[src] as Record<string, unknown>) : {};
    const offset = Number.parseInt(String(spec.offset ?? 0), 10);
    const limit = Number.parseInt(String(spec.limit ?? DEFAULT_PAGE_SIZE), 10);
    const search = typeof spec.search === "string" && spec.search.trim() ? spec.search.trim() : null;
    return {
        offset: Number.isNaN(offset) ? 0 : Math.max(offset, 0),
        limit: Number.isNaN(limit) ? DEFAULT_PAGE_SIZE : Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
        search,
    };
}

/** `search` of the paginated history queries: the name contains it, or a numeric search equals the hid. */
function matchesSearch(item: { name: string; hid: number }, search: string | null): boolean {
    if (!search) {
        return true;
    }
    return (
        item.name.toLowerCase().includes(search.toLowerCase()) || (/^\d+$/.test(search) && item.hid === Number(search))
    );
}

function hdaEntry(item: DatasetItem, name: string, keep: boolean): Model {
    return { id: item.id, hid: item.hid, name, tags: [...item.tags], src: "hda", keep };
}

function hdcaEntry(
    item: CollectionItem,
    name: string,
    options: { keep?: boolean; mapOverType?: string | null; columnDefinitions?: boolean } = {},
): Model {
    const entry: Model = { id: item.id, hid: item.hid, name, src: "hdca", tags: [...item.tags] };
    if (options.keep !== undefined) {
        entry.keep = options.keep;
    }
    if (options.mapOverType) {
        entry.map_over_type = options.mapOverType;
    }
    if (options.columnDefinitions) {
        entry.column_definitions = item.collection.columnDefinitions;
    }
    return entry;
}

/** `_carried_state_label`. */
function carriedLabel(item: { deleted: boolean; visible: boolean }): string {
    if (item.deleted) {
        return "deleted";
    }
    return item.visible ? "not in current history" : "hidden";
}

function byHidDescending(entries: Model[]): Model[] {
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => Number(b.entry.hid ?? -1) - Number(a.entry.hid ?? -1) || a.index - b.index)
        .map(({ entry }) => entry);
}

function pageOf<T>(items: readonly T[], spec: Page): { items: T[]; meta: Model } {
    const slice = items.slice(spec.offset, spec.offset + spec.limit);
    return {
        items: slice,
        meta: {
            offset: spec.offset,
            limit: spec.limit,
            total_estimate: items.length,
            has_more: spec.offset + slice.length < items.length,
        },
    };
}

/** `DataToolParameter.to_dict`: options, pinned selections and pagination metadata. */
function dataOptionsModel(
    param: BundleParameter,
    rc: RequestContext,
    context: StateContext,
    pagination: ParameterPagination | undefined,
): Model {
    const options: Record<string, Model[]> = { dce: [], ldda: [], hda: [], hdca: [] };
    const pinned: Record<string, Model[]> = { dce: [], ldda: [], hda: [], hdca: [] };
    const meta: Model = {};
    const history = rc.snapshot.history;
    if (!history) {
        return { options, pinned, options_meta: meta };
    }
    const hdaPage = page(pagination, "hda");
    const datasets = pageOf(
        matchingDatasets(param, rc, context).filter((item) => matchesSearch(item, hdaPage.search)),
        hdaPage,
    );
    meta.hda = datasets.meta;
    const current = context.get(param.name);
    let selected = (Array.isArray(current) ? current : current ? [current] : []).filter(
        (item) => isDatasetItem(item) || isCollectionItem(item),
    ) as (DatasetItem | CollectionItem)[];
    for (const item of datasets.items) {
        selected = selected.filter(
            (candidate) => candidate !== item && !(candidate.src === "hda" && candidate.id === item.id),
        );
        options.hda!.push(hdaEntry(item, item.name, false));
    }
    const filterValues = dataFilterValues(param, rc, context);
    for (const item of selected) {
        if (isDatasetItem(item)) {
            if (
                item.historyId === history.id &&
                !item.deleted &&
                item.visible &&
                hdaMatch(param, rc, item, filterValues)
            ) {
                pinned.hda!.push(hdaEntry(item, item.name, true));
            } else {
                options.hda!.push(hdaEntry(item, `(${carriedLabel(item)}) ${item.name}`, true));
            }
        } else if (item.deleted || !item.visible || item.historyId !== history.id) {
            options.hdca!.push(hdcaEntry(item, `(${carriedLabel(item)}) ${item.name}`, { keep: true }));
        }
    }
    const hdcaPage = page(pagination, "hdca");
    const candidates: { item: CollectionItem; mapOver: string | null }[] = [];
    for (const item of matchingCollections(param, rc, context)) {
        if (!matchesSearch(item, hdcaPage.search)) {
            continue;
        }
        if (param.multiple && item.collection.collectionType !== "list") {
            const mapOver = mapOverType(["list"], item.collection.collectionType);
            if (mapOver) {
                candidates.push({ item, mapOver });
            }
        } else {
            candidates.push({ item, mapOver: null });
        }
    }
    const collections = pageOf(candidates, hdcaPage);
    meta.hdca = collections.meta;
    for (const { item, mapOver } of collections.items) {
        options.hdca!.push(hdcaEntry(item, item.name, { keep: false, mapOverType: mapOver }));
    }
    for (const src of ["hda", "hdca"]) {
        options[src] = byHidDescending(options[src]!);
        pinned[src] = byHidDescending(pinned[src]!);
    }
    return { options, pinned, options_meta: meta };
}

/** `DataCollectionToolParameter.to_dict`: matching collections, direct and mapped over. */
function collectionOptionsModel(
    param: BundleParameter,
    rc: RequestContext,
    context: StateContext,
    pagination: ParameterPagination | undefined,
): Model {
    const options: Record<string, Model[]> = { hda: [], hdca: [], dce: [] };
    const pinned: Record<string, Model[]> = { hda: [], hdca: [], dce: [] };
    const meta: Model = {};
    const history = rc.snapshot.history;
    if (!history) {
        return { options, pinned, options_meta: meta };
    }
    const accepted = orderedCollectionTypes(param.collection_types);
    const spec = page(pagination, "hdca");
    const filterValues = dataFilterValues(param, rc, context);
    const entries: Model[] = [];
    for (const item of rc.snapshot.activeVisibleCollections()) {
        if (
            !matchesSearch(item, spec.search) ||
            (param.tag && !hasTag(item.tags, param.tag)) ||
            !collectionMatch(param, rc, item.collection, filterValues)
        ) {
            continue;
        }
        const type = item.collection.collectionType;
        if (directMatch(accepted, type)) {
            entries.push(hdcaEntry(item, item.name, { columnDefinitions: true }));
        }
        let mapOver = mapOverType(accepted, type);
        if (mapOver) {
            if (mapOver === "paired_or_unpaired" && !type.endsWith("paired_or_unpaired")) {
                mapOver = type.endsWith("paired") ? "paired" : "single_datasets";
            }
            entries.push(hdcaEntry(item, item.name, { mapOverType: mapOver, columnDefinitions: true }));
        }
    }
    const paged = pageOf(entries, spec);
    meta.hdca = paged.meta;
    options.hdca!.push(...paged.items);
    const current = context.get(param.name);
    if (isCollectionItem(current) && (current.deleted || !current.visible || current.historyId !== history.id)) {
        options.hdca!.push(
            hdcaEntry(current, `(${carriedLabel(current)}) ${current.name}`, { keep: true, columnDefinitions: true }),
        );
    }
    options.hdca = byHidDescending(options.hdca!);
    return { options, pinned, options_meta: meta };
}

function serializeOptions(param: BundleParameter, rc: RequestContext, context: StateContext): unknown[] {
    return selectOptions(param, rc, context).map((option) => [option.name, option.value, option.selected]);
}

/** A parameter's `to_dict`, with `value` the initial value in `context`. */
export function parameterToDict(
    param: BundleParameter,
    rc: RequestContext,
    context: StateContext,
    pagination?: ParameterPagination,
): Model {
    const model: Model = {
        name: param.name,
        argument: param.argument,
        type: param.type,
        label: param.label ?? "",
        help: param.help ?? "",
        help_format: param.help_format ?? "html",
        refresh_on_change: param.refresh_on_change,
        model_class: param.model_class,
        optional: param.optional,
        hidden: param.hidden,
        is_dynamic: param.is_dynamic,
        value: valueToBasic(param, initialValue(param, rc, context)),
    };
    switch (param.type) {
        case "text":
        case "integer":
        case "float":
            if (param.type !== "text") {
                model.min = param.min ?? null;
                model.max = param.max ?? null;
            }
            model.area = param.area ?? false;
            model.datalist = param.datalist ?? [];
            model.multiple = param.multiple ?? false;
            break;
        case "boolean":
            model.truevalue = param.truevalue;
            model.falsevalue = param.falsevalue;
            break;
        case "ftpfile":
            model.multiple = param.multiple ?? true;
            break;
        case "select":
        case "group_tag":
        case "data_column":
            model.options = serializeOptions(param, rc, context);
            model.display = param.display ?? null;
            model.multiple = param.multiple ?? false;
            model.textable = isRuntimeContext(context);
            if (param.type !== "select") {
                model.data_ref = param.data_ref ?? null;
            }
            if (param.type === "data_column") {
                model.numerical = param.numerical ?? false;
            }
            break;
        case "genomebuild": {
            const options = selectOptions(param, rc, new StateContext(emptyDict()));
            const selected = options.filter((option) => option.selected).pop();
            model.options = options.map((option) => [option.name, option.value, option.selected]);
            model.value = selected?.value ?? options[0]?.value ?? null;
            model.display = param.display ?? null;
            model.multiple = param.multiple ?? false;
            break;
        }
        case "drill_down":
            model.options = drillDownOptions(param);
            model.display = param.display ?? null;
            model.multiple = param.multiple ?? false;
            break;
        case "data":
        case "hidden_data": {
            const extensions = param.extensions ?? ["data"];
            model.extensions = extensions;
            model.edam = {
                edam_formats: extensions.map((ext) => rc.edamFormats[ext] ?? null),
                edam_data: extensions.map((ext) => rc.edamData[ext] ?? null),
            };
            model.multiple = param.multiple ?? false;
            if (param.multiple) {
                model.min = param.min ?? null;
                model.max = param.max ?? null;
            }
            model.tag = param.tag ?? null;
            Object.assign(model, dataOptionsModel(param, rc, context, pagination));
            break;
        }
        case "data_collection":
            model.collection_types = param.collection_types ?? null;
            model.fields = param.fields ?? null;
            model.column_definitions = param.column_definitions ?? null;
            model.extensions = param.extensions ?? ["data"];
            model.multiple = false;
            model.tag = param.tag ?? null;
            Object.assign(model, collectionOptionsModel(param, rc, context, pagination));
            break;
    }
    return model;
}

/** A group's or parameter's `to_dict` without state, as Galaxy lists repeat templates and conditional cases. */
export function inputToDict(input: BundleInput, siblings: readonly BundleInput[], rc: RequestContext): Model {
    const context = new StateContext(emptyDict());
    if (isParameter(input)) {
        return parameterToDict(input, rc, context);
    }
    if (isRepeat(input)) {
        return repeatToDict(input, rc);
    }
    if (isSection(input)) {
        return { ...sectionToDict(input), inputs: input.inputs.map((nested) => inputToDict(nested, input.inputs, rc)) };
    }
    if (isUploadDataset(input)) {
        return { name: input.name, type: input.type };
    }
    return conditionalToDict(input, siblings, rc, null);
}

function repeatToDict(input: BundleRepeat, rc: RequestContext): Model {
    return {
        name: input.name,
        type: input.type,
        title: input.title || input.name,
        help: input.help,
        default: input.default,
        min: input.min,
        max: input.max,
        inputs: input.inputs.map((nested) => inputToDict(nested, input.inputs, rc)),
    };
}

function sectionToDict(input: BundleSection): Model {
    return { name: input.name, type: input.type, title: input.title, help: input.help, expanded: input.expanded };
}

function conditionalToDict(
    input: BundleConditional,
    siblings: readonly BundleInput[],
    rc: RequestContext,
    testValue: unknown,
): Model {
    const test = testParameter(input, siblings);
    const model: Model = { name: input.name, type: input.type };
    if (!test) {
        model.cases = [];
        return model;
    }
    model.cases = conditionalCases(input, test, testValue, rc).map((when) => ({
        value: when.value,
        inputs: when.inputs.map((nested) => inputToDict(nested, when.inputs, rc)),
    }));
    model.test_param = parameterToDict(test, rc, new StateContext(emptyDict()));
    return model;
}

/**
 * `populate_model`: the form inputs for a state level, with each parameter's current value (`value`), initial value
 * (`default_value`) and display text, and the inactive conditional cases filled with initial values.
 */
export function populateModel(
    inputs: readonly BundleInput[],
    state: StateDict,
    rc: RequestContext,
    parent: StateContext | null,
    pagination: Readonly<Record<string, ParameterPagination>> = {},
    namePrefix = "",
): Model[] {
    const context = new StateContext(state, parent);
    const out: Model[] = [];
    for (const input of inputs) {
        const fullName = `${namePrefix}${input.name}`;
        const groupState = own(state, input.name);
        if (isRepeat(input)) {
            const instances = Array.isArray(groupState) ? groupState : [];
            const model = repeatToDict(input, rc);
            model.cache = instances.map((instance, index) =>
                populateModel(
                    input.inputs,
                    isDict(instance) ? instance : emptyDict(),
                    rc,
                    context,
                    pagination,
                    `${fullName}_${index}|`,
                ),
            );
            out.push(model);
        } else if (isSection(input)) {
            out.push({
                ...sectionToDict(input),
                inputs: populateModel(
                    input.inputs,
                    isDict(groupState) ? groupState : emptyDict(),
                    rc,
                    context,
                    pagination,
                    `${fullName}|`,
                ),
            });
        } else if (isUploadDataset(input)) {
            out.push({ name: input.name, type: input.type });
        } else if (isParameter(input)) {
            const initial = initialValue(input, rc, context);
            if (!Object.hasOwn(state, input.name)) {
                state[input.name] = initial;
            }
            const model = parameterToDict(
                input,
                rc,
                context,
                Object.hasOwn(pagination, fullName) ? pagination[fullName] : undefined,
            );
            model.value = valueToBasic(input, state[input.name]);
            model.default_value = valueToBasic(input, initial);
            model.text_value = toText(input, model.value);
            out.push(model);
        } else {
            const values = isDict(groupState) ? groupState : emptyDict();
            const test = testParameter(input, inputs);
            let testValue: unknown = null;
            if (test) {
                testValue = Object.hasOwn(values, test.name) ? values[test.name] : initialValue(test, rc, context);
            }
            const model = conditionalToDict(input, inputs, rc, testValue);
            if (test) {
                const testModel = model.test_param as Model;
                testModel.value = valueToBasic(test, testValue);
                testModel.text_value = toText(test, testModel.value);
                const current = own(values, "__current_case__");
                model.cases = conditionalCases(input, test, testValue, rc).map((when, index) => ({
                    value: when.value,
                    inputs: populateModel(
                        when.inputs,
                        index === current ? values : emptyDict(),
                        rc,
                        context,
                        pagination,
                        `${fullName}|`,
                    ),
                }));
            }
            out.push(model);
        }
    }
    return out;
}
