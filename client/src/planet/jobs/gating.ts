/**
 * Dependency gating as Galaxy's job handler does it (`JobHandlerQueue.__filter_jobs_with_invalid_input_states`,
 * `JobWrapper.pause` and the dependent-job pause in `JobWrapper.fail`): a job waits in `new` while an input is
 * not ready, is paused when an input is deleted, paused or in error, and fails when an input was purged.
 * Resuming (`/history/resume_paused_jobs`) puts paused jobs back to `new`.
 */

import {
    collections,
    type DatasetRecord,
    datasets,
    type HdaRecord,
    hdas,
    type JobRecord,
    jobs,
    outbox,
    type ReadTx,
    type WriteTx,
} from "@/planet/db";

/** Galaxy's suffix of the pause message for jobs with bad inputs. */
export const PAUSE_SUFFIX = "To resume this job fix the input dataset(s).";
/** Galaxy's message on the outputs of jobs paused because a job they depend on failed. */
export const DEPENDENT_PAUSE_MESSAGE =
    "Execution of this dataset's job is paused because its input datasets are in an error state.";

/** Stores {@link checkInputs} reads. */
export const GATING_READ_STORES = ["jobs", "hdas", "datasets", "hdcas", "collections", "dces"] as const;

/** Whether a job's inputs allow it to run. */
export type Readiness =
    | { status: "ready" }
    | { status: "wait"; reasons: string[] }
    | { status: "pause"; message: string }
    | { status: "fail"; message: string };

/** Job states in which Galaxy pauses a job (`JobWrapper.pause`). */
const PAUSABLE_STATES = new Set(["new", "queued"]);

interface InputSet {
    hdaIds: Set<string>;
    /** Problems with collection inputs themselves. */
    waiting: string[];
    pausing: string[];
}

/** Resolves a job's inputs to the HDAs they consist of; collection inputs contribute their leaves. */
async function resolveInputs(job: JobRecord, tx: ReadTx): Promise<InputSet> {
    const result: InputSet = { hdaIds: new Set(), waiting: [], pausing: [] };
    const addCollection = async (collectionId: string, name: string) => {
        const collection = await collections.getCollection(collectionId, tx);
        if (!collection || collection.populated_state === "new") {
            result.waiting.push(`Input dataset collection '${name}' is not populated yet`);
            return;
        }
        if (collection.populated_state === "failed") {
            result.pausing.push(`Input dataset collection '${name}' failed to populate`);
            return;
        }
        for (const id of await collections.leafHdaIds(collectionId, tx)) {
            result.hdaIds.add(id);
        }
    };
    for (const input of job.inputs) {
        if (input.src === "hda") {
            result.hdaIds.add(input.id);
        } else if (input.src === "hdca") {
            const hdca = await collections.getHdca(input.id, tx);
            if (!hdca) {
                result.pausing.push(`Input dataset collection '${input.name}' was deleted before the job started`);
            } else {
                await addCollection(hdca.collection_id, hdca.name);
            }
        } else {
            const element = await tx.store("dces").get(input.id);
            if (element?.hda_id) {
                result.hdaIds.add(element.hda_id);
            } else if (element?.child_collection_id) {
                await addCollection(element.child_collection_id, element.element_identifier);
            } else {
                result.pausing.push(
                    `Input dataset collection element '${input.name}' was deleted before the job started`,
                );
            }
        }
    }
    return result;
}

/** The HDAs a job reads, with their datasets. */
async function inputDatasets(
    ids: Iterable<string>,
    tx: ReadTx,
): Promise<{ id: string; hda?: HdaRecord; dataset?: DatasetRecord }[]> {
    const rows = [];
    for (const id of ids) {
        const hda = await hdas.get(id, tx);
        rows.push({ id, hda, dataset: hda ? await datasets.get(hda.dataset_id, tx) : undefined });
    }
    return rows;
}

/**
 * Checks whether a job's inputs are ready, as Galaxy's job handler does before it dispatches a job. Needs
 * {@link GATING_READ_STORES}.
 */
