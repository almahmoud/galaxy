import {
    backupClient,
    BackupError,
    bucketRef,
    buildSnapshot,
    createBackupKey,
    deviceId,
    emptyState,
    forkInstance,
    fromBase64,
    INTERVAL_MS,
    isBackupError,
    isInstanceId,
    isSnapshotName,
    KEEP,
    listInstances,
    listSnapshots,
    localSummary,
    matchesPassphrase,
    MAX_PASSPHRASE_LENGTH,
    MAX_SNAPSHOT_BYTES,
    passphraseProblem,
    readKey,
    readLatest,
    readLease,
    readRequest,
    readSnapshotObject,
    readState,
    requestSnapshot,
    restoreSnapshot,
    updateState,
    writeKey,
    writeState,
} from "@/planet/backup";
import { DB_VERSION, leader, settings } from "@/planet/db";
import { STALE_MS } from "@/planet/jobs/leader";
import type { S3Client, S3Config } from "@/planet/s3";
import { isNotFound, isS3Error } from "@/planet/s3";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import type {
    BackupAction,
    BackupStatus,
    BucketInstance,
    RestoreResponse,
    SnapshotListing,
} from "@/planet/ui/lib/backup";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { newInstanceId } from "@/planet/util/ids";

/** Clients and clocks the endpoints use; tests replace them. */
export interface BackupClients {
    s3Client?: (config: S3Config) => S3Client;
    /** Milliseconds since the epoch. */
    now?: () => number;
    /** The id of a forked instance. */
    newInstanceId?: () => string;
}

/** Instances listed by `GET /api/planet/backup/snapshots`. */
const MAX_INSTANCES = 50;
const ACTIONS: readonly BackupAction["action"][] = [
    "snapshot",
    "set_passphrase",
    "remove_passphrase",
    "take_over",
    "fork",
];
const MAX_SNAPSHOT_BASE64 = Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4;

function iso(time: number | null | undefined): string | null {
    return typeof time === "number" && Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The JSON body of a script's request; see `pageJson` in `planet.ts`. */
async function pageJson(request: PlanetRequest): Promise<Record<string, unknown>> {
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
        throw ApiError.badRequest("Send this request with fetch and Content-Type: application/json.");
    }
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw ApiError.badRequest("The request body is not JSON.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw ApiError.badRequest("The request must be a JSON object.");
    }
    return body as Record<string, unknown>;
}

const BAD_REQUEST_CODES = new Set(["format", "unsupported_version", "schema_version", "damaged", "too_large"]);

/** Converts backup and bucket failures to API errors; `reason` carries the backup error code. */
function apiError(error: unknown): unknown {
    if (isBackupError(error)) {
        const extra = { ...error.details, reason: error.code };
        if (error.code === "wrong_passphrase") {
            return new ApiError(403, error.message, ErrorCodes.USER_CANNOT_ACCESS_ITEM, extra);
        }
        if (error.code === "weak_passphrase") {
            return new ApiError(400, error.message, ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID, extra);
        }
        if (BAD_REQUEST_CODES.has(error.code)) {
            return new ApiError(400, error.message, ErrorCodes.USER_REQUEST_INVALID_PARAMETER, extra);
        }
        return new ApiError(409, error.message, ErrorCodes.CONFLICT, extra);
    }
    if (isS3Error(error)) {
        return new ApiError(502, `The bucket could not be read: ${error.message}`, ErrorCodes.UPSTREAM_PROXY_ERROR, {
            reason: "bucket",
        });
    }
    return error;
}

function guarded<T>(handler: () => Promise<T>): Promise<T> {
    return handler().catch((error: unknown) => {
        throw apiError(error);
    });
}

async function client(clients: BackupClients): Promise<S3Client | null> {
    const [stored, secrets] = await Promise.all([settings.getStored(), settings.getSecrets()]);
    return backupClient(stored, secrets, clients.s3Client);
}

