// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    buildDce,
    collections,
    datasets,
    type HdaRecord,
    hdas,
    type HdcaRecord,
    histories,
    type JobRecord,
    jobs,
    outbox,
    withTransaction,
} from "@/planet/db";
import type { Router } from "@/planet/sw/router";
import { resetStaticData } from "@/planet/util/staticData";

import { fetchJson, resetPlanet, teardownPlanet } from "../../api/__tests__/contents.fixtures";
import { register as registerCollections } from "../../api/collections";
import { kitchenSinkBundle, TOOL_ID, toolboxFiles } from "./bundles.fixtures";
import { formDataFromModel, type HistoryFixture, makeToolRouter, seedHistory, stubData } from "./fixtures";

type Model = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let fixture: HistoryFixture;
let defaults: Record<string, unknown>;
let router: Router;
let tables: HdcaRecord;
let tableElements: HdaRecord[];
let samples: HdcaRecord;

async function addDataset(name: string, extension: string, fields: Partial<HdaRecord> = {}): Promise<HdaRecord> {
    const { hda } = await hdas.createWithDataset(
        { history_id: fixture.historyId, name, extension, visible: false, ...fields },
        { state: "ok", file_size: 10, total_size: 10 },
    );
    return hda;
}

beforeEach(async () => {
    await resetPlanet();
    stubData(toolboxFiles([kitchenSinkBundle()]), false);
    fixture = await seedHistory();
    router = makeToolRouter();
    registerCollections(router);
    defaults = formDataFromModel(
        (await fetchJson(router, "GET", `/api/tools/${TOOL_ID}/build?history_id=${fixture.historyId}`)).inputs,
    );
    const metadata = { columns: 2, column_types: ["str", "int"] };
    tableElements = [
        await addDataset("t1.tsv", "tabular", { tags: ["name:t1"], metadata }),
        await addDataset("t2.tsv", "tabular", { dbkey: "mm10", metadata }),
    ];
    tables = (
        await collections.createHdca({
            hdca: { history_id: fixture.historyId, name: "two tables", tags: ["name:batch", "group:x"] },
            collection: {
                collection_type: "list",
                elements: tableElements.map((hda, index) => ({ identifier: `t${index + 1}`, hda_id: hda.id })),
            },
        })
    ).hdca;
    const pair = async (sample: string) => ({
        identifier: sample,
        collection: {
            collection_type: "paired",
            elements: [
                { identifier: "forward", hda_id: (await addDataset(`${sample}_1.fq`, "fastqsanger")).id },
                { identifier: "reverse", hda_id: (await addDataset(`${sample}_2.fq`, "fastqsanger")).id },
            ],
        },
    });
    samples = (
        await collections.createHdca({
            hdca: { history_id: fixture.historyId, name: "samples" },
            collection: { collection_type: "list:paired", elements: [await pair("s1"), await pair("s2")] },
        })
    ).hdca;
});
afterEach(teardownPlanet);

function run(inputs: Record<string, unknown>, status = 200): Promise<Model> {
    return fetchJson(
        router,
        "POST",
        "/api/tools",
        { tool_id: TOOL_ID, tool_version: "1.1", history_id: fixture.historyId, inputs, __tags: ["group:run"] },
        status,
    );
}

/** The value Galaxy's `FormData` submits for a collection in batch mode. */
function mapOver(hdca: HdcaRecord, mapOverType: string | null = null, linked?: boolean) {
    const value: Record<string, unknown> = {
        batch: true,
        product: false,
        values: [{ id: hdca.id, src: "hdca", map_over_type: mapOverType }],
    };
    if (linked !== undefined) {
        value.linked = linked;
    }
    return value;
}

function jobRecords(response: Model): Promise<JobRecord[]> {
    return Promise.all(response.jobs.map((job: Model) => jobs.getOrThrow(job.id)));
}

function showCollection(id: string): Promise<Model> {
    return fetchJson(router, "GET", `/api/dataset_collections/${id}`);
}

