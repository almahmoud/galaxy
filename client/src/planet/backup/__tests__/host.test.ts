// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leader } from "@/planet/db";
import { Bus, fakeDeps, FakeKube, FakeLocks, FakeProtocol, resetDb, waitFor } from "@/planet/jobs/__tests__/fakes";
import { type HostWindow, LeaderHost, type LeaseGate } from "@/planet/leader/host";

import type { LeaderTask } from "../scheduler";

class FakeWindow extends EventTarget {
    document = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
}

class RecordingTask implements LeaderTask {
    readonly events: string[] = [];

    start(epoch: number): void {
        this.events.push(`start ${epoch}`);
    }

    async stop(): Promise<void> {
        this.events.push("stop");
    }
}

const hosts: LeaderHost[] = [];

const allowAll: LeaseGate = {
    start: () => undefined,
    stop: async () => undefined,
    problem: () => null,
    refresh: async () => undefined,
    subscribe: () => () => undefined,
};

function host(task: LeaderTask, locks = new FakeLocks(), bus = new Bus()) {
    const { deps } = fakeDeps();
    const created = new LeaderHost({
        window: new FakeWindow() as unknown as HostWindow,
        locks,
        channel: bus.channel(),
        protocol: new FakeProtocol(),
        createKube: () => new FakeKube(),
        createDeps: async () => deps,
        loadBuildRuntime: async () => ({ image: null, tagPullPolicy: "Always" }),
        manager: { onError: () => undefined },
        backup: task,
        lease: allowAll,
    });
    hosts.push(created);
    return created;
}

async function settle(): Promise<void> {
    for (let round = 0; round < 30; round++) {
        await waitFor(1);
    }
}

beforeEach(resetDb);

afterEach(async () => {
    await Promise.all(hosts.splice(0).map((each) => each.stop()));
    await resetDb();
});

describe("leader host backups", () => {
    it("writes snapshots only while its tab leads, also without cluster settings", async () => {
        const task = new RecordingTask();
        const first = host(task);
        first.start();
        await vi.waitFor(() => expect(task.events).toHaveLength(1), { timeout: 10_000, interval: 10 });
        await settle();
        const epoch = await leader.currentEpoch();
        expect(task.events).toEqual([`start ${epoch}`]);
        await first.stop();
        await settle();
        expect(task.events).toEqual([`start ${epoch}`, "stop"]);
    });

    it("hands snapshots to the next leader", async () => {
        const locks = new FakeLocks();
        const bus = new Bus();
        const [one, two] = [new RecordingTask(), new RecordingTask()];
        const first = host(one, locks, bus);
        const second = host(two, locks, bus);
        first.start();
        await settle();
        second.start();
        await settle();
        expect(one.events).toHaveLength(1);
        expect(two.events).toEqual([]);
        await first.stop();
        await settle();
        expect(one.events.at(-1)).toBe("stop");
        expect(two.events).toEqual([`start ${await leader.currentEpoch()}`]);
    });
});
