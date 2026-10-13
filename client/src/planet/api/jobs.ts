/**
 * Jobs from the IndexedDB job store: GET /api/jobs, GET/DELETE /api/jobs/{job_id} and
 * /api/jobs/{job_id}/{inputs,outputs,parameters_display,metrics,console_output,common_problems,destination_params,
 * build_for_rerun}. Also exports the parameter summary that `/api/datasets/{dataset_id}/parameters_display` shows
 * for a dataset's creating job.
 *
 * Deleting a job follows Galaxy's `Job.mark_deleted`: the job becomes `deleting` and its outputs are discarded; the
 * leader tab stops the Kubernetes job when it sees the state change.
 */

import type { components } from "@/api/schema";
import {
    CONTENT_STORES,
    hdas,
    JOB_STORES,
    type JobRecord,
    jobs,
    type ReadTx,
    readTx,
    withTransaction,
} from "@/planet/db";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { parseSearch, sqlLike } from "@/planet/util/filters";
import { queryBool, queryInt } from "@/planet/util/query";
import { FINISHED_JOB_STATES } from "@/planet/util/states";
import { parseGalaxyTime } from "@/planet/util/time";

import { GALAXY_VERSION_MAJOR } from "./configuration";
import { markJobDeleted } from "./contents";
import { PLANET_USER_ID } from "./users";

type JobSummary = components["schemas"]["JobSummary"];
type EncodedJobDetails = components["schemas"]["EncodedJobDetails"];
type ShowFullJobResponse = components["schemas"]["ShowFullJobResponse"];
type JobDisplayParametersSummary = components["schemas"]["JobDisplayParametersSummary"];
type JobParameter = components["schemas"]["JobParameter"];
type JobOutput = components["schemas"]["JobOutput"];
type EncodedJobParameterHistoryItem = components["schemas"]["EncodedJobParameterHistoryItem"];

const NOT_YET = "Rerunning jobs arrives in a later Planet release.";

// ---------------------------------------------------------------------------------------------------------
// Serialization (`Job.to_dict` validated through Galaxy's response models)

function jobSummary(job: JobRecord): JobSummary {
    return {
        model_class: "Job",
        id: job.id,
        history_id: job.history_id,
        tool_id: job.tool_id,
        state: job.state,
        exit_code: job.exit_code,
        create_time: job.create_time,
        update_time: job.update_time,
        galaxy_version: GALAXY_VERSION_MAJOR,
        external_id: null,
        handler: null,
        job_runner_name: null,
        command_line: null,
        user_email: null,
        user_id: null,
    };
}

async function jobDetails(job: JobRecord, tx: ReadTx): Promise<EncodedJobDetails> {
    const datasetItem = async (hdaId: string) => {
        const row = await hdas.getWithDataset(hdaId, tx);
        return { id: hdaId, src: "hda" as const, uuid: row?.dataset.uuid ?? null };
    };
    const inputs: EncodedJobDetails["inputs"] = {};
    for (const input of job.inputs) {
        if (input.src === "hda") {
            inputs[input.name] = await datasetItem(input.id);
        }
    }
    const outputs: EncodedJobDetails["outputs"] = {};
    for (const output of job.outputs) {
        outputs[output.name] = await datasetItem(output.id);
    }
    const outputCollections: EncodedJobDetails["output_collections"] = {};
    for (const output of job.output_collections) {
        if (output.src === "hdca") {
            outputCollections[output.name] = { id: output.id, src: "hdca" };
        }
    }
    const params = Object.fromEntries(Object.entries(job.params).filter(([name]) => !Object.hasOwn(inputs, name)));
    return {
        ...jobSummary(job),
        user_id: PLANET_USER_ID,
        command_line: job.command_line,
        command_version: job.command_version,
        copied_from_job_id: job.copied_from_job_id,
        implicit_collection_jobs_id: job.implicit_collection_jobs_id,
        params,
        inputs,
        outputs,
        output_collections: outputCollections,
    };
}

function joinStreams(tool: string | null, job: string | null): string {
    return (tool ?? "") + (job ? `\n${job}` : "");
}