describe("collection map-over", () => {
    it("runs a data parameter once per dataset of a list and collects each output in an implicit list", async () => {
        const firstHid = (await histories.getOrThrow(fixture.historyId)).hid_counter;
        const response = await run({ ...defaults, input: mapOver(tables) });

        expect(response.jobs).toHaveLength(2);
        expect(response.output_collections).toEqual([]);
        // `maybe` has a filter the browser cannot decide: it is created, and the jobs' stage-in decides.
        expect(response.implicit_collections.map((item: Model) => [item.output_name, item.hid])).toEqual([
            ["out", firstHid],
            ["aligned", firstHid + 1],
            ["maybe", firstHid + 2],
        ]);
        const [out, aligned] = response.implicit_collections;
        expect(out).toMatchObject({
            model_class: "HistoryDatasetCollectionAssociation",
            name: `Kitchen sink on collection ${tables.hid}`,
            collection_type: "list",
            populated_state: "ok",
            element_count: 2,
            visible: true,
            tags: ["name:batch"],
            job_source_type: "ImplicitCollectionJobs",
            job_state_summary: { all_jobs: 2, new: 2 },
        });
        expect(aligned.name).toBe(`Kitchen sink on collection ${tables.hid}`);

        const records = await jobRecords(response);
        expect(records.map((job) => job.implicit_collection_jobs_id)).toEqual([out.job_source_id, out.job_source_id]);
        expect(out.implicit_collection_jobs_id).toBe(out.job_source_id);
        expect(aligned.job_source_id).toBe(out.job_source_id);
        records.forEach((job, index) => {
            const element = tableElements[index]!;
            expect(job.inputs).toEqual([{ name: "input", src: "hda", id: element.id }]);
            expect(job.params).toMatchObject({
                input: { src: "hda", id: element.id },
                "input|__identifier__": `t${index + 1}`,
                dbkey: index === 0 ? "?" : "mm10",
            });
            expect(job.request).toMatchObject({ inputs: { input: { src: "hda", id: element.id } } });
        });
        for (const job of records) {
            expect((await outbox.listForJob(job.id)).map((entry) => entry.kind)).toEqual(["dispatch"]);
        }

        // Each job's outputs are hidden and follow the implicit collections' hids, job by job.
        const [t1, t2] = tableElements.map((hda) => `Kitchen sink on dataset ${hda.hid}`);
        expect(
            response.outputs.map((item: Model) => [item.output_name, item.hid, item.visible, item.name, item.tags]),
        ).toEqual([
            ["out", firstHid + 3, false, t1, ["name:t1", "group:run"]],
            ["aligned", firstHid + 4, false, t1, ["name:t1", "group:run"]],
            ["maybe", firstHid + 5, false, t1, ["name:t1", "group:run"]],
            ["out", firstHid + 6, false, t2, ["group:run"]],
            ["aligned", firstHid + 7, false, t2, ["group:run"]],
            ["maybe", firstHid + 8, false, t2, ["group:run"]],
        ]);
        expect(out.elements.map((element: Model) => [element.element_identifier, element.object.id])).toEqual([
            ["t1", records[0]!.outputs[0]!.id],
            ["t2", records[1]!.outputs[0]!.id],
        ]);
        expect(aligned.elements.map((element: Model) => element.object.id)).toEqual([
            records[0]!.outputs[1]!.id,
            records[1]!.outputs[1]!.id,
        ]);
    });

    it("offers collections for batch mode and keeps a batch selection when the form is rebuilt", async () => {
        const form = await fetchJson(router, "POST", `/api/tools/${TOOL_ID}/build`, {
            history_id: fixture.historyId,
            inputs: { ...defaults, input: mapOver(tables), pairs: mapOver(samples, "paired") },
        });
        const input = form.inputs.find((node: Model) => node.name === "input");
        expect(input.options.hdca.map((item: Model) => item.id)).toContain(tables.id);
        expect(input.value).toMatchObject({ values: [{ id: tables.id, src: "hdca" }] });
        const pairs = form.inputs.find((node: Model) => node.name === "pairs");
        expect(pairs.options.hdca).toContainEqual(
            expect.objectContaining({ id: samples.id, src: "hdca", map_over_type: "paired" }),
        );
        expect(pairs.value).toMatchObject({ values: [{ id: samples.id, src: "hdca" }] });
    });

    it("shows and reruns a mapped job with its element", async () => {
        const response = await run({ ...defaults, input: mapOver(tables) });
        const jobId = response.jobs[1].id;
        const rerun = await fetchJson(router, "GET", `/api/jobs/${jobId}/build_for_rerun`);
        const input = rerun.inputs.find((node: Model) => node.name === "input");
        expect(input.value).toMatchObject({ values: [{ id: tableElements[1]!.id, src: "hda" }] });
        const display = await fetchJson(router, "GET", `/api/jobs/${jobId}/parameters_display`);
        expect(display.has_parameter_errors).toBe(false);
        expect(display.outputs.out.map((item: Model) => item.value)).toEqual([
            { src: "hda", id: response.outputs[3].id },
        ]);
    });

    it("updates the implicit collection's job and element states as its jobs progress", async () => {
        const response = await run({ ...defaults, input: mapOver(tables) });
        const [first, second] = response.jobs;
        const [out] = response.implicit_collections;
        const firstOutput = (await jobs.getOrThrow(first.id)).outputs[0]!;
        const before = (await collections.getHdcaOrThrow(out.id)).update_time;

        await jobs.update(first.id, { state: "running" });
        await jobs.update(second.id, { state: "error" });
        await datasets.setState((await hdas.getOrThrow(firstOutput.id)).dataset_id, "ok");

        const shown = await showCollection(out.id);
        expect(shown.job_state_summary).toMatchObject({ all_jobs: 2, running: 1, error: 1, new: 0 });
        expect(shown.elements_states).toEqual({ ok: 1, new: 1 });
        expect((await collections.getHdcaOrThrow(out.id)).update_time > before).toBe(true);
        const filtered = await fetchJson(router, "GET", `/api/jobs?implicit_collection_jobs_id=${out.job_source_id}`);
        expect(filtered.map((job: Model) => job.id).sort()).toEqual([first.id, second.id].sort());
    });

    it("maps a collection parameter over the pairs of a list:paired, nesting each job's collection", async () => {
        const firstHid = (await histories.getOrThrow(fixture.historyId)).hid_counter;
        const response = await run({ ...defaults, pairs: mapOver(samples, "paired") });

        expect(response.jobs).toHaveLength(2);
        expect(response.output_collections).toEqual([]);
        expect(
            response.implicit_collections.map((item: Model) => [item.output_name, item.hid, item.collection_type]),
        ).toEqual([
            ["pair_out", firstHid, "list:paired"],
            ["out", firstHid + 1, "list"],
            ["aligned", firstHid + 2, "list"],
            ["maybe", firstHid + 3, "list"],
        ]);
        const [pairOut, out] = response.implicit_collections;
        // Named after the collections the run maps over (`ExecutionTracker.on_text`).
        expect(pairOut.name).toBe(`Kitchen sink on collection ${samples.hid}: pairs`);
        expect(out.name).toBe(`Kitchen sink on collection ${samples.hid}`);

        const elements = await collections.elements(samples.collection_id);
        const records = await jobRecords(response);
        records.forEach((job, index) => {
            expect(job.params.pairs).toEqual({ src: "dce", id: elements[index]!.id });
            expect(job.inputs).toContainEqual({ name: "pairs", src: "dce", id: elements[index]!.id });
            expect(job.output_collections.map((item) => item.name)).toEqual(["pair_out"]);
        });
        // Each job's own collection is hidden and is the implicit collection's element for its pair.
        for (const [index, job] of records.entries()) {
            const own = await collections.getHdcaOrThrow(job.output_collections[0]!.id);
            expect(own).toMatchObject({ visible: false, job_source_type: "Job", job_source_id: job.id });
            const element = pairOut.elements[index];
            expect(element).toMatchObject({ element_identifier: `s${index + 1}`, element_type: "dataset_collection" });
            expect(element.object.id).toBe(own.collection_id);
            expect(element.object.elements.map((item: Model) => item.element_identifier)).toEqual([
                "forward",
                "reverse",
            ]);
        }
        expect(pairOut.populated).toBe(true);
    });

    it("leaves the implicit collection unpopulated until each job fills its own collection", async () => {
        const bundle = kitchenSinkBundle();
        const pairOut = bundle.outputs[0]!;
        pairOut.structure = { ...pairOut.structure!, collection_type: "list", discover_datasets: [{}] };
        resetPlanetData([bundle]);
        const response = await run({ ...defaults, pairs: mapOver(samples, "paired") });
        const implicit = response.implicit_collections[0];
        expect(implicit).toMatchObject({ collection_type: "list:list", populated_state: "ok", populated: false });

        const records = await jobRecords(response);
        for (const job of records) {
            // What ingest does with results.json: elements added to the job's collection, which is then populated.
            const own = await collections.getHdcaOrThrow(job.output_collections[0]!.id);
            const discovered = await addDataset("found.txt", "txt");
            await collections.updateCollection(own.collection_id, { populated_state: "ok", element_count: 1 });
            await withTransaction(["dces"], "readwrite", (tx) =>
                tx.store("dces").add(
                    buildDce({
                        collection_id: own.collection_id,
                        element_index: 0,
                        element_identifier: "found",
                        hda_id: discovered.id,
                    }),
                ),
            );
        }
        const shown = await showCollection(implicit.id);
        expect(shown.populated).toBe(true);
        expect(shown.elements.map((element: Model) => element.object.elements[0].element_identifier)).toEqual([
            "found",
            "found",
        ]);
    });

    it("matches linked collections element by element and refuses collections that do not match", async () => {
        const response = await run({ ...defaults, input: mapOver(tables), pairs: mapOver(samples, "paired") });
        expect(response.jobs).toHaveLength(2);
        const elements = await collections.elements(samples.collection_id);
        const records = await jobRecords(response);
        records.forEach((job, index) => {
            expect(job.params.input).toEqual({ src: "hda", id: tableElements[index]!.id });
            expect(job.params.pairs).toEqual({ src: "dce", id: elements[index]!.id });
        });
        // The first collection by parameter name gives the identifiers.
        expect(response.implicit_collections[1].elements.map((item: Model) => item.element_identifier)).toEqual([
            "t1",
            "t2",
        ]);
        expect(response.implicit_collections[1].name).toBe(
            `Kitchen sink on collection ${tables.hid} and ${samples.hid}`,
        );

        const before = (await jobs.listForHistory(fixture.historyId)).length;
        const shorter = await run(
            { ...defaults, input: mapOver(fixture.tables), pairs: mapOver(samples, "paired") },
            400,
        );
        expect(shorter.err_msg).toBe(
            "Received 2 inputs for 'pairs' and 1 inputs for 'input', these should be of equal length",
        );
        const nested = (
            await collections.createHdca({
                hdca: { history_id: fixture.historyId, name: "nested tables" },
                collection: {
                    collection_type: "list:list",
                    elements: tableElements.map((hda, index) => ({
                        identifier: `g${index}`,
                        collection: { collection_type: "list", elements: [{ identifier: "t", hda_id: hda.id }] },
                    })),
                },
            })
        ).hdca;
        const mismatch = await run({ ...defaults, input: mapOver(nested), pairs: mapOver(samples, "paired") }, 400);
        expect(mismatch.err_msg).toBe("Cannot match collection types.");
        expect(await jobs.listForHistory(fixture.historyId)).toHaveLength(before);
    });

    it("takes a data output's identifiers from the collection its default_identifier_source names", async () => {
        const bundle = kitchenSinkBundle();
        bundle.outputs = bundle.outputs.map((item) =>
            item.name === "out" ? { ...item, default_identifier_source: "queries_0|table" } : item,
        );
        resetPlanetData([bundle]);
        const renamed = (
            await collections.createHdca({
                hdca: { history_id: fixture.historyId, name: "renamed tables" },
                collection: {
                    collection_type: "list",
                    elements: tableElements.map((hda, index) => ({ identifier: `u${index + 1}`, hda_id: hda.id })),
                },
            })
        ).hdca;
        const identifiers = (response: Model, name: string) =>
            response.implicit_collections
                .find((item: Model) => item.output_name === name)
                .elements.map((element: Model) => element.element_identifier);

        const linked = await run({ ...defaults, input: mapOver(tables), "queries_0|table": mapOver(renamed) });
        expect(linked.jobs).toHaveLength(2);
        expect(identifiers(linked, "out")).toEqual(["u1", "u2"]);
        // Other outputs keep the identifiers of the first collection by parameter name.
        expect(identifiers(linked, "aligned")).toEqual(["t1", "t2"]);

        // A run over both collections unlinked has another shape than the named collection, so nothing changes.
        const unlinked = await run({
            ...defaults,
            input: mapOver(tables, null, false),
            "queries_0|table": mapOver(renamed, null, false),
        });
        expect(unlinked.jobs).toHaveLength(4);
        expect(identifiers(unlinked, "out")).toEqual(["t1", "t2"]);
    });

    it("multiplies unlinked collections into nested implicit collections", async () => {
        const response = await run({
            ...defaults,
            input: mapOver(tables, null, false),
            pairs: mapOver(samples, "paired", false),
        });
        expect(response.jobs).toHaveLength(4);
        const out = response.implicit_collections.find((item: Model) => item.output_name === "out");
        expect(out.collection_type).toBe("list:list");
        expect(out.elements.map((element: Model) => element.element_identifier)).toEqual(["t1", "t2"]);
        expect(
            out.elements.map((element: Model) =>
                element.object.elements.map((inner: Model) => inner.element_identifier),
            ),
        ).toEqual([
            ["s1", "s2"],
            ["s1", "s2"],
        ]);
        const records = await jobRecords(response);
        const elements = await collections.elements(samples.collection_id);
        expect(records.map((job) => [job.params.input, job.params.pairs])).toEqual([
            [
                { src: "hda", id: tableElements[0]!.id },
                { src: "dce", id: elements[0]!.id },
            ],
            [
                { src: "hda", id: tableElements[0]!.id },
                { src: "dce", id: elements[1]!.id },
            ],
            [
                { src: "hda", id: tableElements[1]!.id },
                { src: "dce", id: elements[0]!.id },
            ],
            [
                { src: "hda", id: tableElements[1]!.id },
                { src: "dce", id: elements[1]!.id },
            ],
        ]);
        expect(out.elements[1].object.elements[0].object.id).toBe(
            records[2]!.outputs.find((output) => output.name === "out")!.id,
        );
    });

    it("refuses collections it cannot split, unpopulated collections and single-dataset adapters", async () => {
        expect((await run({ ...defaults, pairs: mapOver(samples, "list") }, 400)).err_msg).toBe(
            "Cannot split collection in desired fashion.",
        );
        expect((await run({ ...defaults, pairs: mapOver(fixture.readsPair, "paired") }, 400)).err_msg).toBe(
            "Cannot split collection in desired fashion.",
        );
        expect(
            (await run({ ...defaults, pairs: mapOver(fixture.readsList, "single_datasets") }, 400)).err_msg,
        ).toContain("not supported by Planet yet");
        await collections.updateCollection(tables.collection_id, { populated_state: "new" });
        const unpopulated = await run({ ...defaults, input: mapOver(tables) }, 400);
        expect(unpopulated).toMatchObject({ err_msg: "An input collection is not populated.", err_code: 400015 });
    });
});

/** Serves `bundles` instead of the default kitchen sink. */
function resetPlanetData(bundles: ReturnType<typeof kitchenSinkBundle>[]): void {
    resetStaticData();
    stubData(toolboxFiles(bundles), false);
}
