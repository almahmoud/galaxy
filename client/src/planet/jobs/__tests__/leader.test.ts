// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobs, leader, leaderFence, LeaderFenceError } from "@/planet/db";

import { LeaderElection, STALE_MS } from "../leader";
import { Bus, FakeLocks, resetDb, seedHistory, seedJob, waitFor } from "./fakes";

interface Tab {
    election: LeaderElection;
    visible: boolean;
    led: number[];
    demoted: number;
    fence: (number | null)[];
}

const elections: LeaderElection[] = [];

function tab(locks: FakeLocks, bus: Bus, name: string, clock: { now: number }, visible = true): Tab {
    const state: Tab = { visible, led: [], demoted: 0, fence: [], election: undefined as unknown as LeaderElection };
    state.election = new LeaderElection({
        locks,
        channel: bus.channel(),
        visible: () => state.visible,
        onLead: (epoch) => void state.led.push(epoch),
        onDemote: () => void (state.demoted += 1),
        now: () => clock.now,
        tabId: name,
        onError: (error) => {
            throw error;
        },
    });
    elections.push(state.election);
    return state;
}

/** Waits for a condition that depends on IndexedDB work, which takes longer when the whole suite runs. */
const UNTIL = { timeout: 5000, interval: 5 };

/** Lets IndexedDB transactions and lock grants run (fake-indexeddb completes requests on later macrotasks). */
async function settle(): Promise<void> {
    for (let round = 0; round < 30; round++) {
        await waitFor(1);
    }
}

beforeEach(resetDb);

afterEach(async () => {
    await Promise.all(elections.splice(0).map((election) => election.stop()));
    await resetDb();
});

describe("leader election", () => {
    it("elects one tab, which claims an epoch, fences its writes and beats", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock);
        const b = tab(locks, bus, "b", clock);
        a.election.start();
        b.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);
        await settle();

        expect(a.election.isLeader).toBe(true);
        expect(b.election.isLeader).toBe(false);
        expect(a.led).toEqual([1]);
        expect(leaderFence()).toBe(1);
        expect(await leader.read()).toEqual({ epoch: 1, tab_id: "a", heartbeat: 1_000, visible: true });

        await a.election.stop();
        await vi.waitFor(() => expect(b.led).toEqual([2]), UNTIL);
        expect(a.demoted).toBe(1);
        expect(await leader.read()).toMatchObject({ epoch: 2, tab_id: "b" });
    });

    it("steals the lock from a leader whose heartbeat went stale", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock);
        const b = tab(locks, bus, "b", clock);
        a.election.start();
        await settle();
        b.election.start();
        await settle();

        clock.now += STALE_MS - 1;
        await b.election.checkLeader();
        await settle();
        expect(b.election.isLeader).toBe(false);

        clock.now += 2;
        await b.election.checkLeader();
        await settle();
        expect(b.election.isLeader).toBe(true);
        expect(b.led).toEqual([2]);
        expect(a.election.isLeader).toBe(false);
        expect(a.demoted).toBe(1);
        expect(await leader.currentEpoch()).toBe(2);
    });

    it("hands over from a hidden leader to a visible tab", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock, false);
        const b = tab(locks, bus, "b", clock, false);
        a.election.start();
        await settle();
        b.election.start();
        await settle();
        expect(a.election.isLeader).toBe(true);
        expect((await leader.read())?.visible).toBe(false);

        b.visible = true;
        b.election.visibilityChanged();
        await settle();
        expect(b.election.isLeader).toBe(true);
        expect(a.election.isLeader).toBe(false);
        expect(await leader.read()).toMatchObject({ tab_id: "b", visible: true });
    });

    it("keeps leading while visible when another tab asks", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock, true);
        const b = tab(locks, bus, "b", clock, true);
        a.election.start();
        b.election.start();
        await settle();
        bus.channel().postMessage({ type: "claim", tab: "b" });
        await settle();
        expect(a.election.isLeader).toBe(true);
        expect(b.election.isLeader).toBe(false);
    });

    it("steps down when its heartbeat finds a newer epoch, then queues again", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock);
        a.election.start();
        await settle();
        expect(a.election.epoch).toBe(1);

        await leader.claimEpoch();
        a.election.visibilityChanged();
        await settle();
        expect(a.demoted).toBe(1);
        expect(a.led).toEqual([1, 3]);
        expect(a.election.epoch).toBe(3);
    });

    it("fences off a demoted tab's job writes until it leads again", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock);
        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);
        await jobs.update(job.id, { info: "while leading" });

        // Stopping leaves the epoch in place; the fence must still refuse writes of a manager that keeps going.
        await a.election.stop();
        expect(a.demoted).toBe(1);
        expect(await leader.currentEpoch()).toBe(1);
        expect(leaderFence()).not.toBeNull();
        await expect(jobs.update(job.id, { info: "after demotion" })).rejects.toBeInstanceOf(LeaderFenceError);
        await expect(leader.assertCurrent()).rejects.toBeInstanceOf(LeaderFenceError);
        expect((await jobs.get(job.id))?.info).toBe("while leading");

        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1, 2]), UNTIL);
        expect(leaderFence()).toBe(2);
        await jobs.update(job.id, { info: "leading again" });
        expect((await jobs.get(job.id))?.info).toBe("leading again");
    });
});
