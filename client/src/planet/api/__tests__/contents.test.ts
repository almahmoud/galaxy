// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { components } from "@/api/schema";
import { collections, datasets, hdas, histories, jobs } from "@/planet/db";

import {
    DatatypeInfo,
    HDA_DETAILED_KEYS,
    HDA_SUMMARY_KEYS,
    type HdaDetailedView,
    type HdaSummaryView,
    HDCA_COLLECTION_VIEW_KEYS,
    HDCA_ELEMENT_VIEW_KEYS,
    HDCA_SUMMARY_KEYS,
    type HdcaDetailedView,
    type HdcaElementView,
    type HdcaSummaryView,
    METADATA_KEY,
    normalizeTags,
    renderPeek,
    SET_METADATA_TOOL_ID,
} from "../contents";
import {
    addDataset,
    addJob,
    addList,
    assertAssignable,
    captureEvents,
    currentHistoryId,
    fetchJson,
    flushEvents,
    keysOf,
    makeRouter,
    MAPPING,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";

type Schemas = components["schemas"];

// The fixed views must satisfy Galaxy's API models. Galaxy itself returns null for creating_job when a dataset has
// no creating job, which the generated model does not express.
assertAssignable<Schemas["HDASummary"]>()<HdaSummaryView>();
assertAssignable<Omit<Schemas["HDADetailed"], "creating_job"> & { creating_job: string | null }>()<HdaDetailedView>();
assertAssignable<Schemas["HDCASummary"]>()<HdcaSummaryView>();
assertAssignable<Schemas["HDCADetailed"]>()<HdcaDetailedView>();
assertAssignable<Schemas["HDCADetailed"]>()<HdcaElementView>();

const DETAILED_FIXED_KEYS = HDA_DETAILED_KEYS.filter((key) => key !== METADATA_KEY);

beforeEach(resetPlanet);
afterEach(teardownPlanet);

function ids(items: { id: string }[]): string[] {
    return items.map((item) => item.id);
}

function names(items: { name: string }[]): string[] {
    return items.map((item) => item.name);
}

async function seed() {
    const historyId = await currentHistoryId();
    const reads = await addDataset(
        historyId,
        { name: "reads.fastq", extension: "fasta", tags: ["name:sample1"] },
        { state: "ok", file_size: 300, total_size: 300 },
    );
    const table = await addDataset(
        historyId,
        {
            name: "table.tsv",
            extension: "tabular",
            peek: "a\tb\n1\t2\n",
            metadata: { dbkey: "?", columns: 2, column_types: ["str", "int"], delimiter: "\t" },
        },
        { state: "running", file_size: 50, total_size: 50 },
    );
    const hidden = await addDataset(historyId, { name: "hidden.txt", visible: false }, { state: "ok" });
    const deleted = await addDataset(historyId, { name: "deleted.txt", deleted: true }, { state: "error" });
    const list = await addList(historyId, [reads.hda.id, hidden.hda.id], { name: "pair of things" });
    return { historyId, reads, table, hidden, deleted, list };
}

describe("GET /api/histories/{history_id}/contents?v=dev", () => {
    it("lists datasets and collections in hid order with Galaxy's summary keys", async () => {
        const { historyId, reads, table, hidden, deleted, list } = await seed();
        const router = makeRouter();
        const items = await fetchJson(router, "GET", `/api/histories/${historyId}/contents?v=dev`);
        expect(items.map((item: { hid: number }) => item.hid)).toEqual([1, 2, 3, 4, 5]);
        expect(ids(items)).toEqual([reads.hda.id, table.hda.id, hidden.hda.id, deleted.hda.id, list.id]);
        expect(keysOf(items[0])).toEqual([...HDA_SUMMARY_KEYS].sort());
        expect(keysOf(items[4])).toEqual([...HDCA_SUMMARY_KEYS].sort());
        expect(items[0]).toMatchObject({
            type_id: `dataset-${reads.hda.id}`,
            history_content_type: "dataset",
            state: "ok",
            extension: "fasta",
            genome_build: "?",
            type: "file",
            url: `/api/histories/${historyId}/contents/datasets/${reads.hda.id}`,
            object_store_id: null,
        });
        expect(items[4]).toMatchObject({
            history_content_type: "dataset_collection",
            collection_type: "list",
            element_count: 2,
            populated_state: "ok",
            elements_states: { ok: 2 },
            elements_datatypes: ["fasta", "txt"],
            elements_deleted: 0,
            url: `/api/histories/${historyId}/contents/dataset_collections/${list.id}`,
            contents_url: `/api/dataset_collections/${list.id}/contents/${list.collection_id}`,
            job_source_id: null,
            store_times_summary: [],
        });
        expect(items[4].job_state_summary).toEqual({
            all_jobs: 0,
            new: 0,
            waiting: 0,
            running: 0,
            error: 0,
            paused: 0,
            skipped: 0,
            deleted_new: 0,
            resubmitted: 0,
            queued: 0,
            ok: 0,
            failed: 0,
            deleted: 0,
            upload: 0,
        });

        const descending = await fetchJson(router, "GET", `/api/histories/${historyId}/contents?v=dev&order=hid`);
        expect(descending.map((item: { hid: number }) => item.hid)).toEqual([5, 4, 3, 2, 1]);
        const byName = await fetchJson(router, "GET", `/api/histories/${historyId}/contents?v=dev&order=name-asc`);
        expect(names(byName)).toEqual(["deleted.txt", "hidden.txt", "pair of things", "reads.fastq", "table.tsv"]);
        const page = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents?v=dev&order=hid&offset=1&limit=2`,
        );
        expect(page.map((item: { hid: number }) => item.hid)).toEqual([4, 3]);
    });

    it("applies the history panel filters", async () => {
        const { historyId, reads, table, list } = await seed();
        const router = makeRouter();
        const base = `/api/histories/${historyId}/contents?v=dev&order=hid-asc`;
        const visible = await fetchJson(router, "GET", `${base}&q=deleted&qv=false&q=visible&qv=true`);
        expect(ids(visible)).toEqual([reads.hda.id, table.hda.id, list.id]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=name-contains&qv=TABLE`))).toEqual([table.hda.id]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=state-eq&qv=running`))).toEqual([table.hda.id]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=extension-eq&qv=fasta`))).toEqual([reads.hda.id]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=tag&qv=name:sample1`))).toEqual([reads.hda.id]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=hid-ge&qv=2&q=hid-le&qv=2`))).toEqual([table.hda.id]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=history_content_type-eq&qv=dataset_collection`))).toEqual([
            list.id,
        ]);
        const bad = await send(router, "GET", `${base}&q=colour-eq&qv=red`);
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ err_msg: "bad filter", err_code: 400008, column: "colour" });
    });

    it("returns items changed since an update_time, as the history watcher asks", async () => {
        const { historyId, table } = await seed();
        const router = makeRouter();
        const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
        await pause();
        const since = new Date().toISOString();
        await pause();
        await hdas.update(table.hda.id, { name: "renamed.tsv" });
        const changed = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents?v=dev&limit=1000&q=update_time-ge&qv=${since}&details=${table.hda.id}`,
        );
        expect(ids(changed)).toEqual([table.hda.id]);
        expect(keysOf(changed[0])).toEqual(expect.arrayContaining([...DETAILED_FIXED_KEYS]));
        expect(changed[0]).toMatchObject({
            name: "renamed.tsv",
            metadata_dbkey: "?",
            metadata_columns: 2,
            metadata_delimiter: "\t",
            peek: '<table cellspacing="0" cellpadding="3"><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>',
        });
    });

    it("answers the stats media type with total_matches", async () => {
        const { historyId } = await seed();
        const response = await send(
            makeRouter(),
            "GET",
            `/api/histories/${historyId}/contents?v=dev&order=hid&offset=0&limit=2&q=deleted&qv=false`,
            undefined,
            { Accept: "application/vnd.galaxy.history.contents.stats+json" },
        );
        const body = await response.json();
        expect(keysOf(body)).toEqual(["contents", "stats"]);
        expect(body.stats).toEqual({ total_matches: 4 });
        expect(body.contents.map((item: { hid: number }) => item.hid)).toEqual([5, 3]);
        expect(keysOf(body.contents[1])).toEqual([...HDA_SUMMARY_KEYS].sort());
        expect(keysOf(body.contents[0])).toEqual([...HDCA_SUMMARY_KEYS].sort());
    });

    it("expands related filters through the job graph", async () => {
        const historyId = await currentHistoryId();
        const input = await addDataset(historyId, { name: "input" });
        const unrelated = await addDataset(historyId, { name: "unrelated" });
        const job = await addJob(historyId, { inputs: [{ name: "input1", src: "hda", id: input.hda.id }] });
        const output = await addDataset(historyId, { name: "output", creating_job_id: job.id }, { job_id: job.id });
        await jobs.update(job.id, { outputs: [{ name: "out_file1", src: "hda", id: output.hda.id }] });
        const router = makeRouter();
        const base = `/api/histories/${historyId}/contents?v=dev&order=hid-asc`;
        expect(ids(await fetchJson(router, "GET", `${base}&q=related-eq&qv=${input.hda.hid}`))).toEqual([
            input.hda.id,
            output.hda.id,
        ]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=related&qv=${output.hda.hid}`))).toEqual([
            input.hda.id,
            output.hda.id,
        ]);
        expect(ids(await fetchJson(router, "GET", `${base}&q=related-eq&qv=${unrelated.hda.hid}`))).toEqual([
            unrelated.hda.id,
        ]);
        const bad = await send(router, "GET", `${base}&q=related-eq&qv=x`);
        expect(bad.status).toBe(400);
        expect((await bad.json()).err_msg).toBe("unparsable value for related filter");
    });

    it("answers 404 for an unknown history and 400 for an unknown version", async () => {
        const router = makeRouter();
        expect((await send(router, "GET", "/api/histories/0123456789abcdef/contents?v=dev")).status).toBe(404);
        const historyId = await currentHistoryId();
        expect((await send(router, "GET", `/api/histories/${historyId}/contents?v=2`)).status).toBe(400);
    });
});

describe("GET /api/histories/{history_id}/contents (legacy)", () => {
    it("lists in hid order with collection views and legacy flags", async () => {
        const { historyId, reads, table, hidden, deleted, list } = await seed();
        const router = makeRouter();
        const items = await fetchJson(router, "GET", `/api/histories/${historyId}/contents`);
        expect(ids(items)).toEqual([reads.hda.id, table.hda.id, hidden.hda.id, deleted.hda.id, list.id]);
        expect(keysOf(items[4])).toEqual([...HDCA_COLLECTION_VIEW_KEYS].sort());
        const visible = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents?deleted=false&visible=true`,
        );
        expect(ids(visible)).toEqual([reads.hda.id, table.hda.id, list.id]);
        const collectionsOnly = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents?types=dataset_collection&details=all`,
        );
        expect(keysOf(collectionsOnly[0])).toEqual([...HDCA_ELEMENT_VIEW_KEYS].sort());
        const selected = await fetchJson(router, "GET", `/api/histories/${historyId}/contents?ids=${table.hda.id}`);
        expect(ids(selected)).toEqual([table.hda.id]);
        expect(selected[0].peek).toContain("<table");
        const typed = await fetchJson(router, "GET", `/api/histories/${historyId}/contents/datasets`);
        expect(typed).toHaveLength(4);
    });
});

describe("GET /api/histories/{history_id}/contents/{type}s/{id}", () => {
    it("shows a dataset in the detailed view", async () => {
        const historyId = await currentHistoryId();
        const job = await addJob(historyId, { tool_id: "cat1", tool_version: "1.0.0", state: "ok" });
        const { hda, dataset } = await addDataset(
            historyId,
            {
                name: "regions.bed",
                extension: "bed",
                info: " made by cat ",
                blurb: "2 regions",
                peek: "chr1\t10\t20\tA\nchr1\t30\t40\tB\n",
                metadata: { dbkey: "hg38", columns: 4, chromCol: 1, startCol: 2, endCol: 3, nameCol: 4, bai: "file" },
                dbkey: "hg38",
                creating_job_id: job.id,
            },
            {
                state: "ok",
                file_size: 2048,
                job_id: job.id,
                created_from_basename: "regions.bed",
                metadata_files: { bai: { key: "datasets/x/meta/bai", file_size: 10 } },
                hashes: [{ hash_function: "MD5", hash_value: "abc", extra_files_path: null }],
            },
        );
        const router = makeRouter();
        const shown = await fetchJson(router, "GET", `/api/histories/${historyId}/contents/datasets/${hda.id}`);
        expect(keysOf(shown).filter((key) => !key.startsWith("metadata_"))).toEqual([...DETAILED_FIXED_KEYS].sort());
        expect(shown).toMatchObject({
            model_class: "HistoryDatasetAssociation",
            hda_ldda: "hda",
            accessible: true,
            file_ext: "bed",
            file_size: 2048,
            genome_build: "hg38",
            misc_info: "made by cat",
            misc_blurb: "2 regions",
            data_type: "galaxy.datatypes.interval.Bed",
            creating_job: job.id,
            rerunnable: true,
            resubmitted: false,
            uuid: dataset.uuid,
            created_from_basename: "regions.bed",
            download_url: `/api/histories/${historyId}/contents/${hda.id}/download`,
            url: `/api/histories/${historyId}/contents/${hda.id}`,
            meta_files: [
                {
                    file_type: "bai",
                    download_url: `/api/histories/${historyId}/contents/${hda.id}/metadata_file?metadata_file=bai`,
                },
            ],
            metadata_dbkey: "hg38",
            metadata_columns: 4,
            display_apps: [],
            permissions: { manage: [], access: [] },
            drs_id: `hda-${hda.id}`,
        });
        expect(shown).not.toHaveProperty("metadata_bai");
        expect(shown.hashes).toEqual([
            {
                id: expect.any(String),
                model_class: "DatasetHash",
                hash_function: "MD5",
                hash_value: "abc",
                extra_files_path: null,
            },
        ]);
        expect(shown.peek).toBe(
            '<table cellspacing="0" cellpadding="3"><tr><th>1.Chrom</th><th>2.Start</th><th>3.End</th><th>4.Name</th></tr>' +
                "<tr><td>chr1</td><td>10</td><td>20</td><td>A</td></tr><tr><td>chr1</td><td>30</td><td>40</td><td>B</td></tr></table>",
        );
        expect(await fetchJson(router, "GET", `/api/histories/${historyId}/contents/${hda.id}`)).toEqual(shown);
        const summary = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents/datasets/${hda.id}?view=summary`,
        );
        expect(keysOf(summary)).toEqual([...HDA_SUMMARY_KEYS].sort());
        const picked = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents/datasets/${hda.id}?keys=name,size,nice_size`,
        );
        expect(picked).toEqual({ name: "regions.bed", size: 2048, nice_size: "2.0 KB" });
        expect(
            (await send(router, "GET", `/api/histories/${historyId}/contents/datasets/0123456789abcdef`)).status,
        ).toBe(404);
        expect((await send(router, "GET", `/api/histories/${historyId}/contents/widgets/${hda.id}`)).status).toBe(400);
    });

    it("shows a collection with its elements, nested collections and job states", async () => {
        const historyId = await currentHistoryId();
        const forward = await addDataset(historyId, { name: "f", visible: false }, { state: "ok" });
        const reverse = await addDataset(historyId, { name: "r", visible: false }, { state: "running" });
        const icj = "0123456789abcdef";
        await addJob(historyId, { state: "ok", implicit_collection_jobs_id: icj });
        await addJob(historyId, { state: "running", implicit_collection_jobs_id: icj });
        const { hdca, collection } = await collections.createHdca({
            hdca: {
                name: "pairs",
                history_id: historyId,
                job_source_id: icj,
                job_source_type: "ImplicitCollectionJobs",
            },
            collection: {
                collection_type: "list:paired",
                elements: [
                    {
                        identifier: "sample1",
                        collection: {
                            collection_type: "paired",
                            elements: [
                                { identifier: "forward", hda_id: forward.hda.id },
                                { identifier: "reverse", hda_id: reverse.hda.id },
                            ],
                        },
                    },
                ],
            },
        });
        const router = makeRouter();
        const shown = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents/dataset_collections/${hdca.id}`,
        );
        expect(keysOf(shown)).toEqual([...HDCA_ELEMENT_VIEW_KEYS].sort());
        expect(shown).toMatchObject({
            id: hdca.id,
            collection_id: collection.id,
            collection_type: "list:paired",
            populated: true,
            elements_states: { ok: 1, running: 1 },
            elements_datatypes: ["txt"],
            job_source_type: "ImplicitCollectionJobs",
            implicit_collection_jobs_id: icj,
            create_time: hdca.create_time,
        });
        expect(shown.job_state_summary).toMatchObject({ all_jobs: 2, ok: 1, running: 1 });
        const [outer] = shown.elements;
        expect(outer).toMatchObject({
            model_class: "DatasetCollectionElement",
            element_identifier: "sample1",
            element_index: 0,
            element_type: "dataset_collection",
            columns: null,
        });
        expect(outer.object).toMatchObject({
            model_class: "DatasetCollection",
            collection_type: "paired",
            element_count: 2,
            populated: true,
            elements_states: { ok: 1, running: 1 },
        });
        const inner = outer.object.elements[1];
        expect(inner).toMatchObject({ element_identifier: "reverse", element_type: "hda" });
        expect(inner.object).toMatchObject({
            model_class: "HistoryDatasetAssociation",
            id: reverse.hda.id,
            hda_ldda: "hda",
            state: "running",
            file_ext: "txt",
            history_id: historyId,
            tags: [],
            metadata_dbkey: "?",
        });

        const summaryView = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents?v=dev&view=detailed&q=history_content_type-eq&qv=dataset_collection`,
        );
        expect(summaryView[0].elements[0].object.elements[0].object).toMatchObject({
            id: forward.hda.id,
            type: "file",
        });
        const collectionView = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}/contents/dataset_collections/${hdca.id}?view=collection`,
        );
        expect(keysOf(collectionView)).toEqual([...HDCA_COLLECTION_VIEW_KEYS].sort());
    });
});

