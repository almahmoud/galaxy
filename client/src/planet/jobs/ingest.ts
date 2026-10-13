/**
 * Ingest of what a job's pod wrote (leader responsibility 6 of notes/phase34-contracts.md): the output decisions of
 * `prepare.json`, the datasets, collections and job fields of `results.json`, and failures of pods that left no
 * results, recorded the way Galaxy's job finishing (`JobWrapper.finish`, `_finish_dataset`) and `JobWrapper.fail`
 * record them. Each function writes IndexedDB in one transaction over `JOB_STORES` and may be called again.
 */

import {
    buildDce,
    type CollectionRecord,
    collections,
    type DatasetRecord,
    datasets,
    type HdaRecord,
    hdas,
    JOB_STORES,
    type JobMetricRecord,
    type JobOutputAssociation,
    type JobRecord,
    jobs,
    type MetadataFileRecord,
    type ReadTx,
    readTx,
    type WriteTx,
    writeTx,
} from "@/planet/db";
import type { NewCollectionTree, NewElement } from "@/planet/db/collections";

import type { JobDeps } from "./deps";
import { datasetObjectKeys, jobObjectKeys, metadataFileKey } from "./keys";
import { jobKind } from "./manifest";
import {
    abortMultipartUploads,
    completeMultipartUpload,
    type DispatchRecord,
    METADATA_FILE_POOL,
    type MultipartUpload,
    readDispatchRecord,
    readJson,
} from "./objects";
import {
    type CollectionResult,
    type CollectionResultElement,
    type DatasetResult,
    parsePrepare,
    parseResults,
    type PrepareDocument,
    ProtocolError,
    type ResultJobMessage,
    type ResultsDocument,
} from "./schemas";

/** A pod failure the leader classified; `message` is shown to the user (Galaxy's runner messages where they exist). */
export interface JobFailure {
    reason:
        | "oom"
        | "walltime"
        | "image_not_found"
        | "image_pull"
        | "wrong_architecture"
        | "rejected"
        | "unschedulable"
        | "evicted"
        | "deleted"
        | "stage_in"
        | "stage_out"
        | "unknown";
    message: string;
    /** The tool container's log, which holds the tool's stdout and stderr. */
    toolStdout?: string;
    toolStderr?: string;
    /** Infrastructure detail (container states, events) for the job's stderr. */
    detail?: string;
}

export interface IngestOutcome {
    state: "ok" | "error";
    /** Datasets the job wrote, discovered ones included. */
    datasetIds: string[];
    /** Their history datasets. */
    hdaIds: string[];
}

/** `prepare.json` of the job's current attempt. */
export type PrepareRecord = PrepareDocument;

/** Galaxy's `DATABASE_MAX_STRING_SIZE`: job streams are shortened to this many characters. */
export const STREAM_LIMIT = 32768;
const STREAM_JOIN = "\n..\n";

/** `StdioErrorLevel.FATAL` and `FATAL_OOM`. */
const FATAL = 3;
const FATAL_OOM = 4;

/** Messages for failures that arrive without one; Galaxy's Kubernetes runner wording where it has one. */
export const FAILURE_MESSAGES: Record<JobFailure["reason"], string> = {
    oom: "Tool failed due to insufficient memory. Try with more memory.",
    walltime: "Job was active longer than specified deadline",
    unschedulable: "Job was unschedulable longer than specified deadline",
    unknown: "An unknown error occurred with this job. See standard output within the info section for details.",
    image_not_found: "The tool's container image does not exist.",
    image_pull: "The tool's container image could not be pulled.",
    wrong_architecture: "The tool's container image cannot run on the cluster's nodes.",
    rejected: "The cluster refused to run the job.",
    evicted: "The cluster evicted the job's pod before the job finished.",
    deleted: "The Kubernetes Job running this job was deleted before the job finished.",
    stage_in: "Preparing the job in the cluster failed.",
    stage_out: "Finishing the job in the cluster failed.",
};

