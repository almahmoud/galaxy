// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobs, leader } from "@/planet/db";

import { LeaderStatus } from "../status";
import { resetDb, seedHistory, seedJob } from "./fakes";

beforeEach(resetDb);
afterEach(resetDb);

describe("leader status record", () => {
    it("reports counts, idle and active states, blocking reasons and the last error", async () => {
        const epoch = await leader.claimEpoch();
        const status = new LeaderStatus(epoch, "tab-a", () => 5_000);
        expect(await status.write()).toBe(true);
        expect(await leader.readStatus()).toEqual({
            epoch,
            tab_id: "tab-a",
            heartbeat: 5_000,
            state: "idle",
            blocked_reason: null,
            last_error: null,
            counts: { queued: 0, running: 0 },
        });

        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id], { enqueue: false });
        await jobs.update(job.id, { state: "running" });
        await status.recordError(new Error("The gateway is unavailable"), job.id);
        expect(await leader.readStatus()).toMatchObject({
            state: "active",
            counts: { queued: 0, running: 1 },
            last_error: { message: "The gateway is unavailable", job_id: job.id, time: 5_000 },
        });

        await status.setClusterProblem("The cluster could not be listed: Failed to fetch");
        expect(await leader.readStatus()).toMatchObject({
            state: "blocked",
            blocked_reason: "The cluster could not be listed: Failed to fetch",
        });
        await status.setClusterProblem(null);
        await status.setBlocked("The cluster settings are incomplete.");
        expect(await leader.readStatus()).toMatchObject({
            state: "blocked",
            blocked_reason: "The cluster settings are incomplete.",
        });
    });

    it("writes nothing once another tab claimed a newer epoch", async () => {
        const epoch = await leader.claimEpoch();
        const stale = new LeaderStatus(epoch, "tab-a", () => 5_000);
        await leader.claimEpoch();
        expect(await stale.setBlocked("The storage settings are incomplete.")).toBe(false);
        expect(await leader.readStatus()).toBeUndefined();
    });
});