describe("PUT /api/histories/{history_id}/contents/{type}s/{id}", () => {
    it("updates a dataset and returns the detailed view", async () => {
        const historyId = await currentHistoryId();
        const { hda } = await addDataset(historyId, { name: "a" });
        const before = await histories.getOrThrow(historyId);
        const { events, stop } = captureEvents();
        const updated = await fetchJson(
            makeRouter(),
            "PUT",
            `/api/histories/${historyId}/contents/datasets/${hda.id}`,
            {
                name: "b",
                visible: false,
                genome_build: "hg38",
                tags: ["#Sample 1", "group:lab;group:lab"],
                annotation: "notes",
                misc_info: null,
            },
        );
        await flushEvents();
        stop();
        expect(updated).toMatchObject({
            name: "b",
            visible: false,
            genome_build: "hg38",
            tags: ["name:Sample1", "group:lab"],
            annotation: "notes",
            misc_info: "",
        });
        expect(keysOf(updated)).toEqual(expect.arrayContaining([...DETAILED_FIXED_KEYS]));
        const after = await histories.getOrThrow(historyId);
        expect(after.update_time > before.update_time).toBe(true);
        expect(events).toContainEqual({ type: "history-changed", historyId });
    });

    it("rejects bad values and datasets that are still uploading", async () => {
        const historyId = await currentHistoryId();
        const router = makeRouter();
        const { hda } = await addDataset(historyId);
        expect(
            (await send(router, "PUT", `/api/histories/${historyId}/contents/datasets/${hda.id}`, { visible: "no" }))
                .status,
        ).toBe(400);
        const uploading = await addDataset(historyId, {}, { state: "upload" });
        const response = await send(
            router,
            "PUT",
            `/api/histories/${historyId}/contents/datasets/${uploading.hda.id}`,
            { name: "x" },
        );
        expect(response.status).toBe(409);
    });

    it("changes the datatype through a set-metadata job", async () => {
        const historyId = await currentHistoryId();
        const { hda } = await addDataset(historyId, { extension: "txt" });
        const router = makeRouter();
        const updated = await fetchJson(router, "PUT", `/api/histories/${historyId}/contents/datasets/${hda.id}`, {
            datatype: "tabular",
        });
        expect(updated).toMatchObject({ extension: "tabular", state: "setting_metadata" });
        const [job] = (await jobs.listForHistory(historyId)).filter((each) => each.tool_id === SET_METADATA_TOOL_ID);
        expect(job).toMatchObject({ state: "new", inputs: [{ name: "input1", src: "hda", id: hda.id }] });
        expect(job!.params).toMatchObject({ datatype: "tabular", overwrite: true });
        expect(
            (await send(router, "PUT", `/api/histories/${historyId}/contents/datasets/${hda.id}`, { datatype: "nope" }))
                .status,
        ).toBe(400);
    });

    it("updates a collection and returns the changed values", async () => {
        const historyId = await currentHistoryId();
        const { hda } = await addDataset(historyId);
        const list = await addList(historyId, [hda.id]);
        const changed = await fetchJson(
            makeRouter(),
            "PUT",
            `/api/histories/${historyId}/contents/dataset_collections/${list.id}`,
            {
                name: "<b>renamed</b>",
                visible: false,
                deleted: false,
                tags: ["group:x"],
            },
        );
        expect(changed).toEqual({ name: "&lt;b&gt;renamed&lt;/b&gt;", visible: false, tags: ["group:x"] });
        expect((await collections.getHdcaOrThrow(list.id)).visible).toBe(false);
    });
});

