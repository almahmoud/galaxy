/**
 * Writing and restoring snapshots. The leading tab runs {@link runBackup} periodically and on request; the Service
 * Worker restores ({@link restoreSnapshot}) and exports ({@link buildSnapshot}).
 */

import { LeaderFenceError } from "@/planet/db/fence";
import * as jobs from "@/planet/db/jobs";
import { assertCurrent as assertLeader } from "@/planet/db/leader";
import { DB_VERSION } from "@/planet/db/schema";
import * as settings from "@/planet/db/settings";
import { readTx } from "@/planet/db/tx";
import type { S3Client, S3Config } from "@/planet/s3";
import { newInstanceId } from "@/planet/util/ids";
import { JOB_STATES, TERMINAL_JOB_STATES } from "@/planet/util/states";

import {
    backupClient,
    bucketRef,
    LATEST_FORMAT,
    LEASE_FORMAT,
    type LeaseRecord,
    pruneSnapshots,
    readLease,
    snapshotKey,
    snapshotName,
    writeLatest,
    writeLease,
} from "./bucket";
import { BackupError } from "./errors";
import { openSnapshot, readSnapshotFile, sealSnapshot } from "./format";
import { type BackupKey, unlockKey } from "./keys";
import { type CollectedState, collectState, parsePayload, storeKeyPaths } from "./payload";
import { importState } from "./restore";
import {
    type BackupState,
    clearRequest,
    deviceId,
    emptyState,
    type LeaseInfo,
    readKey,
    readRequest,
    readState,
    requestSnapshot,
    updateState,
    writeKey,
    writeState,
} from "./state";

/** How often the leader looks for changes to snapshot. */
export const INTERVAL_MS = 15 * 60 * 1000;
/** How long the leader waits after a failed snapshot before trying again unasked. */
export const RETRY_MS = 5 * 60 * 1000;
/** How old the lease may get before the holder renews it. */
export const LEASE_RENEW_MS = 60 * 60 * 1000;

export interface BackupRunOptions {
    /** The caller's leader epoch: state writes stop once another tab leads. */
    epoch?: number;
    s3Client?: (config: S3Config) => S3Client;
    /** Milliseconds since the epoch. */
    now?: () => number;
    signal?: AbortSignal;
    /** Throws once this tab no longer leads; checked before every bucket write. Defaults to `leader.assertCurrent`. */
    assertCurrent?: () => Promise<void>;
}

export type BackupOutcome =
    | "no_passphrase"
    | "not_configured"
    | "not_due"
    | "unchanged"
    | "written"
    | "lease_conflict"
    | "failed"
    /** Another tab took over leadership during the run. */
    | "superseded";

function isDue(state: BackupState, now: number): boolean {
    if (state.last_error && now - state.last_error.time < RETRY_MS) {
        return false;
    }
    return state.checked === null || now - state.checked >= INTERVAL_MS;
}

function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

/** Reads the lease and takes it when it is free, ours, or `takeOver` is set. */
async function acquireLease(
    s3: S3Client,
    instanceId: string,
    device: string,
    takeOver: boolean,
    now: number,
    assertCurrent: () => Promise<void>,
    signal?: AbortSignal,
): Promise<LeaseInfo> {
    const current = await readLease(s3, instanceId, signal);
    const conflict = (lease: LeaseRecord): LeaseInfo => ({
        state: "conflict",
        device_id: lease.device_id,
        renewed: lease.renewed,
        checked: now,
    });
    if (current && current.device_id !== device && !takeOver) {
        return conflict(current);
    }
    const ours = current?.device_id === device;
    if (ours && now - Date.parse(current.renewed) < LEASE_RENEW_MS) {
        return { state: "held", device_id: device, renewed: current.renewed, checked: now };
    }
    const time = new Date(now).toISOString();
    const lease: LeaseRecord = {
        format: LEASE_FORMAT,
        version: 1,
        instance_id: instanceId,
        device_id: device,
        acquired: ours ? current.acquired : time,
        renewed: time,
    };
    await assertCurrent();
    await writeLease(s3, lease, signal);
    const written = await readLease(s3, instanceId, signal);
    if (written && written.device_id !== device) {
        return conflict(written);
    }
    return { state: "held", device_id: device, renewed: time, checked: now };
}

/** Collects the records and seals them with `key`. */
export async function buildSnapshot(
    key: BackupKey,
    now: number = Date.now(),
): Promise<{ sealed: Uint8Array<ArrayBuffer>; collected: CollectedState; name: string }> {
    const collected = await collectState(now);
    const sealed = await sealSnapshot(collected.bytes, key.key, key, {
        instance_id: collected.instance_id,
        created: collected.created,
        schema_version: DB_VERSION,
    });
    return { sealed, collected, name: snapshotName(now) };
}

