/**
 * Tool runs (`Tool.handle_input` for `POST /api/tools`): batch expansion, validation of every job's parameters, and
 * the IndexedDB writes creating each job (state `new`), its output datasets and collections and the `dispatch` outbox
 * entry that hands it to the leader tab. Ordinary runs write each job in its own transaction.
 *
 * A run over the elements of collections (`./mapover`) writes all its jobs in one transaction together with one
 * implicit collection per output (`ExecutionTracker.precreate_output_collections`): an HDCA with the shape of the
 * mapped collections whose leaves are the jobs' outputs, its `job_source_type` `ImplicitCollectionJobs` and its
 * `job_source_id` the id every job carries as `implicit_collection_jobs_id`. A mapped job's datasets are hidden; its
 * collection outputs are hidden HDCAs whose collections are the implicit collection's leaves, so a job fills them
 * (ingest populates collections in place) and the implicit collection with them.
 *
 * Collection operations (`./operations`) run here: their jobs are `ok` when created and nothing is dispatched.
 */

import {
    buildCollection,
    buildDce,
    type CollectionRecord,
    collections,
    type DatasetRecord,
    type DceRecord,
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
import { isInstalledArchiveKey } from "@/planet/install/keys";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { newId } from "@/planet/util/ids";

import { expandIncoming } from "./batch";
import type { BundleOutput } from "./bundle";
import { emptyDict, InputError, ParameterValueError, type RequestContext, type StateDict } from "./context";
import { collectionDatasets, type CollectionItem, isHistoryItem } from "./history";
import { compatibleShape, type MapOver, type Structure, structureOf } from "./mapover";
import { checkOperationAvailable, isCollectionOperation, planOperation } from "./operations";
import {
    implicitCollectionName,
    mappedOnText,
    type OutputPlan,
    OutputPlanError,
    type PlannedElement,
    planOutputs,
} from "./outputs";
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
    /** The job's output datasets. */
    datasets: { name: string; hda: HdaRecord; dataset: DatasetRecord }[];
    collections: { name: string; hdca: HdcaRecord }[];
}

/** The jobs a run created, the collections of a map-over and the errors of the jobs it could not create. */
export interface RunResult {
    jobs: CreatedJob[];
    /** One per output of a map-over (`implicit_collections`). */
    implicitCollections: { name: string; hdca: HdcaRecord }[];
    errors: ApiError[];
}

/** `finalize_dataset_collections`: the state message of a map-over's collections when some jobs were not created. */
export const POPULATION_FAILED = "One or more jobs failed during dataset initialization.";

/** Job creation also reads `tools`, so an uninstall commits either before it or after the jobs it must wait for. */
const RUN_STORES = [...JOB_STORES, "tools"] as const;

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
    return elements.map((element): NewElement => {
        const columns = element.columns ?? null;
        if (element.dataset !== undefined) {
            return { identifier: element.identifier, hda_id: hdaIds[element.dataset]!, columns };
        }
        if (element.hdaId !== undefined) {
            return { identifier: element.identifier, hda_id: element.hdaId, columns };
        }
        return {
            identifier: element.identifier,
            columns,
            collection: {
                collection_type: element.collectionType ?? "list",
                elements: plannedElements(element.elements ?? [], hdaIds),
            },
        };
    });
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
        const available =
            input.item.src === "hdca"
                ? (await tx.store("hdcas").get(input.item.id))?.deleted === false
                : (await tx.store("dces").get(input.item.id)) !== undefined;
        if (!available) {
            throw ApiError.badRequest(
                input.item.src === "hdca"
                    ? `Input collection ${input.item.hid} is no longer available.`
                    : `Input collection element '${input.item.name}' is no longer available.`,
            );
        }
    }
}

/** How a job is created: by a collection operation, and as part of a map-over. */
interface JobKind {
    operation: boolean;
    /** The id shared by the jobs of a map-over (`ImplicitCollectionJobs`). */
    implicitCollectionJobsId: string | null;
}