async function status(clients: BackupClients): Promise<BackupStatus> {
    const now = (clients.now ?? Date.now)();
    const [key, saved, request, current, heartbeat, local, device] = await Promise.all([
        readKey(),
        readState(),
        readRequest(),
        settings.get(),
        leader.read(),
        localSummary(),
        deviceId(),
    ]);
    const bucket = bucketRef(current.storage);
    const state = saved?.instance_id === current.instance_id && saved.bucket === bucket ? saved : null;
    const snapshot = state?.last_snapshot ?? null;
    return {
        passphrase: { set: Boolean(key), key_id: key?.key_id ?? null, created: key?.created ?? null },
        storage_configured: settings.configured(current).storage,
        instance_id: current.instance_id,
        device_id: device,
        schema_version: DB_VERSION,
        interval_minutes: INTERVAL_MS / 60_000,
        keep: KEEP,
        last_snapshot: snapshot
            ? { name: snapshot.name, time: snapshot.time, size: snapshot.size, counts: { ...snapshot.counts } }
            : null,
        checked: iso(state?.checked),
        last_error: state?.last_error
            ? { message: state.last_error.message, time: iso(state.last_error.time) ?? "" }
            : null,
        requested: request !== null,
        lease: state?.lease
            ? {
                  state: state.lease.state,
                  device_id: state.lease.device_id,
                  renewed: state.lease.renewed,
                  checked: iso(state.lease.checked) ?? "",
              }
            : null,
        writer_active: typeof heartbeat?.heartbeat === "number" && now - heartbeat.heartbeat < STALE_MS,
        local,
        restored: saved?.restored
            ? {
                  instance_id: saved.restored.instance_id,
                  created: saved.restored.created,
                  time: iso(saved.restored.time) ?? "",
                  forked_to: saved.restored.forked_to,
              }
            : null,
    };
}

async function requireWriter(): Promise<void> {
    const [key, current] = await Promise.all([readKey(), settings.get()]);
    if (!key) {
        throw new BackupError("no_passphrase", "Set a backup passphrase first.");
    }
    if (!settings.configured(current).storage) {
        throw new BackupError("not_configured", "Set up the storage bucket first.");
    }
}

function stringField(body: Record<string, unknown>, name: string, optional = false): string | undefined {
    const value = body[name];
    if (value === undefined && optional) {
        return undefined;
    }
    if (typeof value !== "string" || value.length > MAX_PASSPHRASE_LENGTH * 4) {
        throw ApiError.badRequest(`${name} must be a string.`);
    }
    return value;
}

function booleanField(body: Record<string, unknown>, name: string): boolean {
    const value = body[name];
    if (value !== undefined && typeof value !== "boolean") {
        throw ApiError.badRequest(`${name} must be true or false.`);
    }
    return value === true;
}

async function setPassphrase(body: Record<string, unknown>, now: number): Promise<void> {
    const passphrase = stringField(body, "passphrase")!;
    const problem = passphraseProblem(passphrase);
    if (problem) {
        throw new ApiError(400, problem, ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID, {
            reason: "weak_passphrase",
            err_data: { passphrase: problem },
        });
    }
    const existing = await readKey();
    if (existing) {
        const currentPassphrase = stringField(body, "current_passphrase", true);
        if (currentPassphrase === undefined || !(await matchesPassphrase(existing, currentPassphrase))) {
            throw new ApiError(403, "The current passphrase is wrong.", ErrorCodes.USER_CANNOT_ACCESS_ITEM, {
                reason: "wrong_passphrase",
                err_data: { current_passphrase: "The current passphrase is wrong." },
            });
        }
    }
    await writeKey(await createBackupKey(passphrase, now));
    const current = await settings.get();
    if (settings.configured(current).storage) {
        await requestSnapshot(true, now);
    }
}

