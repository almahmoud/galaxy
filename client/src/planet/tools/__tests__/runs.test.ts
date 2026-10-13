// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, hdas, histories, jobs, outbox } from "@/planet/db";
import { Router } from "@/planet/sw/router";
import { resetStaticData } from "@/planet/util/staticData";

import { fetchJson, resetPlanet, send, teardownPlanet } from "../../api/__tests__/contents.fixtures";
import { register as registerDatasets } from "../../api/datasets";
import { kitchenSinkBundle, output, TOOL_ID, toolboxFiles } from "./bundles.fixtures";
import { formDataFromModel, type HistoryFixture, makeToolRouter, seedHistory, stubData } from "./fixtures";

type Model = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let fixture: HistoryFixture;
let defaults: Record<string, unknown>;

beforeEach(async () => {
    await resetPlanet();
    stubData(toolboxFiles([kitchenSinkBundle("1.0"), kitchenSinkBundle()]), false);
    fixture = await seedHistory();
    const form = await fetchJson(
        makeToolRouter(),
        "GET",
        `/api/tools/${TOOL_ID}/build?history_id=${fixture.historyId}`,
    );
    defaults = formDataFromModel(form.inputs);
});
afterEach(teardownPlanet);

function run(inputs: Record<string, unknown>, extra: Record<string, unknown> = {}, status = 200): Promise<Model> {
    return fetchJson(
        makeToolRouter(),
        "POST",
        "/api/tools",
        { tool_id: TOOL_ID, tool_version: "1.1", history_id: fixture.historyId, inputs, ...extra },
        status,
    );
}

function data(id: string, src = "hda") {
    return { values: [{ id, src }], batch: false };
}

