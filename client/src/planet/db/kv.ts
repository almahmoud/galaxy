/** Typed access to the `kv` store (current history, leader epoch, counters). */

import { type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { KvKey, KvValues } from "./types";

/** Returns the value stored under `key`, or undefined. */
export function get<K extends KvKey>(key: K, tx?: ReadTx): Promise<KvValues[K] | undefined> {
    return useRead(tx, ["kv"], async (t) => (await t.store("kv").get(key)) as KvValues[K] | undefined);
}

/** Stores `value` under `key`. */
export function set<K extends KvKey>(key: K, value: KvValues[K], tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["kv"], async (t) => {
        await t.store("kv").put(value, key);
    });
}

/** Removes `key`. */
export function remove(key: KvKey, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["kv"], async (t) => {
        await t.store("kv").delete(key);
    });
}

/** Increments a numeric value (missing counts as 0) and returns the new value. */
export function increment(key: "leader_epoch" | `counter:${string}`, tx?: WriteTx): Promise<number> {
    return useWrite(tx, ["kv"], async (t) => {
        const store = t.store("kv");
        const current = await store.get(key);
        const next = (typeof current === "number" ? current : 0) + 1;
        await store.put(next, key);
        return next;
    });
}
