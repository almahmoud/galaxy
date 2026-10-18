// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, datasets, type HdaRecord, hdas, type HdcaRecord, histories, jobs, outbox } from "@/planet/db";
import type { Router } from "@/planet/sw/router";

import { fetchJson, resetPlanet, teardownPlanet } from "../../api/__tests__/contents.fixtures";
import type { BundleInput, BundleOutput, ToolBundle } from "../bundle";
import { conditional, kitchenSinkBundle, output, param, toolboxFiles } from "./bundles.fixtures";
import { type HistoryFixture, makeToolRouter, seedHistory, stubData } from "./fixtures";

type Model = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A bundle of one of Galaxy's collection operation tools (`lib/galaxy/tools/*.xml`). */
function operation(id: string, toolType: string, inputs: BundleInput[], outputs: BundleOutput[]): ToolBundle {
    const base = kitchenSinkBundle();
    return {
        ...base,
        id,
        old_id: id,
        version: "1.0.0",
        versions: ["1.0.0"],
        name: id,
        tool_type: toolType,
        requirements: [],
        data_tables: [],
        tool_shed_repository: null,
        inputs,
        outputs,
        panel_entry: { ...base.panel_entry, id, version: "1.0.0", versions: ["1.0.0"], name: id },
    };
}

function collectionOutput(name: string, label: string, collectionType: string | null): BundleOutput {
    return output(name, {
        model_class: "ToolOutputCollection",
        output_type: "collection",
        format: null,
        format_source: "input",
        label,
        structure: {
            collection_type: collectionType,
            collection_type_source: collectionType ? null : "input",
            structured_like: null,
            discover_datasets: [],
        },
        outputs: [],
    });
}

const listInput = () =>
    param("data_collection", "input", { collection_types: ["list", "list:paired"], extensions: ["data"] });

const BUNDLES = [
    operation(
        "__ZIP_COLLECTION__",
        "zip_collection",
        [
            param("data", "input_forward", { extensions: ["data"] }),
            param("data", "input_reverse", { extensions: ["data"] }),
        ],
        [collectionOutput("output", "${on_string} (zipped)", "paired")],
    ),
    operation(
        "__UNZIP_COLLECTION__",
        "unzip_collection",
        [param("data_collection", "input", { collection_types: ["paired"], extensions: ["data"] })],
        [
            output("forward", { label: "${on_string} (forward)", format_source: "input" }),
            output("reverse", { label: "${on_string} (reverse)", format_source: "input" }),
        ],
    ),
    operation(
        "__FLATTEN__",
        "flatten_collection",
        [
            param("data_collection", "input", { extensions: ["data"] }),
            param("select", "join_identifier", {
                static_options: [
                    ["underscore ( _ )", "_", false],
                    ["colon ( : )", ":", false],
                ],
            }),
        ],
        [collectionOutput("output", "${on_string} (flattened)", "list")],
    ),
    operation(
        "__FILTER_FAILED_DATASETS__",
        "filter_failed_datasets_collection",
        [listInput(), param("data", "replacement", { optional: true, extensions: ["data"] })],
        [collectionOutput("output", "${on_string} (filtered failed datasets)", null)],
    ),
    operation(
        "__FILTER_EMPTY_DATASETS__",
        "filter_empty_datasets_collection",
        [listInput()],
        [collectionOutput("output", "${on_string} (filtered empty datasets)", null)],
    ),
    operation(
        "__KEEP_SUCCESS_DATASETS__",
        "keep_success_datasets_collection",
        [listInput()],
        [collectionOutput("output", "${on_string} (success)", null)],
    ),
    operation(
        "__SORTLIST__",
        "sort_collection",
        [
            listInput(),
            conditional(
                "sort_type",
                param("select", "sort_type", {
                    static_options: [
                        ["alphabetical", "alpha", false],
                        ["numeric", "numeric", false],
                        ["from file", "file", false],
                    ],
                }),
                [
                    ["alpha", []],
                    ["numeric", []],
                    ["file", [param("data", "sort_file", { extensions: ["txt"] })]],
                ],
            ),
        ],
        [collectionOutput("output", "${on_string} (sorted)", null)],
    ),
    operation(
        "__RELABEL_FROM_FILE__",
        "relabel_from_file",
        [listInput(), param("data", "labels", { extensions: ["txt"] })],
        [collectionOutput("output", "${on_string} (relabelled)", null)],
    ),
];

