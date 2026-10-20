/**
 * Restores a state payload into IndexedDB, replacing every snapshot store in one transaction. This device keeps
 * its secrets, its storage settings (they reach the bucket the snapshot came from), its cluster settings when a
 * cluster token is stored (the token belongs to them), and its local `kv` entries. The cluster gateway and runtime
 * image of a snapshot replace this device's only when the user confirmed them: the next cluster token goes to that
 * gateway, and that image receives the presigned URLs of every job. The leader epoch moves on, so a job manager that
 * read the replaced records stops writing and starts again.
 *
 * Continuing the snapshot's instance pauses its jobs that had not reached the cluster, and drops the outbox's
 * dispatches, cancels and cleanups (they were the writing device's), until the user resumes restored jobs
 * ({@link resumeParkedJobs}). Jobs already in the cluster continue.
 *
 * Forking makes this device a new instance: jobs that had not finished stay with the original instance, so here
 * they and their unfinished outputs fail, and the outbox is emptied (its dispatches, cleanups and purges belong
 * to the original instance). `kv` `instance_fork` records the fork; datasets created before it share their bucket
 * objects with the original instance (`forks.ts`).
 */

import { bootstrap, getDb } from "@/planet/db/connection";
import * as datasets from "@/planet/db/datasets";
import * as hdas from "@/planet/db/hdas";
import * as jobs from "@/planet/db/jobs";
import { SECRETS_KEY, SETTINGS_KEY, STORE_NAMES } from "@/planet/db/schema";
import { parseSettingsUpdate } from "@/planet/db/settings";
import { runTransaction, type WriteTx } from "@/planet/db/transaction";
import { JOB_STORES } from "@/planet/db/tx";
import type { DatasetRecord, JobRecord, JobState, PlanetSecrets, StoredSettings } from "@/planet/db/types";
import { TERMINAL_DATASET_STATES, TERMINAL_JOB_STATES } from "@/planet/util/states";

import { BackupError } from "./errors";
import { FORK_KEY, type ForkRecord } from "./forks";
import { isLocalKvKey, SNAPSHOT_STORES, type StatePayload } from "./payload";
import { PARKED_KEY, type ParkedJobs } from "./state";

export { FORK_KEY, type ForkRecord } from "./forks";

/** Info of restored jobs that wait for the user to resume them, and of their outputs. */
export const PARKED_MESSAGE =
    "This job was restored from a snapshot. It runs once you resume restored jobs in Planet's Backups section.";

/** States of jobs that have not reached the cluster; a restore pauses those without a Kubernetes Job. */
const UNDISPATCHED: ReadonlySet<JobState> = new Set<JobState>(["new", "waiting", "queued"]);

/** The gateway and runtime image of a snapshot's cluster settings. */
export interface ClusterEndpoints {
    gateway_url: string;
    runtime_image: string;
}

export interface ImportOptions {
    /** Restores the records as this new instance instead of continuing the snapshot's instance. */
    forkTo?: string | null;
    /** Takes the snapshot's gateway and runtime image, which the user confirmed; otherwise this device keeps its own. */
    useSnapshotEndpoints?: boolean;
    /** Milliseconds since the epoch. */
    now?: number;
}

export interface ImportResult {
    instance_id: string;
    forked_from: string | null;
    /** Jobs failed by the fork. */
    failed_jobs: number;
    /** Jobs paused until the user resumes restored jobs. */
    parked_jobs: number;
}

function forkMessage(from: string, to: string): string {
    return `This job had not finished when this copy of Planet became instance ${to}; it continues with instance ${from}. Run it again here to compute its outputs.`;
}

/** Fails unfinished jobs and their unfinished outputs, empties the outbox and records the fork. */
async function applyFork(tx: WriteTx, from: string, to: string): Promise<number> {
    const message = forkMessage(from, to);
    const unfinished = ((await tx.store("jobs").getAll()) as JobRecord[]).filter(
        (job) => !TERMINAL_JOB_STATES.has(job.state),
    );
    for (const job of unfinished) {
        const outputs = (await tx.store("datasets").index("job_id").getAll(job.id)) as DatasetRecord[];
        for (const dataset of outputs) {
            if (TERMINAL_DATASET_STATES.has(dataset.state)) {
                continue;
            }
            await datasets.update(dataset.id, { state: "error" }, tx);
            for (const hda of await tx.store("hdas").index("dataset_id").getAll(dataset.id)) {
                await hdas.update(hda.id, { info: message, _state: null }, tx);
            }
        }
        await jobs.update(job.id, { state: "error", info: message, k8s: null }, tx);
    }
    await tx.store("outbox").clear();
    // Every record copied has a timestamp at or before the clock; everything made afterwards a later one.
    const clock = (await tx.store("kv").get("clock")) as number;
    const record: ForkRecord = { from, to, time: tx.now, clock, registered: false };
    await tx.store("kv").put(record, FORK_KEY);
    tx.notify({ type: "outbox-changed" });
    return unfinished.length;
}