async function act(body: Record<string, unknown>, clients: BackupClients): Promise<BackupStatus> {
    const action = body.action as BackupAction["action"];
    if (!ACTIONS.includes(action)) {
        throw ApiError.badRequest(`action must be one of ${ACTIONS.join(", ")}.`);
    }
    const now = (clients.now ?? Date.now)();
    switch (action) {
        case "snapshot":
            await requireWriter();
            await requestSnapshot(true, now);
            break;
        case "set_passphrase":
            await setPassphrase(body, now);
            break;
        case "remove_passphrase":
            await writeKey(null);
            break;
        case "take_over": {
            await requireWriter();
            const stored = await settings.getStored();
            await updateState(stored.instance_id, bucketRef(stored.storage), (current) => ({
                ...current,
                take_over: true,
            }));
            await requestSnapshot(true, now);
            break;
        }
        case "fork": {
            const fork = await forkInstance((clients.newInstanceId ?? newInstanceId)());
            const stored = await settings.getStored();
            await writeState(emptyState(fork.to, bucketRef(stored.storage)));
            await requestSnapshot(true, now);
            break;
        }
    }
    return status(clients);
}

async function instance(s3: S3Client, instanceId: string, currentId: string, device: string): Promise<BucketInstance> {
    const [latest, lease, snapshots] = await Promise.all([
        readLatest(s3, instanceId),
        readLease(s3, instanceId),
        listSnapshots(s3, instanceId),
    ]);
    return {
        instance_id: instanceId,
        current: instanceId === currentId,
        latest: latest
            ? {
                  snapshot: latest.snapshot,
                  time: latest.time,
                  size: latest.size,
                  schema_version: latest.schema_version,
                  counts: latest.counts,
              }
            : null,
        lease: lease
            ? { device_id: lease.device_id, renewed: lease.renewed, this_device: lease.device_id === device }
            : null,
        snapshots: snapshots.reverse().map(({ name, time, size }) => ({ name, time, size })),
    };
}

async function snapshots(clients: BackupClients): Promise<SnapshotListing> {
    const s3 = await client(clients);
    if (!s3) {
        throw new BackupError("not_configured", "Set up the storage bucket to find its snapshots.");
    }
    const [ids, current, device] = await Promise.all([listInstances(s3), settings.getStored(), deviceId()]);
    const listed = ids.slice(0, MAX_INSTANCES);
    const instances = await Promise.all(listed.map((id) => instance(s3, id, current.instance_id, device)));
    instances.sort((a, b) => (b.snapshots[0]?.name ?? "").localeCompare(a.snapshots[0]?.name ?? ""));
    return { instances, truncated: ids.length > listed.length };
}

/** Refuses to continue an instance whose lease another device holds; an unreadable lease is checked later. */
async function leaseCheck(clients: BackupClients): Promise<((instanceId: string) => Promise<void>) | undefined> {
    const s3 = await client(clients);
    if (!s3) {
        return undefined;
    }
    const device = await deviceId();
    return async (instanceId) => {
        let lease: Awaited<ReturnType<typeof readLease>>;
        try {
            lease = await readLease(s3, instanceId);
        } catch {
            return;
        }
        if (lease && lease.device_id !== device) {
            throw new BackupError(
                "lease_conflict",
                `Another device writes the snapshots of instance ${instanceId} (last on ${lease.renewed}). Continue the instance here, so that device stops writing snapshots, or restore it as a new instance.`,
                { lease: { device_id: lease.device_id, renewed: lease.renewed } },
            );
        }
    };
}

