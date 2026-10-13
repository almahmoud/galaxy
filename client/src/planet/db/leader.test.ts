// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    closeDb,
    histories,
    JOB_STORES,
    jobs,
    leader,
    LeaderFenceError,
    outbox,
    setLeaderFence,
    settings,
    withTransaction,
} from ".";

beforeEach(async () => {
    await closeDb();
    setLeaderFence(null);
    globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
    setLeaderFence(null);
    await closeDb();
    vi.restoreAllMocks();
});

describe("leader epoch and heartbeat", () => {
    it("claims increasing epochs and accepts heartbeats of the current one only", async () => {
        expect(await leader.currentEpoch()).toBe(0);
        expect(await leader.claimEpoch()).toBe(1);
        const beat = { epoch: 1, tab_id: "t1", heartbeat: 5, visible: true };
        expect(await leader.heartbeat(beat)).toBe(true);
        expect(await leader.read()).toEqual(beat);

        expect(await leader.claimEpoch()).toBe(2);
        expect(await leader.heartbeat({ ...beat, heartbeat: 6 })).toBe(false);
        expect(await leader.read()).toEqual(beat);
        await leader.resign(1);
        expect(await leader.read()).toBeUndefined();
    });
});

describe("leader fence", () => {
    it("aborts job writes in a fenced context once another tab claimed a newer epoch", async () => {
        const job = await jobs.create({ tool_id: "cat1", tool_version: "1" });
        const epoch = await leader.claimEpoch();
        setLeaderFence(epoch);
        await jobs.update(job.id, { info: "fenced write" });
        await expect(leader.assertCurrent()).resolves.toBeUndefined();

        await leader.claimEpoch();
        await expect(jobs.update(job.id, { info: "stale write" })).rejects.toBeInstanceOf(LeaderFenceError);
        await expect(
            withTransaction(JOB_STORES, "readwrite", (t) => jobs.update(job.id, { state: "error" }, t)),
        ).rejects.toThrow(/no longer leads/);
        await expect(leader.assertCurrent()).rejects.toBeInstanceOf(LeaderFenceError);
        expect((await jobs.get(job.id))?.info).toBe("fenced write");

        // Writes that do not touch jobs, and unfenced contexts, are not affected.
        await histories.create({ name: "still fine" });
        setLeaderFence(null);
        await jobs.update(job.id, { info: "service worker write" });
        expect((await jobs.get(job.id))?.info).toBe("service worker write");
    });
});

describe("outbox and console helpers", () => {
    it("postpones entries without counting attempts and removes a job's entries by kind", async () => {
        const dispatch = await outbox.enqueue({ kind: "dispatch", job_id: "j1" });
        await outbox.enqueue({ kind: "cancel", job_id: "j1" });
        const postponed = await outbox.postpone(dispatch.id, "2999-01-01T00:00:00.000000");
        expect(postponed).toMatchObject({ attempts: 0, last_error: null, not_before: "2999-01-01T00:00:00.000000" });
        expect(await outbox.postpone("missing", "2999-01-01T00:00:00.000000")).toBeUndefined();
        await outbox.removeForJob("j1", "dispatch");
        expect((await outbox.listForJob("j1")).map((entry) => entry.kind)).toEqual(["cancel"]);
    });

    it("records console requests", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1234);
        expect(await jobs.consoleRequestedAt("j1")).toBeNull();
        await jobs.requestConsole("j1");
        expect(await jobs.consoleRequestedAt("j1")).toBe(1234);
        await jobs.clearConsoleRequest("j1");
        expect(await jobs.consoleRequestedAt("j1")).toBeNull();
    });

    it("tells whether cluster and storage settings are complete", async () => {
        expect(settings.configured(await settings.get())).toEqual({ cluster: false, storage: false });
        const updated = await settings.update({
            cluster: { gateway_url: "https://k8s.example.org", token: "t" },
            storage: { endpoint: "https://s3.example.org", bucket: "b", access_key_id: "k", secret_access_key: "s" },
        });
        expect(settings.configured(updated)).toEqual({ cluster: true, storage: true });
    });
});