/** `GET /api/jobs/{job_id}?full=true` (`view_show_job` with `expose_dataset_path` on). */
export async function showFullJob(job: JobRecord, tx: ReadTx): Promise<ShowFullJobResponse> {
    return {
        ...(await jobDetails(job, tx)),
        tool_stdout: job.tool_stdout,
        tool_stderr: job.tool_stderr,
        job_stdout: job.job_stdout,
        job_stderr: job.job_stderr,
        stdout: joinStreams(job.tool_stdout, job.job_stdout),
        stderr: joinStreams(job.tool_stderr, job.job_stderr),
        job_messages: job.job_messages as ShowFullJobResponse["job_messages"],
        dependencies: job.dependencies,
        job_metrics: null,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Parameter summary

function displayValue(value: unknown): JobParameter["value"] {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)) {
        return value.map(String).join(", ");
    }
    return JSON.stringify(value);
}

/**
 * Galaxy's `summarize_job_parameters` without the tool's parameter definitions: one row per submitted
 * parameter (nesting from the `a|b` keys), data inputs listed with their hid and name, and the job outputs.
 */
export async function summarizeJobParameters(job: JobRecord, tx: ReadTx): Promise<JobDisplayParametersSummary> {
    const parameters: JobParameter[] = [];
    const dataInputs = new Map<string, EncodedJobParameterHistoryItem[]>();
    for (const input of job.inputs) {
        const items = dataInputs.get(input.name) ?? [];
        let item: EncodedJobParameterHistoryItem;
        if (input.src === "hda") {
            const hda = await hdas.get(input.id, tx);
            item = { src: "hda", id: input.id, hid: hda?.hid ?? null, name: hda?.name ?? "" };
        } else if (input.src === "hdca") {
            const hdca = await tx.store("hdcas").get(input.id);
            item = { src: "hdca", id: input.id, hid: hdca?.hid ?? null, name: hdca?.name ?? "" };
        } else {
            const dce = await tx.store("dces").get(input.id);
            item = { src: "dce", id: input.id, name: dce?.element_identifier ?? "" };
        }
        items.push(item);
        dataInputs.set(input.name, items);
    }
    const sections = new Set<string>();
    for (const [key, value] of Object.entries(job.params)) {
        if (key.startsWith("__") || dataInputs.has(key)) {
            continue;
        }
        const path = key.split("|");
        for (let depth = 1; depth < path.length; depth++) {
            const prefix = path.slice(0, depth).join("|");
            if (!sections.has(prefix)) {
                sections.add(prefix);
                parameters.push({ text: path[depth - 1]!, depth });
            }
        }
        parameters.push({ text: path[path.length - 1]!, depth: path.length, value: displayValue(value) });
    }
    for (const [name, value] of dataInputs) {
        parameters.push({ text: name.split("|").pop()!, depth: name.split("|").length, value });
    }
    const outputs: Record<string, JobOutput[]> = {};
    for (const output of job.outputs) {
        (outputs[output.name] ??= []).push({ label: null, value: { src: "hda", id: output.id } });
    }
    for (const output of job.output_collections) {
        if (output.src === "hdca") {
            (outputs[output.name] ??= []).push({ label: null, value: { src: "hdca", id: output.id } });
        }
    }
    return { parameters, has_parameter_errors: false, outputs };
}

// ---------------------------------------------------------------------------------------------------------
// Index

const ORDER_KEYS = ["update_time", "create_time"] as const;

function listParam(query: URLSearchParams, name: string): string[] | null {
    const values = query
        .getAll(name)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    return values.length ? values : null;
}

function timeParam(query: URLSearchParams, name: string): number | null {
    const raw = query.get(name);
    if (!raw) {
        return null;
    }
    try {
        return parseGalaxyTime(raw);
    } catch {
        throw ApiError.badRequest(`Input should be a valid datetime or date in ('query', '${name}')`);
    }
}

function textMatches(value: string, text: string, quoted: boolean): boolean {
    return quoted ? value === text : value.toLowerCase().includes(text.toLowerCase());
}