/**
 * One backup cycle of the leading tab: when a snapshot is requested or {@link INTERVAL_MS} passed since the last
 * check, and this device holds the lease, writes a snapshot if the records changed (or the request forces one),
 * points `latest.json` at it and prunes old ones. Records the outcome in `kv` `backup:state`.
 */
export async function runBackup(options: BackupRunOptions = {}): Promise<BackupOutcome> {
    const now = options.now ?? Date.now;
    const assertCurrent = options.assertCurrent ?? (() => assertLeader());
    const { signal, epoch } = options;
    const start = now();
    const [key, request, stored, secrets] = await Promise.all([
        readKey(),
        readRequest(),
        settings.getStored(),
        settings.getSecrets(),
    ]);
    if (!key) {
        return "no_passphrase";
    }
    const s3 = backupClient(stored, secrets, options.s3Client);
    if (!s3) {
        return "not_configured";
    }
    const instanceId = stored.instance_id;
    const bucket = bucketRef(stored.storage);
    const saved = await readState();
    const state = saved?.instance_id === instanceId && saved.bucket === bucket ? saved : emptyState(instanceId, bucket);
    if (!request && !isDue(state, start)) {
        return "not_due";
    }
    const update = (change: (current: BackupState) => BackupState) => updateState(instanceId, bucket, change, epoch);
    const finish = async (outcome: BackupOutcome): Promise<BackupOutcome> => {
        if (request) {
            await clearRequest(request.time);
        }
        return outcome;
    };
    try {
        const device = await deviceId();
        const lease = await acquireLease(s3, instanceId, device, state.take_over, start, assertCurrent, signal);
        if (lease.state === "conflict") {
            await update((current) => ({ ...current, lease, checked: start, last_error: null }));
            return finish("lease_conflict");
        }
        const collected = await collectState(start);
        if (collected.instance_id !== instanceId) {
            // The settings changed while the records were read; the next cycle starts over.
            return finish("superseded");
        }
        const changed = collected.digest !== state.digest || state.last_snapshot?.key_id !== key.key_id;
        if (!changed && !request?.force) {
            await update((current) => ({
                ...current,
                lease,
                take_over: false,
                checked: start,
                changed: false,
                last_error: null,
            }));
            return finish("unchanged");
        }
        const sealed = await sealSnapshot(collected.bytes, key.key, key, {
            instance_id: instanceId,
            created: collected.created,
            schema_version: DB_VERSION,
        });
        const name = snapshotName(start);
        await assertCurrent();
        await s3.putObject(snapshotKey(instanceId, name), sealed, {
            contentType: "application/octet-stream",
            signal,
        });
        await assertCurrent();
        await writeLatest(
            s3,
            {
                format: LATEST_FORMAT,
                version: 1,
                instance_id: instanceId,
                snapshot: name,
                time: collected.created,
                size: sealed.byteLength,
                schema_version: DB_VERSION,
                counts: collected.counts,
            },
            signal,
        );
        let pruneError: string | null = null;
        try {
            await pruneSnapshots(s3, instanceId, signal);
        } catch (error) {
            pruneError = `The snapshot was written, but older snapshots could not be removed: ${errorText(error)}`;
        }
        await update((current) => ({
            ...current,
            last_snapshot: {
                name,
                time: collected.created,
                size: sealed.byteLength,
                counts: collected.counts,
                key_id: key.key_id,
            },
            digest: collected.digest,
            lease,
            take_over: false,
            checked: start,
            changed: false,
            last_error: pruneError ? { message: pruneError, time: start } : null,
        }));
        return finish("written");
    } catch (error) {
        if (error instanceof LeaderFenceError || signal?.aborted) {
            return "superseded";
        }
        await update((current) => ({ ...current, last_error: { message: errorText(error), time: start } }));
        return finish("failed");
    }
}

export interface LocalSummary {
    /** Whether the records hold anything a user made: datasets, collections, jobs, uploads, tools or histories. */
    has_content: boolean;
    unfinished_jobs: number;
}

const UNFINISHED_STATES = JOB_STATES.filter((state) => !TERMINAL_JOB_STATES.has(state));

/** Counts the records a user made; a new device has one empty history and nothing else of these. */
export function localSummary(): Promise<LocalSummary> {
    return readTx(["histories", "hdas", "hdcas", "jobs", "uploads", "tools"], async (tx) => {
        const [histories, hdas, hdcas, jobCount, uploads, unfinished] = await Promise.all([
            tx.store("histories").count(),
            tx.store("hdas").count(),
            tx.store("hdcas").count(),
            tx.store("jobs").count(),
            tx.store("uploads").count(),
            jobs.countByState(UNFINISHED_STATES, tx),
        ]);
        let hasContent = histories > 1 || hdas + hdcas + jobCount + uploads > 0;
        // Tool records hold their bundles; read them only when nothing else counts.
        if (!hasContent && (await tx.store("tools").count()) > 0) {
            hasContent = (await tx.store("tools").getAll()).some((tool) => tool.source === "installed");
        }
        return {
            has_content: hasContent,
            unfinished_jobs: Object.values<number>(unfinished).reduce((sum, count) => sum + count, 0),
        };
    });
}