/** The snapshot file a restore request names: inline as base64, or a snapshot in the bucket. */
async function snapshotBytes(body: Record<string, unknown>, clients: BackupClients): Promise<Uint8Array<ArrayBuffer>> {
    const inline = body.snapshot;
    const source = body.bucket as { instance_id?: unknown; name?: unknown } | undefined;
    if ((inline === undefined) === (source === undefined)) {
        throw ApiError.badRequest("Send either snapshot (the file as base64) or bucket ({instance_id, name}).");
    }
    if (inline !== undefined) {
        if (typeof inline !== "string" || inline.length === 0) {
            throw ApiError.badRequest("snapshot must be the snapshot file as base64.");
        }
        if (inline.length > MAX_SNAPSHOT_BASE64) {
            throw new BackupError(
                "too_large",
                `Snapshots larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB are refused.`,
            );
        }
        return fromBase64(inline);
    }
    if (
        typeof source !== "object" ||
        source === null ||
        !isInstanceId(source.instance_id) ||
        !isSnapshotName(source.name)
    ) {
        throw ApiError.badRequest("bucket must name an instance id and a snapshot file name.");
    }
    const s3 = await client(clients);
    if (!s3) {
        throw new BackupError("not_configured", "Set up the storage bucket to restore from it.");
    }
    try {
        return await readSnapshotObject(s3, source.instance_id, source.name);
    } catch (error) {
        if (isNotFound(error)) {
            throw new ApiError(404, "The snapshot is not in the bucket.", ErrorCodes.USER_OBJECT_NOT_FOUND, {
                reason: "not_found",
            });
        }
        throw error;
    }
}

async function restore(body: Record<string, unknown>, clients: BackupClients): Promise<RestoreResponse> {
    const passphrase = stringField(body, "passphrase")!;
    const fork = booleanField(body, "fork");
    const replaceUnsaved = booleanField(body, "replace_unsaved");
    const takeOver = booleanField(body, "take_over");
    const bytes = await snapshotBytes(body, clients);
    return restoreSnapshot(bytes, passphrase, {
        fork,
        replaceUnsaved,
        takeOver,
        checkLease: await leaseCheck(clients),
        now: clients.now,
        newInstanceId: clients.newInstanceId,
    });
}

async function exportSnapshot(clients: BackupClients): Promise<Response> {
    const key = await readKey();
    if (!key) {
        throw new BackupError(
            "no_passphrase",
            "Set a backup passphrase first; exported snapshots are encrypted with it.",
        );
    }
    const { sealed, collected, name } = await buildSnapshot(key, (clients.now ?? Date.now)());
    return new Response(sealed, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="planet-${collected.instance_id}-${name}"`,
        },
    });
}

/**
 * Backup endpoints (see `@/planet/backup`):
 *
 * - `GET /api/planet/backup`: `BackupStatus` (`@/planet/ui/lib/backup`).
 * - `POST /api/planet/backup`: a `BackupAction`: request a snapshot now, set or change the passphrase (changing
 *   it needs the current one), remove it, take the instance's lease over from another device, or fork this
 *   device's records into a new instance. Answers with the new status.
 * - `GET /api/planet/backup/snapshots`: the instances and snapshots under `state/` in the bucket (`SnapshotListing`).
 * - `POST /api/planet/backup/restore`: a `RestoreRequest`; replaces this device's records with the snapshot. Fails
 *   with 409 `reason: "unsaved_changes"` when records in no snapshot would be lost, unless `replace_unsaved`, and
 *   with 409 `reason: "lease_conflict"` (and `lease`) when another device writes the instance's snapshots, unless
 *   `take_over` or `fork`.
 * - `GET /api/planet/backup/export`: an encrypted snapshot of this device's records as a file.
 *
 * Errors carry `reason`, a backup error code (`@/planet/backup/errors`), or `bucket` when the bucket failed.
 */
export function register(router: Router, clients: BackupClients = {}): void {
    router.untyped("/api/planet/backup", "get", () => guarded(() => status(clients)));
    router.untyped("/api/planet/backup", "post", async (request) => {
        const body = await pageJson(request);
        return guarded(() => act(body, clients));
    });
    router.untyped("/api/planet/backup/snapshots", "get", () => guarded(() => snapshots(clients)));
    router.untyped("/api/planet/backup/restore", "post", async (request) => {
        const body = await pageJson(request);
        return guarded(() => restore(body, clients));
    });
    router.untyped("/api/planet/backup/export", "get", () => guarded(() => exportSnapshot(clients)));
}