/** Jobs in these states are settled; results and failures arriving later change nothing. */
const SETTLED_STATES: ReadonlySet<string> = new Set(["ok", "error", "deleted", "deleting"]);

// ---------------------------------------------------------------------------------------------------------
// prepare.json

async function readCurrentPrepare(
    job: JobRecord,
    dispatch: DispatchRecord | null,
    deps: JobDeps,
): Promise<PrepareDocument | null> {
    const value = await readJson(deps.s3, jobObjectKeys(job.id).prepare, deps.signal);
    if (value === null) {
        return null;
    }
    const prepare = parsePrepare(value);
    if (prepare.job_id !== undefined && prepare.job_id !== job.id) {
        throw new ProtocolError("prepare.json", "/job_id", `belongs to job ${prepare.job_id}`);
    }
    if (dispatch && prepare.attempt !== undefined && prepare.attempt !== dispatch.attempt) {
        return null;
    }
    return prepare;
}

/**
 * Reads `prepare.json` of the current attempt and, the first time a successful one is read, applies its output
 * decisions as Galaxy makes them when it creates a job: filtered outputs are removed (deleted, hidden and their
 * datasets discarded), formats and labels replace the provisional ones, and the command line is stored. The job's
 * `command_line` marks the decisions as applied.
 *
 * @returns the document (also when stage-in failed), or null when the current attempt has not written one
 * @throws ProtocolError when the document does not follow the protocol
 */
export async function readPrepare(job: JobRecord, deps: JobDeps): Promise<PrepareRecord | null> {
    const dispatch = await readDispatchRecord(deps.s3, job.id, deps.signal);
    const prepare = await readCurrentPrepare(job, dispatch, deps);
    if (prepare?.state === "ok" && jobKind(job) === "tool") {
        await writeTx(JOB_STORES, async (tx) => {
            const current = await jobs.get(job.id, tx);
            if (current && current.command_line === null && !SETTLED_STATES.has(current.state)) {
                const outputs = await applyDecisions(tx, current, prepare);
                await jobs.update(current.id, { outputs, command_line: prepare.command_line ?? "" }, tx);
            }
        });
    }
    return prepare;
}

/** Applies prepare.json's output decisions; returns the job's outputs without the filtered ones. */
async function applyDecisions(tx: WriteTx, job: JobRecord, prepare: PrepareDocument): Promise<JobOutputAssociation[]> {
    const decisions = prepare.outputs ?? {};
    const kept: JobOutputAssociation[] = [];
    for (const output of job.outputs) {
        const decision = Object.hasOwn(decisions, output.name) ? decisions[output.name] : undefined;
        if (decision?.filtered) {
            await filterOutput(tx, output.id);
            continue;
        }
        kept.push(output);
        if (decision) {
            const hda = await hdas.get(output.id, tx);
            if (hda) {
                await hdas.update(hda.id, { name: decision.label, extension: decision.format ?? hda.extension }, tx);
            }
        }
    }
    for (const output of job.output_collections) {
        const decision = Object.hasOwn(decisions, output.name) ? decisions[output.name] : undefined;
        if (decision && output.src === "hdca" && (await collections.getHdca(output.id, tx))) {
            await collections.updateHdca(output.id, { name: decision.label }, tx);
        }
    }
    return kept;
}

/** An output a `<filter>` rejected: Galaxy never creates it, so it leaves the history and holds no data. */
async function filterOutput(tx: WriteTx, hdaId: string): Promise<void> {
    const hda = await hdas.get(hdaId, tx);
    if (!hda) {
        return;
    }
    await hdas.update(hda.id, { deleted: true, purged: true, visible: false }, tx);
    await datasets.update(hda.dataset_id, { state: "discarded", deleted: true, purged: true }, tx);
}

// ---------------------------------------------------------------------------------------------------------
// results.json

/**
 * Ingests the current attempt's `results.json`: completes the multipart uploads of outputs from the reported
 * ETags (and aborts unused ones), updates the output datasets and every history copy, creates history datasets
 * for discovered datasets (hids allocated now, in slot order), populates output collections and stores the job's
 * state, exit code, streams, command line, messages and metrics. A job that is already settled is left unchanged.
 *
 * @returns null when the current attempt has written no results yet
 * @throws ProtocolError when results.json does not follow the protocol
 */
