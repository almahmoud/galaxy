/**
 * Backup objects under `<prefix>/state/<instance>/`:
 *
 * - `snapshots/<YYYYMMDDTHHMMSSmmm>Z.json.gz.enc`: encrypted snapshots (`format.ts`); the newest {@link KEEP} stay.
 * - `latest.json`: {@link LatestPointer}, unencrypted: the newest snapshot's name, time, size, schema version and
 *   record counts.
 * - `lease.json`: {@link LeaseRecord}, unencrypted: the device that runs the instance's jobs and writes its
 *   snapshots (`lease.ts`). A device takes it from another device only when asked to.
 *
 * Writes are plain PUTs: two devices that find no lease at the same moment can both write one snapshot before
 * the next check shows the conflict.
 */

import type { PlanetSecrets, StoredSettings } from "@/planet/db/types";
import { createS3Client, isNotFound, type S3Client, type S3Config } from "@/planet/s3";

import { isBackupError } from "./errors";
import { MAX_SNAPSHOT_BYTES, readLimited } from "./format";

/** Snapshots kept per instance. */
export const KEEP = 10;

export const STATE_PREFIX = "state/";
const SNAPSHOT_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z\.json\.gz\.enc$/;
const INSTANCE_RE = /^[0-9a-f]{8}$/;
const DEVICE_RE = /^[0-9a-f]{16}$/;
/** The largest pointer or lease object read. */
const MAX_SMALL_OBJECT_BYTES = 64 * 1024;

export const LATEST_FORMAT = "planet-snapshot-pointer";
export const LEASE_FORMAT = "planet-snapshot-lease";

export interface LatestPointer {
    format: typeof LATEST_FORMAT;
    version: 1;
    instance_id: string;
    /** File name under `snapshots/`. */
    snapshot: string;
    /** ISO 8601 UTC time the snapshot was taken. */
    time: string;
    /** Size of the encrypted file in bytes. */
    size: number;
    schema_version: number;
    counts: Record<string, number>;
}

export interface LeaseRecord {
    format: typeof LEASE_FORMAT;
    version: 1;
    instance_id: string;
    device_id: string;
    /** ISO 8601 UTC times the device took the lease and last renewed it. */
    acquired: string;
    renewed: string;
    /** The device this one took the lease from, if it was held when this one took it. */
    taken_from?: string | null;
}

export function instancePrefix(instanceId: string): string {
    return `${STATE_PREFIX}${instanceId}/`;
}

export function snapshotKey(instanceId: string, name: string): string {
    return `${instancePrefix(instanceId)}snapshots/${name}`;
}

export function latestKey(instanceId: string): string {
    return `${instancePrefix(instanceId)}latest.json`;
}

export function leaseKey(instanceId: string): string {
    return `${instancePrefix(instanceId)}lease.json`;
}

export function isInstanceId(value: unknown): value is string {
    return typeof value === "string" && INSTANCE_RE.test(value);
}

export function isSnapshotName(value: unknown): value is string {
    return typeof value === "string" && SNAPSHOT_NAME_RE.test(value);
}

/** The snapshot file name for a time in milliseconds since the epoch. */
export function snapshotName(time: number): string {
    return `${new Date(time).toISOString().replace(/[-:.]/g, "")}.json.gz.enc`;
}

/** The time a snapshot name encodes, as ISO 8601 UTC. */
export function snapshotTime(name: string): string | null {
    const match = SNAPSHOT_NAME_RE.exec(name);
    if (!match) {
        return null;
    }
    const [, y, mo, d, h, mi, s, ms] = match;
    const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Identifies the bucket and prefix snapshots go to, so a settings change starts over. */
export function bucketRef(storage: StoredSettings["storage"]): string {
    return `${storage.endpoint}|${storage.bucket}|${storage.prefix}`;
}

/** A client for the configured bucket, or null when the storage settings or the secret are missing. */
export function backupClient(
    stored: StoredSettings,
    secrets: PlanetSecrets,
    factory: (config: S3Config) => S3Client = createS3Client,
): S3Client | null {
    const storage = stored.storage;
    const secret = secrets.storage_secret_access_key;
    if (!storage.endpoint || !storage.bucket || !storage.access_key_id || !secret) {
        return null;
    }
    return factory({
        endpoint: storage.endpoint,
        clusterEndpoint: storage.cluster_endpoint,
        bucket: storage.bucket,
        prefix: storage.prefix,
        region: storage.region,
        pathStyle: storage.path_style,
        accessKeyId: storage.access_key_id,
        secretAccessKey: secret,
    });
}

function readBody(response: Response, limit: number, message: string): Promise<Uint8Array<ArrayBuffer>> {
    const body = response.body ?? new Blob([]).stream();
    return readLimited(body, limit, message);
}

async function readSmallJson(s3: S3Client, key: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
        response = await s3.getObject(key, { signal });
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }
        throw error;
    }
    let bytes: Uint8Array;
    try {
        bytes = await readBody(response, MAX_SMALL_OBJECT_BYTES, "");
    } catch (error) {
        if (isBackupError(error, "too_large")) {
            return null;
        }
        throw error;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function isIso(value: unknown): value is string {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function countsOf(value: unknown): Record<string, number> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(value).filter(
            (entry): entry is [string, number] =>
                /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] >= 0,
        ),
    );
}

