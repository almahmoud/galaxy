/**
 * Tool runs (`Tool.handle_input` for `POST /api/tools`): batch expansion, validation of every job's parameters, and
 * for each job one IndexedDB transaction creating the job (state `new`), its output datasets and collections and the
 * `dispatch` outbox entry that hands it to the leader tab.
 */

import {
    collections,
    type DatasetRecord,
    type HdaRecord,
    hdas,
    type HdcaRecord,
    histories,
    JOB_STORES,
    type JobInputAssociation,
    type JobRecord,
    jobs,
    outbox,
    withTransaction,
    type WriteTx,
} from "@/planet/db";
import type { NewElement } from "@/planet/db/collections";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { newId } from "@/planet/util/ids";

import { expandIncoming } from "./batch";
import { emptyDict, InputError, ParameterValueError, type RequestContext, type StateDict } from "./context";
import { type OutputPlan, OutputPlanError, type PlannedElement, planOutputs } from "./outputs";
import { populateState, type StateErrors, stateToJobParams } from "./state";

/** The options of a tool run besides its parameters. */
export interface RunOptions {
    /** Tags added to every output (`__tags`), already normalized. */
    tags: string[];
    /** The submitted request, without `inputs`, kept on each job. */
    request: Record<string, unknown>;
}

/** What one job created. */
export interface CreatedJob {
    job: JobRecord;
    datasets: { name: string; hda: HdaRecord; dataset: DatasetRecord }[];
    collections: { name: string; hdca: HdcaRecord }[];
}

/** The jobs a run created and the errors of the jobs it could not create. */
export interface RunResult {
    jobs: CreatedJob[];
    errors: ApiError[];
}

/** `handle_incoming_errors`: one 400 response listing every rejected parameter of every job. */
function incomingError(allErrors: readonly StateErrors[]): ApiError {
    const errData = emptyDict() as Record<string, string>;
    const paramErrors = emptyDict();
    for (const errors of allErrors) {
        for (const [key, error] of Object.entries(errors)) {
            errData[key] = error.message;
            paramErrors[key] = error instanceof ParameterValueError ? error.toDict() : { message: error.message };
        }
    }
    return new ApiError(400, Object.values(errData).join(", "), ErrorCodes.USER_REQUEST_INVALID_PARAMETER, {
        err_data: errData,
        param_errors: paramErrors,
    });
}

function plannedElements(elements: readonly PlannedElement[], hdaIds: readonly string[]): NewElement[] {
    return elements.map((element) =>
        element.dataset !== undefined
            ? { identifier: element.identifier, hda_id: hdaIds[element.dataset]! }
            : {
                  identifier: element.identifier,
                  collection: {
                      collection_type: element.collectionType ?? "list",
                      elements: plannedElements(element.elements ?? [], hdaIds),
                  },
              },
    );
}

function uniqueTags(tags: readonly string[]): string[] {
    return [...new Set(tags)];
}

/** Rejects inputs that were deleted or purged since the run was validated. */
async function checkInputs(plan: OutputPlan, tx: WriteTx): Promise<void> {
    for (const input of plan.inputDatasets) {
        if (!input.item) {
            continue;
        }
        const hda = await tx.store("hdas").get(input.item.id);
        if (!hda || hda.purged) {
            throw ApiError.badRequest(`Input dataset ${input.item.hid} is no longer available.`);
        }
    }
    for (const input of plan.inputCollections) {
        const hdca = await tx.store("hdcas").get(input.item.id);
        if (!hdca || hdca.deleted) {
            throw ApiError.badRequest(`Input collection ${input.item.hid} is no longer available.`);
        }
    }
}

