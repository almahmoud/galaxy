// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { components } from "@/api/schema";
import { datasets, hdas, jobs } from "@/planet/db";
import { Router } from "@/planet/sw/router";

import { register } from "../jobs";
import { PLANET_USER_ID } from "../users";
import {
    addDataset,
    addJob,
    addList,
    captureEvents,
    currentHistoryId,
    fetchJson,
    flushEvents,
    keysOf,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";

type ShowFullJobResponse = components["schemas"]["ShowFullJobResponse"];

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

beforeEach(resetPlanet);
afterEach(teardownPlanet);

async function jobWithData() {
    const historyId = await currentHistoryId();
    const input = await addDataset(historyId, { name: "reads" }, { file_size: 0, total_size: 0 });
    const output = await addDataset(historyId, { name: "result" }, { state: "running" });
    const job = await addJob(historyId, {
        tool_id: "toolshed.example.org/repos/iuc/cat/cat1/1.0",
        state: "running",
        params: { input1: { values: [{ src: "hda", id: input.hda.id }] }, "cond|mode": "fast", "cond|level": 3 },
        inputs: [
            { name: "input1", src: "hda", id: input.hda.id },
            { name: "queries_0|input2", src: "hda", id: input.hda.id },
        ],
        outputs: [{ name: "out_file1", src: "hda", id: output.hda.id }],
        command_line: "cat input > output",
        tool_stdout: "line one\nline two\n",
        tool_stderr: "warning\n",
        job_stdout: "staged",
        job_stderr: null,
        metrics: [{ plugin: "core", name: "runtime_seconds", title: "Job Runtime", value: "1 s", raw_value: "1" }],
    });
    await hdas.update(output.hda.id, { creating_job_id: job.id });
    return { historyId, input, output, job };
}

describe("GET /api/jobs/{job_id}", () => {
    it("serializes the element view and, with full, the streams", async () => {
        const { job, input, output, historyId } = await jobWithData();
        const router = makeRouter();
        const details = await fetchJson(router, "GET", `/api/jobs/${job.id}`);
        expect(details).toMatchObject({
            model_class: "Job",
            id: job.id,
            state: "running",
            history_id: historyId,
            user_id: PLANET_USER_ID,
            command_line: "cat input > output",
            params: { "cond|mode": "fast", "cond|level": 3 },
            inputs: {
                input1: { id: input.hda.id, src: "hda", uuid: input.dataset.uuid },
                "queries_0|input2": { id: input.hda.id, src: "hda", uuid: input.dataset.uuid },
            },
            outputs: { out_file1: { id: output.hda.id, src: "hda", uuid: output.dataset.uuid } },
            output_collections: {},
        });
        expect(details.tool_stdout).toBeUndefined();

        const full: ShowFullJobResponse = await fetchJson(router, "GET", `/api/jobs/${job.id}?full=True`);
        expect(full).toMatchObject({
            tool_stdout: "line one\nline two\n",
            tool_stderr: "warning\n",
            job_stdout: "staged",
            job_stderr: null,
            stdout: "line one\nline two\n\nstaged",
            stderr: "warning\n",
            job_messages: [],
            dependencies: [],
        });
        expect((await fetchJson(router, "GET", "/api/jobs/missing", undefined, 404)).err_code).toBe(404001);
    });

    it("lists the job's inputs, outputs, metrics and parameters", async () => {
        const { job, input, output, historyId } = await jobWithData();
        const router = makeRouter();
        expect(await fetchJson(router, "GET", `/api/jobs/${job.id}/inputs`)).toEqual([
            { name: "input1", dataset: { src: "hda", id: input.hda.id } },
            { name: "queries_0|input2", dataset: { src: "hda", id: input.hda.id } },
        ]);
        const list = await addList(historyId, [output.hda.id]);
        await jobs.update(job.id, { output_collections: [{ name: "list_out", src: "hdca", id: list.id }] });
        expect(await fetchJson(router, "GET", `/api/jobs/${job.id}/outputs`)).toEqual([
            { name: "out_file1", dataset: { src: "hda", id: output.hda.id } },
            { name: "list_out", dataset_collection_instance: { src: "hdca", id: list.id } },
        ]);
        expect(await fetchJson(router, "GET", `/api/jobs/${job.id}/metrics`)).toEqual(job.metrics);
        // The job's tool is not in the toolbox: Galaxy lists no parameters and reports parameter errors.
        expect(await fetchJson(router, "GET", `/api/jobs/${job.id}/parameters_display`)).toEqual({
            parameters: [],
            has_parameter_errors: true,
            outputs: {
                out_file1: [{ label: null, value: { src: "hda", id: output.hda.id } }],
                list_out: [{ label: null, value: { src: "hdca", id: list.id } }],
            },
        });
    });

    it("lists the stored parameters of Planet's internal tools", async () => {
        const { job, input, output } = await jobWithData();
        await jobs.update(job.id, { tool_id: "__SET_METADATA__" });
        const parameters = await fetchJson(makeRouter(), "GET", `/api/jobs/${job.id}/parameters_display`);
        expect(parameters).toEqual({
            parameters: [
                { text: "cond", depth: 1 },
                { text: "mode", depth: 2, value: "fast" },
                { text: "level", depth: 2, value: 3 },
                {
                    text: "input1",
                    depth: 1,
                    value: [{ src: "hda", id: input.hda.id, hid: input.hda.hid, name: "reads" }],
                },
                {
                    text: "input2",
                    depth: 2,
                    value: [{ src: "hda", id: input.hda.id, hid: input.hda.hid, name: "reads" }],
                },
            ],
            has_parameter_errors: false,
            outputs: { out_file1: [{ label: null, value: { src: "hda", id: output.hda.id } }] },
        });
    });

    it("reports common problems with the inputs", async () => {
        const { job } = await jobWithData();
        expect(await fetchJson(makeRouter(), "GET", `/api/jobs/${job.id}/common_problems`)).toEqual({
            has_empty_inputs: true,
            has_duplicate_inputs: true,
        });
    });

    it("returns console output slices while running and the stored streams afterwards", async () => {
        const { job } = await jobWithData();
        const router = makeRouter();
        const path = `/api/jobs/${job.id}/console_output?stdout_position=5&stdout_length=3&stderr_position=0&stderr_length=100`;
        expect(await jobs.consoleRequestedAt(job.id)).toBeNull();
        expect(await fetchJson(router, "GET", path)).toEqual({ state: "running", stdout: "one", stderr: "warning\n" });
        expect(await jobs.consoleRequestedAt(job.id)).toEqual(expect.any(Number));
        await jobs.clearConsoleRequest(job.id);
        await jobs.update(job.id, { state: "ok" });
        expect(await fetchJson(router, "GET", path)).toEqual({
            state: "ok",
            stdout: "line one\nline two\n",
            stderr: "warning\n",
        });
        expect(await jobs.consoleRequestedAt(job.id)).toBeNull();
    });

    it("refuses admin-only views and reruns of unknown tools", async () => {
        const { job } = await jobWithData();
        const router = makeRouter();
        expect(
            (await fetchJson(router, "GET", `/api/jobs/${job.id}/destination_params`, undefined, 403)).err_code,
        ).toBe(403006);
        expect((await fetchJson(router, "GET", `/api/jobs/${job.id}/build_for_rerun`, undefined, 404)).err_msg).toBe(
            "Requested tool not found",
        );
        expect((await fetchJson(router, "GET", "/api/jobs/missing/build_for_rerun", undefined, 404)).err_code).toBe(
            404001,
        );
    });
});

describe("DELETE /api/jobs/{job_id}", () => {
    it("marks the job deleting, discards its outputs and announces the change", async () => {
        const { job, output } = await jobWithData();
        const router = makeRouter();
        const copy = await hdas.copy(output.hda.id, output.hda.history_id);
        const { events, stop } = captureEvents();
        expect(await fetchJson(router, "DELETE", `/api/jobs/${job.id}`, { message: "Stopped by me" })).toBe(true);
        await flushEvents();
        stop();
        expect(await jobs.get(job.id)).toMatchObject({ state: "deleting", info: "Stopped by me" });
        expect((await datasets.get(output.dataset.id))!.state).toBe("discarded");
        for (const id of [output.hda.id, copy.id]) {
            expect(await hdas.get(id)).toMatchObject({ deleted: true, blurb: "deleted", peek: "Job deleted" });
        }
        expect(events).toContainEqual({ type: "job-changed", jobId: job.id, state: "deleting" });
        expect(await fetchJson(router, "DELETE", `/api/jobs/${job.id}`)).toBe(false);
    });
});

describe("GET /api/jobs", () => {
    it("filters, orders and paginates jobs like JobManager.index_query", async () => {
        const historyId = await currentHistoryId();
        const first = await addJob(historyId, { tool_id: "cat1", state: "ok" });
        const second = await addJob(historyId, { tool_id: "sort1", state: "error" });
        const third = await addJob(historyId, {
            tool_id: "toolshed.example.org/repos/iuc/cat/cat1/1.0",
            state: "running",
            implicit_collection_jobs_id: "icj1",
        });
        await jobs.update(first.id, { info: "touched" });
        const router = makeRouter();
        const ids = async (query: string) =>
            (await fetchJson(router, "GET", `/api/jobs${query}`)).map((job: { id: string }) => job.id);

        expect(await ids("")).toEqual([first.id, third.id, second.id]);
        expect(await ids("?order_by=create_time")).toEqual([third.id, second.id, first.id]);
        expect(await ids("?state=ok&state=error")).toEqual([first.id, second.id]);
        expect(await ids("?state=ok,running")).toEqual([first.id, third.id]);
        expect(await ids("?tool_id=sort1")).toEqual([second.id]);
        expect(await ids("?tool_id_like=%25cat%25")).toEqual([first.id, third.id]);
        expect(await ids("?search=tool:sort")).toEqual([second.id]);
        expect(await ids("?search=cat")).toEqual([first.id, third.id]);
        expect(await ids("?implicit_collection_jobs_id=icj1")).toEqual([third.id]);
        expect(await ids(`?history_id=${historyId}&limit=1&offset=1`)).toEqual([third.id]);
        expect(await ids("?history_id=other")).toEqual([]);
        expect(await ids(`?date_range_min=${encodeURIComponent("2999-01-01")}`)).toEqual([]);

        const summary = (await fetchJson(router, "GET", "/api/jobs?limit=1"))[0];
        expect(keysOf(summary)).toEqual(
            [
                "command_line",
                "create_time",
                "exit_code",
                "external_id",
                "galaxy_version",
                "handler",
                "history_id",
                "id",
                "job_runner_name",
                "model_class",
                "state",
                "tool_id",
                "update_time",
                "user_email",
                "user_id",
            ].sort(),
        );
        const element = (await fetchJson(router, "GET", "/api/jobs?view=element&limit=1"))[0];
        expect(element).toHaveProperty("params");
    });

    it("refuses admin-only listings", async () => {
        const router = makeRouter();
        for (const query of ["view=admin_job_list", "user_details=true", "user_id=someone"]) {
            const response = await send(router, "GET", `/api/jobs?${query}`);
            expect(response.status).toBe(403);
        }
        expect((await send(router, "GET", "/api/jobs?order_by=name")).status).toBe(400);
    });
});