export async function ingestResults(job: JobRecord, deps: JobDeps): Promise<IngestOutcome | null> {
    const value = await readJson(deps.s3, jobObjectKeys(job.id).results, deps.signal);
    if (value === null) {
        return null;
    }
    const results = parseResults(value);
    if (results.job_id !== job.id) {
        throw new ProtocolError("results.json", "/job_id", `belongs to job ${results.job_id}`);
    }
    const dispatch = await readDispatchRecord(deps.s3, job.id, deps.signal);
    if (dispatch && results.attempt !== dispatch.attempt) {
        return null;
    }
    const current = await jobs.get(job.id);
    if (!current) {
        return null;
    }
    if (SETTLED_STATES.has(current.state)) {
        return readTx(JOB_STORES, (tx) => settledOutcome(tx, current));
    }
    // Labels and filters come from prepare.json when the leader did not read it while the job ran.
    const prepare =
        jobKind(current) === "tool" && current.command_line === null
            ? await readCurrentPrepare(current, dispatch, deps).catch((error: unknown) => {
                  if (error instanceof ProtocolError) {
                      return null;
                  }
                  throw error;
              })
            : null;
    const uploadErrors = await settleMultipart(deps, dispatch, results);
    return writeTx(JOB_STORES, (tx) => applyResults(tx, job.id, results, { prepare, dispatch, uploadErrors }));
}

/** Completes the multipart uploads the pod used and aborts the others; returns errors by output name. */
async function settleMultipart(
    deps: JobDeps,
    dispatch: DispatchRecord | null,
    results: ResultsDocument,
): Promise<Map<string, string>> {
    const errors = new Map<string, string>();
    const unused: MultipartUpload[] = [];
    for (const upload of dispatch?.multipart ?? []) {
        const record = Object.hasOwn(results.outputs, upload.output) ? results.outputs[upload.output] : undefined;
        const data = record?.data;
        if (record?.uuid !== upload.uuid || data?.mode !== "multipart") {
            unused.push(upload);
            continue;
        }
        try {
            await completeMultipartUpload(deps.s3, upload, data.parts ?? [], deps.signal);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            errors.set(upload.output, `The dataset's data could not be stored: ${reason}`);
        }
    }
    await abortMultipartUploads(deps.s3, unused, deps.signal);
    return errors;
}

interface ResultsContext {
    prepare: PrepareDocument | null;
    dispatch: DispatchRecord | null;
    uploadErrors: Map<string, string>;
}

async function settledOutcome(tx: ReadTx, job: JobRecord): Promise<IngestOutcome> {
    const datasetIds: string[] = [];
    const hdaIds: string[] = [];
    for (const output of job.outputs) {
        const hda = await hdas.get(output.id, tx);
        if (hda) {
            hdaIds.push(hda.id);
            datasetIds.push(hda.dataset_id);
        }
    }
    return { state: job.state === "ok" ? "ok" : "error", datasetIds, hdaIds };
}