/** Whether this device holds records that no snapshot of its instance contains. */
export async function hasUnsavedChanges(): Promise<boolean> {
    if (!(await localSummary()).has_content) {
        return false;
    }
    const [state, stored] = await Promise.all([readState(), settings.getStored()]);
    if (!state?.digest || state.instance_id !== stored.instance_id) {
        return true;
    }
    return (await collectState()).digest !== state.digest;
}

export interface RestoreOptions {
    /** Restore as a new instance instead of continuing the snapshot's instance on this device. */
    fork?: boolean;
    /** Replace records that are in no snapshot. */
    replaceUnsaved?: boolean;
    /** This device's next snapshot takes the instance's lease from whichever device holds it. */
    takeOver?: boolean;
    /**
     * Called with the snapshot's instance id before anything is replaced, unless forking or taking over; throws
     * `lease_conflict` when another device writes that instance's snapshots.
     */
    checkLease?: (instanceId: string) => Promise<void>;
    now?: () => number;
    /** The new instance id of a fork (tests). */
    newInstanceId?: () => string;
}

export interface RestoreResult {
    instance_id: string;
    /** The instance the snapshot belongs to. */
    source_instance_id: string;
    /** ISO 8601 UTC time the snapshot was taken. */
    created: string;
    forked: boolean;
    failed_jobs: number;
    counts: Record<string, number>;
}

/**
 * Decrypts a snapshot file with `passphrase` and replaces this device's records with it (`restore.ts`). The key
 * becomes this device's snapshot key, and a snapshot cycle is requested: a fork writes the new instance's first
 * snapshot; otherwise the cycle takes the lease when it is free (or `takeOver` is set) and writes only once the
 * records change.
 *
 * @throws BackupError `format`, `unsupported_version`, `schema_version`, `wrong_passphrase`, `damaged`,
 *   `too_large`, `unsaved_changes` or `lease_conflict` (from `checkLease`)
 */
export async function restoreSnapshot(
    bytes: Uint8Array<ArrayBuffer>,
    passphrase: string,
    options: RestoreOptions = {},
): Promise<RestoreResult> {
    const now = options.now ?? Date.now;
    const file = readSnapshotFile(bytes);
    const { header } = file;
    if (header.schema_version !== DB_VERSION) {
        throw new BackupError(
            "schema_version",
            `The snapshot was written by a Planet with database schema ${header.schema_version}; this Planet uses schema ${DB_VERSION}. Restore it with a matching Planet build.`,
        );
    }
    const key = await unlockKey(
        passphrase,
        {
            key_id: header.key_id,
            salt: header.kdf.salt,
            iterations: header.kdf.iterations,
            key_check: header.key_check,
        },
        now(),
    );
    const payload = parsePayload(await openSnapshot(file, key.key), await storeKeyPaths());
    if (payload.instance_id !== header.instance_id) {
        throw new BackupError("format", "The snapshot's header and records name different instances.");
    }
    if (!options.replaceUnsaved && (await hasUnsavedChanges())) {
        throw new BackupError(
            "unsaved_changes",
            "This device has records that are in no snapshot. Restoring replaces them; confirm to continue.",
        );
    }
    if (!options.fork && !options.takeOver && options.checkLease) {
        await options.checkLease(header.instance_id);
    }
    const forkTo = options.fork ? (options.newInstanceId ?? newInstanceId)() : null;
    const result = await importState(payload, { forkTo });
    await writeKey(key);
    const [collected, stored] = await Promise.all([collectState(now()), settings.getStored()]);
    const state = emptyState(result.instance_id, bucketRef(stored.storage));
    await writeState({
        ...state,
        // Unchanged records need no new snapshot of the same instance; a fork has none yet.
        last_snapshot: forkTo
            ? null
            : {
                  name: snapshotName(Date.parse(header.created)),
                  time: header.created,
                  size: bytes.byteLength,
                  counts: collected.counts,
                  key_id: header.key_id,
              },
        digest: forkTo ? null : collected.digest,
        take_over: !forkTo && options.takeOver === true,
        restored: { instance_id: header.instance_id, created: header.created, time: now(), forked_to: forkTo },
    });
    await requestSnapshot(false, now());
    return {
        instance_id: result.instance_id,
        source_instance_id: header.instance_id,
        created: header.created,
        forked: Boolean(forkTo),
        failed_jobs: result.failed_jobs,
        counts: collected.counts,
    };
}
