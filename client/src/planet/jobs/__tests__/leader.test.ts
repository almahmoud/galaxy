// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jobs, kv, leader, leaderFence, LeaderFenceError, LeaderProtocolError } from "@/planet/db";

import { LEADER_PROTOCOL, LeaderElection, STALE_MS, STOP_WAIT_MS } from "../leader";
import { Bus, FakeLocks, resetDb, seedHistory, seedJob, waitFor } from "./fakes";

interface Tab {
    election: LeaderElection;
    visible: boolean;
    led: number[];
    demoted: number;
    fence: (number | null)[];
    outdated: LeaderProtocolError[];
    /** What `onDemote` returns: the time job processing takes to stop. */
    stopping?: Promise<void>;
}

interface TabOptions {
    visible?: boolean;
    protocol?: number;
    stopWaitMs?: number;
}

const elections: LeaderElection[] = [];

function tab(
    locks: FakeLocks,
    bus: Bus,
    name: string,
    clock: { now: number },
    options: TabOptions | boolean = {},
): Tab {
    const { visible = true, protocol, stopWaitMs } = typeof options === "boolean" ? { visible: options } : options;
    const state: Tab = {
        visible,
        led: [],
        demoted: 0,
        fence: [],
        outdated: [],
        election: undefined as unknown as LeaderElection,
    };
    state.election = new LeaderElection({
        locks,
        channel: bus.channel(),
        visible: () => state.visible,
        onLead: (epoch) => {
            state.led.push(epoch);
            state.fence.push(leaderFence());
        },
        onDemote: () => {
            state.demoted += 1;
            return state.stopping;
        },
        onOutdated: (error) => void state.outdated.push(error),
        protocol,
        stopWaitMs,
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
        expect(await leader.read()).toEqual({
            epoch: 1,
            tab_id: "a",
            heartbeat: 1_000,
            visible: true,
            protocol: LEADER_PROTOCOL,
        });
        expect(await kv.get("leader_protocol")).toBe(LEADER_PROTOCOL);

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
    it("hands over only to tabs of the same or a newer leader protocol version", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock, { visible: false, protocol: 2 });
        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);
        await settle();

        // A tab of a build from before versions sends claims without one.
        bus.channel().postMessage({ type: "claim", tab: "old" });
        bus.channel().postMessage({ type: "claim", tab: "older", protocol: 1 });
        const answers: unknown[] = [];
        const listener = bus.channel();
        listener.addEventListener("message", (event) => answers.push(event.data));
        await settle();
        expect(answers).toEqual([]);

        const b = tab(locks, bus, "b", clock, { visible: true, protocol: 2 });
        b.election.start();
        await settle();
        await b.election.checkLeader();
        await vi.waitFor(() => expect(b.led).toEqual([2]), UNTIL);
        expect(a.election.isLeader).toBe(false);
        expect(answers).toContainEqual({ type: "handover", to: "b", epoch: 1, protocol: 2 });
    });

    it("takes the lock from a leader of an older version at once, and never from one of a newer version", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        // A leader of a build from before versions: a fresh heartbeat without a version.
        await leader.claimEpoch();
        await leader.heartbeat({ epoch: 1, tab_id: "old", heartbeat: clock.now, visible: true });
        const held = locks.request("planet:leader", {}, () => new Promise<void>(() => undefined));
        void held.catch(() => undefined);

        const b = tab(locks, bus, "b", clock, { protocol: 1 });
        b.election.start();
        await settle();
        expect(b.election.isLeader).toBe(false);
        await b.election.checkLeader();
        await vi.waitFor(() => expect(b.led).toEqual([2]), UNTIL);
        await expect(held).rejects.toThrow("stolen");

        // A tab of a newer version leads; the older one leaves it alone, even when its heartbeat goes stale.
        const c = tab(locks, bus, "c", clock, { protocol: 2 });
        c.election.start();
        await settle();
        await c.election.checkLeader();
        await vi.waitFor(() => expect(c.led).toEqual([3]), UNTIL);
        await settle();
        expect(b.election.isLeader).toBe(false);
        clock.now += STALE_MS + 1;
        await b.election.checkLeader();
        await settle();
        expect(c.election.isLeader).toBe(true);
        expect(b.election.isLeader).toBe(false);
    });

    it("stops taking part once a tab of a newer version led, and lets the lock go", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock, { protocol: 2 });
        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);
        await a.election.stop();

        const old = tab(locks, bus, "old", clock, { protocol: 1 });
        old.election.start();
        await vi.waitFor(() => expect(old.outdated).toHaveLength(1), UNTIL);
        expect(old.outdated[0]).toMatchObject({ protocol: 1, newest: 2 });
        expect(old.election.outdated).toBe(true);
        expect(old.election.isLeader).toBe(false);
        expect(old.led).toEqual([]);
        expect(await leader.currentEpoch()).toBe(1);
        await expect(leader.claimEpoch({ protocol: 1 })).rejects.toBeInstanceOf(LeaderProtocolError);

        // It asks for nothing more, so a tab of the newer version takes the lock without stealing it.
        old.election.visibilityChanged();
        await old.election.checkLeader();
        bus.channel().postMessage({ type: "handover", to: "old", epoch: 1, protocol: 2 });
        await settle();
        expect(locks.holder).toBeNull();
        const b = tab(locks, bus, "b", clock, { protocol: 2 });
        b.election.start();
        await vi.waitFor(() => expect(b.led).toEqual([2]), UNTIL);
        expect(old.led).toEqual([]);
    });

    it("leads again only once the job processing of its previous leadership stopped", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock);
        let stopped!: () => void;
        a.stopping = new Promise<void>((resolve) => (stopped = resolve));
        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);

        // Another tab claims an epoch; the heartbeat finds it, and the tab queues for the lock again at once.
        await leader.claimEpoch();
        a.election.visibilityChanged();
        await settle();
        expect(a.demoted).toBe(1);
        expect(a.led).toEqual([1]);
        expect(leaderFence()).toBe(-1);
        expect(await leader.currentEpoch()).toBe(2);

        stopped();
        await vi.waitFor(() => expect(a.led).toEqual([1, 3]), UNTIL);
        expect(a.fence).toEqual([1, 3]);
    });

    it("leaves the election at once while a lock grant waits for the previous leadership to stop", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock);
        a.stopping = new Promise<void>(() => undefined);
        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);
        await leader.claimEpoch();
        a.election.visibilityChanged();
        await vi.waitFor(() => expect(a.demoted).toBe(1), UNTIL);
        await settle();
        expect(locks.holder).not.toBeNull();

        const started = Date.now();
        await a.election.stop();
        expect(Date.now() - started).toBeLessThan(STOP_WAIT_MS / 10);
        await settle();
        expect(locks.holder).toBeNull();
        expect(a.led).toEqual([1]);
    });

    it("does not wait longer than STOP_WAIT_MS for job processing that never stops", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const clock = { now: 1_000 };
        const a = tab(locks, bus, "a", clock, { stopWaitMs: 200 });
        a.stopping = new Promise<void>(() => undefined);
        a.election.start();
        await vi.waitFor(() => expect(a.led).toEqual([1]), UNTIL);
        await leader.claimEpoch();
        a.election.visibilityChanged();
        await vi.waitFor(() => expect(a.demoted).toBe(1), UNTIL);
        expect(a.led).toEqual([1]);
        await vi.waitFor(() => expect(a.led).toEqual([1, 3]), UNTIL);
        expect(STOP_WAIT_MS).toBeGreaterThan(200);
    });
});