/** Sets the outputs of a job to `state` (unless finished) and their history copies' info to `info`. */
async function setOutputs(tx: WriteTx, job: JobRecord, state: "paused" | "new", info: string | null): Promise<void> {
    for (const output of job.outputs) {
        const hda = await tx.store("hdas").get(output.id);
        if (!hda) {
            continue;
        }
        const dataset = await tx.store("datasets").get(hda.dataset_id);
        if (dataset && !TERMINAL_DATASET_STATES.has(dataset.state) && dataset.state !== state) {
            if (state === "paused" || dataset.state === "paused") {
                await datasets.update(dataset.id, { state }, tx);
            }
        }
        if (state === "paused" || hda.info === PARKED_MESSAGE) {
            await hdas.update(hda.id, { info }, tx);
        }
    }
}

/** Pauses the restored jobs that have not reached the cluster and drops the writing device's outbox entries. */
async function parkJobs(tx: WriteTx): Promise<string[]> {
    const parked: string[] = [];
    for (const job of (await tx.store("jobs").getAll()) as JobRecord[]) {
        if (!UNDISPATCHED.has(job.state) || job.k8s) {
            continue;
        }
        await setOutputs(tx, job, "paused", PARKED_MESSAGE);
        await jobs.update(job.id, { state: "paused", info: PARKED_MESSAGE }, tx);
        parked.push(job.id);
    }
    const outbox = tx.store("outbox");
    for (const entry of await outbox.getAll()) {
        if (entry.kind !== "purge") {
            await outbox.delete(entry.id);
        }
    }
    return parked;
}

async function nextEpoch(tx: WriteTx): Promise<void> {
    const kv = tx.store("kv");
    const epoch = await kv.get("leader_epoch");
    await kv.put((typeof epoch === "number" ? epoch : 0) + 1, "leader_epoch");
}

