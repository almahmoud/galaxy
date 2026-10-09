// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { datasets, hdas, histories, jobs, kv } from "@/planet/db";

import { HISTORY_DEV_DETAILED_KEYS } from "../histories";
import {
    addDataset,
    addJob,
    captureEvents,
    currentHistoryId,
    fetchJson,
    flushEvents,
    keysOf,
    makeRouter,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";

beforeEach(resetPlanet);
afterEach(teardownPlanet);

describe("GET /history/current_history_json", () => {
    it("returns the current history in the dev-detailed view", async () => {
        const history = await fetchJson(makeRouter(), "GET", "/history/current_history_json");
        expect(keysOf(history)).toEqual([...HISTORY_DEV_DETAILED_KEYS].sort());
        expect(history.id).toBe(await histories.getCurrentId());
    });

    it("returns JSON null while update_time has not moved past since", async () => {
        const router = makeRouter();
        const history = await fetchJson(router, "GET", "/history/current_history_json");
        const unchanged = await send(router, "GET", `/history/current_history_json?since=${history.update_time}`);
        expect(unchanged.status).toBe(200);
        expect(await unchanged.text()).toBe("null");

        await addDataset(history.id);
        const changed = await fetchJson(router, "GET", `/history/current_history_json?since=${history.update_time}`);
        expect(changed.update_time > history.update_time).toBe(true);
        expect(changed.hid_counter).toBe(2);
        // The client's own clock form, with a Z suffix and milliseconds, is accepted too.
        const iso = new Date(Date.parse(`${changed.update_time}Z`) + 60_000).toISOString();
        expect(await (await send(router, "GET", `/history/current_history_json?since=${iso}`)).text()).toBe("null");
        expect((await send(router, "GET", "/history/current_history_json?since=yesterday")).status).toBe(400);
    });

    it("creates a history when the current one was purged", async () => {
        const purged = await currentHistoryId();
        await histories.markDeleted(purged, { purge: true });
        const history = await fetchJson(makeRouter(), "GET", "/history/current_history_json");
        expect(history.id).not.toBe(purged);
        expect(await kv.get("current_history_id")).toBe(history.id);
    });
});

describe("set_as_current and create_new_current", () => {
    it("switches the current history", async () => {
        const router = makeRouter();
        const other = await histories.create({ name: "other" });
        const switched = await fetchJson(router, "GET", `/history/set_as_current?id=${other.id}`);
        expect(switched).toMatchObject({ id: other.id, name: "other" });
        expect(await histories.getCurrentId()).toBe(other.id);
        expect((await send(router, "GET", "/history/set_as_current?id=0123456789abcdef")).status).toBe(404);
        expect((await send(router, "GET", "/history/set_as_current")).status).toBe(400);
    });

    it("creates and selects a named history in one request", async () => {
        const router = makeRouter();
        const { events, stop } = captureEvents();
        const created = await fetchJson(router, "GET", "/history/create_new_current?name=Analysis%202");
        await flushEvents();
        stop();
        expect(created.name).toBe("Analysis 2");
        expect(await histories.getCurrentId()).toBe(created.id);
        expect(events).toContainEqual({ type: "current-history-changed", historyId: created.id });
        expect((await fetchJson(router, "GET", "/history/create_new_current")).name).toBe("Unnamed history");
    });
});

describe("resume_paused_jobs", () => {
    it("resumes paused jobs of the current history and their paused dependents", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const first = await addJob(historyId, { state: "paused" });
        const out = await addDataset(historyId, { creating_job_id: first.id, info: "paused" }, { state: "paused" });
        await jobs.update(first.id, { outputs: [{ name: "out", src: "hda", id: out.hda.id }] });
        const dependent = await addJob(historyId, {
            state: "paused",
            inputs: [{ name: "input", src: "hda", id: out.hda.id }],
        });
        const finished = await addJob(historyId, { state: "ok" });

        const { events, stop } = captureEvents();
        const result = await fetchJson(router, "GET", "/history/resume_paused_jobs?current=True");
        await flushEvents();
        stop();
        expect(result).toEqual({ message: "Your jobs have been resumed.", status: "success" });
        expect((await jobs.getOrThrow(first.id)).state).toBe("new");
        expect((await jobs.getOrThrow(dependent.id)).state).toBe("new");
        expect((await jobs.getOrThrow(finished.id)).state).toBe("ok");
        expect((await datasets.getOrThrow(out.dataset.id)).state).toBe("new");
        expect((await hdas.getOrThrow(out.hda.id)).info).toBeNull();
        expect(events).toContainEqual({ type: "job-created", jobId: first.id });
        expect(events).toContainEqual({ type: "job-created", jobId: dependent.id });
        expect(events).not.toContainEqual({ type: "job-created", jobId: finished.id });
    });

    it("only resumes the whole current history", async () => {
        const response = await send(makeRouter(), "POST", "/history/resume_paused_jobs?ids=abc");
        expect(response.status).toBe(400);
        expect((await response.json()).err_msg).toMatch(/current history/);
    });
});