async function applyResults(
    tx: WriteTx,
    jobId: string,
    results: ResultsDocument,
    context: ResultsContext,
): Promise<IngestOutcome> {
    const job = await jobs.get(jobId, tx);
    if (!job) {
        return { state: results.state, datasetIds: [], hdaIds: [] };
    }
    if (SETTLED_STATES.has(job.state)) {
        return settledOutcome(tx, job);
    }
    const kind = jobKind(job);
    let outputs = job.outputs;
    let commandLine = job.command_line;
    if (context.prepare?.state === "ok" && commandLine === null) {
        outputs = await applyDecisions(tx, job, context.prepare);
        commandLine = context.prepare.command_line ?? null;
    }
    const filtered = new Set(results.filtered_outputs);
    for (const output of outputs.filter((item) => filtered.has(item.name))) {
        await filterOutput(tx, output.id);
    }
    outputs = outputs.filter((item) => !filtered.has(item.name));

    let state = results.state;
    const datasetIds: string[] = [];
    const hdaIds: string[] = [];
    const finishMessage = results.job_messages.find((message) => message.desc)?.desc ?? results.errors[0];
    if (kind === "set_metadata") {
        for (const input of job.inputs.filter((item) => item.src === "hda")) {
            const record = Object.hasOwn(results.outputs, input.name) ? results.outputs[input.name]! : null;
            const hda = await applyMetadataRecord(tx, input.id, record);
            if (hda) {
                hdaIds.push(hda.id);
                datasetIds.push(hda.dataset_id);
            }
        }
    } else {
        for (const output of outputs) {
            const record = Object.hasOwn(results.outputs, output.name) ? results.outputs[output.name]! : null;
            const uploadError = context.uploadErrors.get(output.name);
            const hda = await hdas.get(output.id, tx);
            if (!hda) {
                continue;
            }
            hdaIds.push(hda.id);
            datasetIds.push(hda.dataset_id);
            if (!record || uploadError) {
                state = "error";
                await failOutput(
                    tx,
                    hda,
                    uploadError ?? finishMessage ?? "The job's pod reported no result for this dataset.",
                );
            } else if (!(await applyOutputRecord(tx, hda, record))) {
                state = "error";
            }
        }
    }

    const discovered = await createDiscovered(tx, job, results, context.dispatch);
    datasetIds.push(...discovered.datasetIds);
    hdaIds.push(...discovered.slots.values());
    await populateCollections(tx, job, kind, results, outputs, discovered.slots);

    await jobs.update(
        job.id,
        {
            state,
            exit_code: results.exit_code,
            outputs: [...outputs, ...discovered.associations],
            command_line: results.command_line ?? commandLine,
            command_version: results.command_version ?? null,
            tool_stdout: shrinkStream(results.tool_stdout.text),
            tool_stderr: shrinkStream(results.tool_stderr.text),
            job_stdout: shrinkStream(results.job_stdout.text),
            job_stderr: shrinkStream(results.job_stderr.text),
            job_messages: results.job_messages,
            metrics: mergeMetrics(job.metrics, coreMetrics(results, context.dispatch)),
        },
        tx,
    );
    return { state, datasetIds, hdaIds };
}

/** Dataset fields of a record: sizes, metadata files and extra files at the keys the manifest gave the pod. */
function datasetFields(
    uuid: string,
    record: DatasetResult,
    createdFromBasename: string | null = null,
): Pick<DatasetRecord, "file_size" | "total_size" | "metadata_files" | "extra_files" | "created_from_basename"> {
    const metadataFiles: Record<string, MetadataFileRecord> = {};
    for (const [name, file] of Object.entries(record.metadata_files)) {
        if (Number.isSafeInteger(file.index) && file.index >= 0 && file.index < METADATA_FILE_POOL) {
            metadataFiles[name] = { key: metadataFileKey(uuid, file.index), file_size: file.size };
        }
    }
    const keys = datasetObjectKeys(uuid);
    return {
        file_size: record.size,
        total_size: record.total_size,
        metadata_files: metadataFiles,
        extra_files: record.extra_files ? { key: keys.extra, index_key: keys.extraIndex } : null,
        created_from_basename: record.created_from_basename ?? createdFromBasename,
    };
}

function recordInfo(record: DatasetResult): string | null {
    if (record.info) {
        return record.info;
    }
    return record.state === "error" && record.errors.length ? record.errors.join("\n") : record.info;
}

/**
 * Galaxy's `_finish_dataset` for a declared output: the dataset takes the record's state (`empty` and
 * `failed_metadata` are `ok` datasets; the latter marks every copy) and every history copy its datatype, metadata,
 * peek, blurb and info; outputs in error become visible and `auto` becomes `data`.
 *
 * @returns false when the dataset ended in error
 */