/** An output dataset: a new dataset, or for collection operations a copy of an existing HDA sharing its dataset. */
async function createDataset(
    planned: OutputPlan["datasets"][number],
    historyId: string,
    hid: number | undefined,
    jobId: string,
    tags: string[],
    tx: WriteTx,
): Promise<{ hda: HdaRecord; dataset: DatasetRecord }> {
    if (planned.copyOf === undefined) {
        return hdas.createWithDataset(
            {
                history_id: historyId,
                hid,
                name: planned.hdaName,
                extension: planned.extension,
                dbkey: planned.dbkey,
                visible: planned.visible,
                blurb: "queued",
                metadata: planned.metadata,
                tags,
                creating_job_id: jobId,
            },
            { state: "new", job_id: jobId, created_from_basename: planned.createdFromBasename },
            tx,
        );
    }
    const source = await tx.store("hdas").get(planned.copyOf);
    const dataset = source && (await tx.store("datasets").get(source.dataset_id));
    if (!source || !dataset || source.purged) {
        throw ApiError.badRequest(`Input dataset ${source?.hid ?? planned.copyOf} is no longer available.`);
    }
    const hda = await hdas.create(
        {
            ...source,
            id: undefined,
            hid,
            history_id: historyId,
            visible: planned.visible,
            tags,
            copied_from: { src: "hda", id: source.id },
            // Copies in collections keep the job that made their dataset, as Galaxy's copies do.
            creating_job_id: planned.element ? source.creating_job_id : jobId,
        },
        tx,
    );
    return { hda, dataset };
}

/** Refuses jobs of an installed tool version (one with an install archive) that is no longer installed. */
async function checkInstalled(rc: RequestContext, tx: WriteTx): Promise<void> {
    if (!isInstalledArchiveKey(rc.tool.source?.repo_tar?.path)) {
        return;
    }
    const record = await tx.store("tools").get([rc.tool.id, rc.tool.version]);
    if (record?.source !== "installed" || record.status !== "ready") {
        throw ApiError.notFound(`Tool ${rc.tool.id} ${rc.tool.version} is not installed.`);
    }
}