let fixture: HistoryFixture;
let router: Router;

beforeEach(async () => {
    await resetPlanet();
    stubData(toolboxFiles(BUNDLES), false);
    fixture = await seedHistory();
    router = makeToolRouter();
});
afterEach(teardownPlanet);

function run(toolId: string, inputs: Record<string, unknown>, status = 200): Promise<Model> {
    return fetchJson(
        router,
        "POST",
        "/api/tools",
        { tool_id: toolId, history_id: fixture.historyId, inputs, __tags: ["group:run"] },
        status,
    );
}

function ref(item: HdaRecord | HdcaRecord, src = "collection_id" in item ? "hdca" : "hda") {
    return { values: [{ id: item.id, src }], batch: false };
}

async function addDataset(name: string, fields: Partial<HdaRecord> = {}, state = "ok", size = 10): Promise<HdaRecord> {
    const { hda } = await hdas.createWithDataset(
        { history_id: fixture.historyId, name, extension: "txt", visible: false, ...fields },
        { state: state as "ok", file_size: size, total_size: size },
    );
    return hda;
}

async function list(name: string, elements: [string, HdaRecord][], tags: string[] = []): Promise<HdcaRecord> {
    return (
        await collections.createHdca({
            hdca: { history_id: fixture.historyId, name, tags },
            collection: {
                collection_type: "list",
                elements: elements.map(([identifier, hda]) => ({ identifier, hda_id: hda.id })),
            },
        })
    ).hdca;
}

/** The identifiers of a collection's elements and the source each copy was made from. */
async function copiedElements(hdcaId: string): Promise<[string, string | undefined][]> {
    const hdca = await collections.getHdcaOrThrow(hdcaId);
    const out: [string, string | undefined][] = [];
    for (const element of await collections.elements(hdca.collection_id)) {
        const hda = element.hda_id ? await hdas.getOrThrow(element.hda_id) : undefined;
        out.push([element.element_identifier, hda?.copied_from?.id]);
    }
    return out;
}

async function expectSettled(response: Model): Promise<void> {
    for (const job of response.jobs) {
        expect(job.state).toBe("ok");
        expect(await outbox.listForJob(job.id)).toEqual([]);
    }
}