describe("DELETE /api/histories/{history_id}/contents/{type}s/{id}", () => {
    it("deletes a dataset and, with stop_job, cancels its job once every output is deleted", async () => {
        const historyId = await currentHistoryId();
        const job = await addJob(historyId, { state: "running" });
        const first = await addDataset(historyId, { creating_job_id: job.id }, { state: "running", job_id: job.id });
        const second = await addDataset(historyId, { creating_job_id: job.id }, { state: "running", job_id: job.id });
        await jobs.update(job.id, {
            outputs: [
                { name: "a", src: "hda", id: first.hda.id },
                { name: "b", src: "hda", id: second.hda.id },
            ],
        });
        const router = makeRouter();
        const path = (id: string) =>
            `/api/histories/${historyId}/contents/datasets/${id}?purge=false&recursive=false&stop_job=true`;
        expect((await send(router, "DELETE", path(first.hda.id))).status).toBe(204);
        expect((await hdas.getOrThrow(first.hda.id)).deleted).toBe(true);
        expect((await jobs.getOrThrow(job.id)).state).toBe("running");

        const { events, stop } = captureEvents();
        expect((await send(router, "DELETE", path(second.hda.id))).status).toBe(204);
        await flushEvents();
        stop();
        const cancelled = await jobs.getOrThrow(job.id);
        expect(cancelled).toMatchObject({
            state: "deleting",
            info: "Job output deleted by user before job completed.",
        });
        expect(events).toContainEqual({ type: "job-changed", jobId: job.id, state: "deleting" });
        expect(await datasets.getOrThrow(second.dataset.id)).toMatchObject({ state: "discarded" });
        expect(await hdas.getOrThrow(second.hda.id)).toMatchObject({
            deleted: true,
            blurb: "deleted",
            peek: "Job deleted",
        });
    });

    it("purges a dataset and marks the dataset purged with its last copy", async () => {
        const historyId = await currentHistoryId();
        const { hda, dataset } = await addDataset(historyId);
        const copy = await hdas.copy(hda.id, historyId);
        const router = makeRouter();
        expect(
            (
                await send(router, "DELETE", `/api/histories/${historyId}/contents/datasets/${hda.id}`, {
                    purge: true,
                    recursive: false,
                    stop_job: false,
                })
            ).status,
        ).toBe(204);
        expect(await hdas.getOrThrow(hda.id)).toMatchObject({ deleted: true, purged: true });
        expect((await datasets.getOrThrow(dataset.id)).purged).toBe(false);
        expect(
            (await send(router, "DELETE", `/api/histories/${historyId}/contents/${copy.id}?purge=true`)).status,
        ).toBe(204);
        expect(await datasets.getOrThrow(dataset.id)).toMatchObject({ deleted: true, purged: true });
        const shown = await fetchJson(router, "GET", `/api/histories/${historyId}/contents/datasets/${copy.id}`);
        expect(shown).toMatchObject({ deleted: true, purged: true });
    });

    it("deletes a collection recursively and refuses uploading datasets", async () => {
        const historyId = await currentHistoryId();
        const { hda } = await addDataset(historyId, { visible: false });
        const list = await addList(historyId, [hda.id]);
        const router = makeRouter();
        expect(
            (
                await send(
                    router,
                    "DELETE",
                    `/api/histories/${historyId}/contents/dataset_collections/${list.id}?recursive=true&purge=true`,
                )
            ).status,
        ).toBe(204);
        expect((await collections.getHdcaOrThrow(list.id)).deleted).toBe(true);
        expect(await hdas.getOrThrow(hda.id)).toMatchObject({ deleted: true, purged: true });
        const uploading = await addDataset(historyId, {}, { state: "upload" });
        expect(
            (await send(router, "DELETE", `/api/histories/${historyId}/contents/datasets/${uploading.hda.id}`)).status,
        ).toBe(409);
    });
});