describe("POST /api/tools", () => {
    it("creates the job, its outputs and the dispatch entry, and answers Galaxy's response", async () => {
        const firstHid = (await histories.getOrThrow(fixture.historyId)).hid_counter;
        const response = await run({ ...defaults, mode: "fast" }, { __tags: ["#batch", "group:a"] });
        expect(response.jobs).toHaveLength(1);
        const [job] = response.jobs;
        expect(job).toMatchObject({ model_class: "Job", state: "new", tool_id: TOOL_ID, tool_version: "1.1" });
        expect(response.output_collections).toEqual([]);
        expect(response.implicit_collections).toEqual([]);
        expect(response.produces_entry_points).toBe(false);
        expect(response.errors).toBeUndefined();
        expect(
            response.outputs.map((output: Model) => [output.output_name, output.hid, output.name, output.file_ext]),
        ).toEqual([
            ["out", firstHid, "Kitchen sink on dataset 1", "tabular"],
            ["aligned", firstHid + 1, "Kitchen sink on dataset 1", "bam"],
            ["maybe", firstHid + 2, "Kitchen sink on dataset 1", "txt"],
        ]);
        expect(response.outputs[0]).toMatchObject({
            model_class: "HistoryDatasetAssociation",
            state: "new",
            visible: true,
            history_id: fixture.historyId,
            genome_build: "hg38",
            misc_blurb: "queued",
            tags: ["name:sample", "name:batch", "group:a"],
        });

        const record = await jobs.getOrThrow(job.id);
        expect(record).toMatchObject({ state: "new", history_id: fixture.historyId, tool_id: TOOL_ID });
        expect(record.inputs).toEqual([{ name: "input", src: "hda", id: fixture.table.id }]);
        expect(record.outputs.map((output) => output.name)).toEqual(["out", "aligned", "maybe"]);
        expect(record.params).toMatchObject({
            input: { src: "hda", id: fixture.table.id },
            column: "1",
            reads: null,
            mode: "fast",
            threads: "4",
            ratio: "0.5",
            verbose: false,
            options: { kind: "basic", __current_case__: 0 },
            queries: [{ __index__: 0, q: "x", table: null }],
            advanced: { keep: true },
            reference: { use_ref: false, __current_case__: 1 },
            dbkey: "hg38",
            __input_ext: "input",
        });
        expect(record.request).toMatchObject({ tool_id: TOOL_ID, tool_version: "1.1", inputs: { mode: "fast" } });
        const entries = await outbox.listForJob(job.id);
        expect(entries.map((entry) => entry.kind)).toEqual(["dispatch"]);

        const out = await hdas.getWithDatasetOrThrow(response.outputs[0].id);
        expect(out.dataset).toMatchObject({ state: "new", job_id: job.id });
        expect(out.dataset.uuid).toMatch(/^[0-9a-f-]{36}$/);
        expect(out.hda).toMatchObject({ creating_job_id: job.id, metadata: fixture.table.metadata });
    });

    it("decides filters, labels and change_format with the safe subset and keeps undecidable outputs", async () => {
        const response = await run({
            ...defaults,
            "options|kind": "advanced",
            "options|level": "2",
            "options|note": "",
        });
        const names = response.outputs.map((output: Model) => [output.output_name, output.name, output.file_ext]);
        expect(names).toEqual([
            ["out", "Kitchen sink on dataset 1", "tabular"],
            ["report", "Report of slow (advanced)", "html"],
            ["aligned", "Kitchen sink on dataset 1", "sam"],
            ["maybe", "Kitchen sink on dataset 1", "txt"],
        ]);
        const report = await hdas.getWithDatasetOrThrow(response.outputs[1].id);
        expect(report.dataset.created_from_basename).toBe("report.html");
    });

    it("creates output collections before the datasets, as Galaxy numbers them", async () => {
        const firstHid = (await histories.getOrThrow(fixture.historyId)).hid_counter;
        const response = await run({ ...defaults, pairs: data(fixture.readsPair.id, "hdca") });
        expect(
            response.outputs.map((output: Model) => [output.output_name, output.hid, output.visible, output.file_ext]),
        ).toEqual([
            ["pair_out|__part__|forward", firstHid, false, "fastqsanger"],
            ["pair_out|__part__|reverse", firstHid + 1, false, "fastqsanger"],
            ["out", firstHid + 3, true, "tabular"],
            ["aligned", firstHid + 4, true, "sam"],
            ["maybe", firstHid + 5, true, "txt"],
        ]);
        expect(response.output_collections).toHaveLength(1);
        expect(response.output_collections[0]).toMatchObject({
            output_name: "pair_out",
            hid: firstHid + 2,
            name: `Kitchen sink on dataset 1 and collection ${fixture.readsPair.hid}: pairs`,
            collection_type: "paired",
            populated_state: "ok",
            job_source_type: "Job",
            job_source_id: response.jobs[0].id,
        });
        expect(response.output_collections[0].elements.map((element: Model) => element.element_identifier)).toEqual([
            "forward",
            "reverse",
        ]);
        const record = await jobs.getOrThrow(response.jobs[0].id);
        expect(record.output_collections).toEqual([
            { name: "pair_out", src: "hdca", id: response.output_collections[0].id },
        ]);
        expect(record.inputs.map((association) => association.name)).toEqual(["pairs", "input", "pairs1", "pairs2"]);
    });

    it("passes collections to multiple data parameters as their datasets", async () => {
        const response = await run({
            ...defaults,
            reads: { values: [{ id: fixture.readsList.id, src: "hdca" }], batch: false },
        });
        const record = await jobs.getOrThrow(response.jobs[0].id);
        expect(record.params.reads).toEqual([{ id: fixture.readsList.id, src: "hdca" }]);
        expect(record.inputs.map((association) => [association.name, association.src])).toEqual([
            ["reads", "hdca"],
            ["input", "hda"],
            ["reads", "hda"],
            ["reads1", "hda"],
            ["reads2", "hda"],
        ]);
        expect(response.outputs[0].name).toBe(`Kitchen sink on dataset 1 and collection ${fixture.readsList.hid}`);
    });

    it("runs one job per batch value", async () => {
        const other = await hdas.createWithDataset(
            { history_id: fixture.historyId, name: "other.tsv", extension: "tabular", metadata: { columns: 3 } },
            { state: "ok", file_size: 5 },
        );
        const response = await run({
            ...defaults,
            input: {
                batch: true,
                values: [
                    { id: fixture.table.id, src: "hda" },
                    { id: other.hda.id, src: "hda" },
                ],
            },
        });
        expect(response.jobs).toHaveLength(2);
        expect(
            response.outputs
                .filter((output: Model) => output.output_name === "out")
                .map((output: Model) => output.name),
        ).toEqual(["Kitchen sink on dataset 1", `Kitchen sink on dataset ${other.hda.hid}`]);
        const unlinked = await run({
            ...defaults,
            input: {
                batch: true,
                linked: false,
                values: [
                    { id: fixture.table.id, src: "hda" },
                    { id: other.hda.id, src: "hda" },
                ],
            },
            mode: { batch: true, linked: false, values: ["fast", "slow"] },
        });
        expect(unlinked.jobs).toHaveLength(4);
        const mismatch = await run(
            {
                ...defaults,
                input: { batch: true, values: [{ id: fixture.table.id, src: "hda" }] },
                reads: {
                    batch: true,
                    values: [
                        { id: fixture.reads1.id, src: "hda" },
                        { id: fixture.reads2.id, src: "hda" },
                    ],
                },
            },
            {},
            400,
        );
        expect(mismatch.err_msg).toBe(
            "Received 2 inputs for 'reads' and 1 inputs for 'input', these should be of equal length",
        );
    });

    it("rejects invalid parameters of any job before creating jobs", async () => {
        const before = (await jobs.listForHistory(fixture.historyId)).length;
        const error = await run({ ...defaults, input: null, threads: "100" }, {}, 400);
        expect(error.err_code).toBe(400008);
        expect(error.err_data).toEqual({
            input: "Parameter 'input': specify a dataset of the required format / build for parameter",
            column: "Parameter 'column': requires a value, but no legal values defined",
            threads: "Parameter 'threads': Value ('100') must fulfill (1 <= value <= 64)",
        });
        expect(error.param_errors.threads).toEqual({
            message: "Parameter 'threads': Value ('100') must fulfill (1 <= value <= 64)",
            message_suffix: "Value ('100') must fulfill (1 <= value <= 64)",
            parameter_name: "threads",
            parameter_value: 100,
        });
        // As in Galaxy, a falsy value is not shown in the validator's message.
        const zero = await run({ ...defaults, threads: "0" }, {}, 400);
        expect(zero.err_data.threads).toBe("Parameter 'threads': Value ('%s') must fulfill (1 <= value <= 64)");
        expect(error.err_msg).toContain("specify a dataset of the required format");
        expect(await jobs.listForHistory(fixture.historyId)).toHaveLength(before);
    });

    it("refuses collection map-over, the upload tool, unknown tools and immutable histories", async () => {
        const mapOver = await run(
            { ...defaults, input: { batch: true, values: [{ id: fixture.tables.id, src: "hdca" }] } },
            {},
            400,
        );
        expect(mapOver.err_msg).toContain("over the elements of a collection");
        const collection = await run({ ...defaults, input: data(fixture.tables.id, "hdca") }, {}, 400);
        expect(collection.err_data.input).toContain("dataset collection supplied to single input dataset parameter");
        const router = makeToolRouter();
        const upload = await fetchJson(router, "POST", "/api/tools", { tool_id: "upload1", inputs: {} }, 404);
        expect(upload.err_msg).toBe("Could not find tool with id 'upload1'.");
        expect((await fetchJson(router, "POST", "/api/tools", { inputs: {} }, 400)).err_code).toBe(400007);
        expect((await run(defaults, { inputs: "x" }, 400)).err_msg).toBe('inputs invalid "x"');
        expect((await run(defaults, { input_format: "21.01" }, 400)).err_msg).toContain("legacy input format");
        expect((await run({ ...defaults, rerun_remap_job_id: "abc" }, {}, 400)).err_msg).toContain("dependent jobs");
        await histories.update(fixture.historyId, { archived: true });
        expect((await run(defaults, {}, 403)).err_code).toBe(403003);
    });

    it("fails a run whose inputs disappeared after validation with Galaxy's error list", async () => {
        const response = await send(makeToolRouter(), "POST", "/api/tools", {
            tool_id: TOOL_ID,
            history_id: fixture.historyId,
            inputs: { ...defaults, input: data("ffffffffffffffff") },
        });
        expect(response.status).toBe(400);
        expect((await response.json()).err_data.input).toBe("Invalid input id passed to job submission API.");
    });
});

