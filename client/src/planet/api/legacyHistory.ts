/**
 * The legacy history controller (`controllers/history.py`): GET /history/current_history_json,
 * /history/set_as_current, /history/create_new_current and GET/POST /history/resume_paused_jobs.
 */

import {
    datasets,
    hdas,
    histories,
    type HistoryRecord,
    JOB_STORES,
    type JobRecord,
    jobs,
    readTx,
    withTransaction,
    type WriteTx,
} from "@/planet/db";
import type { Router } from "@/planet/sw/router";
import { ApiError } from "@/planet/util/errors";
import { parseGalaxyTime } from "@/planet/util/time";

import { HISTORY_DEV_DETAILED_KEYS, type HistoryDevDetailedView, serializeHistoryView } from "./histories";

/** Galaxy's `string_as_bool`. */
function stringAsBool(value: string | null): boolean {
    return value !== null && ["true", "yes", "on", "1"].includes(value.toLowerCase());
}

/** Returns the current history, creating one when none is set or the stored one was purged. */
export async function currentHistory(): Promise<HistoryRecord> {
    const existing = await readTx(["histories", "kv"], async (t) => {
        const id = await histories.getCurrentId(t);
        return id ? histories.get(id, t) : undefined;
    });
    return existing && !existing.purged ? existing : histories.getOrCreateCurrent();
}

/** The history as the legacy controller returns it (`dev-detailed`). */
export function historyData(history: HistoryRecord): Promise<HistoryDevDetailedView> {
    return serializeHistoryView(history, HISTORY_DEV_DETAILED_KEYS);
}

function parseSince(since: string): number {
    try {
        return parseGalaxyTime(since);
    } catch {
        throw ApiError.badRequest(`Invalid date format for 'since': '${since}'`);
    }
}

/**
 * Resumes a paused job (`Job.resume`): the job and its paused outputs go back to `new`, and so does every paused
 * job that consumes those outputs. Each resumed job is announced with `job-created` so the leader dispatches it.
 */
async function resumeJob(job: JobRecord, all: readonly JobRecord[], tx: WriteTx, resumed: Set<string>): Promise<void> {
    if (resumed.has(job.id) || job.state !== "paused") {
        return;
    }
    resumed.add(job.id);
    await jobs.update(job.id, { state: "new" }, tx);
    tx.notify({ type: "job-created", jobId: job.id });
    for (const output of job.outputs) {
        await unpauseDataset(output.id, all, tx, resumed);
    }
}

async function unpauseDataset(
    hdaId: string,
    all: readonly JobRecord[],
    tx: WriteTx,
    resumed: Set<string>,
): Promise<void> {
    const hda = await tx.store("hdas").get(hdaId);
    if (!hda) {
        return;
    }
    const dataset = await tx.store("datasets").get(hda.dataset_id);
    if (dataset?.state === "paused" && !hda._state) {
        await datasets.update(dataset.id, { state: "new" }, tx);
        await hdas.update(hda.id, { info: null }, tx);
    }
    for (const dependent of all) {
        if (dependent.inputs.some((input) => input.src === "hda" && input.id === hdaId)) {
            await resumeJob(dependent, all, tx, resumed);
        }
    }
}

/** Resumes the paused jobs of a history (`History.resume_paused_jobs`) and returns the ids of the resumed jobs. */
export function resumePausedJobs(historyId: string): Promise<string[]> {
    return withTransaction(JOB_STORES, "readwrite", async (t) => {
        const all = await t.store("jobs").getAll();
        const resumed = new Set<string>();
        for (const job of all) {
            if (job.history_id === historyId && job.state === "paused") {
                await resumeJob(job, all, t, resumed);
            }
        }
        return [...resumed];
    });
}

export function register(router: Router): void {
    router.untyped("/history/current_history_json", "get", async ({ query }) => {
        const history = await currentHistory();
        const since = query.get("since");
        if (since && parseGalaxyTime(history.update_time) <= parseSince(since)) {
            return null;
        }
        return historyData(history);
    });

    router.untyped("/history/set_as_current", ["get", "post"], async ({ query }) => {
        const id = query.get("id");
        if (!id) {
            throw ApiError.missingParameter("Missing required parameter 'id'");
        }
        return historyData(await histories.setCurrent(id));
    });

    router.untyped("/history/create_new_current", ["get", "post"], async ({ query }) => {
        const name = query.get("name");
        const history = await withTransaction(["histories", "kv"], "readwrite", async (t) => {
            const created = await histories.create({ name: name || undefined }, t);
            return histories.setCurrent(created.id, t);
        });
        return historyData(history);
    });

    router.untyped("/history/resume_paused_jobs", ["get", "post"], async ({ query }) => {
        if (!query.get("ids") && stringAsBool(query.get("current"))) {
            await resumePausedJobs((await currentHistory()).id);
            return { message: "Your jobs have been resumed.", status: "success" };
        }
        throw ApiError.badRequest("You can currently only resume all the datasets of the current history.");
    });
}