async function applyOutputRecord(tx: WriteTx, hda: HdaRecord, record: DatasetResult): Promise<boolean> {
    const dataset = await datasets.get(hda.dataset_id, tx);
    if (!dataset) {
        return true;
    }
    if (record.uuid !== dataset.uuid) {
        await failOutput(tx, hda, "The job's pod reported another dataset for this output.");
        return false;
    }
    const failed = record.state === "error";
    await datasets.update(
        dataset.id,
        { ...datasetFields(dataset.uuid, record, dataset.created_from_basename), state: failed ? "error" : "ok" },
        tx,
    );
    for (const copy of await hdas.listForDataset(dataset.id, tx)) {
        await hdas.update(
            copy.id,
            {
                extension: failed && record.ext === "auto" ? "data" : record.ext,
                dbkey: record.dbkey ?? copy.dbkey,
                info: recordInfo(record),
                blurb: record.blurb ?? (failed ? "error" : copy.blurb),
                peek: record.peek,
                metadata: record.metadata,
                _state: record.state === "failed_metadata" ? "failed_metadata" : null,
                ...(failed && copy.id === hda.id ? { visible: true } : {}),
            },
            tx,
        );
    }
    return !failed;
}

/**
 * `SetMetadataTool.exec_after_process`: on success the dataset takes the new datatype, metadata and peek and its
 * `_state` override is cleared; otherwise it is marked `failed_metadata`.
 */
async function applyMetadataRecord(
    tx: WriteTx,
    hdaId: string,
    record: DatasetResult | null,
): Promise<HdaRecord | undefined> {
    const hda = await hdas.get(hdaId, tx);
    if (!hda) {
        return undefined;
    }
    const dataset = await datasets.get(hda.dataset_id, tx);
    if (!record || !dataset || record.uuid !== dataset.uuid || record.state === "error") {
        return hdas.update(hda.id, { _state: "failed_metadata" }, tx);
    }
    if (record.state === "failed_metadata") {
        return hdas.update(hda.id, { extension: record.ext, _state: "failed_metadata" }, tx);
    }
    await datasets.update(dataset.id, datasetFields(dataset.uuid, record, dataset.created_from_basename), tx);
    return hdas.update(
        hda.id,
        { extension: record.ext, metadata: record.metadata, peek: record.peek, blurb: record.blurb, _state: null },
        tx,
    );
}

/** `JobWrapper.fail` for one output: the dataset is in error and the history dataset says why. */
async function failOutput(tx: WriteTx, hda: HdaRecord, message: string): Promise<void> {
    await datasets.update(hda.dataset_id, { state: "error" }, tx);
    await hdas.update(
        hda.id,
        {
            blurb: "tool error",
            info: message,
            visible: true,
            extension: hda.extension === "auto" ? "data" : hda.extension,
            _state: null,
        },
        tx,
    );
}

interface Discovered {
    /** History dataset of each slot. */
    slots: Map<number, string>;
    datasetIds: string[];
    associations: JobOutputAssociation[];
}

/** The job output name Galaxy's discovery gives a dataset (`__new_primary_file_<output>|<designation>__`). */
function discoveredOutputName(record: ResultsDocument["discovered"][number]): string | null {
    if (record.output && record.designation) {
        return `__new_primary_file_${record.output}|${record.designation}__`;
    }
    if (record.collection && record.element_identifiers?.length) {
        return `__new_primary_file_${record.collection}|${record.element_identifiers.join(":")}__`;
    }
    return null;
}

