/**
 * Planet's IndexedDB layer. Repository functions take an optional transaction as their last argument:
 * pass one to combine several writes atomically (`withTransaction(CONTENT_STORES, "readwrite", ...)`),
 * omit it to run in a transaction of their own.
 */

export * as collections from "./collections";
export { bootstrap, closeDb, getDb } from "./connection";
export * as contents from "./contents";
export * as datasets from "./datasets";
export { leaderFence, LeaderFenceError, revokeLeaderFence, setLeaderFence } from "./fence";
export * as hdas from "./hdas";
export * as histories from "./histories";
export * as jobs from "./jobs";
export * as kv from "./kv";
export * as leader from "./leader";
export { LeaderProtocolError } from "./leader";
export { MIGRATIONS } from "./migrations";
export * as outbox from "./outbox";
export { touchHistory } from "./propagation";
export * from "./records";
export { DB_NAME, DB_VERSION, type PlanetDB, type PlanetDBSchema, STORE_NAMES, type StoreName } from "./schema";
export * as settings from "./settings";
export * as tools from "./tools";
export {
    CONTENT_STORES,
    JOB_STORES,
    type ReadTx,
    readTx,
    useRead,
    useWrite,
    withTransaction,
    type WriteTx,
    writeTx,
} from "./tx";
export * from "./types";
export * as uploads from "./uploads";
