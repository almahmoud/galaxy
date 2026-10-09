import type { PlanetDB, UpgradeTransaction } from "./schema";

/**
 * Schema migrations. `MIGRATIONS[n]` upgrades a database from version `n - 1` to `n`. Steps run
 * synchronously inside the versionchange transaction; data rewrites issue requests on `tx` without
 * awaiting them.
 */
export const MIGRATIONS: Readonly<Record<number, (db: PlanetDB, tx: UpgradeTransaction) => void>> = {
    1(db) {
        db.createObjectStore("settings");
        db.createObjectStore("secrets");
        db.createObjectStore("kv");

        const histories = db.createObjectStore("histories", { keyPath: "id" });
        histories.createIndex("update_time", "update_time");

        const datasets = db.createObjectStore("datasets", { keyPath: "id" });
        datasets.createIndex("uuid", "uuid", { unique: true });
        datasets.createIndex("job_id", "job_id");

        const hdas = db.createObjectStore("hdas", { keyPath: "id" });
        hdas.createIndex("history_id", "history_id");
        hdas.createIndex("history_hid", ["history_id", "hid"]);
        hdas.createIndex("history_update_time", ["history_id", "update_time"]);
        hdas.createIndex("dataset_id", "dataset_id");
        hdas.createIndex("creating_job_id", "creating_job_id");

        db.createObjectStore("collections", { keyPath: "id" });

        const hdcas = db.createObjectStore("hdcas", { keyPath: "id" });
        hdcas.createIndex("history_id", "history_id");
        hdcas.createIndex("history_hid", ["history_id", "hid"]);
        hdcas.createIndex("history_update_time", ["history_id", "update_time"]);
        hdcas.createIndex("collection_id", "collection_id");
        hdcas.createIndex("job_source_id", "job_source_id");

        const dces = db.createObjectStore("dces", { keyPath: "id" });
        dces.createIndex("collection_id", "collection_id");
        dces.createIndex("collection_index", ["collection_id", "element_index"]);
        dces.createIndex("hda_id", "hda_id");
        dces.createIndex("child_collection_id", "child_collection_id");

        const jobs = db.createObjectStore("jobs", { keyPath: "id" });
        jobs.createIndex("history_id", "history_id");
        jobs.createIndex("state", "state");
        jobs.createIndex("update_time", "update_time");
        jobs.createIndex("tool_id", "tool_id");

        const outbox = db.createObjectStore("outbox", { keyPath: "id" });
        outbox.createIndex("job_id", "job_id");
        outbox.createIndex("not_before", "not_before");

        const tools = db.createObjectStore("tools", { keyPath: ["tool_id", "tool_version"] });
        tools.createIndex("tool_id", "tool_id");

        db.createObjectStore("toolPanel", { keyPath: "view_id" });

        const uploads = db.createObjectStore("uploads", { keyPath: "id" });
        uploads.createIndex("state", "state");
        uploads.createIndex("history_id", "history_id");
    },
};

/** Applies every migration between `oldVersion` and `newVersion` in order. */
export function migrate(db: PlanetDB, tx: UpgradeTransaction, oldVersion: number, newVersion: number): void {
    for (let version = oldVersion + 1; version <= newVersion; version++) {
        const step = MIGRATIONS[version];
        if (!step) {
            throw new Error(`No migration to database version ${version}`);
        }
        step(db, tx);
    }
}
