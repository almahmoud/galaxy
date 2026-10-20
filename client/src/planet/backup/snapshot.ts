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
import { loadOptionalStaticData } from "@/planet/util/staticData";

import {
    backupClient,
    bucketRef,
    LATEST_FORMAT,
    listSnapshots,
    pruneSnapshots,
    readSnapshotObject,
    snapshotKey,
    snapshotName,
    writeLatest,
} from "./bucket";
import { BackupError } from "./errors";
import { registerFork } from "./forks";
import { openSnapshot, readSnapshotFile, sealSnapshot } from "./format";
import { type BackupKey, unlockKey } from "./keys";
import { acquireLease } from "./lease";
import {
    type CollectedState,
    collectState,
    parsePayload,
    restorableSchema,
    schemaError,
    storeKeyPaths,
} from "./payload";
import { type ClusterEndpoints, endpointsToConfirm, importState } from "./restore";
import {
    type BackupState,
    clearRequest,
    deviceId,
    emptyState,
    readKey,
    readPreviousKeys,
    readRequest,
    readState,
    type RekeyRequest,
    requestSnapshot,
    updateState,
    writeKey,
    writePreviousKeys,
    writeState,
} from "./state";
import { checkRecords } from "./validate";

/** How often the leader looks for changes to snapshot. */
export const INTERVAL_MS = 15 * 60 * 1000;
/** How long the leader waits after a failed snapshot before trying again unasked. */
export const RETRY_MS = 5 * 60 * 1000;

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
 * Re-encrypts with `key`, or deletes, the instance's snapshots of earlier keys, as `request` asks; called once the
 * newest snapshot has `key`. Snapshots of keys this device does not have, and unreadable ones, stay. Returns the
 * request with its progress, or null when there is nothing to do. A failure is recorded and retried by the next cycle.
 */
async function rekeyAfter(
    s3: S3Client,
    instanceId: string,
    key: BackupKey,
    request: RekeyRequest | null | undefined,
    assertCurrent: () => Promise<void>,
    now: number,
    signal?: AbortSignal,
): Promise<RekeyRequest | null> {
    if (!request || request.finished !== null || request.key_id !== key.key_id) {
        return null;
    }
    const previous = new Map((await readPreviousKeys()).map((each) => [each.key_id, each]));
    let { done } = request;
    let skipped = 0;
    try {
        for (const listed of await listSnapshots(s3, instanceId, signal)) {
            const bytes = await readSnapshotObject(s3, instanceId, listed.name, signal);
            let file: ReturnType<typeof readSnapshotFile>;
            try {
                file = readSnapshotFile(bytes);
            } catch {
                skipped++;
                continue;
            }
            if (file.header.key_id === key.key_id) {
                continue;
            }
            const objectKey = snapshotKey(instanceId, listed.name);
            if (request.mode === "delete") {
                await assertCurrent();
                await s3.deleteObject(objectKey, { signal });
                done++;
                continue;
            }
            const old = previous.get(file.header.key_id);
            let plain: Uint8Array<ArrayBuffer>;
            try {
                if (!old) {
                    throw new BackupError("wrong_passphrase", "The key is not on this device.");
                }
                plain = await openSnapshot(file, old.key);
            } catch {
                skipped++;
                continue;
            }
            const sealed = await sealSnapshot(plain, key.key, key, {
                instance_id: file.header.instance_id,
                created: file.header.created,
                schema_version: file.header.schema_version,
            });
            await assertCurrent();
            await s3.putObject(objectKey, sealed, { contentType: "application/octet-stream", signal });
            done++;
        }
    } catch (error) {
        if (error instanceof LeaderFenceError || signal?.aborted) {
            throw error;
        }
        return { ...request, done, last_error: errorText(error) };
    }
    await writePreviousKeys([]);
    return { ...request, done, skipped, last_error: null, finished: now };
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
        const lease = await acquireLease(s3, instanceId, device, {
            takeOver: state.take_over,
            now: start,
            assertCurrent,
            signal,
        });
        if (lease.state === "conflict") {
            await update((current) => ({ ...current, lease, checked: start, last_error: null }));
            return finish("lease_conflict");
        }
        const collected = await collectState(start);
        if (collected.instance_id !== instanceId) {
            // The settings changed while the records were read; the next cycle starts over.
            return finish("superseded");
        }
        const changed =
            collected.digest !== state.digest ||
            state.last_snapshot?.key_id !== key.key_id ||
            state.last_snapshot?.schema_version !== DB_VERSION;
        if (!changed && !request?.force) {
            const rekey = await rekeyAfter(s3, instanceId, key, state.rekey, assertCurrent, start, signal);
            await update((current) => ({
                ...current,
                lease,
                take_over: false,
                checked: start,
                changed: false,
                last_error: null,
                ...(rekey ? { rekey } : {}),
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
                schema_version: DB_VERSION,
            },
            digest: collected.digest,
            lease,
            take_over: false,
            checked: start,
            changed: false,
            last_error: pruneError ? { message: pruneError, time: start } : null,
        }));
        const rekey = await rekeyAfter(s3, instanceId, key, state.rekey, assertCurrent, start, signal);
        if (rekey) {
            await update((current) => ({ ...current, rekey }));
        }
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
     * The user's choice for a snapshot whose cluster gateway or runtime image differs from this device's: keep this
     * device's, or take the snapshot's (the values the user was shown).
     */
    endpoints?: "device" | ClusterEndpoints;
    /**
     * Called with the snapshot's instance id before anything is replaced, unless forking or taking over; throws
     * `lease_conflict` when another device writes that instance's snapshots.
     */
    checkLease?: (instanceId: string) => Promise<void>;
    /** The bucket, for the marker a fork leaves its origin; the leader writes it later when missing. */
    s3?: S3Client | null;
    /** Ids of the tools built into this build; defaults to those of `toolbox/tools.json`. */
    builtInToolIds?: () => Promise<ReadonlySet<string>>;
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
    /** Jobs paused until the user resumes restored jobs. */
    parked_jobs: number;
    counts: Record<string, number>;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ids of the tools of this build's toolbox, every version of each. */
export async function builtInToolIds(): Promise<ReadonlySet<string>> {
    const entries = await loadOptionalStaticData<unknown>("toolbox/tools.json");
    const ids = new Set<string>();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!isObject(entry) || typeof entry.id !== "string") {
            continue;
        }
        ids.add(entry.id);
        // A Tool Shed id ends with its version: `<host>/repos/<owner>/<name>/<tool>/<version>`.
        const versions = Array.isArray(entry.versions) ? entry.versions : [];
        if (
            entry.id.includes("/repos/") &&
            typeof entry.version === "string" &&
            entry.id.endsWith(`/${entry.version}`)
        ) {
            const base = entry.id.slice(0, entry.id.length - entry.version.length);
            for (const version of versions) {
                if (typeof version === "string") {
                    ids.add(`${base}${version}`);
                }
            }
        }
    }
    return ids;
}