async function jobsIndex({ query }: PlanetRequest): Promise<(JobSummary | EncodedJobDetails)[]> {
    const view = query.get("view") ?? "collection";
    if (view === "admin_job_list") {
        throw new ApiError(403, "Only admins can use the admin_job_list view", ErrorCodes.ADMIN_REQUIRED);
    }
    if (!["collection", "element"].includes(view)) {
        throw ApiError.badRequest(`Input should be 'collection', 'admin_job_list' or 'element' in ('query', 'view')`);
    }
    if (queryBool(query, "user_details", false)) {
        throw new ApiError(403, "Only admins can index the jobs with user details enabled", ErrorCodes.ADMIN_REQUIRED);
    }
    const userId = query.get("user_id");
    if (userId && userId !== PLANET_USER_ID) {
        throw new ApiError(403, "Only admins can index the jobs of others", ErrorCodes.ADMIN_REQUIRED);
    }
    const orderBy = query.get("order_by") ?? "update_time";
    if (!(ORDER_KEYS as readonly string[]).includes(orderBy)) {
        throw ApiError.badRequest(`Input should be 'create_time' or 'update_time' in ('query', 'order_by')`);
    }
    const states = listParam(query, "state");
    const toolIds = listParam(query, "tool_id");
    const toolIdsLike = listParam(query, "tool_id_like");
    const minTime = timeParam(query, "date_range_min");
    const maxTime = timeParam(query, "date_range_max");
    const historyId = query.get("history_id");
    const icjId = query.get("implicit_collection_jobs_id");
    const limit = queryInt(query, "limit", 500, 1);
    const offset = queryInt(query, "offset", 0, 0);
    const search = query.get("search");
    if (query.get("workflow_id") || query.get("invocation_id") || query.get("tool_request_id")) {
        return [];
    }
    const searchTerms = search ? parseSearch(search, { tool: "tool", t: "tool" }).terms : [];

    return readTx([...CONTENT_STORES, "jobs"], async (tx) => {
        const all = historyId ? await jobs.listForHistory(historyId, tx) : await tx.store("jobs").getAll();
        const matched = all.filter((job) => {
            if (states && !states.includes(job.state)) {
                return false;
            }
            if (toolIds && !toolIds.includes(job.tool_id)) {
                return false;
            }
            if (toolIdsLike && !toolIdsLike.some((pattern) => sqlLike(job.tool_id, pattern))) {
                return false;
            }
            const updated = parseGalaxyTime(job.update_time);
            if ((minTime !== null && updated < minTime) || (maxTime !== null && updated > maxTime)) {
                return false;
            }
            if (icjId && job.implicit_collection_jobs_id !== icjId) {
                return false;
            }
            return searchTerms.every((term) => textMatches(job.tool_id, term.text, term.quoted));
        });
        matched.sort((a, b) => {
            const left = a[orderBy as (typeof ORDER_KEYS)[number]];
            const right = b[orderBy as (typeof ORDER_KEYS)[number]];
            return left < right ? 1 : left > right ? -1 : 0;
        });
        const page = matched.slice(offset, offset + limit);
        if (view === "element") {
            const out: EncodedJobDetails[] = [];
            for (const job of page) {
                out.push(await jobDetails(job, tx));
            }
            return out;
        }
        return page.map(jobSummary);
    });
}

// ---------------------------------------------------------------------------------------------------------
// Deletion

/**
 * Galaxy's `JobManager.stop`: marks an unfinished job `deleting` and discards its outputs; the leader tab stops the
 * Kubernetes job when it sees the change. Returns false when the job had already finished.
 */
export function stopJob(jobId: string, message?: string | null): Promise<boolean> {
    return withTransaction(JOB_STORES, "readwrite", async (tx) => {
        const job = await jobs.getOrThrow(jobId, tx);
        if (FINISHED_JOB_STATES.has(job.state)) {
            return false;
        }
        await markJobDeleted(job, tx, message || undefined);
        return true;
    });
}

// ---------------------------------------------------------------------------------------------------------
// Handlers