/** Creates the history datasets of discovered datasets in slot order; slots already ingested are reused. */
async function createDiscovered(
    tx: WriteTx,
    job: JobRecord,
    results: ResultsDocument,
    dispatch: DispatchRecord | null,
): Promise<Discovered> {
    const discovered: Discovered = { slots: new Map(), datasetIds: [], associations: [] };
    const historyId = job.history_id;
    if (!historyId) {
        return discovered;
    }
    const records = [...results.discovered].sort((a, b) => a.slot - b.slot);
    for (const record of records) {
        if (dispatch && dispatch.slot_uuids[record.slot] !== record.uuid) {
            continue;
        }
        let dataset = await datasets.getByUuid(record.uuid, tx);
        let hda: HdaRecord | undefined;
        if (dataset) {
            hda = (await hdas.listForDataset(dataset.id, tx)).find((copy) => copy.creating_job_id === job.id);
        } else {
            const failed = record.state === "error";
            const created = await hdas.createWithDataset(
                {
                    history_id: historyId,
                    name: record.name ?? record.designation ?? "",
                    extension: failed && record.ext === "auto" ? "data" : record.ext,
                    dbkey: record.dbkey ?? "?",
                    info: recordInfo(record),
                    blurb: record.blurb,
                    peek: record.peek,
                    metadata: record.metadata,
                    visible: failed ? true : record.visible,
                    _state: record.state === "failed_metadata" ? "failed_metadata" : null,
                    creating_job_id: job.id,
                },
                {
                    uuid: record.uuid,
                    state: failed ? "error" : "ok",
                    job_id: job.id,
                    ...datasetFields(record.uuid, record),
                },
                tx,
            );
            dataset = created.dataset;
            hda = created.hda;
        }
        if (!hda) {
            continue;
        }
        discovered.slots.set(record.slot, hda.id);
        discovered.datasetIds.push(dataset.id);
        const name = discoveredOutputName(record);
        if (name && !job.outputs.some((output) => output.id === hda.id)) {
            discovered.associations.push({ name, src: "hda", id: hda.id });
        }
    }
    return discovered;
}

/** Galaxy's name of a fetch target's collection when the request gives none. */
const UNNAMED_COLLECTION = "unnamed collection";

/**
 * Output collections of the job by the name results.json uses: tool outputs by output name; collections of an
 * upload's `hdca` targets, created in target order, by target name.
 */
function collectionTargets(job: JobRecord): Map<string, string> {
    const created = job.output_collections.filter((item) => item.src === "hdca");
    const targets = new Map<string, string>();
    if (jobKind(job) !== "upload") {
        created.forEach((item) => targets.set(item.name, item.id));
        return targets;
    }
    const request = job.request as { targets?: unknown } | null;
    const fetchTargets = Array.isArray(request?.targets) ? (request.targets as Record<string, unknown>[]) : [];
    const names = fetchTargets
        .filter((target) => (target?.destination as { type?: unknown } | undefined)?.type === "hdca")
        .map((target) => (typeof target.name === "string" && target.name ? target.name : UNNAMED_COLLECTION));
    names.forEach((name, index) => {
        const item = created[index];
        if (item && !targets.has(name)) {
            targets.set(name, item.id);
        }
    });
    return targets;
}

async function populateCollections(
    tx: WriteTx,
    job: JobRecord,
    kind: string,
    results: ResultsDocument,
    outputs: JobOutputAssociation[],
    slots: Map<number, string>,
): Promise<void> {
    if (kind === "set_metadata") {
        return;
    }
    const outputHdas = new Map(outputs.map((output) => [output.name, output.id]));
    const resolve = (element: CollectionResultElement): string | undefined =>
        element.slot !== undefined
            ? slots.get(element.slot)
            : element.output
              ? outputHdas.get(element.output)
              : undefined;
    const targets = collectionTargets(job);
    for (const [name, result] of Object.entries(results.output_collections)) {
        const hdcaId = targets.get(name);
        const hdca = hdcaId ? await collections.getHdca(hdcaId, tx) : undefined;
        const collection = hdca && (await collections.getCollection(hdca.collection_id, tx));
        if (collection) {
            await populateCollection(tx, collection, result, resolve);
        }
    }
}

function elementTree(
    elements: CollectionResultElement[],
    resolve: (element: CollectionResultElement) => string | undefined,
): NewElement[] {
    return elements.flatMap((element): NewElement[] => {
        const columns = Array.isArray(element.columns) ? element.columns : null;
        if (element.elements) {
            const collection: NewCollectionTree = {
                collection_type: element.collection_type ?? "list",
                elements: elementTree(element.elements, resolve),
            };
            return [{ identifier: element.element_identifier, collection, columns }];
        }
        const hdaId = resolve(element);
        return hdaId ? [{ identifier: element.element_identifier, hda_id: hdaId, columns }] : [];
    });
}