export async function checkInputs(job: JobRecord, tx: ReadTx): Promise<Readiness> {
    const resolved = await resolveInputs(job, tx);
    const failing: string[] = [];
    const pausing = [...resolved.pausing];
    const waiting = [...resolved.waiting];
    for (const { id, hda, dataset } of await inputDatasets(resolved.hdaIds, tx)) {
        const name = hda?.name ?? id;
        if (!hda || !dataset) {
            failing.push(`Input dataset '${name}' was deleted before the job started`);
        } else if (hda.deleted || dataset.deleted) {
            // An undeleted input lets the job resume; a purged one never will.
            (dataset.purged || hda.purged ? failing : pausing).push(
                `Input dataset '${name}' was deleted before the job started`,
            );
        } else if (hda._state === "failed_metadata") {
            pausing.push(`Input dataset '${name}' failed to properly set metadata`);
        } else if (dataset.state === "paused") {
            pausing.push(`Input dataset '${name}' was paused before the job started`);
        } else if (dataset.state === "error") {
            pausing.push(`Input dataset '${name}' is in error state`);
        } else if (hda._state === "setting_metadata") {
            waiting.push(`Input dataset '${name}' is in setting_metadata state`);
        } else if (dataset.state !== "ok" && dataset.state !== "deferred") {
            waiting.push(`Input dataset '${name}' is in ${dataset.state} state`);
        }
    }
    if (failing.length) {
        return { status: "fail", message: failing.join(", ") };
    }
    if (pausing.length) {
        return { status: "pause", message: `${pausing.join(", ")}. ${PAUSE_SUFFIX}` };
    }
    if (waiting.length) {
        return { status: "wait", reasons: waiting };
    }
    return { status: "ready" };
}

/**
 * Pauses a job that has not been dispatched (Galaxy's `JobWrapper.pause`): the job becomes `paused`, its output
 * datasets `paused` with `message` as info, and its pending dispatch is dropped. Returns false when the job was
 * not in a pausable state. Needs `JOB_STORES`.
 */
export async function pauseJob(jobId: string, message: string, tx: WriteTx): Promise<boolean> {
    const job = await jobs.get(jobId, tx);
    if (!job || !PAUSABLE_STATES.has(job.state) || job.k8s) {
        return false;
    }
    for (const output of job.outputs) {
        const hda = await hdas.get(output.id, tx);
        if (!hda) {
            continue;
        }
        const dataset = await datasets.get(hda.dataset_id, tx);
        if (dataset && dataset.state !== "paused") {
            await datasets.update(dataset.id, { state: "paused" }, tx);
        }
        await hdas.update(hda.id, { info: message }, tx);
    }
    await jobs.update(jobId, { state: "paused" }, tx);
    await outbox.removeForJob(jobId, "dispatch", tx);
    return true;
}

/**
 * Pauses the undispatched jobs that read any output of `jobId` (directly, through a copy of the output's
 * dataset, or through a collection), after that job failed. Returns the ids of the paused jobs. Needs
 * `JOB_STORES`.
 */
export async function pauseDependents(jobId: string, tx: WriteTx): Promise<string[]> {
    const failed = await jobs.get(jobId, tx);
    if (!failed) {
        return [];
    }
    const affected = new Set<string>();
    for (const output of failed.outputs) {
        const hda = await hdas.get(output.id, tx);
        if (!hda) {
            continue;
        }
        for (const copy of await hdas.listForDataset(hda.dataset_id, tx)) {
            affected.add(copy.id);
        }
    }
    if (!affected.size) {
        return [];
    }
    const candidates = await jobs.listByState(["new", "queued"], tx);
    const paused: string[] = [];
    for (const candidate of candidates) {
        if (candidate.id === jobId || candidate.k8s) {
            continue;
        }
        const { hdaIds } = await resolveInputs(candidate, tx);
        if ([...hdaIds].some((id) => affected.has(id)) && (await pauseJob(candidate.id, DEPENDENT_PAUSE_MESSAGE, tx))) {
            paused.push(candidate.id);
        }
    }
    return paused;
}
