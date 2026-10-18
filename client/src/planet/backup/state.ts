/**
 * This device's backup records in `kv`. Keys starting with `backup:` describe the device, not the instance: they
 * are left out of snapshots and survive a restore.
 */

import { readTx, writeTx } from "@/planet/db/tx";
import { randomHex } from "@/planet/util/ids";

import type { BackupKey } from "./keys";

export const KEY_KEY = "backup:key";
export const DEVICE_KEY = "backup:device";
export const STATE_KEY = "backup:state";
export const REQUEST_KEY = "backup:request";

/** BroadcastChannel the Service Worker nudges the leading tab on when a snapshot is requested. */
export const BACKUP_CHANNEL = "planet:backup";

export interface BackupNudge {
    type: "snapshot-requested";
}

/** A snapshot this device wrote or restored. */
export interface SnapshotInfo {
    /** File name under `state/<instance>/snapshots/`. */
    name: string;
    /** ISO 8601 UTC time the snapshot was taken. */
    time: string;
    /** Size of the encrypted file in bytes. */
    size: number;
    /** Records per store. */
    counts: Record<string, number>;
    key_id: string;
}

/** What this device knows about the instance's lease (`state/<instance>/lease.json`). */
export interface LeaseInfo {
    /** `held`: this device holds it; `conflict`: another device does. */
    state: "held" | "conflict";
    device_id: string;
    /** ISO 8601 UTC time the holder last renewed it, if known. */
    renewed: string | null;
    /** When this device last read it, in milliseconds since the epoch. */
    checked: number;
}

export interface BackupState {
    /** Instance and bucket (`endpoint|bucket|prefix`) the fields below describe. */
    instance_id: string;
    bucket: string;
    last_snapshot: SnapshotInfo | null;
    /** SHA-256 of the stores in the last snapshot written or restored, to skip unchanged snapshots. */
    digest: string | null;
    /** When the leader last compared the records with the last snapshot, in milliseconds since the epoch. */
    checked: number | null;
    /** Whether the records differed from the last snapshot at that check. */
    changed: boolean | null;
    last_error: { message: string; time: number } | null;
    lease: LeaseInfo | null;
    /** The next snapshot takes the lease over from whichever device holds it. */
    take_over: boolean;
    /** The snapshot this device's records were restored from. */
    restored: { instance_id: string; created: string; time: number; forked_to: string | null } | null;
}

/** A snapshot request (`kv` `backup:request`); `force` writes one even when nothing changed. */
export interface SnapshotRequest {
    time: number;
    force: boolean;
}

export function emptyState(instanceId: string, bucket: string): BackupState {
    return {
        instance_id: instanceId,
        bucket,
        last_snapshot: null,
        digest: null,
        checked: null,
        changed: null,
        last_error: null,
        lease: null,
        take_over: false,
        restored: null,
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored key, or null when no passphrase is set. */
export async function readKey(): Promise<BackupKey | null> {
    const value = await readTx(["kv"], (tx) => tx.store("kv").get(KEY_KEY));
    return isObject(value) && value.key instanceof CryptoKey ? (value as unknown as BackupKey) : null;
}

export function writeKey(key: BackupKey | null): Promise<void> {
    return writeTx(["kv"], async (tx) => {
        if (key) {
            await tx.store("kv").put(key, KEY_KEY);
        } else {
            await tx.store("kv").delete(KEY_KEY);
        }
    });
}

const DEVICE_RE = /^[0-9a-f]{16}$/;

/** This device's id, created on first use. */
export async function deviceId(): Promise<string> {
    const stored = await readTx(["kv"], (tx) => tx.store("kv").get(DEVICE_KEY));
    if (typeof stored === "string" && DEVICE_RE.test(stored)) {
        return stored;
    }
    return writeTx(["kv"], async (tx) => {
        const store = tx.store("kv");
        const current = await store.get(DEVICE_KEY);
        if (typeof current === "string" && DEVICE_RE.test(current)) {
            return current;
        }
        const created = randomHex(8);
        await store.put(created, DEVICE_KEY);
        return created;
    });
}

export async function readState(): Promise<BackupState | null> {
    const value = await readTx(["kv"], (tx) => tx.store("kv").get(STATE_KEY));
    return isObject(value) && typeof value.instance_id === "string" ? (value as unknown as BackupState) : null;
}

/**
 * Updates the state in one transaction. `epoch`, when given, is the leader epoch of the caller: nothing is written
 * once another tab leads. Returns the new state, or null when nothing was written.
 */
export function updateState(
    instanceId: string,
    bucket: string,
    change: (current: BackupState) => BackupState,
    epoch?: number,
): Promise<BackupState | null> {
    return writeTx(["kv"], async (tx) => {
        const store = tx.store("kv");
        if (epoch !== undefined && (await store.get("leader_epoch")) !== epoch) {
            return null;
        }
        const stored = await store.get(STATE_KEY);
        const current =
            isObject(stored) && stored.instance_id === instanceId && stored.bucket === bucket
                ? (stored as unknown as BackupState)
                : emptyState(instanceId, bucket);
        const next = change(current);
        await store.put(next, STATE_KEY);
        return next;
    });
}

export function writeState(state: BackupState): Promise<void> {
    return writeTx(["kv"], async (tx) => {
        await tx.store("kv").put(state, STATE_KEY);
    });
}

export async function readRequest(): Promise<SnapshotRequest | null> {
    const value = await readTx(["kv"], (tx) => tx.store("kv").get(REQUEST_KEY));
    return isObject(value) && typeof value.time === "number" ? (value as unknown as SnapshotRequest) : null;
}

/** Removes the request if it was made at or before `time`; a newer request stays. */
export function clearRequest(time: number): Promise<void> {
    return writeTx(["kv"], async (tx) => {
        const store = tx.store("kv");
        const value = (await store.get(REQUEST_KEY)) as Partial<SnapshotRequest> | undefined;
        if (value && typeof value.time === "number" && value.time <= time) {
            await store.delete(REQUEST_KEY);
        }
    });
}

/** Asks the leading tab for a snapshot and nudges it. A forced request survives an unforced one. */
export async function requestSnapshot(force: boolean, now: number = Date.now()): Promise<void> {
    await writeTx(["kv"], async (tx) => {
        const store = tx.store("kv");
        const current = (await store.get(REQUEST_KEY)) as Partial<SnapshotRequest> | undefined;
        await store.put({ time: now, force: force || current?.force === true } satisfies SnapshotRequest, REQUEST_KEY);
    });
    if (typeof BroadcastChannel === "function") {
        const channel = new BroadcastChannel(BACKUP_CHANNEL);
        channel.postMessage({ type: "snapshot-requested" } satisfies BackupNudge);
        channel.close();
    }
}