describe("PUT /api/histories/{history_id}/contents/bulk", () => {
    it("applies operations to the items matching the filters", async () => {
        const { historyId, reads, table, hidden, list } = await seed();
        const router = makeRouter();
        const bulk = (body: unknown, query = "") =>
            fetchJson(router, "PUT", `/api/histories/${historyId}/contents/bulk${query}`, body);

        expect(await bulk({ operation: "hide" }, "?q=deleted&qv=false&q=visible&qv=true")).toEqual({
            success_count: 3,
            errors: [],
        });
        expect((await hdas.getOrThrow(reads.hda.id)).visible).toBe(false);
        expect((await collections.getHdcaOrThrow(list.id)).visible).toBe(false);

        await bulk({
            operation: "add_tags",
            items: [{ id: table.hda.id, history_content_type: "dataset" }],
            params: { type: "add_tags", tags: ["group:lab", "#x"] },
        });
        expect((await hdas.getOrThrow(table.hda.id)).tags).toEqual(["group:lab", "name:x"]);
        await bulk({
            operation: "remove_tags",
            items: [{ id: table.hda.id, history_content_type: "dataset" }],
            params: { type: "remove_tags", tags: ["group:lab"] },
        });
        expect((await hdas.getOrThrow(table.hda.id)).tags).toEqual(["name:x"]);

        await bulk({
            operation: "change_dbkey",
            items: [{ id: list.id, history_content_type: "dataset_collection" }],
            params: { type: "change_dbkey", dbkey: "mm10" },
        });
        expect((await hdas.getOrThrow(hidden.hda.id)).dbkey).toBe("mm10");
        const unknown = await send(router, "PUT", `/api/histories/${historyId}/contents/bulk`, {
            operation: "change_dbkey",
            params: { type: "change_dbkey", dbkey: "xyz1" },
        });
        expect(unknown.status).toBe(400);
        expect((await unknown.json()).err_msg).toBe("Database/build 'xyz1' is not registered");
    });

    it("deletes, purges and reports per-item errors", async () => {
        const { historyId, reads, table } = await seed();
        const router = makeRouter();
        const items = [
            { id: reads.hda.id, history_content_type: "dataset" },
            { id: table.hda.id, history_content_type: "dataset" },
        ];
        expect(
            await fetchJson(router, "PUT", `/api/histories/${historyId}/contents/bulk`, {
                operation: "purge",
                items: [items[0]],
            }),
        ).toEqual({ success_count: 1, errors: [] });
        const result = await fetchJson(router, "PUT", `/api/histories/${historyId}/contents/bulk`, {
            operation: "undelete",
            items,
        });
        expect(result).toEqual({
            success_count: 1,
            errors: [
                {
                    item: { id: reads.hda.id, history_content_type: "dataset" },
                    error: "This item has been permanently deleted and cannot be recovered.",
                },
            ],
        });
        expect(
            (await send(router, "PUT", `/api/histories/${historyId}/contents/bulk`, { operation: "explode" })).status,
        ).toBe(400);
    });

    it("queues set-metadata jobs when changing datatypes", async () => {
        const { historyId, reads, list } = await seed();
        const router = makeRouter();
        const { events, stop } = captureEvents();
        const result = await fetchJson(router, "PUT", `/api/histories/${historyId}/contents/bulk`, {
            operation: "change_datatype",
            items: [{ id: list.id, history_content_type: "dataset_collection" }],
            params: { type: "change_datatype", datatype: "auto" },
        });
        await flushEvents();
        stop();
        expect(result).toEqual({ success_count: 1, errors: [] });
        const created = (await jobs.listForHistory(historyId)).filter((job) => job.tool_id === SET_METADATA_TOOL_ID);
        expect(created).toHaveLength(2);
        expect(events.filter((event) => event.type === "job-created")).toHaveLength(2);
        const reread = await hdas.getOrThrow(reads.hda.id);
        expect(reread).toMatchObject({ _state: "setting_metadata", extension: "fasta" });

        const busy = await addJob(historyId, {
            state: "running",
            inputs: [{ name: "i", src: "hda", id: reads.hda.id }],
        });
        const blocked = await fetchJson(router, "PUT", `/api/histories/${historyId}/contents/bulk`, {
            operation: "change_datatype",
            items: [{ id: reads.hda.id, history_content_type: "dataset" }],
            params: { type: "change_datatype", datatype: "txt" },
        });
        expect(blocked.success_count).toBe(0);
        expect(blocked.errors[0].error).toMatch(/currently being used as input or output/);
        expect(busy.state).toBe("running");
        expect(
            (
                await send(router, "PUT", `/api/histories/${historyId}/contents/bulk`, {
                    operation: "change_datatype",
                    params: { type: "change_datatype", datatype: "nope" },
                })
            ).status,
        ).toBe(400);
    });
});

