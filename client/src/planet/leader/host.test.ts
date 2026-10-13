// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settings } from "@/planet/db";
import { Bus, fakeDeps, FakeKube, FakeLocks, FakeProtocol, resetDb, waitFor } from "@/planet/jobs/__tests__/fakes";
import type { KubeClientConfig } from "@/planet/k8s";

import { type HostWindow, LeaderHost } from "./host";

class FakeWindow extends EventTarget {
    document = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
}

const hosts: LeaderHost[] = [];

function host() {
    const window = new FakeWindow();
    const kube = new FakeKube();
    const kubeConfigs: KubeClientConfig[] = [];
    const { deps } = fakeDeps();
    const createDeps = vi.fn(async () => deps);
    const created = new LeaderHost({
        window: window as unknown as HostWindow,
        locks: new FakeLocks(),
        channel: new Bus().channel(),
        protocol: new FakeProtocol(),
        createKube: (config) => {
            kubeConfigs.push(config);
            return kube;
        },
        createDeps,
    });
    hosts.push(created);
    return { host: created, window, kube, kubeConfigs, createDeps };
}

async function settle(target: LeaderHost): Promise<void> {
    for (let round = 0; round < 30; round++) {
        await waitFor(1);
    }
    await target.settled();
    await target.manager?.idle();
}

async function configure(): Promise<void> {
    await settings.update({
        cluster: { gateway_url: "https://k8s.example.org", token: "secret-token" },
        storage: { endpoint: "https://s3.example.org", bucket: "b", access_key_id: "k", secret_access_key: "s" },
    });
}

beforeEach(resetDb);

afterEach(async () => {
    await Promise.all(hosts.splice(0).map((each) => each.stop()));
    await resetDb();
});

describe("leader host", () => {
    it("runs the job manager only while leading with complete settings, and restarts it on changes", async () => {
        const { host: running, kube, kubeConfigs, createDeps } = host();
        running.start();
        await settle(running);
        expect(running.election.isLeader).toBe(true);
        expect(running.manager).toBeNull();

        await configure();
        await settle(running);
        const first = running.manager;
        expect(first?.active).toBe(true);
        expect(kubeConfigs).toEqual([
            { gatewayUrl: "https://k8s.example.org", namespace: "planet", token: "secret-token" },
        ]);
        expect(createDeps).toHaveBeenCalledWith(
            expect.objectContaining({ resolveContainer: expect.any(Function), signal: expect.any(AbortSignal) }),
        );
        expect(kube.openWatches()).toBe(2);

        await settings.update({ cluster: { default_cpu: "2" } });
        await settle(running);
        expect(first?.active).toBe(false);
        expect(running.manager).not.toBe(first);
        expect(running.manager?.active).toBe(true);

        await running.stop();
        expect(running.manager).toBeNull();
        expect(kube.openWatches()).toBe(0);
    });

    it("reconciles when the page becomes visible or the network returns", async () => {
        const { host: running, window } = host();
        await configure();
        running.start();
        await settle(running);
        const reconcile = vi.spyOn(running.manager!, "reconcile");

        window.dispatchEvent(new Event("online"));
        window.document.dispatchEvent(new Event("visibilitychange"));
        expect(reconcile).toHaveBeenCalledTimes(2);

        window.dispatchEvent(new Event("pagehide"));
        await settle(running);
        expect(running.election.isLeader).toBe(false);
        window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
        await settle(running);
        expect(running.election.isLeader).toBe(true);
    });
});