/**
 * Fills a collection created at submit with the elements the pod reports, once, and records its populated state.
 * Elements are added to the existing collection record so its id stays the one the client already knows.
 */
async function populateCollection(
    tx: WriteTx,
    collection: CollectionRecord,
    result: CollectionResult,
    resolve: (element: CollectionResultElement) => string | undefined,
): Promise<void> {
    if (result.populated_state === "new") {
        return;
    }
    const existing = await collections.elements(collection.id, tx);
    let count = existing.length;
    if (!existing.length && result.populated_state === "ok") {
        const tree = elementTree(result.elements, resolve);
        for (const [index, element] of tree.entries()) {
            const base = {
                collection_id: collection.id,
                element_index: index,
                element_identifier: element.identifier,
                columns: element.columns ?? null,
            };
            if ("hda_id" in element) {
                await tx.store("dces").add(buildDce({ ...base, element_type: "hda", hda_id: element.hda_id }));
            } else {
                const child = await collections.createCollection(element.collection, tx);
                await tx
                    .store("dces")
                    .add(buildDce({ ...base, element_type: "dataset_collection", child_collection_id: child.id }));
            }
        }
        count = tree.length;
    }
    await collections.updateCollection(
        collection.id,
        {
            populated_state: result.populated_state,
            populated_state_message: result.populated_state_message ?? null,
            element_count: result.populated_state === "ok" ? count : collection.element_count,
        },
        tx,
    );
}

// ---------------------------------------------------------------------------------------------------------
// Failures

/**
 * Records a pod failure without results as Galaxy's `JobWrapper.fail` does: the job is in error with the message
 * as `info`, its outputs are in error (blurb "tool error", the message as info, visible, `auto` becomes `data`) and
 * the tool's log and the infrastructure detail are kept. Datasets of set-metadata jobs are marked
 * `failed_metadata`. Multipart uploads of the attempt are aborted. Settled and cancelled jobs are left unchanged.
 */
export async function ingestFailure(job: JobRecord, failure: JobFailure, deps: JobDeps): Promise<void> {
    const dispatch = await readDispatchRecord(deps.s3, job.id, deps.signal).catch(() => null);
    if (dispatch?.multipart.length) {
        await abortMultipartUploads(deps.s3, dispatch.multipart, deps.signal);
    }
    const kind = jobKind(job);
    const prepare =
        dispatch && kind === "tool" ? await readCurrentPrepare(job, dispatch, deps).catch(() => null) : null;
    const message = failure.message.trim() || FAILURE_MESSAGES[failure.reason];
    const stderr = [
        message,
        failure.detail?.trim(),
        ...(prepare?.errors ?? []).map((error) => `${error.phase}: ${error.message}`),
    ].filter((line): line is string => Boolean(line));

    await writeTx(JOB_STORES, async (tx) => {
        const current = await jobs.get(job.id, tx);
        if (!current || SETTLED_STATES.has(current.state)) {
            return;
        }
        let outputs = current.outputs;
        let commandLine = current.command_line;
        if (prepare?.state === "ok" && commandLine === null) {
            outputs = await applyDecisions(tx, current, prepare);
            commandLine = prepare.command_line ?? null;
        }
        if (kind === "set_metadata") {
            for (const input of current.inputs.filter((item) => item.src === "hda")) {
                if (await hdas.get(input.id, tx)) {
                    await hdas.update(input.id, { _state: "failed_metadata" }, tx);
                }
            }
        } else {
            for (const output of outputs) {
                const hda = await hdas.get(output.id, tx);
                if (hda) {
                    await failOutput(tx, hda, message);
                }
            }
        }
        const jobMessage: ResultJobMessage = {
            type: "internal",
            desc: message,
            code_desc: null,
            error_level: failure.reason === "oom" ? FATAL_OOM : FATAL,
        };
        await jobs.update(
            current.id,
            {
                state: "error",
                info: message,
                outputs,
                command_line: commandLine,
                tool_stdout: shrinkStream(failure.toolStdout ?? current.tool_stdout),
                tool_stderr: shrinkStream(failure.toolStderr ?? current.tool_stderr),
                job_stderr: shrinkStream(stderr.join("\n")),
                job_messages: [...current.job_messages, jobMessage],
            },
            tx,
        );
    });
}