function readJob<R>(jobId: string, fn: (job: JobRecord, tx: ReadTx) => Promise<R>): Promise<R> {
    return readTx([...CONTENT_STORES, "jobs"], async (tx) => fn(await jobs.getOrThrow(jobId, tx), tx));
}

function consoleSlice(text: string | null, position: number, length: number): string {
    if (position < 0 || length < 0) {
        return "";
    }
    return (text ?? "").slice(position, position + length);
}

export function register(router: Router): void {
    router.route("/api/jobs", "get", jobsIndex);

    router.route("/api/jobs/{job_id}", "get", ({ params, query }) =>
        readJob(params.job_id, (job, tx) =>
            queryBool(query, "full", false) ? showFullJob(job, tx) : jobDetails(job, tx),
        ),
    );

    router.route("/api/jobs/{job_id}", "delete", async ({ params, json }) => {
        const body = (await json()) as { message?: unknown } | null;
        const message = body && typeof body.message === "string" ? body.message : null;
        return stopJob(params.job_id, message);
    });

    router.route("/api/jobs/{job_id}/inputs", "get", ({ params }) =>
        readJob(params.job_id, async (job) =>
            job.inputs
                .filter((input) => input.src === "hda")
                .map((input) => ({ name: input.name, dataset: { src: "hda" as const, id: input.id } })),
        ),
    );

    router.route("/api/jobs/{job_id}/outputs", "get", ({ params }) =>
        readJob(params.job_id, async (job) => [
            ...job.outputs.map((output) => ({ name: output.name, dataset: { src: "hda" as const, id: output.id } })),
            ...job.output_collections
                .filter((output) => output.src === "hdca")
                .map((output) => ({
                    name: output.name,
                    dataset_collection_instance: { src: "hdca" as const, id: output.id },
                })),
        ]),
    );

    router.route("/api/jobs/{job_id}/parameters_display", "get", ({ params }) =>
        readJob(params.job_id, summarizeJobParameters),
    );

    router.route("/api/jobs/{job_id}/metrics", "get", ({ params }) =>
        readJob(params.job_id, async (job) => job.metrics),
    );

    router.route("/api/jobs/{job_id}/console_output", "get", ({ params, query }) =>
        readJob(params.job_id, async (job) => {
            if (job.state !== "running") {
                return { state: job.state, stdout: job.tool_stdout, stderr: job.tool_stderr };
            }
            return {
                state: job.state,
                stdout: consoleSlice(
                    job.tool_stdout,
                    queryInt(query, "stdout_position", -1),
                    queryInt(query, "stdout_length", 0),
                ),
                stderr: consoleSlice(
                    job.tool_stderr,
                    queryInt(query, "stderr_position", -1),
                    queryInt(query, "stderr_length", 0),
                ),
            };
        }),
    );

    router.route("/api/jobs/{job_id}/common_problems", "get", ({ params }) =>
        readJob(params.job_id, async (job, tx) => {
            const seen = new Set<string>();
            let hasEmptyInputs = false;
            let hasDuplicateInputs = false;
            for (const input of job.inputs) {
                if (input.src !== "hda") {
                    continue;
                }
                const row = await hdas.getWithDataset(input.id, tx);
                if (!row) {
                    continue;
                }
                if ((row.dataset.total_size ?? row.dataset.file_size ?? 0) === 0) {
                    hasEmptyInputs = true;
                }
                if (seen.has(input.id)) {
                    hasDuplicateInputs = true;
                }
                seen.add(input.id);
            }
            return { has_empty_inputs: hasEmptyInputs, has_duplicate_inputs: hasDuplicateInputs };
        }),
    );

    router.route("/api/jobs/{job_id}/destination_params", "get", () => {
        throw new ApiError(403, "You must be an administrator to access this feature.", ErrorCodes.ADMIN_REQUIRED);
    });

    router.untyped("/api/jobs/{job_id}/build_for_rerun", "get", ({ params }) =>
        readJob(params.job_id!, async () => {
            throw new ApiError(501, NOT_YET, ErrorCodes.NOT_IMPLEMENTED);
        }),
    );
}
