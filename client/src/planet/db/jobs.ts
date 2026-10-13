/** Jobs. Output datasets carry their own state; see `datasets.update` for propagating it. */

import { ApiError } from "@/planet/util/errors";

import { bumpCollections } from "./propagation";
import { buildJob, type NewJob } from "./records";
import { JOB_STORES, type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { JobRecord, JobState } from "./types";

export type { NewJob };

/** Fields a job update may change. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "create_time" | "update_time" | "state_history">>;

/** Creates a job and announces it (`job-created`) after commit. */
export function create(input: NewJob, tx?: WriteTx): Promise<JobRecord> {
    return useWrite(tx, ["jobs"], async (t) => {
        const job = buildJob(input, t.now);
        await t.store("jobs").add(job);
        t.notify({ type: "job-created", jobId: job.id });
        return job;
    });
}

/** Returns the job, or undefined. */
export function get(id: string, tx?: ReadTx): Promise<JobRecord | undefined> {
    return useRead(tx, ["jobs"], (t) => t.store("jobs").get(id));
}

/** Returns the job or throws a 404 {@link ApiError}. */
export async function getOrThrow(id: string, tx?: ReadTx): Promise<JobRecord> {
    const job = await get(id, tx);
    if (!job) {
        throw ApiError.notFound("Job not found");
    }
    return job;
}

/** Returns the history's jobs, oldest first. */
export function listForHistory(historyId: string, tx?: ReadTx): Promise<JobRecord[]> {
    return useRead(tx, ["jobs"], async (t) => {
        const jobs = await t.store("jobs").index("history_id").getAll(historyId);
        return jobs.sort((a, b) => (a.create_time < b.create_time ? -1 : a.create_time > b.create_time ? 1 : 0));
    });
}

/** Returns the jobs in any of `states`. */
export function listByState(states: readonly JobState[], tx?: ReadTx): Promise<JobRecord[]> {
    return useRead(tx, ["jobs"], async (t) => {
        const index = t.store("jobs").index("state");
        const groups = await Promise.all(states.map((state) => index.getAll(state)));
        return groups.flat();
    });
}

/** Counts the jobs in each of `states`. */
export function countByState<S extends JobState>(states: readonly S[], tx?: ReadTx): Promise<Record<S, number>> {
    return useRead(tx, ["jobs"], async (t) => {
        const index = t.store("jobs").index("state");
        const counts = await Promise.all(states.map((state) => index.count(state)));
        return Object.fromEntries(states.map((state, i) => [state, counts[i]!])) as Record<S, number>;
    });
}

/**
 * Applies `patch` and bumps `update_time`. A state change is appended to `state_history`, bumps the HDCAs
 * whose job source is this job (their job state summary changed) and announces `job-changed`.
 */
export function update(id: string, patch: JobPatch, tx?: WriteTx): Promise<JobRecord> {
    return useWrite(tx, JOB_STORES, async (t) => {
        const store = t.store("jobs");
        const job = await store.get(id);
        if (!job) {
            throw ApiError.notFound("Job not found");
        }
        const next: JobRecord = { ...job, ...patch, update_time: t.now };
        const stateChanged = patch.state !== undefined && patch.state !== job.state;
        if (stateChanged) {
            next.state_history = [...job.state_history, { state: next.state, time: t.now }];
            const sources = [job.id, next.implicit_collection_jobs_id].filter((value): value is string => !!value);
            const collectionIds = new Set<string>();
            for (const source of sources) {
                for (const hdca of await t.store("hdcas").index("job_source_id").getAll(source)) {
                    collectionIds.add(hdca.collection_id);
                }
            }
            if (collectionIds.size) {
                await bumpCollections(collectionIds, t);
            }
        }
        await store.put(next);
        t.notify({ type: "job-changed", jobId: id, state: next.state });
        return next;
    });
}

/**
 * Records that a client is reading the job's live console output, so the leader tab keeps the job's
 * `tool_stdout` current with the tool container's log. Call it from `GET /api/jobs/{id}/console_output` while
 * the job runs.
 */
export function requestConsole(id: string, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["kv"], async (t) => {
        await t.store("kv").put(Date.now(), `console:${id}`);
    });
}

/** When a client last read the job's live console output (milliseconds since the epoch), or null. */
export function consoleRequestedAt(id: string, tx?: ReadTx): Promise<number | null> {
    return useRead(tx, ["kv"], async (t) => {
        const value = await t.store("kv").get(`console:${id}`);
        return typeof value === "number" ? value : null;
    });
}

/** Forgets the console request of a finished job. */
export function clearConsoleRequest(id: string, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["kv"], async (t) => {
        await t.store("kv").delete(`console:${id}`);
    });
}
