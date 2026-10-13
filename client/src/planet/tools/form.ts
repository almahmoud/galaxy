/**
 * The tool form (`Tool.to_json`): the tool's panel entry plus the input tree for the current state, the state itself
 * (`state_inputs`), parameter errors and warnings, help, requirements and the form's submission details.
 */

import { escapeHtml } from "@/planet/util/html";

import type { BundleInput, BundleParameter, ToolBundle } from "./bundle";
import { isParameter } from "./bundle";
import { emptyDict, isDict, type RequestContext, type StateDict } from "./context";
import { type OptionsPagination, populateModel } from "./model";
import { populateState, type StateErrors, stateToJson, visitInputValues } from "./state";

/** What a form built for an existing job adds. */
export interface FormJobContext {
    jobId: string;
    /** `Job.remappable()`. */
    remap: boolean | "job_produced_collection_elements";
    /** Version mismatch message (`_compare_tool_version`). */
    message: string;
    /** Values of the job that no longer validate, by flat parameter name. */
    warnings: Record<string, string>;
}

/** Galaxy's `swap_inf_nan`: infinite and NaN numbers become the strings Galaxy's JSON uses for them. */
export function swapInfNan(value: unknown): unknown {
    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return "__NaN__";
        }
        if (value === Infinity) {
            return "__Infinity__";
        }
        return value === -Infinity ? "__-Infinity__" : value;
    }
    if (Array.isArray(value)) {
        return value.map(swapInfNan);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapInfNan(item)]));
    }
    return value;
}

/** The tool's `/api/tools/{id}` entry; built from the bundle when it has none. */
export function panelEntry(tool: ToolBundle): Record<string, unknown> {
    if (tool.panel_entry) {
        return { ...tool.panel_entry };
    }
    return {
        model_class: tool.model_class ?? "Tool",
        id: tool.id,
        name: tool.name,
        version: tool.version,
        description: tool.description ?? null,
        labels: [],
        icon: null,
        edam_operations: [],
        edam_topics: [],
        hidden: "",
        is_workflow_compatible: tool.is_workflow_compatible ?? true,
        xrefs: [],
        versions: tool.versions ?? [tool.version],
        hidden_versions: [],
        link: `/tool_runner?tool_id=${encodeURIComponent(tool.id)}`,
        has_parameters: tool.has_parameters ?? true,
        panel_section_id: null,
        panel_section_name: null,
        form_style: tool.form_style ?? "regular",
    };
}

/** The tool help as the form shows it, with `${static_path}` and `${host_url}` filled in (`Tool.render_help`). */
export function toolHelp(tool: ToolBundle, origin: string): { help: string; help_format: string } {
    const help = tool.help;
    if (!help) {
        return { help: "", help_format: "restructuredtext" };
    }
    if (help.format !== "restructuredtext") {
        return { help: help.content ?? "", help_format: help.format };
    }
    const html = typeof help.html === "string" ? help.html : `<pre>${escapeHtml(help.content ?? "")}</pre>`;
    return {
        help: html.replaceAll("${static_path}", "/static").replaceAll("${host_url}", `${origin}/`),
        help_format: "restructuredtext",
    };
}

/** The Tool Shed page of a repository tool (`get_tool_shed_repository_url`), or null. */
function sharableUrl(tool: ToolBundle): string | null {
    const repository = tool.tool_shed_repository;
    if (!repository?.tool_shed || !repository.owner || !repository.name) {
        return null;
    }
    return `https://${repository.tool_shed}/view/${repository.owner}/${repository.name}`;
}

function containsFileParameter(inputs: readonly BundleInput[]): boolean {
    return inputs.some((input) => {
        if (isParameter(input)) {
            return input.type === "file";
        }
        if ("cases" in input) {
            return input.cases.some((when) => containsFileParameter(when.inputs));
        }
        return containsFileParameter(input.inputs);
    });
}

/** Where a parameter's options come from when Planet cannot list them, or null. */
function unlistedOptionsSource(param: BundleParameter): string | null {
    if (param.dynamic_options) {
        return "Python code";
    }
    const options = param.options;
    if (!isDict(options)) {
        return null;
    }
    if (options.from_dataset) {
        return "the content of a dataset";
    }
    if (options.from_file) {
        return "a reference data file";
    }
    return options.from_url ? "a web service" : null;
}

/** Warnings for the active parameters whose options Planet cannot list (they are left empty). */
function optionWarnings(rc: RequestContext, state: StateDict): Record<string, string> {
    const warnings = emptyDict() as Record<string, string>;
    visitInputValues(rc.tool.inputs, state, rc, ({ input, prefixedName }) => {
        const source = unlistedOptionsSource(input);
        if (source) {
            warnings[prefixedName] = `Planet cannot list the options of this parameter yet: they come from ${source}.`;
        }
    });
    return warnings;
}

/** `unicodify` of a state error. */
export function errorMessages(errors: StateErrors): Record<string, string> {
    return Object.fromEntries(Object.entries(errors).map(([key, error]) => [key, error.message]));
}

/**
 * Builds the tool form for `incoming` (the flat parameters of the form, or of a job for a rerun): the state is
 * populated and validated, and every parameter gets its options and values for the request's history.
 */
export function buildToolForm(
    rc: RequestContext,
    incoming: Readonly<Record<string, unknown>>,
    options: { pagination?: OptionsPagination; job?: FormJobContext; versions?: readonly string[] } = {},
): Record<string, unknown> {
    const { tool } = rc;
    const { state, errors } = populateState(tool.inputs, incoming, rc);
    const inputs = populateModel(tool.inputs, state, rc, null, options.pagination ?? {});
    const stateInputs: StateDict = stateToJson(tool.inputs, state, rc);
    const entry = panelEntry(tool);
    const unlisted = optionWarnings(rc, state);
    const warnings =
        options.job || Object.keys(unlisted).length ? { ...(options.job?.warnings ?? {}), ...unlisted } : null;
    const model: Record<string, unknown> = {
        ...entry,
        inputs,
        ...toolHelp(tool, rc.origin),
        id: tool.id,
        citations: Array.isArray(tool.citations) && tool.citations.length > 0,
        sharable_url: sharableUrl(tool),
        message: options.job?.message ?? "",
        warnings,
        versions: options.versions ?? entry.versions ?? tool.versions ?? [tool.version],
        hidden_versions: entry.hidden_versions ?? [],
        requirements: (tool.requirements ?? []).map((requirement) => ({
            name: requirement.name ?? null,
            version: requirement.version ?? null,
        })),
        credentials: Array.isArray(tool.credentials) ? tool.credentials : [],
        errors: errorMessages(errors),
        tool_errors: null,
        state_inputs: stateInputs,
        job_id: options.job?.jobId ?? null,
        job_remap: options.job ? options.job.remap : null,
        job_credentials_context: null,
        history_id: rc.snapshot.history?.id ?? null,
        display: tool.display_interface ?? true,
        action: tool.form?.action ?? "/tool_runner/index",
        license: tool.license ?? null,
        creator: tool.creator ?? null,
        funding: tool.funding ?? null,
        method: tool.form?.method ?? "post",
        enctype: containsFileParameter(tool.inputs) ? "multipart/form-data" : "application/x-www-form-urlencoded",
    };
    return swapInfNan(model) as Record<string, unknown>;
}