/** Creates one job with its outputs and, unless it is a collection operation, its dispatch entry in `tx`. */
async function createJob(
    rc: RequestContext,
    historyId: string,
    state: StateDict,
    incoming: Record<string, unknown>,
    plan: OutputPlan,
    options: RunOptions,
    kind: JobKind,
    tx: WriteTx,
): Promise<CreatedJob> {
    await checkInstalled(rc, tx);
    await checkInputs(plan, tx);
    const jobId = newId();
    const mapped = kind.implicitCollectionJobsId !== null;
    const outputTags = uniqueTags([...plan.tags, ...options.tags]);
    const count = plan.hidOrder.length;
    let nextHid = count ? await histories.allocateHids(historyId, count, tx) : 0;
    const hids = { datasets: new Map<number, number>(), collections: new Map<number, number>() };
    for (const entry of plan.hidOrder) {
        (entry.kind === "dataset" ? hids.datasets : hids.collections).set(entry.index, nextHid++);
    }
    const hdaIds: string[] = [];
    const createdDatasets: CreatedJob["datasets"] = [];
    for (const [index, planned] of plan.datasets.entries()) {
        const tags =
            planned.copyOf === undefined
                ? outputTags
                : uniqueTags([...(planned.tags ?? []), ...(planned.element ? [] : options.tags)]);
        const { hda, dataset } = await createDataset(
            { ...planned, visible: planned.visible && !mapped },
            historyId,
            hids.datasets.get(index),
            jobId,
            tags,
            tx,
        );
        hdaIds.push(hda.id);
        // The datasets a collection operation copies into its collections are not outputs of its job.
        if (!(kind.operation && planned.element)) {
            createdDatasets.push({ name: planned.name, hda, dataset });
        }
    }
    const createdCollections: CreatedJob["collections"] = [];
    for (const [index, planned] of plan.collections.entries()) {
        const { hdca } = await collections.createHdca(
            {
                hdca: {
                    history_id: historyId,
                    hid: hids.collections.get(index),
                    name: planned.hdcaName,
                    visible: !mapped,
                    tags: outputTags,
                    implicit_output_name: planned.name,
                    job_source_id: jobId,
                    job_source_type: "Job",
                },
                collection: {
                    collection_type: planned.collectionType,
                    populated_state: planned.populated ? "ok" : "new",
                    column_definitions: planned.columnDefinitions ?? null,
                    elements: plannedElements(planned.elements, hdaIds),
                },
            },
            tx,
        );
        createdCollections.push({ name: planned.name, hdca });
    }
    const inputs: JobInputAssociation[] = [
        ...plan.inputCollections.map((input) => ({ name: input.name, src: input.item.src, id: input.item.id })),
        ...plan.inputDatasets
            .filter((input) => input.item !== null)
            .map((input) => ({ name: input.name, src: "hda" as const, id: input.item!.id })),
    ];
    const params = stateToJobParams(rc.tool.inputs, state, rc);
    params.dbkey = plan.dbkey;
    params.__input_ext = plan.inputExt;
    for (const input of plan.inputDatasets) {
        // `DefaultToolAction.execute`: the element identifier of each dataset a run maps over.
        if (input.item?.elementIdentifier !== undefined) {
            params[`${input.name}|__identifier__`] = input.item.elementIdentifier;
        }
    }
    const job = await jobs.create(
        {
            id: jobId,
            tool_id: rc.tool.id,
            tool_version: rc.tool.version,
            history_id: historyId,
            state: kind.operation ? "ok" : "new",
            params,
            request: { ...options.request, inputs: incoming },
            inputs,
            outputs: createdDatasets.map(({ name, hda }) => ({ name, src: "hda" as const, id: hda.id })),
            output_collections: createdCollections.map(({ name, hdca }) => ({
                name,
                src: "hdca" as const,
                id: hdca.id,
            })),
            implicit_collection_jobs_id: kind.implicitCollectionJobsId,
        },
        tx,
    );
    if (!kind.operation) {
        await outbox.enqueue({ kind: "dispatch", job_id: job.id }, tx);
    }
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

// ---------------------------------------------------------------------------------------------------------
// Map-over

/** A job of a run, planned and ready to be created. */
interface PlannedJob {
    values: Record<string, unknown>;
    state: StateDict;
    plan: OutputPlan;
}

/** An output a map-over collects into an implicit collection; `leafType` is the type of a collection output. */
interface ImplicitOutput {
    name: string;
    leafType: string | null;
}

/** The outputs the first job creates, in tool output order (`filter_output` over the example parameters). */
function implicitOutputs(rc: RequestContext, plan: OutputPlan): ImplicitOutput[] {
    const out: ImplicitOutput[] = [];
    for (const output of rc.tool.outputs) {
        const collection = plan.collections.find((planned) => planned.name === output.name);
        if (collection) {
            out.push({ name: output.name, leafType: collection.collectionType });
        } else if (plan.datasets.some((planned) => planned.name === output.name && !planned.element)) {
            out.push({ name: output.name, leafType: null });
        }
    }
    return out;
}

/** What a leaf of an implicit collection holds. */
type Leaf = { hda_id: string } | { child_collection_id: string } | null;

/**
 * Inserts the collections of `structure` (`precreate_dataset_collection`): one per level, typed with the mapped
 * structure followed by `leafType`, whose leaves are given by `leaf` in walk order.
 */
async function insertStructure(
    structure: Structure,
    leafType: string | null,
    leaf: (index: number) => Leaf,
    counter: { next: number },
    tx: WriteTx,
): Promise<CollectionRecord> {
    const collection = buildCollection(
        {
            collection_type: leafType ? `${structure.collectionType}:${leafType}` : structure.collectionType,
            populated_state: "ok",
            column_definitions: structure.columnDefinitions,
        },
        tx.now,
    );
    const dces: DceRecord[] = [];
    for (const child of structure.children) {
        const base = {
            collection_id: collection.id,
            element_index: dces.length,
            element_identifier: child.identifier,
            columns: child.columns,
        };
        if (child.child) {
            const nested = await insertStructure(child.child, leafType, leaf, counter, tx);
            dces.push(buildDce({ ...base, element_type: "dataset_collection", child_collection_id: nested.id }));
            continue;
        }
        const target = leaf(counter.next++);
        if (target && "hda_id" in target) {
            dces.push(buildDce({ ...base, element_type: "hda", hda_id: target.hda_id }));
        } else if (target) {
            dces.push(buildDce({ ...base, element_type: "dataset_collection", ...target }));
        }
    }
    collection.element_count = dces.length;
    await tx.store("collections").add(collection);
    for (const dce of dces) {
        await tx.store("dces").add(dce);
    }
    return collection;
}

/**
 * `_structure_for_output`: a data output's implicit collection takes its identifiers from the mapped collection its
 * `default_identifier_source` names, when that collection has the run's shape.
 */
function identifierStructure(mapOver: MapOver, definition: BundleOutput): Structure {
    const source = definition.default_identifier_source;
    const input = typeof source === "string" ? mapOver.inputs.find((item) => item.key === source) : undefined;
    if (!input) {
        return mapOver.structure;
    }
    const content = input.item.collection;
    const own = structureOf(content, content.collectionType);
    return compatibleShape(mapOver.structure, own) ? own : mapOver.structure;
}

/** `auto_propagated_tags` of the collections a run maps over: their `name:` tags (a DCE's are its first dataset's). */
function mappedTags(items: readonly CollectionItem[]): string[] {
    const tags = items.flatMap((item) =>
        item.src === "hdca" ? item.tags : (collectionDatasets(item.collection)[0]?.tags ?? []),
    );
    return uniqueTags(
        tags
            .map((tag) => (tag.startsWith("#") ? `name:${tag.slice(1)}` : tag))
            .filter((tag) => tag.startsWith("name:")),
    );
}

/**
 * Creates the jobs of a map-over and its implicit collections in `tx`. Implicit collections get their hids first, as
 * Galaxy creates them before the jobs; `planned` holds an error for each job that could not be planned.
 */
async function createMapOver(
    rc: RequestContext,
    historyId: string,
    mapOver: MapOver,
    planned: readonly (PlannedJob | ApiError)[],
    options: RunOptions,
    operation: boolean,
    tx: WriteTx,
): Promise<Pick<RunResult, "jobs" | "implicitCollections">> {
    const example = planned.find((job): job is PlannedJob => !(job instanceof ApiError))!;
    const outputs = implicitOutputs(rc, example.plan);
    const firstHid = outputs.length ? await histories.allocateHids(historyId, outputs.length, tx) : 0;
    const kind: JobKind = { operation, implicitCollectionJobsId: newId() };
    const created: (CreatedJob | null)[] = [];
    for (const job of planned) {
        created.push(
            job instanceof ApiError
                ? null
                : await createJob(rc, historyId, job.state, toJson(job.values), job.plan, options, kind, tx),
        );
    }
    const linked = mapOver.inputs.filter((input) => input.linked);
    const mapped = new Map(linked.map((input) => [input.key, input.item]));
    const onText = mappedOnText(linked.map((input) => input.item));
    const tags = mappedTags(linked.map((input) => input.item));
    const failed = created.some((job) => job === null);
    const implicitCollections: RunResult["implicitCollections"] = [];
    for (const [index, output] of outputs.entries()) {
        const leaf = (jobIndex: number): Leaf => {
            const job = created[jobIndex];
            if (!job) {
                return null;
            }
            if (output.leafType === null) {
                const dataset = job.datasets.find((item) => item.name === output.name);
                return dataset ? { hda_id: dataset.hda.id } : null;
            }
            const collection = job.collections.find((item) => item.name === output.name);
            return collection ? { child_collection_id: collection.hdca.collection_id } : null;
        };
        const definition = rc.tool.outputs.find((item) => item.name === output.name)!;
        const structure = output.leafType === null ? identifierStructure(mapOver, definition) : mapOver.structure;
        const collection = await insertStructure(structure, output.leafType, leaf, { next: 0 }, tx);
        if (failed) {
            await tx
                .store("collections")
                .put({ ...collection, populated_state: "failed", populated_state_message: POPULATION_FAILED });
        }
        const { hdca } = await collections.createHdca(
            {
                hdca: {
                    history_id: historyId,
                    hid: firstHid + index,
                    collection_id: collection.id,
                    name: implicitCollectionName(rc, definition, example.state, example.plan, mapped, onText),
                    tags,
                    implicit_output_name: output.name,
                    job_source_id: kind.implicitCollectionJobsId,
                    job_source_type: "ImplicitCollectionJobs",
                },
            },
            tx,
        );
        implicitCollections.push({ name: output.name, hdca });
    }
    return { jobs: created.filter((job): job is CreatedJob => job !== null), implicitCollections };
}

// ---------------------------------------------------------------------------------------------------------
// Runs

/**
 * Runs the tool of `rc` with the flat form parameters `incoming` in the history of `rc`: one job per batch value or
 * element of the collections it maps over. Every job's parameters are validated before any job is created.
 *
 * @throws ApiError 400 with `err_data` and `param_errors` when parameters are rejected, when inputs are not ready,
 *   or the first job's error when no job could be created
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
    const operation = isCollectionOperation(rc);
    if (operation) {
        checkOperationAvailable(rc);
    }
    const expanded = expandIncoming(rc.tool, incoming, rc);
    const populated = expanded.combos.map((values) => ({ values, ...populateState(rc.tool.inputs, values, rc) }));
    if (populated.some(({ errors }) => Object.keys(errors).length > 0)) {
        throw incomingError(populated.map(({ errors }) => errors));
    }
    const planned = populated.map(({ values, state }): PlannedJob | ApiError => {
        try {
            return { values, state, plan: operation ? planOperation(rc, state) : planOutputs(rc, state) };
        } catch (error) {
            const apiError = asApiError(error);
            // `ToolInputsNotReadyException` fails the whole run; other errors fail one job.
            if (apiError.errCode === ErrorCodes.TOOL_INPUTS_NOT_READY) {
                throw apiError;
            }
            return apiError;
        }
    });
    if (expanded.mapOver && planned.length === 0) {
        throw ApiError.badRequest("The collections this run maps over have no elements.");
    }
    const result: RunResult = { jobs: [], implicitCollections: [], errors: [] };
    result.errors = planned.filter((job): job is ApiError => job instanceof ApiError);
    if (expanded.mapOver && result.errors.length < planned.length) {
        const mapOver = expanded.mapOver;
        Object.assign(
            result,
            await withTransaction(RUN_STORES, "readwrite", (tx) =>
                createMapOver(rc, history.id, mapOver, planned, options, operation, tx),
            ),
        );
    } else if (!expanded.mapOver) {
        const kind: JobKind = { operation, implicitCollectionJobsId: null };
        for (const job of planned) {
            if (job instanceof ApiError) {
                continue;
            }
            try {
                const created = await withTransaction(RUN_STORES, "readwrite", (tx) =>
                    createJob(rc, history.id, job.state, toJson(job.values), job.plan, options, kind, tx),
                );
                result.jobs.push(created);
            } catch (error) {
                result.errors.push(asApiError(error));
            }
        }
    }
    const [firstError] = result.errors;
    if (result.jobs.length === 0 && firstError) {
        throw firstError;
    }
    return result;
}

/** A plain JSON copy of submitted values; history items become `{src, id}` references. */
function toJson(values: Record<string, unknown>): Record<string, unknown> {
    const out = emptyDict();
    for (const [key, value] of Object.entries(values)) {
        out[key] = JSON.parse(
            JSON.stringify(value ?? null, (_, item: unknown) =>
                isHistoryItem(item) ? { src: item.src, id: item.id } : item,
            ),
        ) as unknown;
    }
    return out;
}