// ---------------------------------------------------------------------------------------------------------
// Streams and metrics

/**
 * Galaxy's `shrink_string_by_size(value, DATABASE_MAX_STRING_SIZE, join_by="\n..\n", left_larger=True)`: text
 * longer than the limit keeps its beginning and end around the joiner.
 */
export function shrinkStream(text: string | null | undefined, limit: number = STREAM_LIMIT): string {
    if (!text) {
        return "";
    }
    const characters = text.length > limit ? Array.from(text) : null;
    if (!characters || characters.length <= limit) {
        return text;
    }
    const half = Math.floor((limit - STREAM_JOIN.length) / 2);
    const left = half * 2 + STREAM_JOIN.length < limit ? half + 1 : half;
    return characters.slice(0, left).join("") + STREAM_JOIN + characters.slice(characters.length - half).join("");
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/** `%Y-%m-%d %H:%M:%S` in local time, as Galaxy's core metrics formatter prints epochs. */
function formatLocal(date: Date): string {
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

/** Galaxy's `seconds_to_str`. */
function secondsToString(value: number): string {
    const minutes = Math.floor(value / 60) % 60;
    const hours = Math.floor(value / 3600);
    const seconds = value % 60;
    const plural = (count: number, unit: string) => `${count} ${unit}${count !== 1 ? "s" : ""}`;
    if (value < 60) {
        return plural(seconds, "second");
    }
    if (value < 3600) {
        return plural(minutes, "minute");
    }
    return `${plural(hours, "hour")} and ${plural(minutes, "minute")}`;
}

/** Epoch seconds of a pod timestamp (naive UTC ISO 8601), or null. */
function epochSeconds(value: string | null | undefined): number | null {
    if (!value) {
        return null;
    }
    const milliseconds = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

/** Galaxy's `core` job metrics: allocated cores and memory, start and end time and runtime of the tool. */
export function coreMetrics(results: ResultsDocument, dispatch: DispatchRecord | null): JobMetricRecord[] {
    const metric = (name: string, title: string, value: string, raw: number): JobMetricRecord => ({
        plugin: "core",
        name,
        title,
        value,
        raw_value: String(raw),
    });
    const metrics: JobMetricRecord[] = [];
    if (dispatch) {
        metrics.push(metric("galaxy_slots", "Cores Allocated", String(dispatch.slots), dispatch.slots));
        if (dispatch.memory_mb !== null) {
            metrics.push(
                metric("galaxy_memory_mb", "Memory Allocated (MB)", String(dispatch.memory_mb), dispatch.memory_mb),
            );
        }
    }
    const start = epochSeconds(results.timings.tool_start);
    const end = epochSeconds(results.timings.tool_end);
    if (start !== null) {
        metrics.push(metric("start_epoch", "Job Start Time", formatLocal(new Date(start * 1000)), start));
    }
    if (end !== null) {
        metrics.push(metric("end_epoch", "Job End Time", formatLocal(new Date(end * 1000)), end));
    }
    if (start !== null && end !== null && end >= start) {
        metrics.push(metric("runtime_seconds", "Job Runtime (Wall Clock)", secondsToString(end - start), end - start));
    }
    return metrics;
}

function mergeMetrics(existing: JobMetricRecord[], core: JobMetricRecord[]): JobMetricRecord[] {
    const replaced = new Set(core.map((metric) => metric.name));
    return [...existing.filter((metric) => metric.plugin !== "core" || !replaced.has(metric.name)), ...core];
}
