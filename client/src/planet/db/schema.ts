import type { DBSchema, IDBPDatabase, IDBPTransaction, StoreNames } from "idb";

import type {
    CollectionRecord,
    DatasetRecord,
    DceRecord,
    HdaRecord,
    HdcaRecord,
    HistoryRecord,
    JobRecord,
    OutboxRecord,
    PlanetSecrets,
    StoredSettings,
    ToolPanelRecord,
    ToolRecord,
    UploadRecord,
} from "./types";

export const DB_NAME = "planet";
export const DB_VERSION = 1;

/** Keys of the singleton records. */
export const SETTINGS_KEY = "settings";
export const SECRETS_KEY = "secrets";

/** Typed schema of the `planet` database. */
export interface PlanetDBSchema extends DBSchema {
    settings: { key: string; value: StoredSettings };
    secrets: { key: string; value: PlanetSecrets };
    histories: { key: string; value: HistoryRecord; indexes: { update_time: string } };
    datasets: { key: string; value: DatasetRecord; indexes: { uuid: string; job_id: string } };
    hdas: {
        key: string;
        value: HdaRecord;
        indexes: {
            history_id: string;
            history_hid: [string, number];
            history_update_time: [string, string];
            dataset_id: string;
            creating_job_id: string;
        };
    };
    collections: { key: string; value: CollectionRecord };
    hdcas: {
        key: string;
        value: HdcaRecord;
        indexes: {
            history_id: string;
            history_hid: [string, number];
            history_update_time: [string, string];
            collection_id: string;
            job_source_id: string;
        };
    };
    dces: {
        key: string;
        value: DceRecord;
        indexes: {
            collection_id: string;
            collection_index: [string, number];
            hda_id: string;
            child_collection_id: string;
        };
    };
    jobs: {
        key: string;
        value: JobRecord;
        indexes: { history_id: string; state: string; update_time: string; tool_id: string };
    };
    outbox: { key: string; value: OutboxRecord; indexes: { job_id: string; not_before: string } };
    tools: { key: [string, string]; value: ToolRecord; indexes: { tool_id: string } };
    toolPanel: { key: string; value: ToolPanelRecord };
    uploads: { key: string; value: UploadRecord; indexes: { state: string; history_id: string } };
    kv: { key: string; value: unknown };
}

export type StoreName = StoreNames<PlanetDBSchema>;
export type PlanetDB = IDBPDatabase<PlanetDBSchema>;
export type UpgradeTransaction = IDBPTransaction<PlanetDBSchema, StoreName[], "versionchange">;

/** Every object store, in creation order. */
export const STORE_NAMES: readonly StoreName[] = [
    "settings",
    "secrets",
    "histories",
    "datasets",
    "hdas",
    "collections",
    "hdcas",
    "dces",
    "jobs",
    "outbox",
    "tools",
    "toolPanel",
    "uploads",
    "kv",
];