/** Validates an untrusted pointer; null when it is not one. */
export function parseLatest(value: unknown, instanceId: string): LatestPointer | null {
    const pointer = value as Partial<Record<keyof LatestPointer, unknown>> | null;
    if (
        typeof pointer !== "object" ||
        pointer === null ||
        pointer.format !== LATEST_FORMAT ||
        pointer.instance_id !== instanceId ||
        !isSnapshotName(pointer.snapshot) ||
        !isIso(pointer.time) ||
        !Number.isSafeInteger(pointer.size) ||
        !Number.isSafeInteger(pointer.schema_version)
    ) {
        return null;
    }
    return {
        format: LATEST_FORMAT,
        version: 1,
        instance_id: instanceId,
        snapshot: pointer.snapshot,
        time: pointer.time,
        size: pointer.size as number,
        schema_version: pointer.schema_version as number,
        counts: countsOf(pointer.counts),
    };
}

/** Validates an untrusted lease; null when it is not one. */
export function parseLease(value: unknown, instanceId: string): LeaseRecord | null {
    const lease = value as Partial<Record<keyof LeaseRecord, unknown>> | null;
    if (
        typeof lease !== "object" ||
        lease === null ||
        lease.format !== LEASE_FORMAT ||
        lease.instance_id !== instanceId ||
        typeof lease.device_id !== "string" ||
        !DEVICE_RE.test(lease.device_id) ||
        !isIso(lease.acquired) ||
        !isIso(lease.renewed)
    ) {
        return null;
    }
    return {
        format: LEASE_FORMAT,
        version: 1,
        instance_id: instanceId,
        device_id: lease.device_id,
        acquired: lease.acquired,
        renewed: lease.renewed,
        taken_from: typeof lease.taken_from === "string" && DEVICE_RE.test(lease.taken_from) ? lease.taken_from : null,
    };
}

export async function readLatest(
    s3: S3Client,
    instanceId: string,
    signal?: AbortSignal,
): Promise<LatestPointer | null> {
    return parseLatest(await readSmallJson(s3, latestKey(instanceId), signal), instanceId);
}

/** The lease, or null when there is none or it is unreadable (and may be replaced). */
export async function readLease(s3: S3Client, instanceId: string, signal?: AbortSignal): Promise<LeaseRecord | null> {
    return parseLease(await readSmallJson(s3, leaseKey(instanceId), signal), instanceId);
}

export async function writeLease(s3: S3Client, lease: LeaseRecord, signal?: AbortSignal): Promise<void> {
    await s3.putObject(leaseKey(lease.instance_id), JSON.stringify(lease), {
        contentType: "application/json",
        signal,
    });
}

export async function writeLatest(s3: S3Client, pointer: LatestPointer, signal?: AbortSignal): Promise<void> {
    await s3.putObject(latestKey(pointer.instance_id), JSON.stringify(pointer), {
        contentType: "application/json",
        signal,
    });
}

export interface ListedSnapshot {
    name: string;
    time: string;
    size: number;
}

/** The instance's snapshots, oldest first. */
export async function listSnapshots(s3: S3Client, instanceId: string, signal?: AbortSignal): Promise<ListedSnapshot[]> {
    const prefix = `${instancePrefix(instanceId)}snapshots/`;
    const found: ListedSnapshot[] = [];
    let token: string | undefined;
    do {
        const page = await s3.listObjects(prefix, { continuationToken: token, signal });
        for (const object of page.objects) {
            const name = object.key.slice(prefix.length);
            const time = snapshotTime(name);
            if (object.key.startsWith(prefix) && time) {
                found.push({ name, time, size: object.size });
            }
        }
        token = page.isTruncated && page.nextContinuationToken ? page.nextContinuationToken : undefined;
    } while (token);
    return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Instance ids with objects under `state/`. */
export async function listInstances(s3: S3Client, signal?: AbortSignal): Promise<string[]> {
    const found = new Set<string>();
    let token: string | undefined;
    do {
        const page = await s3.listObjects(STATE_PREFIX, { delimiter: "/", continuationToken: token, signal });
        for (const prefix of page.commonPrefixes) {
            const id = prefix.slice(STATE_PREFIX.length).replace(/\/$/, "");
            if (prefix.startsWith(STATE_PREFIX) && isInstanceId(id)) {
                found.add(id);
            }
        }
        token = page.isTruncated && page.nextContinuationToken ? page.nextContinuationToken : undefined;
    } while (token);
    return [...found].sort();
}

/**
 * Downloads a snapshot file.
 *
 * @throws BackupError `too_large` above {@link MAX_SNAPSHOT_BYTES}
 */
export async function readSnapshotObject(
    s3: S3Client,
    instanceId: string,
    name: string,
    signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    const response = await s3.getObject(snapshotKey(instanceId, name), { signal });
    return readBody(
        response,
        MAX_SNAPSHOT_BYTES,
        `Snapshots larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB are refused.`,
    );
}

/** Deletes all but the newest {@link KEEP} snapshots; returns the deleted names. */
export async function pruneSnapshots(s3: S3Client, instanceId: string, signal?: AbortSignal): Promise<string[]> {
    const snapshots = await listSnapshots(s3, instanceId, signal);
    const old = snapshots.slice(0, Math.max(0, snapshots.length - KEEP));
    for (const snapshot of old) {
        await s3.deleteObject(snapshotKey(instanceId, snapshot.name), { signal });
    }
    return old.map((snapshot) => snapshot.name);
}
