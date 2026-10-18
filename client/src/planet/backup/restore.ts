/**
 * Restores a state payload into IndexedDB, replacing every snapshot store in one transaction. This device keeps
 * its secrets, its storage settings (they reach the bucket the snapshot came from), its cluster settings when a
 * cluster token is stored (the token belongs to them), and its local `kv` entries. The leader epoch moves on, so
 * a job manager that read the replaced records stops writing and starts again.
 *
 * Forking makes this device a new instance: jobs that had not finished stay with the original instance, so here
 * they and their unfinished outputs fail, and the outbox is emptied (its dispatches, cleanups and purges belong
 * to the original instance). `kv` `instance_fork` records when the copy was made; datasets created before then
 * share their bucket objects with the original instance.
 */

import { bootstrap, getDb } from "@/planet/db/connection";
import * as datasets from "@/planet/db/datasets";
import * as hdas from "@/planet/db/hdas";
import * as jobs from "@/planet/db/jobs";
import { SECRETS_KEY, SETTINGS_KEY, STORE_NAMES } from "@/planet/db/schema";
import { parseSettingsUpdate } from "@/planet/db/settings";
import { runTransaction, type WriteTx } from "@/planet/db/transaction";
import { JOB_STORES } from "@/planet/db/tx";
import type { DatasetRecord, JobRecord, PlanetSecrets, StoredSettings } from "@/planet/db/types";
import { TERMINAL_DATASET_STATES, TERMINAL_JOB_STATES } from "@/planet/util/states";

import { BackupError } from "./errors";
import { isLocalKvKey, SNAPSHOT_STORES, type StatePayload } from "./payload";

/** `kv` key of the last fork: `{from, to, time}` with a Galaxy timestamp. */
export const FORK_KEY = "instance_fork";

export interface ForkRecord {
    from: string;
    to: string;
    time: string;
}

export interface ImportOptions {
    /** Restores the records as this new instance instead of continuing the snapshot's instance. */
    forkTo?: string | null;
}

export interface ImportResult {
    instance_id: string;
    forked_from: string | null;
    /** Jobs failed by the fork. */
    failed_jobs: number;
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
    await tx.store("kv").put({ from, to, time: tx.now } satisfies ForkRecord, FORK_KEY);
    tx.notify({ type: "outbox-changed" });
    return unfinished.length;
}

async function nextEpoch(tx: WriteTx): Promise<void> {
    const kv = tx.store("kv");
    const epoch = await kv.get("leader_epoch");
    await kv.put((typeof epoch === "number" ? epoch : 0) + 1, "leader_epoch");
}

function restoredSettings(
    local: StoredSettings,
    snapshot: unknown,
    keepCluster: boolean,
    instanceId: string,
): StoredSettings {
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
    return {
        instance_id: instanceId,
        cluster: keepCluster ? local.cluster : { ...local.cluster, ...restoredCluster },
        storage: local.storage,
        user: { ...local.user, ...(parsed.user ?? {}) },
    };
}

/** Replaces this device's records with `payload` (validated by `parsePayload`). */
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
                        ? restoredSettings(local, value, Boolean(secrets?.cluster_token), instanceId)
                        : value;
                writes.push(store.put(stored as never, key));
            }
            await Promise.all(writes);
        }
        await kv.put(Math.max(tx.nowMicros, Math.floor(payload.clock)), "clock");
        await nextEpoch(tx);
        const failed = options.forkTo ? await applyFork(tx, payload.instance_id, options.forkTo) : 0;
        const current = await kv.get("current_history_id");
        if (typeof current === "string") {
            tx.notify({ type: "current-history-changed", historyId: current });
        }
        tx.notify({ type: "settings-changed" });
        tx.notify({ type: "tools-changed" });
        tx.notify({ type: "outbox-changed" });
        return failed;
    });
    await bootstrap(db);
    return { instance_id: instanceId, forked_from: options.forkTo ? payload.instance_id : null, failed_jobs: result };
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
        tx.notify({ type: "settings-changed" });
        return { from, to, failed_jobs: failed };
    });
}
