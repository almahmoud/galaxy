/**
 * Planet tool bundles (`planet/docs/tool-bundle.md`): one Galaxy tool version parsed by Galaxy's own code, as JSON.
 * The types cover the fields the tool form and job submission read; bundles carry many more.
 */

import * as db from "@/planet/db";
import { loadOptionalStaticData } from "@/planet/util/staticData";

import type { SanitizerDefinition } from "./python";

/** A validator as Galaxy's validator models serialize it. */
export interface BundleValidator {
    type: string;
    message?: string | null;
    negate: boolean;
    implicit: boolean;
    expression?: string;
    min?: number | null;
    max?: number | null;
    exclude_min?: boolean;
    exclude_max?: boolean;
    check?: string[] | null;
    skip?: string[] | null;
    metadata_name?: string | null;
    value?: unknown;
}

/** A `<filter>` of dynamic options, with its XML attributes. */
export interface BundleOptionsFilter {
    type: string;
    [attribute: string]: unknown;
}

/** The `<options>` element of a select-like or data parameter. */
export interface BundleDynamicOptions {
    from_dataset: string | null;
    from_file: string | null;
    from_data_table: string | null;
    from_parameter: string | null;
    from_url: unknown;
    transform_lines: string | null;
    meta_file_key: string | null;
    options_filter_attribute: string | null;
    separator: string;
    startswith: string | null;
    columns: Record<string, number>;
    filters: BundleOptionsFilter[];
    validators: BundleValidator[];
}

/** A node of a `drill_down` parameter's static option tree. */
export interface DrillDownOption {
    name: string;
    value: string;
    options: DrillDownOption[];
    selected: boolean;
}

/** A tool parameter. Type-specific fields are present for the types that define them. */
export interface BundleParameter {
    model_class: string;
    type: string;
    name: string;
    argument: string | null;
    label: string | null;
    help: string | null;
    help_format: string;
    hidden: boolean;
    refresh_on_change: boolean;
    optional: boolean;
    is_dynamic: boolean;
    sanitizer: SanitizerDefinition | null;
    validators: BundleValidator[];
    value?: string | null;
    area?: boolean;
    datalist?: { label: string; value: string }[];
    multiple?: boolean;
    optionality_inferred?: boolean;
    min?: number | null;
    max?: number | null;
    truevalue?: string;
    falsevalue?: string;
    checked?: boolean | null;
    rgb?: boolean;
    display?: string | null;
    separator?: string;
    static_options?: [string | null, string | null, boolean][] | null;
    legal_values?: (string | null)[];
    options?: BundleDynamicOptions | DrillDownOption[] | null;
    dynamic_options?: string | null;
    data_ref?: string | null;
    accept_default?: boolean;
    default_value?: string | null;
    numerical?: boolean;
    usecolnames?: boolean;
    hierarchy?: string;
    extensions?: string[];
    tag?: string | null;
    no_validation?: boolean;
    default_object?: unknown;
    options_filter_attribute?: string | null;
    collection_types?: string[] | null;
    fields?: string | null;
    column_definitions?: string | null;
}

export interface BundleRepeat {
    model_class: "Repeat";
    type: "repeat";
    name: string;
    title: string;
    help: string | null;
    default: number;
    min: number;
    max: number | null;
    inputs: BundleInput[];
}

export interface BundleSection {
    model_class: "Section";
    type: "section";
    name: string;
    title: string | null;
    help: string | null;
    expanded: boolean;
    inputs: BundleInput[];
}

export interface BundleCase {
    value: string | null;
    inputs: BundleInput[];
}

export interface BundleConditional {
    model_class: "Conditional";
    type: "conditional";
    name: string;
    value_ref: string | null;
    value_ref_in_group: boolean;
    value_from: string | null;
    test_param: BundleParameter | null;
    cases: BundleCase[];
}

export interface BundleUploadDataset {
    model_class: "UploadDataset";
    type: "upload_dataset";
    name: string;
    title: string | null;
    file_type_name: string;
    default_file_type: string;
    metadata_ref: string;
    inputs: BundleInput[];
}

export type BundleGroup = BundleRepeat | BundleSection | BundleConditional | BundleUploadDataset;
export type BundleInput = BundleParameter | BundleGroup;

export interface BundleChangeFormat {
    value: string | null;
    format: string | null;
    input: string | null;
    input_dataset: string | null;
    check_attribute: string | null;
}

