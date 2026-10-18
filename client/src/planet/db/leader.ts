/** Job leader bookkeeping in `kv`: the leader epoch and the leader's heartbeat. */

import { checkLeaderFence, leaderFence } from "./fence";
import { type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { LeaderRecord, LeaderStatusRecord } from "./types";

/** Raised when a tab of an older leader protocol version tries to lead after a newer one led. */
export class LeaderProtocolError extends Error {
    constructor(
        readonly protocol: number,
        readonly newest: number,
    ) {
        super(
            `A newer Planet version (leader protocol ${newest}) processes jobs; this tab (${protocol}) must be reloaded.`,
        );
        this.name = "LeaderProtocolError";
    }
}

/**
 * Starts a new leader epoch and returns it. Called by a tab that has just become the leader. With `protocol`, the
 * claim is refused with {@link LeaderProtocolError} when a tab of a newer leader protocol version has led, and
 * otherwise records the version.
 */
export function claimEpoch(options: { protocol?: number } = {}, tx?: WriteTx): Promise<number> {
    return useWrite(tx, ["kv"], async (t) => {
        const store = t.store("kv");
        const { protocol } = options;
        if (protocol !== undefined) {
            const stored = await store.get("leader_protocol");
            const newest = typeof stored === "number" ? stored : 0;
            if (newest > protocol) {
                throw new LeaderProtocolError(protocol, newest);
            }
            if (newest !== protocol) {
                await store.put(protocol, "leader_protocol");
            }
        }
        const current = await store.get("leader_epoch");
        const next = (typeof current === "number" ? current : 0) + 1;
        await store.put(next, "leader_epoch");
        return next;
    });
}

/** Returns the current leader epoch (0 before any tab led). */
export function currentEpoch(tx?: ReadTx): Promise<number> {
    return useRead(tx, ["kv"], async (t) => {
        const value = await t.store("kv").get("leader_epoch");
        return typeof value === "number" ? value : 0;
    });
}

/**
 * Throws `LeaderFenceError` when this context is fenced to an epoch that is no longer current. The leader checks
 * it before writes outside IndexedDB (Kubernetes, the bucket), which the transaction fence cannot cover.
 */
export async function assertCurrent(tx?: ReadTx): Promise<void> {
    if (leaderFence() !== null) {
        checkLeaderFence(await currentEpoch(tx));
    }
}

/** Returns the last heartbeat of the leader, or undefined. */
export function read(tx?: ReadTx): Promise<LeaderRecord | undefined> {
    return useRead(tx, ["kv"], async (t) => (await t.store("kv").get("leader")) as LeaderRecord | undefined);
}

/**
 * Stores `record` as the leader's heartbeat if its epoch is still the current one. Returns false, writing nothing,
 * when another tab has claimed a newer epoch.
 */
export function heartbeat(record: LeaderRecord, tx?: WriteTx): Promise<boolean> {
    return useWrite(tx, ["kv"], async (t) => {
        const store = t.store("kv");
        if ((await store.get("leader_epoch")) !== record.epoch) {
            return false;
        }
        await store.put(record, "leader");
        return true;
    });
}

/** Removes the heartbeat if it belongs to `epoch`, so other tabs need not wait for it to go stale. */
export function resign(epoch: number, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["kv"], async (t) => {
        const store = t.store("kv");
        const record = (await store.get("leader")) as LeaderRecord | undefined;
        if (record?.epoch === epoch) {
            await store.delete("leader");
        }
    });
}

/** Returns the leader's last status record, or undefined. */
export function readStatus(tx?: ReadTx): Promise<LeaderStatusRecord | undefined> {
    return useRead(
        tx,
        ["kv"],
        async (t) => (await t.store("kv").get("leader_status")) as LeaderStatusRecord | undefined,
    );
}

/**
 * Stores the leader's status if its epoch is still the current one. Returns false, writing nothing, when another
 * tab has claimed a newer epoch.
 */
export function writeStatus(record: LeaderStatusRecord, tx?: WriteTx): Promise<boolean> {
    return useWrite(tx, ["kv"], async (t) => {
        const store = t.store("kv");
        if ((await store.get("leader_epoch")) !== record.epoch) {
            return false;
        }
        await store.put(record, "leader_status");
        return true;
    });
}
