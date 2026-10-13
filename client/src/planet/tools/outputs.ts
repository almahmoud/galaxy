/**
 * What a tool run creates (`DefaultToolAction.execute`): the job's input associations, the outputs that survive their
 * filters, and each output's provisional name, format and metadata. Filters, labels and `change_format` checks are
 * decided here only when the safe expression subset can decide them; otherwise the output keeps Galaxy's default
 * and the job's stage-in container decides (`prepare.json`).
 */

import type { BundleChangeFormat, BundleInput, BundleOutput, ToolBundle } from "./bundle";
import { isConditional, isParameter, isSection } from "./bundle";
import { isDict, own, type RequestContext, type StateDict } from "./context";
import { evaluate, type PyObject, type PyValue, truthy } from "./expressions";
import {
    type CollectionContent,
    collectionDatasets,
    type CollectionItem,
    type DatasetItem,
    isCollectionItem,
    isDatasetItem,
} from "./history";
import { metadataValue } from "./options";
import { paramDictString, profileBefore } from "./parameters";
import { pyStr } from "./python";
import { caseInputs, testParameter, visitInputValues } from "./state";
import { renderTemplate, type TemplateLookup, type TemplateValue } from "./templates";

/** A dataset input of the job (`inp_data`), by Galaxy's input name. */
export interface InputDataset {
    name: string;
    /** The name without conditional and section prefixes (Galaxy's legacy alias). */
    legacyName: string;
    item: DatasetItem | null;
    /** True for the datasets of a collection input. */
    fromCollection: boolean;
}

/** A collection input of the job (`inp_dataset_collections`). */
export interface InputCollection {
    name: string;
    legacyName: string;
    item: CollectionItem;
    /** True when a multiple data parameter consumes the collection's datasets. */
    reduced: boolean;
}

/** An output dataset to create. */
export interface PlannedDataset {
    /** The job output name; collection elements are `<collection>|__part__|<identifier>`. */
    name: string;
    hdaName: string;
    extension: string;
    visible: boolean;
    dbkey: string;
    metadata: Record<string, unknown>;
    createdFromBasename: string | null;
    /** True for elements of an output collection. */
    element: boolean;
}

/** An element of a planned collection: a planned dataset (by index) or a nested collection. */
export interface PlannedElement {
    identifier: string;
    dataset?: number;
    collectionType?: string;
    elements?: PlannedElement[];
}

/** An output collection to create. */
export interface PlannedCollection {
    name: string;
    hdcaName: string;
    collectionType: string;
    /** False for collections whose elements the job discovers. */
    populated: boolean;
    elements: PlannedElement[];
}

/** Everything a tool run creates for one job. */
export interface OutputPlan {
    inputDatasets: InputDataset[];
    inputCollections: InputCollection[];
    datasets: PlannedDataset[];
    collections: PlannedCollection[];
    /** History items in the order Galaxy gives them hids. */
    hidOrder: ({ kind: "dataset"; index: number } | { kind: "collection"; index: number })[];
    /** Tags the outputs inherit from the inputs (`name:` tags). */
    tags: string[];
    dbkey: string;
    inputExt: string;
    onText: string;
}

/** An output could not be planned; the job is not created. */
export class OutputPlanError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Inputs

/** `_collect_input_datasets` and `collect_input_dataset_collections`. */
export function collectInputs(
    tool: ToolBundle,
    state: StateDict,
    rc: RequestContext,
): { datasets: InputDataset[]; collections: InputCollection[] } {
    const datasets: InputDataset[] = [];
    const collections: InputCollection[] = [];
    visitInputValues(tool.inputs, state, rc, ({ input, value, prefixedName, legacyName }) => {
        if (input.type === "data" || input.type === "hidden_data") {
            const values = Array.isArray(value) ? value : [value];
            let expanded: (DatasetItem | null)[] = [];
            let reducedCollections = false;
            for (const item of values) {
                if (isCollectionItem(item)) {
                    collections.push({ name: prefixedName, legacyName, item, reduced: true });
                    expanded.push(...collectionDatasets(item.collection));
                    reducedCollections = true;
                } else {
                    expanded.push(isDatasetItem(item) ? item : null);
                }
            }
            if (!Array.isArray(value) && !reducedCollections) {
                datasets.push({ name: prefixedName, legacyName, item: expanded[0] ?? null, fromCollection: false });
                return;
            }
            expanded = expanded.filter((item) => item !== null);
            expanded.forEach((item, index) => {
                if (index === 0) {
                    datasets.push({ name: prefixedName, legacyName, item, fromCollection: false });
                }
                datasets.push({
                    name: `${prefixedName}${index + 1}`,
                    legacyName: `${legacyName}${index + 1}`,
                    item,
                    fromCollection: false,
                });
            });
        } else if (input.type === "data_collection" && isCollectionItem(value)) {
            collections.push({ name: prefixedName, legacyName, item: value, reduced: false });
            collectionDatasets(value.collection).forEach((item, index) => {
                datasets.push({
                    name: `${prefixedName}${index + 1}`,
                    legacyName: `${legacyName}${index + 1}`,
                    item,
                    fromCollection: true,
                });
            });
        }
    });
    return { datasets, collections };
}