/** Creates one job with its outputs and dispatch entry in `tx`. */
async function createJob(
    rc: RequestContext,
    historyId: string,
    state: StateDict,
    incoming: Record<string, unknown>,
    plan: OutputPlan,
    options: RunOptions,
    tx: WriteTx,
): Promise<CreatedJob> {
    await checkInputs(plan, tx);
    const jobId = newId();
    const outputTags = uniqueTags([...plan.tags, ...options.tags]);
    const count = plan.hidOrder.length;
    let nextHid = count ? await histories.allocateHids(historyId, count, tx) : 0;
    const hids = { datasets: new Map<number, number>(), collections: new Map<number, number>() };
    for (const entry of plan.hidOrder) {
        (entry.kind === "dataset" ? hids.datasets : hids.collections).set(entry.index, nextHid++);
    }
    const createdDatasets: CreatedJob["datasets"] = [];
    for (const [index, planned] of plan.datasets.entries()) {
        const { hda, dataset } = await hdas.createWithDataset(
            {
                history_id: historyId,
                hid: hids.datasets.get(index),
                name: planned.hdaName,
                extension: planned.extension,
                dbkey: planned.dbkey,
                visible: planned.visible,
                blurb: "queued",
                metadata: planned.metadata,
                tags: outputTags,
                creating_job_id: jobId,
            },
            { state: "new", job_id: jobId, created_from_basename: planned.createdFromBasename },
            tx,
        );
        createdDatasets.push({ name: planned.name, hda, dataset });
    }
    const hdaIds = createdDatasets.map(({ hda }) => hda.id);
    const createdCollections: CreatedJob["collections"] = [];
    for (const [index, planned] of plan.collections.entries()) {
        const { hdca } = await collections.createHdca(
            {
                hdca: {
                    history_id: historyId,
                    hid: hids.collections.get(index),
                    name: planned.hdcaName,
                    tags: outputTags,
                    implicit_output_name: planned.name,
                    job_source_id: jobId,
                    job_source_type: "Job",
                },
                collection: {
                    collection_type: planned.collectionType,
                    populated_state: planned.populated ? "ok" : "new",
                    elements: plannedElements(planned.elements, hdaIds),
                },
            },
            tx,
        );
        createdCollections.push({ name: planned.name, hdca });
    }
    const inputs: JobInputAssociation[] = [
        ...plan.inputCollections.map((input) => ({ name: input.name, src: "hdca" as const, id: input.item.id })),
        ...plan.inputDatasets
            .filter((input) => input.item !== null)
            .map((input) => ({ name: input.name, src: "hda" as const, id: input.item!.id })),
    ];
    const params = stateToJobParams(rc.tool.inputs, state, rc);
    params.dbkey = plan.dbkey;
    params.__input_ext = plan.inputExt;
    const job = await jobs.create(
        {
            id: jobId,
            tool_id: rc.tool.id,
            tool_version: rc.tool.version,
            history_id: historyId,
            state: "new",
            params,
            request: { ...options.request, inputs: incoming },
            inputs,
            outputs: createdDatasets.map(({ name, hda }) => ({ name, src: "hda" as const, id: hda.id })),
            output_collections: createdCollections.map(({ name, hdca }) => ({
                name,
                src: "hdca" as const,
                id: hdca.id,
            })),
        },
        tx,
    );
    await outbox.enqueue({ kind: "dispatch", job_id: job.id }, tx);
    return { job, datasets: createdDatasets, collections: createdCollections };
}

function asApiError(error: unknown): ApiError {
    if (error instanceof ApiError) {
        return error;
    }
    if (error instanceof OutputPlanError || error instanceof InputError || error instanceof ParameterValueError) {
        return new ApiError(400, error.message, ErrorCodes.TOOL_EXECUTION_ERROR);
    }
    throw error;
}

/**
 * Runs the tool of `rc` with the flat form parameters `incoming` in the history of `rc`: one job per batch value.
 * Every job's parameters are validated before any job is created.
 *
 * @throws ApiError 400 with `err_data` and `param_errors` when parameters are rejected, or the first job's error when
 * no job could be created
 */
export async function runTool(
    rc: RequestContext,
    incoming: Record<string, unknown>,
    options: RunOptions,
): Promise<RunResult> {
    const history = rc.snapshot.history;
    if (!history) {
        throw ApiError.missingParameter("A valid history is required to execute tools.");
    }
    const expanded = expandIncoming(rc.tool, incoming, rc);
    const populated = expanded.map((values) => ({ values, ...populateState(rc.tool.inputs, values, rc) }));
    if (populated.some(({ errors }) => Object.keys(errors).length > 0)) {
        throw incomingError(populated.map(({ errors }) => errors));
    }
    const result: RunResult = { jobs: [], errors: [] };
    for (const { values, state } of populated) {
        try {
            const plan = planOutputs(rc, state);
            const created = await withTransaction(JOB_STORES, "readwrite", (tx) =>
                createJob(rc, history.id, state, toJson(values), plan, options, tx),
            );
            result.jobs.push(created);
        } catch (error) {
            result.errors.push(asApiError(error));
        }
    }
    const [firstError] = result.errors;
    if (result.jobs.length === 0 && firstError) {
        throw firstError;
    }
    return result;
}

/** A plain JSON copy of submitted values. */
function toJson(values: Record<string, unknown>): Record<string, unknown> {
    const out = emptyDict();
    for (const [key, value] of Object.entries(values)) {
        out[key] = JSON.parse(JSON.stringify(value ?? null)) as unknown;
    }
    return out;
}