/** The snapshot's gateway and runtime image to take, after the user confirmed them; throws until then. */
async function chooseEndpoints(
    payload: Parameters<typeof endpointsToConfirm>[0],
    choice: RestoreOptions["endpoints"],
): Promise<boolean> {
    const [local, secrets] = await Promise.all([settings.getStored(), settings.getSecrets()]);
    const shown = endpointsToConfirm(payload, local, Boolean(secrets.cluster_token));
    if (!shown || choice === "device") {
        return false;
    }
    if (isObject(choice) && choice.gateway_url === shown.gateway_url && choice.runtime_image === shown.runtime_image) {
        return true;
    }
    throw new BackupError(
        "cluster_settings",
        "The snapshot names a cluster gateway and runtime image. Confirm them, or keep this device's cluster settings.",
        { cluster: shown },
    );
}

/**
 * Decrypts a snapshot file with `passphrase`, checks its records (`validate.ts`) and replaces this device's records
 * with them (`restore.ts`). The key becomes this device's snapshot key, and a snapshot cycle is requested: a fork
 * writes the new instance's first snapshot; otherwise the cycle takes the lease when it is free (or `takeOver` is set)
 * and writes once the records change or were migrated from an older schema.
 *
 * @throws BackupError `format`, `unsupported_version`, `schema_version`, `wrong_passphrase`, `damaged`,
 *   `too_large`, `unsaved_changes`, `lease_conflict` (from `checkLease`) or `cluster_settings`
 */
export async function restoreSnapshot(
    bytes: Uint8Array<ArrayBuffer>,
    passphrase: string,
    options: RestoreOptions = {},
): Promise<RestoreResult> {
    const now = options.now ?? Date.now;
    const file = readSnapshotFile(bytes);
    const { header } = file;
    if (!restorableSchema(header.schema_version)) {
        throw schemaError(header.schema_version);
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
    if (payload.instance_id !== header.instance_id || payload.schema_version !== header.schema_version) {
        throw new BackupError("format", "The snapshot's header and records describe different snapshots.");
    }
    checkRecords(payload, await (options.builtInToolIds ?? builtInToolIds)());
    if (!options.replaceUnsaved && (await hasUnsavedChanges())) {
        throw new BackupError(
            "unsaved_changes",
            "This device has records that are in no snapshot. Restoring replaces them; confirm to continue.",
        );
    }
    if (!options.fork && !options.takeOver && options.checkLease) {
        await options.checkLease(header.instance_id);
    }
    const useSnapshotEndpoints = await chooseEndpoints(payload, options.endpoints);
    const forkTo = options.fork ? (options.newInstanceId ?? newInstanceId)() : null;
    const result = await importState(payload, { forkTo, useSnapshotEndpoints, now: now() });
    if (forkTo && options.s3) {
        // The leader writes the marker when this fails.
        await registerFork(options.s3).catch(() => false);
    }
    await writeKey(key);
    await writePreviousKeys([]);
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
                  schema_version: header.schema_version,
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
        parked_jobs: result.parked_jobs,
        counts: collected.counts,
    };
}