/** `on_text_for_numeric_ids`. */
function onTextForIds(ids: readonly number[], prefix: string): string {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    if (unique.length === 0) {
        return "";
    }
    const groups: string[] = [];
    let start = 0;
    for (let i = 1; i <= unique.length; i++) {
        if (i === unique.length || unique[i] !== unique[i - 1]! + 1) {
            const group = unique.slice(start, i);
            if (group.length === 1) {
                groups.push(String(group[0]));
            } else if (group.length === 2) {
                groups.push(String(group[0]), String(group[1]));
            } else {
                groups.push(`${group[0]}-${group[group.length - 1]}`);
            }
            start = i;
        }
    }
    let names: string;
    if (groups.length === 1) {
        names = groups[0]!;
    } else if (groups.length === 2) {
        names = `${groups[0]} and ${groups[1]}`;
    } else if (groups.length === 3) {
        names = `${groups[0]}, ${groups[1]}, and ${groups[2]}`;
    } else {
        names = `${groups[0]}, ${groups[1]}, and others`;
    }
    return `${prefix} ${names}`;
}

/** `DefaultToolAction._get_on_text`. */
export function onText(datasets: readonly InputDataset[], collections: readonly InputCollection[]): string {
    const collectionNames = new Set(collections.map((input) => input.name));
    const collectionHids = collections.map((input) => input.item.hid);
    const datasetHids: number[] = [];
    for (const input of datasets) {
        const derived = [...collectionNames].some(
            (name) =>
                input.name === name || (input.name.startsWith(name) && /^\d+$/.test(input.name.slice(name.length))),
        );
        if (!derived && input.item?.hid) {
            datasetHids.push(input.item.hid);
        }
    }
    const parts = [onTextForIds(datasetHids, "dataset"), onTextForIds(collectionHids, "collection")].filter(Boolean);
    if (parts.length <= 1) {
        return parts[0] ?? "";
    }
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function lookupInput<T extends { name: string; legacyName: string }>(
    inputs: readonly T[],
    name: string,
): T | undefined {
    return inputs.find((input) => input.name === name) ?? inputs.find((input) => input.legacyName === name);
}

// ---------------------------------------------------------------------------------------------------------
// Expression scope

function datasetObject(item: DatasetItem): PyObject {
    return {
        kind: "object",
        typeName: "HistoryDatasetAssociation",
        attribute(name) {
            switch (name) {
                case "name":
                    return item.name;
                case "ext":
                case "extension":
                    return item.extension;
                case "dbkey":
                    return item.dbkey;
                case "hid":
                    return item.hid;
                case "state":
                    return item.effectiveState;
                case "metadata":
                    return metadataObject(item);
                default:
                    return undefined;
            }
        },
    };
}

function metadataObject(item: DatasetItem): PyObject {
    return {
        kind: "object",
        typeName: "MetadataCollection",
        attribute(name) {
            const value = metadataValue(item, name);
            return value === undefined ? undefined : toPyValue(value, 0);
        },
    };
}

function collectionObject(item: CollectionItem): PyObject {
    return {
        kind: "object",
        typeName: "HistoryDatasetCollectionAssociation",
        attribute(name) {
            if (name === "name") {
                return item.name;
            }
            return name === "hid" ? item.hid : undefined;
        },
    };
}

/** Converts a tool state value to the values expressions see. */
function toPyValue(value: unknown, depth: number): PyValue {
    if (depth > 32 || value === undefined || value === null) {
        return null;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (isDatasetItem(value)) {
        return datasetObject(value);
    }
    if (isCollectionItem(value)) {
        return collectionObject(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => toPyValue(item, depth + 1));
    }
    if (isDict(value)) {
        return new Map(Object.entries(value).map(([key, item]) => [key, toPyValue(item, depth + 1)]));
    }
    return null;
}

/** The names `<filter>` expressions see: the tool state plus `dbkey` and `__input_ext`. */
function filterScope(state: StateDict, plan: Pick<OutputPlan, "dbkey" | "inputExt">): Map<string, PyValue> {
    const scope = new Map<string, PyValue>();
    for (const [key, value] of Object.entries(state)) {
        scope.set(key, toPyValue(value, 0));
    }
    scope.set("dbkey", plan.dbkey);
    scope.set("__input_ext", plan.inputExt);
    return scope;
}

/** `filter_output`: false when a filter decides the output is not created. Undecidable filters keep it. */
function passesFilters(output: BundleOutput, scope: ReadonlyMap<string, PyValue>): boolean {
    for (const filter of output.filters ?? []) {
        if (!filter) {
            continue;
        }
        const result = evaluate(filter, scope);
        if (result.status === "value" && !truthy(result.value)) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------------------------------------
// Templates

/** Resolves `$a.b.c` placeholders against the tool state like Cheetah's name mapper over Galaxy's wrappers. */
function stateLookup(
    rc: RequestContext,
    state: StateDict,
    extras: Readonly<Record<string, string | undefined>>,
): TemplateLookup {
    return (path): TemplateValue => {
        const [first = "", ...rest] = path;
        if (Object.hasOwn(extras, first) && rest.length === 0) {
            const text = extras[first];
            return text === undefined ? { status: "undecided" } : { status: "value", text };
        }
        if (first === "tool") {
            if (rest.length === 1 && rest[0] === "name") {
                return { status: "value", text: rc.tool.name };
            }
            if (rest.length === 1 && rest[0] === "id") {
                return { status: "value", text: rc.tool.id };
            }
            return { status: "undecided" };
        }
        return walk(rc, rc.tool.inputs, state, path, true);
    };
}

function walk(
    rc: RequestContext,
    inputs: readonly BundleInput[],
    values: StateDict,
    path: readonly string[],
    topLevel = false,
): TemplateValue {
    const [name = "", ...rest] = path;
    const input = inputs.find((candidate) => candidate.name === name);
    if (!Object.hasOwn(values, name)) {
        // Other names of Galaxy's template namespace are not modelled; names inside groups are not found.
        return topLevel && !input ? { status: "undecided" } : { status: "missing" };
    }
    const value = values[name];
    if (!input) {
        return rest.length === 0 && (typeof value === "string" || typeof value === "number")
            ? { status: "value", text: pyStr(value) }
            : { status: "undecided" };
    }
    if (isParameter(input)) {
        if (rest.length) {
            return { status: "undecided" };
        }
        const text = paramDictString(input, value, rc);
        return text === undefined ? { status: "undecided" } : { status: "value", text };
    }
    if (rest.length === 0 || !isDict(value)) {
        return { status: "undecided" };
    }
    if (isSection(input)) {
        return walk(rc, input.inputs, value, rest);
    }
    if (isConditional(input)) {
        const test = testParameter(input, inputs);
        if (!test) {
            return { status: "undecided" };
        }
        const selected = caseInputs(input, test, own(value, test.name) ?? null, rc);
        return walk(rc, [test, ...(selected?.inputs ?? [])], value, rest);
    }
    return { status: "undecided" };
}

/** `get_output_name`: the rendered label, or `<tool name> on <inputs>` when there is none or it cannot be rendered. */
function outputName(rc: RequestContext, output: BundleOutput, lookup: TemplateLookup, on: string): string {
    const fallback = on ? `${rc.tool.name} on ${on}` : rc.tool.name;
    if (!output.label) {
        return fallback;
    }
    const rendered = renderTemplate(output.label, lookup);
    return rendered.status === "value" ? rendered.text : fallback;
}

// ---------------------------------------------------------------------------------------------------------
// Formats

/** Dataset attributes `change_format` checks may compare; others are left to the job. */
function datasetAttributeValue(item: DatasetItem, attribute: string): unknown {
    switch (attribute) {
        case "ext":
        case "extension":
            return item.extension;
        case "dbkey":
            return item.dbkey;
        case "name":
            return item.name;
        case "hid":
            return item.hid;
        case "state":
            return item.effectiveState;
        default:
            return undefined;
    }
}

/** `resolve_format_source`. */
function resolveFormatSource(
    source: string,
    plan: Pick<OutputPlan, "inputDatasets" | "inputCollections">,
    fallback: string,
): string {
    const dataset = lookupInput(plan.inputDatasets, source);
    if (dataset) {
        return dataset.item?.extension ?? fallback;
    }
    let collectionName = source;
    let elementIndex: string | number | null = null;
    const match = /^([^[\]]*)\[([^[\]]*)\]$/.exec(source);
    if (match) {
        collectionName = match[1]!;
        try {
            elementIndex = JSON.parse(match[2]!.replace(/'/g, '"')) as string | number;
        } catch {
            return fallback;
        }
    }
    const collection = lookupInput(plan.inputCollections, collectionName);
    if (!collection) {
        return fallback;
    }
    const content: CollectionContent = collection.item.collection;
    let element: DatasetItem | null | undefined;
    if (elementIndex === null) {
        element = collectionDatasets(content)[0];
    } else if (typeof elementIndex === "number") {
        element = content.elements[elementIndex]?.dataset;
    } else {
        element = content.elements.find((candidate) => candidate.identifier === elementIndex)?.dataset;
    }
    return element?.extension ?? fallback;
}

/** `change_format` checks: the format of the first matching `<when>`, null when none matches, undefined if unknown. */
function changedFormat(
    rules: readonly BundleChangeFormat[],
    plan: Pick<OutputPlan, "inputDatasets">,
    lookup: TemplateLookup,
    current: string,
): string | null | undefined {
    for (const rule of rules) {
        if (rule.input !== null && rule.input !== undefined) {
            const rendered = renderTemplate(rule.input, lookup);
            if (rendered.status === "undecided") {
                return undefined;
            }
            if (rendered.status === "value" && rendered.text === rule.value && rule.format) {
                return rule.format;
            }
            continue;
        }
        if (!rule.input_dataset || rule.value === null || !rule.check_attribute) {
            continue;
        }
        const dataset = lookupInput(plan.inputDatasets, rule.input_dataset)?.item;
        if (!dataset) {
            continue;
        }
        const format = rule.format || current;
        const attribute = rule.check_attribute;
        const value = datasetAttributeValue(dataset, attribute);
        if (value !== undefined) {
            if (pyStr(value) === rule.value) {
                return format;
            }
            continue;
        }
        const metadata = metadataValue(dataset, attribute);
        if (metadata === undefined) {
            return undefined;
        }
        if (metadata !== null && pyStr(metadata) === rule.value) {
            return format;
        }
    }
    return null;
}

/** `determine_output_format`, with `_sniff_` (`auto_format`) reported as `auto`. */
function outputFormat(
    output: BundleOutput,
    plan: Pick<OutputPlan, "inputDatasets" | "inputCollections" | "inputExt">,
    lookup: TemplateLookup,
): string {
    let ext = output.format ?? "data";
    if (ext === "input") {
        ext = plan.inputExt;
        if (["data", "auto"].includes(ext) && plan.inputDatasets.length) {
            ext = plan.inputDatasets[0]!.item?.extension ?? ext;
        }
    }
    if (output.format_source) {
        ext = resolveFormatSource(output.format_source, plan, ext);
    }
    if (output.change_format?.length) {
        const changed = changedFormat(output.change_format, plan, lookup, ext);
        if (changed) {
            ext = changed;
        }
    }
    return ext === "_sniff_" ? "auto" : ext;
}

// ---------------------------------------------------------------------------------------------------------
// Planning

function basename(path: string): string {
    return path.split("/").pop() ?? path;
}

/** Element outputs of a collection with a static structure (`ToolOutputCollection.known_outputs`). */
function knownElements(
    output: BundleOutput,
    plan: Pick<OutputPlan, "inputCollections">,
): { identifier: string; parents: string[]; definition: BundleOutput }[] | null {
    const structure = output.structure;
    if (!structure || (structure.discover_datasets ?? []).length) {
        return [];
    }
    const explicit = output.outputs ?? [];
    if (explicit.length > 1) {
        return explicit.map((definition) => ({ identifier: definition.name, parents: [], definition }));
    }
    const prototype = (identifier: string, parents: string[], dataset: DatasetItem | null) => ({
        identifier,
        parents,
        definition: {
            model_class: "ToolOutput",
            name: identifier,
            label: null,
            hidden: false,
            output_type: "data",
            format: output.inherit_format && dataset ? dataset.extension : (output.default_format ?? "data"),
            format_source: output.format_source ?? null,
            metadata_source: output.metadata_source ?? null,
            filters: [],
        } satisfies BundleOutput,
    });
    if (structure.structured_like) {
        const source = lookupInput(plan.inputCollections, structure.structured_like);
        if (!source) {
            return null;
        }
        const out: ReturnType<typeof prototype>[] = [];
        const visit = (content: CollectionContent, parents: string[]) => {
            for (const element of content.elements) {
                if (element.collection) {
                    visit(element.collection, [...parents, element.identifier]);
                } else {
                    out.push(prototype(element.identifier, parents, element.dataset));
                }
            }
        };
        visit(source.item.collection, []);
        return out;
    }
    return structure.collection_type === "paired"
        ? [prototype("forward", [], null), prototype("reverse", [], null)]
        : null;
}

function inheritedTags(datasets: readonly InputDataset[], collections: readonly InputCollection[]): string[] {
    const byValue = new Map<string, string>();
    const add = (tag: string) => {
        const normalized = tag.startsWith("#") ? `name:${tag.slice(1)}` : tag;
        if (normalized.startsWith("name:")) {
            byValue.set(normalized.slice("name:".length), normalized);
        }
    };
    datasets.forEach((input) => input.item?.tags.forEach(add));
    collections.forEach((input) => input.item.tags.forEach(add));
    return [...byValue.values()];
}

/**
 * Plans the outputs of one job for the populated `state`: which outputs survive their filters, their provisional
 * names and formats, collection structures, and the order Galaxy gives the new items hids.
 */
export function planOutputs(rc: RequestContext, state: StateDict): OutputPlan {
    const { tool } = rc;
    const { datasets: inputDatasets, collections: inputCollections } = collectInputs(tool, state, rc);
    const legacyProfile = profileBefore(tool.profile, "16.04");
    let inputExt = legacyProfile ? "data" : "input";
    const ownDbkey = own(state, "dbkey");
    let dbkey = typeof ownDbkey === "string" ? ownDbkey : "?";
    for (const input of [...inputDatasets].reverse()) {
        if (!input.item) {
            continue;
        }
        if (legacyProfile) {
            inputExt = input.item.extension;
        }
        if (input.item.dbkey && input.item.dbkey !== "?") {
            dbkey = input.item.dbkey;
        }
    }
    const plan: OutputPlan = {
        inputDatasets,
        inputCollections,
        datasets: [],
        collections: [],
        hidOrder: [],
        tags: inheritedTags(inputDatasets, inputCollections),
        dbkey,
        inputExt,
        onText: onText(inputDatasets, inputCollections),
    };
    const scope = filterScope(state, plan);
    const lookup = stateLookup(rc, state, { on_string: plan.onText, dbkey, __input_ext: inputExt });
    const datasetOrder: number[] = [];
    const planDataset = (definition: BundleOutput, name: string, element: boolean): number => {
        const source = definition.metadata_source ? lookupInput(inputDatasets, definition.metadata_source)?.item : null;
        plan.datasets.push({
            name,
            hdaName: outputName(rc, definition, lookup, plan.onText),
            extension: outputFormat(definition, plan, lookup),
            visible: !(element || definition.hidden),
            dbkey,
            metadata: source ? { ...source.metadata } : {},
            createdFromBasename: definition.from_work_dir ? basename(definition.from_work_dir) : null,
            element,
        });
        return plan.datasets.length - 1;
    };
    for (const output of tool.outputs) {
        if (!passesFilters(output, scope)) {
            continue;
        }
        if (output.model_class === "ToolOutputCollection") {
            const collectionType = output.structure?.collection_type;
            if (!collectionType) {
                throw new OutputPlanError(`Could not determine the collection type of output '${output.name}'.`);
            }
            const parts = knownElements(output, plan);
            if (parts === null) {
                throw new OutputPlanError(`Cannot pre-determine structure for collection of type ${collectionType}`);
            }
            const elements: PlannedElement[] = [];
            for (const part of parts) {
                let level = elements;
                let levelType = collectionType;
                for (const parent of part.parents) {
                    levelType = levelType.split(":").slice(1).join(":");
                    let node = level.find((candidate) => candidate.identifier === parent && candidate.elements);
                    if (!node) {
                        node = { identifier: parent, collectionType: levelType, elements: [] };
                        level.push(node);
                    }
                    level = node.elements!;
                }
                const index = planDataset(part.definition, `${output.name}|__part__|${part.identifier}`, true);
                plan.hidOrder.push({ kind: "dataset", index });
                level.push({ identifier: part.identifier, dataset: index });
            }
            plan.collections.push({
                name: output.name,
                hdcaName: outputName(rc, output, lookup, plan.onText),
                collectionType,
                populated: !(output.structure?.discover_datasets ?? []).length,
                elements,
            });
            plan.hidOrder.push({ kind: "collection", index: plan.collections.length - 1 });
        } else if (output.model_class === "ToolOutput") {
            datasetOrder.push(planDataset(output, output.name, false));
        }
    }
    for (const index of datasetOrder) {
        plan.hidOrder.push({ kind: "dataset", index });
    }
    return plan;
}
