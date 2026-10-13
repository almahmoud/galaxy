import type { IDBPObjectStore, IDBPTransaction } from "idb";

import { type PlanetEvent, publish } from "@/planet/util/events";
import { formatGalaxyTime, nextMicros } from "@/planet/util/time";

import { checkLeaderFence, leaderFence } from "./fence";
import type { PlanetDB, PlanetDBSchema, StoreName } from "./schema";

/** A transaction that can read the stores it was opened on. */
export interface ReadTx {
    readonly mode: "readonly" | "readwrite";
    /** Returns an object store in this transaction's scope (throws `NotFoundError` otherwise). */
    store<N extends StoreName>(name: N): IDBPObjectStore<PlanetDBSchema, StoreName[], N, "readonly" | "readwrite">;
}

/** A read-write transaction. */
export interface WriteTx extends ReadTx {
    readonly mode: "readwrite";
    /**
     * The timestamp for every `create_time`/`update_time` written in this transaction. It is taken
     * after the transaction started and is strictly greater than the timestamp of every earlier write
     * transaction in any context, so `update_time` filters never miss a change.
     */
    readonly now: string;
    /** {@link now} in microseconds since the epoch. */
    readonly nowMicros: number;
    store<N extends StoreName>(name: N): IDBPObjectStore<PlanetDBSchema, StoreName[], N, "readwrite">;
    /** Publishes `event` once the transaction commits. Duplicate events are sent once. */
    notify(event: PlanetEvent): void;
}

type RawTx<M extends IDBTransactionMode> = IDBPTransaction<PlanetDBSchema, StoreName[], M>;

class ReadTransaction implements ReadTx {
    readonly mode = "readonly" as const;

    constructor(private readonly raw: RawTx<"readonly">) {}

    store<N extends StoreName>(name: N) {
        return this.raw.objectStore(name);
    }
}

class WriteTransaction implements WriteTx {
    readonly mode = "readwrite" as const;
    readonly now: string;
    readonly events = new Map<string, PlanetEvent>();

    constructor(
        private readonly raw: RawTx<"readwrite">,
        readonly nowMicros: number,
    ) {
        this.now = formatGalaxyTime(nowMicros);
    }

    store<N extends StoreName>(name: N) {
        return this.raw.objectStore(name);
    }

    notify(event: PlanetEvent): void {
        this.events.set(JSON.stringify(event), event);
    }
}

function scopeOf(stores: readonly StoreName[], mode: IDBTransactionMode): StoreName[] {
    const scope = new Set(stores);
    if (mode === "readwrite") {
        scope.add("kv");
    }
    return [...scope];
}

async function abort(raw: RawTx<IDBTransactionMode>): Promise<void> {
    try {
        raw.abort();
    } catch {
        // Already committed or aborted.
    }
    await raw.done.catch(() => undefined);
}

/**
 * Runs `fn` in one transaction on `db`. The transaction commits after `fn` resolves and aborts if it
 * throws. `fn` may only await requests on this transaction: awaiting anything else (fetch, timers,
 * other databases) lets IndexedDB auto-commit and the next request fails with
 * `TransactionInactiveError`.
 */
export async function runTransaction<R>(
    db: PlanetDB,
    stores: readonly StoreName[],
    mode: "readonly",
    fn: (tx: ReadTx) => Promise<R> | R,
): Promise<R>;
export async function runTransaction<R>(
    db: PlanetDB,
    stores: readonly StoreName[],
    mode: "readwrite",
    fn: (tx: WriteTx) => Promise<R> | R,
): Promise<R>;
export async function runTransaction<R>(
    db: PlanetDB,
    stores: readonly StoreName[],
    mode: "readonly" | "readwrite",
    fn: ((tx: ReadTx) => Promise<R> | R) | ((tx: WriteTx) => Promise<R> | R),
): Promise<R> {
    if (mode === "readonly") {
        const raw = db.transaction(scopeOf(stores, mode), "readonly");
        try {
            const result = await (fn as (tx: ReadTx) => Promise<R> | R)(new ReadTransaction(raw));
            await raw.done;
            return result;
        } catch (error) {
            await abort(raw);
            throw error;
        }
    }
    const scope = scopeOf(stores, mode);
    const raw = db.transaction(scope, "readwrite");
    try {
        const kv = raw.objectStore("kv");
        if (leaderFence() !== null && scope.includes("jobs")) {
            checkLeaderFence(await kv.get("leader_epoch"));
        }
        const last = await kv.get("clock");
        const micros = nextMicros(typeof last === "number" ? last : 0);
        await kv.put(micros, "clock");
        const tx = new WriteTransaction(raw, micros);
        const result = await (fn as (tx: WriteTx) => Promise<R> | R)(tx);
        await raw.done;
        for (const event of tx.events.values()) {
            publish(event);
        }
        return result;
    } catch (error) {
        await abort(raw);
        throw error;
    }
}