describe("job parameters and rerun", () => {
    async function runDefaults(): Promise<string> {
        const response = await run({
            ...defaults,
            "options|kind": "advanced",
            "options|level": "3",
            "options|note": "it's",
            mode: "fast",
        });
        return response.jobs[0].id;
    }

    it("summarizes a job's parameters from the tool's inputs", async () => {
        const jobId = await runDefaults();
        const summary = await fetchJson(makeToolRouter(), "GET", `/api/jobs/${jobId}/parameters_display`);
        expect(summary.has_parameter_errors).toBe(false);
        expect(summary.parameters).toEqual([
            {
                text: "Table",
                depth: 1,
                value: [{ src: "hda", id: fixture.table.id, hid: fixture.table.hid, name: "table.tsv" }],
            },
            { text: "column", depth: 1, value: "1", notes: "" },
            { text: "reads", depth: 1, value: [] },
            { text: "pairs", depth: 1, value: [] },
            { text: "mode", depth: 1, value: "Fast", notes: "" },
            { text: "flags", depth: 1, value: "Nothing selected.", notes: "" },
            { text: "index", depth: 1, value: "None", notes: "" },
            { text: "read_group", depth: 1, value: "None", notes: "" },
            { text: "threads", depth: 1, value: "4", notes: "" },
            { text: "ratio", depth: 1, value: "0.5", notes: "" },
            { text: "title", depth: 1, value: "run", notes: "" },
            { text: "verbose", depth: 1, value: "False", notes: "" },
            // Galaxy stores the inputs' genome build under `dbkey`, replacing a parameter of that name.
            { text: "dbkey", depth: 1, value: "hg38", notes: "" },
            { text: "kind", depth: 1, value: "advanced" },
            { text: "level", depth: 2, value: "3", notes: "" },
            { text: "note", depth: 2, value: "it's", notes: "" },
            { text: "q", depth: 2, value: "x", notes: "" },
            { text: "table", depth: 2, value: [] },
            { text: "advanced", depth: 1 },
            { text: "keep", depth: 2, value: "True", notes: "" },
            { text: "secret", depth: 1, value: "s3", notes: "" },
            { text: "colour", depth: 1, value: "#ff0000", notes: "" },
            { text: "use_ref", depth: 1, value: "no" },
        ]);
        expect(summary.outputs.report).toEqual([
            { label: "Report of fast (advanced)", value: { src: "hda", id: expect.any(String) } },
        ]);
        expect(summary.outputs.out[0].label).toBe("Kitchen sink on None");

        const router = new Router();
        registerDatasets(router);
        const outputId = summary.outputs.out[0].value.id;
        expect(await fetchJson(router, "GET", `/api/datasets/${outputId}/parameters_display`)).toEqual(summary);
    });

    it("flags stored values the tool no longer has", async () => {
        const jobId = await runDefaults();
        const record = await jobs.getOrThrow(jobId);
        await jobs.update(jobId, { params: { ...record.params, options: { kind: "expert", __current_case__: 2 } } });
        const summary = await fetchJson(makeToolRouter(), "GET", `/api/jobs/${jobId}/parameters_display`);
        expect(summary.has_parameter_errors).toBe(true);
        expect(summary.parameters).toContainEqual({
            text: "options",
            depth: 1,
            notes: "The previously used value is no longer valid.",
            error: true,
        });
        const unknown = await jobs.create({ tool_id: "gone", tool_version: "1", history_id: fixture.historyId });
        expect(await fetchJson(makeToolRouter(), "GET", `/api/jobs/${unknown.id}/parameters_display`)).toEqual({
            parameters: [],
            has_parameter_errors: true,
            outputs: {},
        });
    });

    it("rebuilds the form of a job with its parameters", async () => {
        const jobId = await runDefaults();
        const router = makeToolRouter();
        const form = await fetchJson(router, "GET", `/api/jobs/${jobId}/build_for_rerun`);
        expect(form).toMatchObject({
            id: TOOL_ID,
            job_id: jobId,
            job_remap: false,
            message: "",
            warnings: {},
            errors: {},
        });
        expect(form.state_inputs).toMatchObject({
            input: { values: [{ id: fixture.table.id, src: "hda" }] },
            mode: "fast",
            options: { kind: "advanced", __current_case__: 1, level: "3", note: "it's" },
        });
        const rerun = await run(formDataFromModel(form.inputs));
        expect((await jobs.getOrThrow(rerun.jobs[0].id)).params).toEqual((await jobs.getOrThrow(jobId)).params);
    });

    it("reports a version change and values it replaced with defaults", async () => {
        const jobId = await runDefaults();
        await jobs.update(jobId, { tool_version: "0.9" });
        await hdas.update(fixture.table.id, { deleted: true });
        const form = await fetchJson(makeToolRouter(), "GET", `/api/jobs/${jobId}/build_for_rerun`);
        expect(form.message).toBe(
            'This job was run with tool version "0.9", which is not available. You can re-run the job with the selected tool or choose another version of the tool. ',
        );
        // The default is the newest tabular dataset: the first run's output.
        const output = (await jobs.getOrThrow(jobId)).outputs.find((association) => association.name === "out")!;
        const replacement = await hdas.getOrThrow(output.id);
        expect(form.warnings.input).toBe(
            `Parameter 'input': the previously selected dataset has been deleted. Using default: '${replacement.hid}: ${replacement.name}'.`,
        );
        expect(form.state_inputs.input).toEqual({ values: [{ id: replacement.id, src: "hda" }] });
    });

    it("maps the job's datasets to their copies in the current history", async () => {
        const jobId = await runDefaults();
        const other = await histories.create({ name: "copy" });
        await histories.setCurrent(other.id);
        const copy = await hdas.copy(fixture.table.id, other.id);
        const form = await fetchJson(makeToolRouter(), "GET", `/api/jobs/${jobId}/build_for_rerun`);
        expect(form.history_id).toBe(other.id);
        expect(form.state_inputs.input).toEqual({ values: [{ id: copy.id, src: "hda" }] });
    });

    it("refuses jobs of missing or rerun-incompatible tools", async () => {
        const missing = await jobs.create({ tool_id: "gone", tool_version: "1", history_id: fixture.historyId });
        const router = makeToolRouter();
        expect(
            (await fetchJson(router, "GET", `/api/jobs/${missing.id}/build_for_rerun`, undefined, 404)).err_msg,
        ).toBe("Requested tool not found");
        expect((await fetchJson(router, "GET", "/api/jobs/missing/build_for_rerun", undefined, 404)).err_code).toBe(
            404001,
        );
    });
});