/** The snapshot's cluster and user settings, checked as a settings update; never a token. */
function snapshotSettings(snapshot: unknown): {
    cluster: Partial<StoredSettings["cluster"]>;
    user: Partial<StoredSettings["user"]>;
} {
    const { cluster, user } = (snapshot ?? {}) as { cluster?: unknown; user?: unknown };
    let parsed: ReturnType<typeof parseSettingsUpdate>;
    try {
        parsed = parseSettingsUpdate({ cluster, user });
    } catch (error) {
        throw new BackupError(
            "format",
            `The snapshot's settings are invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const { token: _token, ...restoredCluster } = parsed.cluster ?? {};
    return { cluster: restoredCluster, user: parsed.user ?? {} };
}

function payloadSettings(payload: StatePayload): unknown {
    const entry = (payload.stores.settings as [string, unknown][]).find(([key]) => key === SETTINGS_KEY);
    return entry?.[1];
}

/**
 * The snapshot's gateway and runtime image when restoring would replace this device's with them, so the user has
 * to confirm them; null when this device keeps its cluster settings (it has a cluster token) or they agree.
 */
export function endpointsToConfirm(
    payload: StatePayload,
    local: StoredSettings,
    hasToken: boolean,
): ClusterEndpoints | null {
    if (hasToken) {
        return null;
    }
    const { cluster } = snapshotSettings(payloadSettings(payload));
    const gateway = cluster.gateway_url ?? "";
    const runtime = cluster.runtime_image ?? "";
    const differs = (value: string, current: string) => value !== "" && value !== current;
    if (!differs(gateway, local.cluster.gateway_url) && !differs(runtime, local.cluster.runtime_image)) {
        return null;
    }
    return { gateway_url: gateway, runtime_image: runtime };
}

function restoredSettings(
    local: StoredSettings,
    snapshot: unknown,
    keepCluster: boolean,
    useEndpoints: boolean,
    instanceId: string,
): StoredSettings {
    const { cluster, user } = snapshotSettings(snapshot);
    const endpoints = useEndpoints
        ? { gateway_url: cluster.gateway_url ?? "", runtime_image: cluster.runtime_image ?? "" }
        : { gateway_url: local.cluster.gateway_url, runtime_image: local.cluster.runtime_image };
    return {
        instance_id: instanceId,
        cluster: keepCluster ? local.cluster : { ...local.cluster, ...cluster, ...endpoints },
        storage: local.storage,
        user: { ...local.user, ...user },
    };
}

/** Replaces this device's records with `payload` (validated by `parsePayload` and `checkRecords`). */
export async function importState(payload: StatePayload, options: ImportOptions = {}): Promise<ImportResult> {
    const instanceId = options.forkTo ?? payload.instance_id;
    const db = await getDb();
    const result = await runTransaction(db, STORE_NAMES, "readwrite", async (tx) => {
        const kv = tx.store("kv");
        const local = await tx.store("settings").get(SETTINGS_KEY);
        if (!local) {
            throw new BackupError("format", "This device's settings are missing.");
        }
        const secrets = (await tx.store("secrets").get(SECRETS_KEY)) as PlanetSecrets | undefined;
        for (const key of await kv.getAllKeys()) {
            if (typeof key !== "string" || !isLocalKvKey(key) || key.startsWith("console:")) {
                await kv.delete(key);
            }
        }
        for (const name of SNAPSHOT_STORES) {
            const store = tx.store(name);
            const items = payload.stores[name] ?? [];
            if (name !== "kv") {
                await store.clear();
            }
            const writes: Promise<unknown>[] = [];
            for (const item of items) {
                if (store.keyPath !== null) {
                    writes.push(store.put(item as never));
                    continue;
                }
                const [key, value] = item as [string, unknown];
                if ((name === "kv" && isLocalKvKey(key)) || (name === "settings" && key !== SETTINGS_KEY)) {
                    continue;
                }
                const stored =
                    name === "settings"
                        ? restoredSettings(
                              local,
                              value,
                              Boolean(secrets?.cluster_token),
                              options.useSnapshotEndpoints === true,
                              instanceId,
                          )
                        : value;
                writes.push(store.put(stored as never, key));
            }
            await Promise.all(writes);
        }
        await kv.put(Math.max(tx.nowMicros, Math.floor(payload.clock)), "clock");
        await nextEpoch(tx);
        let failed = 0;
        let parked: string[] = [];
        if (options.forkTo) {
            failed = await applyFork(tx, payload.instance_id, options.forkTo);
            await kv.delete(PARKED_KEY);
        } else {
            parked = await parkJobs(tx);
            const record: ParkedJobs = { instance_id: instanceId, job_ids: parked, time: options.now ?? Date.now() };
            await (parked.length ? kv.put(record, PARKED_KEY) : kv.delete(PARKED_KEY));
        }
        const current = await kv.get("current_history_id");
        if (typeof current === "string") {
            tx.notify({ type: "current-history-changed", historyId: current });
        }
        tx.notify({ type: "settings-changed" });
        tx.notify({ type: "tools-changed" });
        tx.notify({ type: "outbox-changed" });
        return { failed, parked: parked.length };
    });
    await bootstrap(db);
    return {
        instance_id: instanceId,
        forked_from: options.forkTo ? payload.instance_id : null,
        failed_jobs: result.failed,
        parked_jobs: result.parked,
    };
}

/** Makes this device's records a new instance `to` (see the module comment). Returns the jobs it failed. */
export async function forkInstance(to: string): Promise<{ from: string; to: string; failed_jobs: number }> {
    const db = await getDb();
    return runTransaction(db, [...JOB_STORES, "settings"], "readwrite", async (tx) => {
        const settings = await tx.store("settings").get(SETTINGS_KEY);
        if (!settings) {
            throw new BackupError("format", "This device's settings are missing.");
        }
        const from = settings.instance_id;
        await tx.store("settings").put({ ...settings, instance_id: to }, SETTINGS_KEY);
        await nextEpoch(tx);
        const failed = await applyFork(tx, from, to);
        await tx.store("kv").delete(PARKED_KEY);
        tx.notify({ type: "settings-changed" });
        return { from, to, failed_jobs: failed };
    });
}

function parkedRecord(value: unknown): ParkedJobs | null {
    const record = value as Partial<ParkedJobs> | null | undefined;
    return typeof record?.instance_id === "string" &&
        Array.isArray(record.job_ids) &&
        record.job_ids.every((id) => typeof id === "string")
        ? (record as ParkedJobs)
        : null;
}

/** The jobs a restore paused that still wait for the user, if they belong to `instanceId`. */
export async function parkedJobs(instanceId: string): Promise<string[]> {
    const db = await getDb();
    return runTransaction(db, ["kv", "jobs"], "readonly", async (tx) => {
        const record = parkedRecord(await tx.store("kv").get(PARKED_KEY));
        if (!record || record.instance_id !== instanceId) {
            return [];
        }
        const waiting: string[] = [];
        for (const id of record.job_ids) {
            const job = await tx.store("jobs").get(id);
            if (job?.state === "paused" && job.info === PARKED_MESSAGE) {
                waiting.push(id);
            }
        }
        return waiting;
    });
}

/**
 * Resumes the jobs a restore paused that are still paused: they and their outputs go back to `new` and are announced
 * with `job-created` for the leader to dispatch. Returns how many were resumed.
 */
export async function resumeParkedJobs(instanceId: string): Promise<number> {
    const db = await getDb();
    return runTransaction(db, JOB_STORES, "readwrite", async (tx) => {
        const kv = tx.store("kv");
        const record = parkedRecord(await kv.get(PARKED_KEY));
        if (!record || record.instance_id !== instanceId) {
            return 0;
        }
        let resumed = 0;
        for (const id of record.job_ids) {
            const job = (await tx.store("jobs").get(id)) as JobRecord | undefined;
            if (job?.state !== "paused" || job.info !== PARKED_MESSAGE) {
                continue;
            }
            await setOutputs(tx, job, "new", null);
            await jobs.update(job.id, { state: "new", info: null }, tx);
            tx.notify({ type: "job-created", jobId: job.id });
            resumed++;
        }
        await kv.delete(PARKED_KEY);
        return resumed;
    });
}
