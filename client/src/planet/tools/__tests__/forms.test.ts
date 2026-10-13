// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { visitInputs } from "@/components/Form/utilities";
import { datasets, hdas } from "@/planet/db";
import { resetStaticData } from "@/planet/util/staticData";

import { fetchJson, resetPlanet, teardownPlanet } from "../../api/__tests__/contents.fixtures";
import { kitchenSinkBundle, param, TOOL_ID, toolboxFiles } from "./bundles.fixtures";
import { formDataFromModel, type HistoryFixture, makeToolRouter, seedHistory, stubData } from "./fixtures";

type Model = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let fixture: HistoryFixture;

beforeEach(async () => {
    await resetPlanet();
    stubData(toolboxFiles([kitchenSinkBundle("1.0"), kitchenSinkBundle()]), false);
    fixture = await seedHistory();
});
afterEach(teardownPlanet);

function build(query = ""): Promise<Model> {
    return fetchJson(makeToolRouter(), "GET", `/api/tools/${TOOL_ID}/build?history_id=${fixture.historyId}${query}`);
}

function refresh(inputs: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Model> {
    return fetchJson(makeToolRouter(), "POST", `/api/tools/${encodeURIComponent(TOOL_ID)}/build`, {
        tool_id: TOOL_ID,
        tool_version: "1.1",
        history_id: fixture.historyId,
        inputs,
        ...extra,
    });
}

function input(form: Model, name: string): Model {
    let found: Model | null = null;
    visitInputs(form.inputs, (node: Model, key: string) => {
        if (key === name) {
            found = node;
        }
    });
    if (!found) {
        throw new Error(`no active input ${name}`);
    }
    return found;
}

describe("GET /api/tools/{tool_id}/build", () => {
    it("answers the tool model with Galaxy's form fields", async () => {
        const form = await build();
        expect(form).toMatchObject({
            model_class: "Tool",
            id: TOOL_ID,
            name: "Kitchen sink",
            version: "1.1",
            versions: ["1.0", "1.1"],
            hidden_versions: [],
            panel_section_id: "tests",
            form_style: "regular",
            help_format: "restructuredtext",
            citations: true,
            sharable_url: "https://toolshed.example.org/view/planet/kitchen_sink",
            message: "",
            warnings: null,
            requirements: [{ name: "kitchen", version: "1.0" }],
            credentials: [],
            errors: {},
            tool_errors: null,
            job_id: null,
            job_remap: null,
            job_credentials_context: null,
            history_id: fixture.historyId,
            display: true,
            action: "/tool_runner/index",
            method: "post",
            enctype: "application/x-www-form-urlencoded",
            license: "MIT",
            creator: [{ class: "Person", name: "Planet" }],
        });
        expect(form.inputs.map((node: Model) => node.name)).toEqual(
            kitchenSinkBundle().inputs.map((node) => node.name),
        );
    });

    it("fills the help's static path and host URL", async () => {
        const form = await build();
        expect(form.help).toBe(
            '<p><img src="/static/images/a.png"/> <a href="https://planet.test/datasets">datasets</a></p>',
        );
    });

    it("offers matching history datasets and collections newest first", async () => {
        const form = await build();
        const data = input(form, "input");
        expect(data).toMatchObject({
            model_class: "DataToolParameter",
            type: "data",
            extensions: ["tabular"],
            edam: { edam_formats: ["format_3475"], edam_data: ["data_0006"] },
            multiple: false,
            tag: null,
            optional: false,
            refresh_on_change: true,
            is_dynamic: true,
            value: { values: [{ id: fixture.table.id, src: "hda" }] },
            default_value: { values: [{ id: fixture.table.id, src: "hda" }] },
            text_value: "No dataset.",
        });
        expect(data.options.hda).toEqual([
            {
                id: fixture.table.id,
                hid: fixture.table.hid,
                name: "table.tsv",
                tags: ["name:sample"],
                src: "hda",
                keep: false,
            },
        ]);
        expect(data.options.hdca).toEqual([
            { id: fixture.tables.id, hid: fixture.tables.hid, name: "tables", src: "hdca", tags: [], keep: false },
        ]);
        expect(data.options.dce).toEqual([]);
        expect(data.options.ldda).toEqual([]);
        expect(data.pinned).toEqual({ dce: [], ldda: [], hda: [], hdca: [] });
        expect(data.options_meta).toEqual({
            hda: { offset: 0, limit: 50, total_estimate: 1, has_more: false },
            hdca: { offset: 0, limit: 50, total_estimate: 1, has_more: false },
        });

        const reads = input(form, "reads");
        expect(reads.multiple).toBe(true);
        expect(reads.max).toBe(4);
        expect(reads.value).toBeNull();
        expect(reads.options.hda.map((option: Model) => option.name)).toEqual(["reads_2.fq", "reads_1.fq"]);
        // A multiple data parameter takes lists (and what maps over to lists), not pairs.
        expect(reads.options.hdca).toEqual([
            { id: fixture.readsList.id, hid: fixture.readsList.hid, name: "reads", src: "hdca", tags: [], keep: false },
        ]);

        const pairs = input(form, "pairs");
        expect(pairs).toMatchObject({
            model_class: "DataCollectionToolParameter",
            collection_types: ["paired"],
            extensions: ["fastqsanger"],
            multiple: false,
            value: null,
        });
        expect(pairs.options.hdca).toEqual([
            {
                id: fixture.readsPair.id,
                hid: fixture.readsPair.hid,
                name: "pair",
                src: "hdca",
                tags: [],
                column_definitions: null,
            },
        ]);
        expect(Object.keys(pairs.options)).toEqual(["hda", "hdca", "dce"]);
    });

    it("lists select, column, genome build and dynamic options", async () => {
        const form = await build();
        expect(input(form, "column")).toMatchObject({
            model_class: "ColumnListParameter",
            options: [
                ["Column: 1", "1", false],
                ["Column: 2", "2", false],
                ["Column: 3", "3", false],
            ],
            value: "1",
            textable: false,
            data_ref: "input",
            numerical: false,
        });
        expect(input(form, "mode")).toMatchObject({
            options: [
                ["Fast", "fast", false],
                ["Slow", "slow", true],
            ],
            value: "slow",
            text_value: "Slow",
            display: null,
            multiple: false,
            textable: false,
        });
        expect(input(form, "flags")).toMatchObject({ value: null, multiple: true, display: "checkboxes" });
        expect(input(form, "index")).toMatchObject({ options: [], value: null, is_dynamic: true });
        expect(input(form, "read_group").options).toEqual([
            ["name", "name", false],
            ["count", "count", false],
            ["score", "score", false],
        ]);
        expect(input(form, "dbkey")).toMatchObject({
            model_class: "GenomeBuildParameter",
            value: "?",
            options: [
                ["unspecified (?)", "?", false],
                ["Human Dec. 2013 (GRCh38/hg38) (hg38)", "hg38", false],
                ["Mouse Dec. 2011 (GRCm38/mm10) (mm10)", "mm10", false],
            ],
        });
    });

    it("serializes numbers, booleans, text, colors and hidden values like value_to_basic", async () => {
        const form = await build();
        expect(input(form, "threads")).toMatchObject({ value: "4", min: 1, max: 64, area: false, datalist: [] });
        expect(input(form, "ratio")).toMatchObject({ value: "0.5", default_value: "0.5" });
        expect(input(form, "title")).toMatchObject({ value: "run", text_value: "run", optional: true });
        expect(input(form, "verbose")).toMatchObject({
            value: false,
            truevalue: "--verbose",
            falsevalue: "",
            text_value: "False",
        });
        expect(input(form, "secret")).toMatchObject({ value: "s3", hidden: true });
        expect(input(form, "colour").value).toBe("#ff0000");
    });

    it("describes groups: conditionals with all cases, repeats with a cache and sections", async () => {
        const form = await build();
        const options = form.inputs.find((node: Model) => node.name === "options");
        expect(options.test_param).toMatchObject({
            name: "kind",
            value: "basic",
            text_value: "Basic",
            refresh_on_change: true,
        });
        expect(options.cases.map((when: Model) => when.value)).toEqual(["basic", "advanced"]);
        expect(options.cases[1].inputs.map((node: Model) => [node.name, node.value])).toEqual([
            ["level", "1"],
            ["note", ""],
        ]);
        const queries = form.inputs.find((node: Model) => node.name === "queries");
        expect(queries).toMatchObject({ type: "repeat", title: "Query", min: 1, default: 1, max: 3 });
        expect(queries.inputs.map((node: Model) => node.name)).toEqual(["q", "table"]);
        expect(queries.cache).toHaveLength(1);
        expect(queries.cache[0][0]).toMatchObject({ name: "q", value: "x" });
        const advanced = form.inputs.find((node: Model) => node.name === "advanced");
        expect(advanced).toMatchObject({ type: "section", title: "Advanced settings", expanded: false });
        expect(advanced.inputs[0]).toMatchObject({ name: "keep", value: true });
        const reference = form.inputs.find((node: Model) => node.name === "reference");
        expect(reference.test_param).toMatchObject({ type: "boolean", value: false });
        expect(reference.cases[0].inputs[0]).toMatchObject({ name: "ref", type: "data" });
        expect(reference.cases[0].inputs[0].options.hda.map((option: Model) => option.name)).toEqual(["reference.fa"]);
    });

    it("returns the state in Galaxy's basic form", async () => {
        const form = await build();
        expect(form.state_inputs).toMatchObject({
            input: { values: [{ id: fixture.table.id, src: "hda" }] },
            column: "1",
            reads: null,
            mode: "slow",
            threads: "4",
            ratio: "0.5",
            verbose: false,
            dbkey: "?",
            options: { kind: "basic", __current_case__: 0 },
            queries: [{ __index__: 0, q: "x", table: null }],
            advanced: { keep: true },
            secret: "s3",
            colour: "#ff0000",
            reference: { use_ref: false, __current_case__: 1 },
        });
    });

    it("reports unknown tools", async () => {
        const error = await fetchJson(makeToolRouter(), "GET", "/api/tools/nope/build", undefined, 404);
        expect(error.err_msg).toBe("Could not find tool with id 'nope'.");
    });

    it("builds another version of the tool lineage", async () => {
        const form = await build("&tool_version=1.0");
        expect(form).toMatchObject({ id: TOOL_ID.replace(/1\.1$/, "1.0"), version: "1.0" });
    });
});

describe("POST /api/tools/{tool_id}/build", () => {
    it("rebuilds the form for changed values, following conditionals and data references", async () => {
        const form = await build();
        const inputs = formDataFromModel(form.inputs);
        const tables = await hdas.createWithDataset(
            { history_id: fixture.historyId, name: "wide.tsv", extension: "tabular", metadata: { columns: 5 } },
            { state: "ok", file_size: 10 },
        );
        const refreshed = await refresh({
            ...inputs,
            input: { values: [{ id: tables.hda.id, src: "hda" }], batch: false },
            "options|kind": "advanced",
            "options|level": "7",
            "reference|use_ref": "true",
        });
        expect(refreshed.errors).toEqual({});
        expect(input(refreshed, "input").value).toEqual({ values: [{ id: tables.hda.id, src: "hda" }] });
        expect(input(refreshed, "column").options).toHaveLength(5);
        expect(input(refreshed, "options|level").value).toBe("7");
        expect(input(refreshed, "reference|ref").value).toEqual({ values: [{ id: fixture.fasta.id, src: "hda" }] });
        expect(refreshed.state_inputs.options).toEqual({ kind: "advanced", __current_case__: 1, level: "7", note: "" });
    });

    it("reports invalid values in Galaxy's error format", async () => {
        const form = await build();
        const refreshed = await refresh({
            ...formDataFromModel(form.inputs),
            threads: "many",
            ratio: "x",
            mode: "turbo",
            title: "1st",
            column: "9",
            "queries_0|q": "y",
        });
        expect(refreshed.errors).toEqual({
            threads: "Parameter 'threads': the attribute 'value' must be set for non optional parameters",
            ratio: "Parameter 'ratio': the attribute 'value' must be set for non optional parameters",
            mode: "Parameter 'mode': an invalid option ('turbo') was selected (valid options: fast,slow)",
            title: "Parameter 'title': Must start with a letter",
            column: "Parameter 'column': an invalid option ('9') was selected (valid options: 1,2,3)",
        });
        const range = await refresh({ ...formDataFromModel(form.inputs), threads: 100 });
        expect(range.errors).toEqual({ threads: "Parameter 'threads': Value ('100') must fulfill (1 <= value <= 64)" });
    });

    it("adds and removes repeat instances within the repeat's bounds", async () => {
        const form = await build();
        const inputs = formDataFromModel(form.inputs);
        const refreshed = await refresh({
            ...inputs,
            "queries_1|q": "second",
            "queries_2|q": "third",
            "queries_3|q": "dropped",
        });
        const queries = refreshed.inputs.find((node: Model) => node.name === "queries");
        expect(queries.cache.map((instance: Model[]) => instance[0]!.value)).toEqual(["x", "second", "third"]);
        expect(refreshed.state_inputs.queries).toHaveLength(3);
    });

    it("accepts any column while the referenced dataset is not ready", async () => {
        await datasets.update(fixture.table.dataset_id, { state: "running" });
        await hdas.update(fixture.table.id, { metadata: {} });
        const form = await build();
        expect(input(form, "column")).toMatchObject({ options: [], textable: true });
        const refreshed = await refresh({ ...formDataFromModel(form.inputs), column: "4" });
        expect(refreshed.errors).toEqual({});
        expect(input(refreshed, "column").value).toBe("4");
    });

    it("paginates and searches data options", async () => {
        for (const name of ["one.tsv", "two.tsv", "three.tsv"]) {
            await hdas.createWithDataset(
                { history_id: fixture.historyId, name, extension: "tabular" },
                { state: "ok", file_size: 1 },
            );
        }
        const form = await build();
        const inputs = formDataFromModel(form.inputs);
        const page = await refresh(inputs, { options_pagination: { input: { hda: { offset: 1, limit: 2 } } } });
        const data = input(page, "input");
        expect(data.options.hda.map((option: Model) => option.name)).toEqual(["two.tsv", "one.tsv"]);
        expect(data.options_meta.hda).toEqual({ offset: 1, limit: 2, total_estimate: 4, has_more: true });
        const search = await refresh(inputs, { options_pagination: { input: { hda: { search: "THREE" } } } });
        expect(input(search, "input").options.hda.map((option: Model) => option.name)).toEqual(["three.tsv"]);
    });

    it("keeps selected datasets that are hidden, deleted or outside the page", async () => {
        const hidden = await hdas.createWithDataset(
            { history_id: fixture.historyId, name: "hidden.tsv", extension: "tabular", visible: false },
            { state: "ok", file_size: 1 },
        );
        const form = await build();
        const inputs = formDataFromModel(form.inputs);
        const refreshed = await refresh(
            { ...inputs, input: { values: [{ id: hidden.hda.id, src: "hda" }], batch: false } },
            { options_pagination: { input: { hda: { limit: 1, offset: 5 } } } },
        );
        const data = input(refreshed, "input");
        expect(data.options.hda).toEqual([
            { id: hidden.hda.id, hid: hidden.hda.hid, name: "(hidden) hidden.tsv", tags: [], src: "hda", keep: true },
        ]);
        const table = await refresh(
            { ...inputs, input: { values: [{ id: fixture.table.id, src: "hda" }], batch: false } },
            { options_pagination: { input: { hda: { limit: 1, offset: 5 } } } },
        );
        expect(input(table, "input").pinned.hda).toEqual([
            {
                id: fixture.table.id,
                hid: fixture.table.hid,
                name: "table.tsv",
                tags: ["name:sample"],
                src: "hda",
                keep: true,
            },
        ]);
    });

    it("rejects deleted and unusable datasets", async () => {
        const form = await build();
        await hdas.update(fixture.table.id, { deleted: true });
        const refreshed = await refresh(formDataFromModel(form.inputs));
        expect(refreshed.errors.input).toBe("Parameter 'input': the previously selected dataset has been deleted.");
        const missing = await refresh({
            ...formDataFromModel(form.inputs),
            input: { values: [{ id: "0123456789abcdef", src: "hda" }] },
        });
        expect(missing.errors.input).toBe("Invalid input id passed to job submission API.");
    });
});

describe("tool definitions Galaxy computes in Python", () => {
    it("lists upload formats and resolves a conditional whose cases come from the datatypes", async () => {
        const bundle = kitchenSinkBundle();
        bundle.inputs = [
            param("select", "file_type", {
                is_dynamic: true,
                options: {
                    from_dataset: null,
                    from_file: null,
                    from_data_table: null,
                    from_parameter: "tool.app.datatypes_registry.upload_file_formats",
                    from_url: null,
                    transform_lines: '[ "%s%s%s" % ( line, self.separator, line ) for line in obj ]',
                    meta_file_key: null,
                    options_filter_attribute: null,
                    separator: "\t",
                    startswith: null,
                    columns: { value: 1, name: 0 },
                    filters: [
                        { type: "sort_by", column: "0" },
                        { type: "add_value", name: "Auto-detect", value: "auto", index: "0" },
                    ],
                    validators: [],
                },
            }),
            {
                model_class: "Conditional",
                type: "conditional",
                name: "files_metadata",
                value_ref: "file_type",
                value_ref_in_group: false,
                value_from: "self:app.datatypes_registry.get_upload_metadata_params",
                test_param: null,
                cases: [],
            },
        ];
        bundle.outputs = [];
        resetStaticData();
        stubData(toolboxFiles([bundle]), false);
        const form = await build();
        expect(form.errors).toEqual({});
        expect(input(form, "file_type").options).toEqual([
            ["Auto-detect", "auto", false],
            ["tabular", "tabular", false],
            ["txt", "txt", false],
        ]);
        const metadata = form.inputs[1];
        expect(metadata.test_param).toMatchObject({ name: "file_type", value: "auto" });
        expect(metadata.cases).toEqual([{ value: "auto", inputs: [] }]);
        const refreshed = await refresh({ file_type: "txt" });
        expect(refreshed.state_inputs).toEqual({
            file_type: "txt",
            files_metadata: { file_type: "txt", __current_case__: 0 },
        });
    });

    it("warns about options read from datasets, files, web services or Python code", async () => {
        const bundle = kitchenSinkBundle();
        bundle.inputs = [
            param("data", "input", { extensions: ["tabular"] }),
            param("select", "from_dataset", {
                optional: true,
                is_dynamic: true,
                options: {
                    from_dataset: "input",
                    from_file: null,
                    from_data_table: null,
                    from_parameter: null,
                    from_url: null,
                    transform_lines: null,
                    meta_file_key: null,
                    options_filter_attribute: null,
                    separator: "\t",
                    startswith: null,
                    columns: { value: 0 },
                    filters: [],
                    validators: [],
                },
            }),
            param("select", "from_code", { optional: true, is_dynamic: true, dynamic_options: "load(input)" }),
        ];
        bundle.outputs = [];
        resetStaticData();
        stubData(toolboxFiles([bundle]), false);
        const form = await build();
        expect(form.errors).toEqual({});
        expect(form.warnings).toEqual({
            from_dataset:
                "Planet cannot list the options of this parameter yet: they come from the content of a dataset.",
            from_code: "Planet cannot list the options of this parameter yet: they come from Python code.",
        });
        expect(input(form, "from_dataset")).toMatchObject({ options: [], is_dynamic: true });
    });

    it("shows Markdown help as written and rst help without a rendering as text", async () => {
        const markdown = kitchenSinkBundle();
        markdown.help = { format: "markdown", content: "# Title\n${static_path}", html: null, rendered: true };
        resetStaticData();
        stubData(toolboxFiles([markdown]), false);
        expect(await build()).toMatchObject({ help: "# Title\n${static_path}", help_format: "markdown" });
        const raw = kitchenSinkBundle();
        raw.help = { format: "restructuredtext", content: "<b>a</b>", html: null, rendered: false };
        resetStaticData();
        stubData(toolboxFiles([raw]), false);
        expect(await build()).toMatchObject({
            help: "<pre>&lt;b&gt;a&lt;/b&gt;</pre>",
            help_format: "restructuredtext",
        });
    });

    it("never reads bundles outside the toolbox", async () => {
        const router = makeToolRouter();
        for (const id of ["..%2Fconfig", "a/../../config", "a/./b", "bad id"]) {
            const response = await fetchJson(router, "GET", `/api/tools/${id}/build?tool_version=..`, undefined, 404);
            expect(response.err_code).toBe(404001);
        }
    });
});
