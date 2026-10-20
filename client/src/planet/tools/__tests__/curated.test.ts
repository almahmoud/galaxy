// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fetchJson, resetPlanet, send, teardownPlanet } from "../../api/__tests__/contents.fixtures";
import type { ToolBundle } from "../bundle";
import { isCollectionOperation } from "../operations";
import {
    formDataFromModel,
    generatedBundlePaths,
    hasGeneratedData,
    type HistoryFixture,
    makeToolRouter,
    readGenerated,
    seedHistory,
    stubData,
    walkModel,
} from "./fixtures";

type Model = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const available = hasGeneratedData();

/**
 * Parameters the test history cannot satisfy with the form's defaults: Planet has no reference indexes (Galaxy with
 * empty `.loc` files rejects the same defaults), and one tool's default column (`0`) is not a column.
 */
const UNSATISFIED: Record<string, string[]> = {
    bowtie2: ["reference_genome|index"],
    bwa_mem2: ["reference_source|ref_file"],
    minimap2: ["reference_source|ref_file"],
    column_order_header_sort: ["key_column"],
};

/**
 * Inputs set instead of the form's defaults. Galaxy's initial collection is the newest one whose datasets match,
 * whatever its type, and the test history's newest collection is a list.
 */
const OVERRIDES: Record<string, (fixture: HistoryFixture) => Record<string, unknown>> = {
    __UNZIP_COLLECTION__: (fixture) => ({
        input: { values: [{ id: fixture.readsPair.id, src: "hdca" }], batch: false },
    }),
};

beforeEach(async () => {
    await resetPlanet();
    stubData();
});
afterEach(teardownPlanet);

describe.skipIf(!available)("curated tool bundles", () => {
    const paths = available ? generatedBundlePaths() : [];

    it("covers the curated toolbox", () => {
        expect(paths.length).toBeGreaterThanOrEqual(20);
    });

    it.each(paths)("builds, refreshes, runs, summarizes and reruns %s", async (path) => {
        const bundle = readGenerated<ToolBundle>(path);
        const fixture = await seedHistory();
        const router = makeToolRouter();
        const query = `tool_version=${encodeURIComponent(bundle.version)}&history_id=${fixture.historyId}`;
        const form = await fetchJson<Model>(router, "GET", `/api/tools/${bundle.id}/build?${query}`);
        expect(form).toMatchObject({ id: bundle.id, version: bundle.version, history_id: fixture.historyId });
        expect(form.inputs).toHaveLength(bundle.inputs.length);
        walkModel(form.inputs, (node, name) => {
            expect(typeof node.name, name).toBe("string");
            expect(typeof node.type, name).toBe("string");
            if (node.type === "conditional") {
                expect(node.test_param, name).toBeTruthy();
                expect(Array.isArray(node.cases), name).toBe(true);
            }
            if (node.type === "data" || node.type === "data_collection") {
                expect(Array.isArray((node.options as Model).hdca), name).toBe(true);
                expect(node.options_meta, name).toBeTruthy();
            }
        });
        expect(Object.values(form.errors).every((message) => typeof message === "string")).toBe(true);

        const inputs = { ...formDataFromModel(form.inputs), ...OVERRIDES[bundle.old_id]?.(fixture) };
        const refreshed = await fetchJson<Model>(router, "POST", `/api/tools/${bundle.id}/build`, {
            tool_id: bundle.id,
            tool_version: bundle.version,
            history_id: fixture.historyId,
            inputs,
        });
        expect(refreshed.inputs).toHaveLength(bundle.inputs.length);
        expect(refreshed.errors).toEqual(form.errors);

        const response = await send(router, "POST", "/api/tools", {
            tool_id: bundle.id,
            tool_version: bundle.version,
            history_id: fixture.historyId,
            inputs,
        });
        const body = await response.json();
        if (bundle.id === "upload1") {
            expect(response.status).toBe(400);
            expect(body.err_msg).toContain("/api/tools/fetch");
            return;
        }
        const unsatisfied = UNSATISFIED[bundle.old_id];
        if (unsatisfied) {
            expect(response.status).toBe(400);
            expect(Object.keys(body.err_data)).toEqual(unsatisfied);
            return;
        }
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.jobs).toHaveLength(1);
        // Collection operations run in the Service Worker; their dataset outputs are copies of the inputs.
        const created = isCollectionOperation({ tool: bundle })
            ? { state: "ok" }
            : { state: "new", misc_blurb: "queued" };
        for (const output of body.outputs) {
            expect(output).toMatchObject(created);
            expect(typeof output.hid).toBe("number");
            expect(output.name).toBeTruthy();
            expect(output.file_ext).toBeTruthy();
        }
        const jobId = body.jobs[0].id;
        const summary = await fetchJson<Model>(router, "GET", `/api/jobs/${jobId}/parameters_display`);
        expect(summary.has_parameter_errors).toBe(false);
        expect(summary.parameters.length).toBeGreaterThan(0);
        const rerun = await fetchJson<Model>(router, "GET", `/api/jobs/${jobId}/build_for_rerun`);
        expect(rerun).toMatchObject({ job_id: jobId, errors: {} });
        expect(rerun.warnings).toEqual({});
        expect(rerun.state_inputs).toEqual(refreshed.state_inputs);
    });
});
