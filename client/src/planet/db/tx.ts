import { getDb } from "./connection";
import type { StoreName } from "./schema";
import { type ReadTx, runTransaction, type WriteTx } from "./transaction";

export type { ReadTx, WriteTx };

/** Stores touched when history items change: an item write bumps its history and containing collections. */
export const CONTENT_STORES = [
    "histories",
    "datasets",
    "hdas",
    "collections",
    "hdcas",
    "dces",
] as const satisfies readonly StoreName[];

/** {@link CONTENT_STORES} plus `jobs` and `outbox`, for writes that create or change jobs. */
export const JOB_STORES = [...CONTENT_STORES, "jobs", "outbox"] as const satisfies readonly StoreName[];

/**
 * Runs `fn` in one transaction over `stores` (read-write transactions also include `kv`, which holds the
 * timestamp clock). Commits when `fn` resolves, aborts when it throws. Inside `fn`, await only requests
 * on `tx`; any other await lets IndexedDB commit early.
 */
export function withTransaction<R>(
    stores: readonly StoreName[],
    mode: "readonly",
    fn: (tx: ReadTx) => Promise<R> | R,
): Promise<R>;
export function withTransaction<R>(
    stores: readonly StoreName[],
    mode: "readwrite",
    fn: (tx: WriteTx) => Promise<R> | R,
): Promise<R>;
export async function withTransaction<R>(
    stores: readonly StoreName[],
    mode: "readonly" | "readwrite",
    fn: ((tx: ReadTx) => Promise<R> | R) | ((tx: WriteTx) => Promise<R> | R),
): Promise<R> {
    const db = await getDb();
    return mode === "readonly"
        ? runTransaction(db, stores, mode, fn as (tx: ReadTx) => Promise<R> | R)
        : runTransaction(db, stores, mode, fn as (tx: WriteTx) => Promise<R> | R);
}

/** `withTransaction(stores, "readonly", fn)`. */
export function readTx<R>(stores: readonly StoreName[], fn: (tx: ReadTx) => Promise<R> | R): Promise<R> {
    return withTransaction(stores, "readonly", fn);
}

/** `withTransaction(stores, "readwrite", fn)`. */
export function writeTx<R>(stores: readonly StoreName[], fn: (tx: WriteTx) => Promise<R> | R): Promise<R> {
    return withTransaction(stores, "readwrite", fn);
}

/** Runs `fn` in `tx` when given, otherwise in a new read-only transaction over `stores`. */
export function useRead<R>(
    tx: ReadTx | undefined,
    stores: readonly StoreName[],
    fn: (tx: ReadTx) => Promise<R>,
): Promise<R> {
    return tx ? fn(tx) : readTx(stores, fn);
}

/** Runs `fn` in `tx` when given, otherwise in a new read-write transaction over `stores`. */
export function useWrite<R>(
    tx: WriteTx | undefined,
    stores: readonly StoreName[],
    fn: (tx: WriteTx) => Promise<R>,
): Promise<R> {
    return tx ? fn(tx) : writeTx(stores, fn);
}