export interface BundleCollectionStructure {
    collection_type: string | null;
    collection_type_source: string | null;
    structured_like: string | null;
    discover_datasets: unknown[];
    fields?: unknown;
}

/** `ToolOutput.to_dict()` or `ToolOutputCollection.to_dict()` with Planet's additions. */
export interface BundleOutput {
    model_class: "ToolOutput" | "ToolOutputCollection" | "ToolExpressionOutput";
    name: string;
    label: string | null;
    hidden: boolean;
    output_type: string;
    format?: string | null;
    format_source?: string | null;
    metadata_source?: string | null;
    from_work_dir?: string | null;
    filters: (string | null)[];
    change_format?: BundleChangeFormat[] | null;
    default_format?: string | null;
    inherit_format?: boolean;
    inherit_metadata?: boolean;
    structure?: BundleCollectionStructure;
    outputs?: BundleOutput[];
    discover_datasets?: unknown[] | null;
}

export interface BundleDataTable {
    name: string;
    columns: string[];
    files?: { entries?: string[][] }[];
}

export interface BundleHelp {
    format: string;
    content: string;
    html: string | null;
    rendered: boolean;
}

/** A Planet tool bundle (`format_version` 1). */
export interface ToolBundle {
    id: string;
    old_id: string;
    version: string;
    versions?: string[];
    name: string;
    description?: string | null;
    profile: string;
    model_class?: string;
    tool_type?: string;
    form_style?: string;
    display_interface?: boolean;
    is_workflow_compatible?: boolean;
    has_parameters?: boolean;
    license?: string | null;
    creator?: unknown;
    funding?: unknown;
    citations?: unknown[];
    help?: BundleHelp | null;
    requirements?: { name?: string; version?: string | null; type?: string }[];
    credentials?: unknown[];
    options?: { sanitize?: boolean; refresh?: boolean };
    form?: { action?: string; method?: string; check_values?: boolean };
    inputs: BundleInput[];
    outputs: BundleOutput[];
    data_tables?: BundleDataTable[];
    tool_shed_repository?: { name?: string; owner?: string; tool_shed?: string } | null;
    panel_entry?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has the fields every bundle has. */
export function isToolBundle(value: unknown): value is ToolBundle {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.version === "string" &&
        typeof value.name === "string" &&
        Array.isArray(value.inputs) &&
        Array.isArray(value.outputs)
    );
}

export function isConditional(input: BundleInput): input is BundleConditional {
    return input.type === "conditional";
}

export function isRepeat(input: BundleInput): input is BundleRepeat {
    return input.type === "repeat";
}

export function isSection(input: BundleInput): input is BundleSection {
    return input.type === "section";
}

export function isUploadDataset(input: BundleInput): input is BundleUploadDataset {
    return input.type === "upload_dataset";
}

export function isParameter(input: BundleInput): input is BundleParameter {
    return !isConditional(input) && !isRepeat(input) && !isSection(input) && !isUploadDataset(input);
}

/** Path of a bundle below the static data root: each `/`-separated segment percent-encoded. */
export function bundlePath(toolId: string, version: string): string {
    const segments = [...toolId.split("/"), ...version.split("/")].map(encodeURIComponent);
    return `toolbox/bundles/${segments.join("/")}.json`;
}

/** Tool ids and versions use these characters, in `/`-separated segments that are not `.` or `..`. */
const SEGMENT = /^[A-Za-z0-9._+@~-]+$/;

/** True when `toolId` and `version` name a bundle path (`planet/docs/tool-bundle.md`). */
export function isBundleName(toolId: string, version: string): boolean {
    return [...toolId.split("/"), ...version.split("/")].every(
        (segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..",
    );
}

/** Reads a tool version's bundle from IndexedDB (installed tools) or the build's static data, or undefined. */
export async function readBundle(toolId: string, version: string): Promise<ToolBundle | undefined> {
    if (!isBundleName(toolId, version)) {
        return undefined;
    }
    const record = await db.tools.get(toolId, version).catch(() => undefined);
    if (record && isToolBundle(record.bundle)) {
        return record.bundle;
    }
    const bundle = await loadOptionalStaticData<unknown>(bundlePath(toolId, version));
    return isToolBundle(bundle) ? bundle : undefined;
}

/** The XML id of a tool: the second to last segment of a Tool Shed GUID, else the id itself. */
export function oldToolId(toolId: string): string {
    const segments = toolId.split("/");
    return toolId.includes("/repos/") && segments.length >= 6 ? segments[segments.length - 2]! : toolId;
}
