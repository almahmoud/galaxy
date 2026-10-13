// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/planet/util/errors";
import * as events from "@/planet/util/events";
import { parseContentsFilters } from "@/planet/util/filters";

import {
    closeDb,
    collections,
    CONTENT_STORES,
    contents,
    datasets,
    DB_NAME,
    DB_VERSION,
    getDb,
    hdas,
    histories,
    jobs,
    kv,
    outbox,
    type PlanetDB,
    type PlanetDBSchema,
    settings,
    STORE_NAMES,
    uploads,
    withTransaction,
} from ".";
import { parseSettingsUpdate } from "./settings";
import { runTransaction } from "./transaction";

beforeEach(async () => {
    await closeDb();
    globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
    await closeDb();
    vi.restoreAllMocks();
});

async function currentHistory() {
    return histories.getOrThrow((await histories.getCurrentId())!);
}

describe("schema and migrations", () => {
    it("creates every store and index at the current version", async () => {
        const db = await getDb();
        expect(db.version).toBe(DB_VERSION);
        expect([...db.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
        const tx = db.transaction(["hdas", "dces", "tools"], "readonly");
        expect([...tx.objectStore("hdas").indexNames].sort()).toEqual([
            "creating_job_id",
            "dataset_id",
            "history_hid",
            "history_id",
            "history_update_time",
        ]);
        expect(tx.objectStore("tools").keyPath).toEqual(["tool_id", "tool_version"]);
        expect([...tx.objectStore("dces").indexNames]).toContain("collection_index");
        await tx.done;
    });

    it("closes its connection when another context upgrades the database", async () => {
        await getDb();
        // The upgrade would stay blocked if the open connection ignored versionchange.
        const upgraded = await openDB(DB_NAME, DB_VERSION + 1);
        expect(upgraded.version).toBe(DB_VERSION + 1);
        upgraded.close();
        await expect(getDb()).rejects.toThrow();
    });
});

describe("first-run bootstrap", () => {
    it("creates settings with an instance id and a current Unnamed history", async () => {
        const current = await currentHistory();
        expect(current.name).toBe("Unnamed history");
        expect(current.hid_counter).toBe(1);
        expect(current.update_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
        const value = await settings.get();
        expect(value.instance_id).toMatch(/^[0-9a-f]{8}$/);
        expect(value.cluster.has_token).toBe(false);
        expect(value.storage.has_secret).toBe(false);
        expect(value.cluster).not.toHaveProperty("token");
        expect(value.cluster.scratch_default).toBe("20Gi");
    });

    it("runs once: reopening keeps the same instance and history", async () => {
        const before = await settings.get();
        const historyId = await histories.getCurrentId();
        await closeDb();
        expect((await settings.get()).instance_id).toBe(before.instance_id);
        expect(await histories.getCurrentId()).toBe(historyId);
        expect(await histories.count()).toBe(1);
    });

    it("repairs a purged current history on the next open", async () => {
        const first = await currentHistory();
        const second = await histories.create({ name: "Second" });
        await histories.markDeleted(first.id, { purge: true });
        await closeDb();
        expect(await histories.getCurrentId()).toBe(second.id);
    });
});

describe("transactions", () => {
    it("gives each write transaction a strictly later timestamp", async () => {
        const stamps: string[] = [];
        for (let i = 0; i < 20; i++) {
            stamps.push(await withTransaction(["histories"], "readwrite", (tx) => tx.now));
        }
        expect(new Set(stamps).size).toBe(stamps.length);
        expect([...stamps].sort()).toEqual(stamps);
    });

    it("keeps timestamps monotonic across contexts through the stored clock", async () => {
        const future = (Date.now() + 3_600_000) * 1000;
        await kv.set("clock", future);
        const now = await withTransaction(["histories"], "readwrite", (tx) => tx.nowMicros);
        expect(now).toBeGreaterThan(future);
    });

    it("aborts every write when the function throws", async () => {
        const history = await currentHistory();
        await expect(
            withTransaction(CONTENT_STORES, "readwrite", async (tx) => {
                await histories.update(history.id, { name: "Changed" }, tx);
                throw ApiError.badRequest("stop");
            }),
        ).rejects.toThrow("stop");
        expect((await histories.getOrThrow(history.id)).name).toBe("Unnamed history");
    });

    it("publishes events only after commit", async () => {
        const history = await currentHistory();
        const published = vi.spyOn(events, "publish");
        await expect(
            withTransaction(CONTENT_STORES, "readwrite", async (tx) => {
                await histories.update(history.id, { name: "x" }, tx);
                expect(published).not.toHaveBeenCalled();
                throw new Error("abort");
            }),
        ).rejects.toThrow("abort");
        expect(published).not.toHaveBeenCalled();
        await histories.update(history.id, { name: "y" });
        expect(published).toHaveBeenCalledWith({ type: "history-changed", historyId: history.id });
    });
});

describe("histories", () => {
    it("creates, lists, updates, deletes and switches histories", async () => {
        const first = await currentHistory();
        const second = await histories.create({ name: "RNA-seq", tags: ["name:rna"] });
        expect((await histories.list()).map((history) => history.id)).toEqual([second.id, first.id]);
        const renamed = await histories.update(first.id, { name: "Renamed" });
        expect(renamed.update_time > second.update_time).toBe(true);
        expect((await histories.list())[0]!.id).toBe(first.id);
        await histories.markDeleted(second.id);
        expect(await histories.count()).toBe(1);
        expect(await histories.count({ deleted: true })).toBe(2);
        await histories.undelete(second.id);
        await histories.setCurrent(second.id);
        expect(await histories.getCurrentId()).toBe(second.id);
        await histories.markDeleted(second.id, { purge: true });
        await expect(histories.undelete(second.id)).rejects.toBeInstanceOf(ApiError);
        const replacement = await histories.getOrCreateCurrent();
        expect(replacement.id).not.toBe(second.id);
        expect(await histories.getCurrentId()).toBe(replacement.id);
    });

    it("throws a 404 ApiError for unknown histories", async () => {
        const error = await histories.getOrThrow("ffffffffffffffff").catch((caught) => caught);
        expect(error).toBeInstanceOf(ApiError);
        expect(error.status).toBe(404);
    });
});

describe("hid allocation", () => {
    it("never hands out the same hid to concurrent creates", async () => {
        const history = await currentHistory();
        const created = await Promise.all(
            Array.from({ length: 25 }, (_, index) =>
                hdas.createWithDataset({ history_id: history.id, name: `item ${index}` }),
            ),
        );
        const hids = created.map(({ hda }) => hda.hid).sort((a, b) => a - b);
        expect(hids).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
        expect((await histories.getOrThrow(history.id)).hid_counter).toBe(26);
    });

    it("never hands out the same hid across separate connections", async () => {
        const history = await currentHistory();
        const other = await openDB<PlanetDBSchema>(DB_NAME, DB_VERSION);
        const mine = await getDb();
        const allocate = (db: PlanetDB) =>
            runTransaction(db, ["histories"], "readwrite", (tx) => histories.allocateHids(history.id, 2, tx));
        const firsts = await Promise.all(Array.from({ length: 10 }, (_, index) => allocate(index % 2 ? other : mine)));
        other.close();
        expect(firsts.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, index) => 1 + index * 2));
    });

    it("shares the counter between datasets and collections and reserves ranges", async () => {
        const history = await currentHistory();
        const { hda } = await hdas.createWithDataset({ history_id: history.id, name: "a" });
        const { hdca } = await collections.createHdca({
            hdca: { history_id: history.id, name: "list" },
            collection: { collection_type: "list", elements: [{ identifier: "a", hda_id: hda.id }] },
        });
        const first = await withTransaction(["histories"], "readwrite", (tx) =>
            histories.allocateHids(history.id, 3, tx),
        );
        expect([hda.hid, hdca.hid, first]).toEqual([1, 2, 3]);
        expect((await histories.getOrThrow(history.id)).hid_counter).toBe(6);
    });
});

describe("update_time propagation", () => {
    it("bumps HDA copies, histories and containing collections when a dataset changes", async () => {
        const source = await currentHistory();
        const target = await histories.create({ name: "Target" });
        const { hda, dataset } = await hdas.createWithDataset({ history_id: source.id, name: "x" });
        const copy = await hdas.copy(hda.id, target.id);
        expect(copy.dataset_id).toBe(dataset.id);
        expect(copy.copied_from).toEqual({ src: "hda", id: hda.id });
        const { hdca, collection } = await collections.createHdca({
            hdca: { history_id: target.id, name: "pair" },
            collection: {
                collection_type: "list:list",
                elements: [
                    {
                        identifier: "outer",
                        collection: { collection_type: "list", elements: [{ identifier: "x", hda_id: copy.id }] },
                    },
                ],
            },
        });
        expect(collection.element_count).toBe(1);

        const updated = await datasets.setState(dataset.id, "running");
        const [hdaAfter, copyAfter, hdcaAfter, sourceAfter, targetAfter] = await Promise.all([
            hdas.getOrThrow(hda.id),
            hdas.getOrThrow(copy.id),
            collections.getHdcaOrThrow(hdca.id),
            histories.getOrThrow(source.id),
            histories.getOrThrow(target.id),
        ]);
        for (const record of [hdaAfter, copyAfter, hdcaAfter, sourceAfter, targetAfter]) {
            expect(record.update_time).toBe(updated.update_time);
        }
        expect((await hdas.getWithDatasetOrThrow(copy.id)).state).toBe("running");
    });

    it("reports the HDA state override before the dataset state", async () => {
        const history = await currentHistory();
        const { hda, dataset } = await hdas.createWithDataset({ history_id: history.id, name: "x" }, { state: "ok" });
        await hdas.update(hda.id, { _state: "setting_metadata" });
        expect((await hdas.getWithDatasetOrThrow(hda.id)).state).toBe("setting_metadata");
        expect((await datasets.getOrThrow(dataset.id)).state).toBe("ok");
    });

    it("records job state history and bumps the job's output collections", async () => {
        const history = await currentHistory();
        const job = await jobs.create({ tool_id: "cat1", tool_version: "1.0.0", history_id: history.id });
        const { hdca } = await collections.createHdca({
            hdca: { history_id: history.id, name: "out", job_source_id: job.id, job_source_type: "Job" },
            collection: { collection_type: "list", populated_state: "new", elements: [] },
        });
        expect((await collections.getCollection(hdca.collection_id))!.element_count).toBeNull();
        const running = await jobs.update(job.id, { state: "running" });
        expect(running.state_history.map((entry) => entry.state)).toEqual(["new", "running"]);
        expect((await collections.getHdcaOrThrow(hdca.id)).update_time).toBe(running.update_time);
        expect((await jobs.listByState(["running"])).map((each) => each.id)).toEqual([job.id]);
    });
});

describe("contents", () => {
    async function populate() {
        const history = await currentHistory();
        const a = await hdas.createWithDataset(
            { history_id: history.id, name: "reads.fastq", extension: "fastqsanger", tags: ["name:s1"] },
            { state: "ok", file_size: 10 },
        );
        const b = await hdas.createWithDataset(
            { history_id: history.id, name: "aligned.bam", extension: "bam", visible: false },
            { state: "running", file_size: 300 },
        );
        const c = await hdas.createWithDataset(
            { history_id: history.id, name: "old.txt", extension: "txt", deleted: true },
            { state: "ok", file_size: null },
        );
        const list = await collections.createHdca({
            hdca: { history_id: history.id, name: "bams" },
            collection: { collection_type: "list", elements: [{ identifier: "b", hda_id: b.hda.id }] },
        });
        return { history, a, b, c, list };
    }

    it("lists datasets and collections by hid descending with totals and paging", async () => {
        const { history } = await populate();
        const page = await contents.list(history.id, { limit: 2, offset: 1 });
        expect(page.total).toBe(4);
        expect(page.rows.map((row) => (row.type === "dataset" ? row.hda.hid : row.hdca.hid))).toEqual([3, 2]);
    });

    it("applies the history panel's default filters", async () => {
        const { history } = await populate();
        const filters = parseContentsFilters(new URLSearchParams("q=deleted&qv=false&q=visible&qv=true"));
        const result = await contents.list(history.id, { filters });
        expect(result.rows.map((row) => (row.type === "dataset" ? row.hda.name : row.hdca.name))).toEqual([
            "bams",
            "reads.fastq",
        ]);
    });

    it("filters by state, extension (collections by leaves) and tag", async () => {
        const { history } = await populate();
        const names = async (search: string) =>
            (await contents.list(history.id, { filters: parseContentsFilters(new URLSearchParams(search)) })).rows.map(
                (row) => (row.type === "dataset" ? row.hda.name : row.hdca.name),
            );
        expect(await names("q=state&qv=running")).toEqual(["aligned.bam"]);
        expect(await names("q=extension&qv=bam")).toEqual(["bams", "aligned.bam"]);
        expect(await names("q=tag&qv=name:s1")).toEqual(["reads.fastq"]);
        expect(await names("q=history_content_type&qv=dataset_collection")).toEqual(["bams"]);
    });

    it("returns only items changed since an update_time", async () => {
        const { history, a } = await populate();
        const before = (await histories.getOrThrow(history.id)).update_time;
        const changed = await hdas.update(a.hda.id, { name: "renamed.fastq" });
        expect(changed.update_time > before).toBe(true);
        const filters = parseContentsFilters(new URLSearchParams(`q=update_time-gt&qv=${before}`));
        const result = await contents.list(history.id, { filters });
        expect(result.rows.map((row) => (row.type === "dataset" ? row.hda.name : row.hdca.name))).toEqual([
            "renamed.fastq",
        ]);
        expect((await histories.getOrThrow(history.id)).update_time).toBe(changed.update_time);
    });

    it("orders by other keys, with Galaxy's null placement for size", async () => {
        const { history } = await populate();
        const order = (value: string) => contents.parseContentsOrder(value);
        const sizes = async (value: string) =>
            (await contents.list(history.id, { order: order(value), types: ["dataset"] })).rows.map((row) =>
                row.type === "dataset" ? row.dataset.file_size : undefined,
            );
        expect(await sizes("size-dsc")).toEqual([300, 10, null]);
        expect(await sizes("size-asc")).toEqual([null, 10, 300]);
        const byName = await contents.list(history.id, { order: order("name-asc") });
        expect(byName.rows.map((row) => (row.type === "dataset" ? row.hda.name : row.hdca.name))).toEqual([
            "aligned.bam",
            "bams",
            "old.txt",
            "reads.fastq",
        ]);
        expect(() => order("bogus")).toThrow(ApiError);
    });

    it("finds items by hid and type", async () => {
        const { history, list } = await populate();
        const row = await contents.getByHid(history.id, list.hdca.hid);
        expect(row?.type).toBe("dataset_collection");
        expect(await contents.getItem("dataset", "ffffffffffffffff")).toBeUndefined();
        expect(await histories.activeCounts(history.id)).toEqual({ active: 2, deleted: 1, hidden: 1 });
        expect(await histories.diskSize(history.id)).toBe(310);
    });
});

describe("settings", () => {
    it("stores secrets separately and never returns them", async () => {
        const updated = await settings.update(
            parseSettingsUpdate({
                cluster: { gateway_url: "https://gateway.example", token: " abc ", has_token: false },
                storage: { bucket: "data", secret_access_key: "s3cret" },
                instance_id: "ignored",
            }),
        );
        expect(updated.cluster.gateway_url).toBe("https://gateway.example");
        expect(updated.cluster.has_token).toBe(true);
        expect(updated.storage.has_secret).toBe(true);
        expect(JSON.stringify(updated)).not.toContain("s3cret");
        expect(await settings.getSecrets()).toEqual({ cluster_token: "abc", storage_secret_access_key: "s3cret" });
        const cleared = await settings.update(parseSettingsUpdate({ cluster: { token: "" } }));
        expect(cleared.cluster.has_token).toBe(false);
        expect(cleared.storage.has_secret).toBe(true);
    });

    it.each([
        [[], "Settings must be a JSON object"],
        [{ cluster: { gateway: "x" } }, "Unknown setting cluster.gateway"],
        [{ storage: { path_style: "yes" } }, "storage.path_style must be a boolean"],
        [{ cluster: { arch_policy: "arm" } }, 'cluster.arch_policy must be "amd64-only" or "any"'],
        [{ cluster: { default_walltime_seconds: -1 } }, "cluster.default_walltime_seconds must be a positive integer"],
        [{ other: 1 }, "Unknown setting other"],
    ])("rejects %j", (input, message) => {
        expect(() => parseSettingsUpdate(input)).toThrow(message);
    });
});

describe("other stores", () => {
    it("queues outbox entries by not_before", async () => {
        const later = await outbox.enqueue({ kind: "dispatch", not_before: "2999-01-01T00:00:00.000000" });
        const now = await outbox.enqueue({ kind: "dispatch", job_id: "j1" });
        expect((await outbox.due("2100-01-01T00:00:00.000000")).map((entry) => entry.id)).toEqual([now.id]);
        const retried = await outbox.reschedule(now.id, "2999-01-02T00:00:00.000000", "gateway unreachable");
        expect(retried.attempts).toBe(1);
        expect((await outbox.list()).map((entry) => entry.id)).toEqual([later.id, now.id]);
        await outbox.remove(later.id);
        expect(await outbox.listForJob("j1")).toHaveLength(1);
    });

    it("tracks uploads and counters", async () => {
        const upload = await uploads.create({ name: "reads.fastq", size: 100, part_size: 8 * 1024 * 1024 });
        expect(upload.key).toBe(`uploads/${upload.id}`);
        await uploads.update(upload.id, { state: "uploaded", parts: [{ part_number: 1, etag: '"e"', size: 100 }] });
        expect((await uploads.listByState("uploaded")).map((each) => each.id)).toEqual([upload.id]);
        expect(await kv.increment("leader_epoch")).toBe(1);
        expect(await kv.increment("leader_epoch")).toBe(2);
    });
});