describe("collections outputs", () => {
    it("leaves the elements of discovered collections to the job", async () => {
        const bundle = kitchenSinkBundle();
        bundle.outputs = [
            {
                model_class: "ToolOutputCollection",
                name: "discovered",
                label: null,
                hidden: false,
                output_type: "collection",
                filters: [],
                structure: {
                    collection_type: "list",
                    collection_type_source: null,
                    structured_like: null,
                    discover_datasets: [{}],
                },
                outputs: [],
            },
        ];
        resetStaticData();
        stubData(toolboxFiles([bundle]), false);
        const response = await run(defaults);
        expect(response.outputs).toEqual([]);
        expect(response.output_collections[0]).toMatchObject({ populated_state: "new", collection_type: "list" });
        const hdca = await collections.getHdcaWithCollection(response.output_collections[0].id);
        expect(hdca?.collection).toMatchObject({ populated_state: "new", element_count: null });
    });
});

describe("labels and limits", () => {
    it("prints values in labels as Cheetah does, sanitized, and falls back to the default name", async () => {
        const bundle = kitchenSinkBundle();
        bundle.outputs = [
            output("titled", { format: "txt", label: "$title for ${options.kind} ($verbose, $ratio)" }),
            output("inactive", { format: "txt", label: "$options.level" }),
        ];
        resetStaticData();
        stubData(toolboxFiles([bundle]), false);
        const response = await run({ ...defaults, title: "it's <b>", verbose: true, ratio: "2" });
        expect(response.outputs.map((item: Model) => item.name)).toEqual([
            "it__sq__s __lt__b__gt__ for basic (--verbose, 2.0)",
            "Kitchen sink on dataset 1",
        ]);
    });

    it("limits the number of jobs one run creates", async () => {
        const many = Array.from({ length: 40 }, (_, index) => `value${index}`);
        const error = await run(
            {
                ...defaults,
                title: { batch: true, linked: false, values: many },
                ratio: { batch: true, linked: false, values: many },
            },
            {},
            400,
        );
        expect(error.err_msg).toBe("This run would create 1600 jobs; Planet runs at most 1000 jobs at once.");
    });
});
