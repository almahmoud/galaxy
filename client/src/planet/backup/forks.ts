/**
 * Forks: an instance made from another instance's records (a restore as a new instance, or `forkInstance`). Both
 * instances then hold records of the same datasets, whose bucket objects (`datasets/<uuid>/`) they share. Neither
 * deletes the objects of a dataset that existed at the fork:
 *
 * - the fork knows its origin from `kv` {@link FORK_KEY};
 * - the origin learns of the fork from a marker the fork writes to `state/<origin>/forks/<fork>.json`.
 *
 * `clock` is the boundary: every shared dataset has a `create_time` at or before it (the restored records' timestamp
 * clock, or the device's clock at the fork), every dataset made afterwards on either side a later one. Datasets
 * created before a fork and purged on both sides keep their objects.
 */

import { readTx, writeTx } from "@/planet/db/tx";
import type { S3Client } from "@/planet/s3";
import { isNotFound } from "@/planet/s3";
import { parseGalaxyTime } from "@/planet/util/time";

import { instancePrefix, isInstanceId } from "./bucket";

/** `kv` key of this instance's origin: a {@link ForkRecord}. */
export const FORK_KEY = "instance_fork";

export const FORK_MARKER_FORMAT = "planet-instance-fork";
/** The largest marker read. */
const MAX_MARKER_BYTES = 4096;

export interface ForkRecord {
    from: string;
    to: string;
    /** Galaxy timestamp of the fork. */
    time: string;
    /** Datasets created at or before this timestamp (microseconds since the epoch) are shared with `from`. */
    clock?: number;
    /** Whether `from`'s marker of this fork is in the bucket. */
    registered?: boolean;
}

/** `state/<from>/forks/<to>.json`. */
export interface ForkMarker {
    format: typeof FORK_MARKER_FORMAT;
    version: 1;
    from: string;
    to: string;
    time: string;
    clock: number;
}

export function forksPrefix(instanceId: string): string {
    return `${instancePrefix(instanceId)}forks/`;
}

export function forkMarkerKey(from: string, to: string): string {
    return `${forksPrefix(from)}${to}.json`;
}

/** The boundary of a fork record, in microseconds; records without `clock` use the fork time. */
export function forkClock(record: Pick<ForkRecord, "time" | "clock">): number {
    if (Number.isSafeInteger(record.clock) && record.clock! > 0) {
        return record.clock!;
    }
    try {
        return parseGalaxyTime(record.time);
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

/** Validates a `kv` fork record; null when it is not one. */
export function parseForkRecord(value: unknown): ForkRecord | null {
    const record = value as Partial<Record<keyof ForkRecord, unknown>> | null;
    if (
        typeof record !== "object" ||
        record === null ||
        !isInstanceId(record.from) ||
        !isInstanceId(record.to) ||
        typeof record.time !== "string"
    ) {
        return null;
    }
    return {
        from: record.from,
        to: record.to,
        time: record.time,
        ...(Number.isSafeInteger(record.clock) ? { clock: record.clock as number } : {}),
        registered: record.registered === true,
    };
}

/** Writes the marker that tells `record.from` which of its datasets `record.to` shares. */
export async function writeForkMarker(s3: S3Client, record: ForkRecord, signal?: AbortSignal): Promise<void> {
    const marker: ForkMarker = {
        format: FORK_MARKER_FORMAT,
        version: 1,
        from: record.from,
        to: record.to,
        time: record.time,
        clock: forkClock(record),
    };
    await s3.putObject(forkMarkerKey(record.from, record.to), JSON.stringify(marker), {
        contentType: "application/json",
        signal,
    });
}

/**
 * Writes the marker of the fork this instance was made by when the origin has not been told yet, and records that it
 * has. Returns whether the origin knows of the fork.
 */
export async function registerFork(s3: S3Client, signal?: AbortSignal): Promise<boolean> {
    const fork = parseForkRecord(await readTx(["kv"], (tx) => tx.store("kv").get(FORK_KEY)));
    if (!fork || fork.registered) {
        return true;
    }
    await writeForkMarker(s3, fork, signal);
    await writeTx(["kv"], async (tx) => {
        const store = tx.store("kv");
        const stored = parseForkRecord(await store.get(FORK_KEY));
        if (stored && stored.to === fork.to && stored.time === fork.time) {
            await store.put({ ...stored, registered: true }, FORK_KEY);
        }
    });
    return true;
}

async function markerClock(s3: S3Client, key: string, from: string, signal?: AbortSignal): Promise<number | null> {
    let text: string;
    try {
        const response = await s3.getObject(key, { signal });
        text = await response.text();
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
    let marker: Partial<ForkMarker> | null = null;
    try {
        marker = text.length <= MAX_MARKER_BYTES ? (JSON.parse(text) as Partial<ForkMarker>) : null;
    } catch {
        marker = null;
    }
    if (
        marker?.format !== FORK_MARKER_FORMAT ||
        marker.from !== from ||
        !Number.isSafeInteger(marker.clock) ||
        marker.clock! <= 0
    ) {
        // An unreadable marker still names a fork: keep every object.
        return Number.POSITIVE_INFINITY;
    }
    return marker.clock!;
}

/**
 * The newest boundary of the forks `instanceId` takes part in: datasets created at or before it may be used by
 * another instance. 0 when there are none. Marker contents never change, so `cache` keeps those already read.
 */
export async function sharedBefore(
    s3: S3Client,
    instanceId: string,
    origin: ForkRecord | null,
    cache: Map<string, number> = new Map(),
    signal?: AbortSignal,
): Promise<number> {
    let boundary = origin && origin.to === instanceId ? forkClock(origin) : 0;
    const prefix = forksPrefix(instanceId);
    let token: string | undefined;
    do {
        const page = await s3.listObjects(prefix, { continuationToken: token, signal });
        for (const object of page.objects) {
            if (!object.key.startsWith(prefix) || !object.key.endsWith(".json")) {
                continue;
            }
            let clock = cache.get(object.key);
            if (clock === undefined) {
                const read = await markerClock(s3, object.key, instanceId, signal);
                if (read === null) {
                    continue;
                }
                clock = read;
                cache.set(object.key, clock);
            }
            boundary = Math.max(boundary, clock);
        }
        token = page.isTruncated ? (page.nextContinuationToken ?? undefined) : undefined;
    } while (token);
    return boundary;
}