describe("collection operations", () => {
    it("zips two datasets into a pair of hidden copies without dispatching a job", async () => {
        const firstHid = (await histories.getOrThrow(fixture.historyId)).hid_counter;
        const response = await run("__ZIP_COLLECTION__", {
            input_forward: ref(fixture.reads1),
            input_reverse: ref(fixture.reads2),
        });
        await expectSettled(response);
        expect(response.outputs).toEqual([]);
        const [zipped] = response.output_collections;
        expect(zipped).toMatchObject({
            output_name: "output",
            hid: firstHid + 2,
            name: `dataset ${fixture.reads1.hid} and ${fixture.reads2.hid} (zipped)`,
            collection_type: "paired",
            populated_state: "ok",
            tags: ["group:run"],
        });
        expect(await copiedElements(zipped.id)).toEqual([
            ["forward", fixture.reads1.id],
            ["reverse", fixture.reads2.id],
        ]);
        const forward = await hdas.getOrThrow(zipped.elements[0].object.id);
        expect(forward).toMatchObject({
            hid: firstHid,
            name: fixture.reads1.name,
            visible: false,
            dataset_id: fixture.reads1.dataset_id,
            creating_job_id: fixture.reads1.creating_job_id,
        });
        const job = await jobs.getOrThrow(response.jobs[0].id);
        expect(job).toMatchObject({ state: "ok", k8s: null, outputs: [] });
        expect(job.output_collections).toEqual([{ name: "output", src: "hdca", id: zipped.id }]);
    });

    it("unzips a pair into its two datasets, as outputs of the job", async () => {
        const response = await run("__UNZIP_COLLECTION__", { input: ref(fixture.readsPair) });
        await expectSettled(response);
        const pair = await collections.elements(fixture.readsPair.collection_id);
        expect(response.outputs.map((item: Model) => [item.output_name, item.visible, item.tags])).toEqual([
            ["forward", false, ["group:run"]],
            ["reverse", false, ["group:run"]],
        ]);
        const forward = await hdas.getOrThrow(response.outputs[0].id);
        expect(forward).toMatchObject({
            copied_from: { src: "hda", id: pair[0]!.hda_id },
            creating_job_id: response.jobs[0].id,
        });
        // A copy shares its dataset: state changes reach it.
        await datasets.setState(forward.dataset_id, "error");
        expect((await hdas.getWithDatasetOrThrow(pair[0]!.hda_id!)).dataset.state).toBe("error");
    });

    it("flattens nested collections, joining identifiers", async () => {
        const forward = await addDataset("f");
        const reverse = await addDataset("r");
        const nested = (
            await collections.createHdca({
                hdca: { history_id: fixture.historyId, name: "nested", tags: ["name:cohort"] },
                collection: {
                    collection_type: "list:paired",
                    elements: [
                        {
                            identifier: "s1",
                            collection: {
                                collection_type: "paired",
                                elements: [
                                    { identifier: "forward", hda_id: forward.id },
                                    { identifier: "reverse", hda_id: reverse.id },
                                ],
                            },
                        },
                    ],
                },
            })
        ).hdca;
        const response = await run("__FLATTEN__", { input: ref(nested), join_identifier: ":" });
        await expectSettled(response);
        const [flat] = response.output_collections;
        expect(flat).toMatchObject({ collection_type: "list", name: `collection ${nested.hid} (flattened)` });
        expect(flat.tags).toEqual(["name:cohort", "group:run"]);
        expect(await copiedElements(flat.id)).toEqual([
            ["s1:forward", forward.id],
            ["s1:reverse", reverse.id],
        ]);
    });

    it("filters failed datasets, or replaces them, and waits for pending ones", async () => {
        const good = await addDataset("good", { tags: ["name:good"] });
        const bad = await addDataset("bad", { tags: ["name:bad"] }, "error");
        const input = await list("mixed", [
            ["a", good],
            ["b", bad],
        ]);
        const filtered = await run("__FILTER_FAILED_DATASETS__", { input: ref(input), replacement: null });
        await expectSettled(filtered);
        expect(await copiedElements(filtered.output_collections[0].id)).toEqual([["a", good.id]]);

        const replaced = await run("__FILTER_FAILED_DATASETS__", { input: ref(input), replacement: ref(fixture.text) });
        const elements = await collections.elements(
            (await collections.getHdcaOrThrow(replaced.output_collections[0].id)).collection_id,
        );
        const replacement = await hdas.getOrThrow(elements[1]!.hda_id!);
        expect(replacement).toMatchObject({ copied_from: { src: "hda", id: fixture.text.id }, tags: ["name:bad"] });

        const pending = await list("pending", [["a", await addDataset("running", {}, "running")]]);
        const notReady = await run("__FILTER_FAILED_DATASETS__", { input: ref(pending), replacement: null }, 400);
        expect(notReady).toMatchObject({ err_msg: "An input dataset is pending.", err_code: 400015 });
    });

    it("keeps successful datasets once none is pending", async () => {
        const input = await list("mixed", [
            ["a", await addDataset("good")],
            ["b", await addDataset("paused", {}, "paused")],
        ]);
        const response = await run("__KEEP_SUCCESS_DATASETS__", { input: ref(input) });
        expect((await copiedElements(response.output_collections[0].id)).map(([identifier]) => identifier)).toEqual([
            "a",
        ]);
        const pending = await list("pending", [["a", await addDataset("queued", {}, "queued")]]);
        expect((await run("__KEEP_SUCCESS_DATASETS__", { input: ref(pending) }, 400)).err_code).toBe(400015);
    });

    it("filters empty datasets by size and refuses what only the content can decide", async () => {
        const full = await addDataset("full");
        const input = await list("sizes", [
            ["full", full],
            ["empty", await addDataset("empty", {}, "ok", 0)],
        ]);
        const response = await run("__FILTER_EMPTY_DATASETS__", { input: ref(input) });
        expect(await copiedElements(response.output_collections[0].id)).toEqual([["full", full.id]]);

        const gzipped = await list("gz", [["a", await addDataset("a.gz", { extension: "txt.gz" }, "ok", 20)]]);
        expect((await run("__FILTER_EMPTY_DATASETS__", { input: ref(gzipped) }, 400)).err_msg).toContain(
            "may be compressed and empty",
        );
        const failed = await list("failed", [["a", await addDataset("bad", {}, "error")]]);
        expect((await run("__FILTER_EMPTY_DATASETS__", { input: ref(failed) }, 400)).err_code).toBe(400017);
    });

    it("sorts by identifier, alphabetically or by number", async () => {
        const items = await Promise.all(["x10", "x9", "B", "a"].map((name) => addDataset(name)));
        const input = await list(
            "unsorted",
            items.map((hda) => [hda.name, hda] as [string, HdaRecord]),
        );
        const alpha = await run("__SORTLIST__", { input: ref(input), "sort_type|sort_type": "alpha" });
        expect((await copiedElements(alpha.output_collections[0].id)).map(([identifier]) => identifier)).toEqual([
            "B",
            "a",
            "x10",
            "x9",
        ]);
        const numbered = await list("numbered", [
            ["x10", items[0]!],
            ["x9", items[1]!],
        ]);
        const numeric = await run("__SORTLIST__", { input: ref(numbered), "sort_type|sort_type": "numeric" });
        expect((await copiedElements(numeric.output_collections[0].id)).map(([identifier]) => identifier)).toEqual([
            "x9",
            "x10",
        ]);
        const noNumber = await run("__SORTLIST__", { input: ref(input), "sort_type|sort_type": "numeric" }, 400);
        expect(noNumber.err_msg).toContain("needs a number in every element identifier");
        const byFile = await run(
            "__SORTLIST__",
            { input: ref(input), "sort_type|sort_type": "file", "sort_type|sort_file": ref(fixture.text) },
            400,
        );
        expect(byFile.err_msg).toContain("needs the dataset's content");
    });

    it("refuses operations that read dataset contents, with a message naming why", async () => {
        const before = (await jobs.listForHistory(fixture.historyId)).length;
        const response = await run(
            "__RELABEL_FROM_FILE__",
            { input: ref(fixture.readsList), labels: ref(fixture.text) },
            400,
        );
        expect(response.err_msg).toBe(
            "Planet cannot run '__RELABEL_FROM_FILE__': this collection operation reads new identifiers from a dataset.",
        );
        expect(await jobs.listForHistory(fixture.historyId)).toHaveLength(before);
    });

    it("maps over the pairs of a list:paired, collecting each job's copies", async () => {
        const pair = async (sample: string) => ({
            identifier: sample,
            collection: {
                collection_type: "paired",
                elements: [
                    { identifier: "forward", hda_id: (await addDataset(`${sample}_1`)).id },
                    { identifier: "reverse", hda_id: (await addDataset(`${sample}_2`)).id },
                ],
            },
        });
        const samples = (
            await collections.createHdca({
                hdca: { history_id: fixture.historyId, name: "samples" },
                collection: { collection_type: "list:paired", elements: [await pair("s1"), await pair("s2")] },
            })
        ).hdca;
        const response = await run("__UNZIP_COLLECTION__", {
            input: { batch: true, product: false, values: [{ id: samples.id, src: "hdca", map_over_type: "paired" }] },
        });
        await expectSettled(response);
        expect(response.implicit_collections.map((item: Model) => [item.output_name, item.collection_type])).toEqual([
            ["forward", "list"],
            ["reverse", "list"],
        ]);
        const [forward] = response.implicit_collections;
        expect(forward).toMatchObject({
            name: `collection ${samples.hid} (forward)`,
            job_state_summary: { all_jobs: 2, ok: 2 },
            elements_states: { ok: 2 },
        });
        const sources = await Promise.all(
            forward.elements.map(async (element: Model) => [
                element.element_identifier,
                (await hdas.getOrThrow(element.object.id)).name,
            ]),
        );
        expect(sources).toEqual([
            ["s1", "s1_1"],
            ["s2", "s2_1"],
        ]);
    });
});