describe("hid allocation", () => {
    it("allocates consecutive hids to datasets and collections and keeps the counter", async () => {
        const historyId = await currentHistoryId();
        const a = await addDataset(historyId);
        const b = await addDataset(historyId);
        const list = await addList(historyId, [a.hda.id, b.hda.id]);
        const c = await addDataset(historyId);
        expect([a.hda.hid, b.hda.hid, list.hid, c.hda.hid]).toEqual([1, 2, 3, 4]);
        const history = await fetchJson(makeRouter(), "GET", `/api/histories/${historyId}`);
        expect(history).toMatchObject({ hid_counter: 5, count: 4 });
    });
});

describe("renderPeek", () => {
    const info = new DatatypeInfo(MAPPING);
    const hda = (extension: string, peek: string | null, metadata: Record<string, unknown> = {}) =>
        ({ extension, peek, metadata }) as Parameters<typeof renderPeek>[0];

    it("renders text as one row per non-empty line, escaped", () => {
        expect(renderPeek(hda("txt", "  <b>one</b>\n\n two \n"), info)).toBe(
            '<table cellspacing="0" cellpadding="3"><tr><td>&lt;b&gt;one&lt;/b&gt;</td></tr><tr><td>two</td></tr></table>',
        );
        expect(renderPeek(hda("txt", "no peek"), info)).toBeNull();
        expect(renderPeek(hda("txt", null), info)).toBeNull();
    });

    it("keeps binary peeks unchanged", () => {
        expect(renderPeek(hda("bam", "Binary bam alignments file"), info)).toBe("Binary bam alignments file");
    });

    it("renders tabular peeks with column headers, except for plain tabular", () => {
        const tabular = renderPeek(hda("tabular", "a\tb\nshort\n", { columns: 2 }), info);
        expect(tabular).toBe(
            '<table cellspacing="0" cellpadding="3"><tr><td>a</td><td>b</td></tr><tr><td>short</td><td></td></tr></table>',
        );
        const csv = renderPeek(
            hda("csv", "x,y\n1,2,3\n", { columns: 2, delimiter: ",", column_names: ["x", "y"] }),
            info,
        );
        expect(csv).toBe(
            '<table cellspacing="0" cellpadding="3"><tr><th>1.x</th><th>2.y</th></tr><tr><td>x</td><td>y</td></tr>' +
                '<tr><td colspan="100%">1,2,3</td></tr></table>',
        );
        const vcf = renderPeek(hda("vcf", "##fileformat=VCFv4.2\n", { columns: 2 }), info);
        expect(vcf).toContain("<th>1.Chrom</th><th>2.Pos</th>");
    });

    it("falls back to the generic table without a datatype mapping", () => {
        expect(renderPeek(hda("bam", "Binary bam alignments file"), new DatatypeInfo(null))).toBe(
            '<table cellspacing="0" cellpadding="3"><tr><td>Binary bam alignments file</td></tr></table>',
        );
    });
});

describe("normalizeTags", () => {
    it("stores tags the way Galaxy's tag handler does", () => {
        expect(
            normalizeTags(["#My Sample", "group:a b", " plain ", "plain", "name=x", ".dotted", "", ";", "a,b"]),
        ).toEqual(["name:MySample", "group:ab", "plain", "name:x", "dotted", "a", "b"]);
    });
});
