// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leader, outbox, settings } from "@/planet/db";
import {
    Bus,
    fakeDeps,
    FakeKube,
    FakeLocks,
    FakeProtocol,
    resetDb,
    seedHistory,
    seedJob,
    waitFor,
} from "@/planet/jobs/__tests__/fakes";
import type { JobDepsOptions } from "@/planet/jobs/deps";
import { DEFAULT_RUNTIME_IMAGE } from "@/planet/jobs/k8sJob";
import type { PullPolicy } from "@/planet/jobs/runtime";
import type { KubeClientConfig } from "@/planet/k8s";
import { KubeError } from "@/planet/k8s";

import { type HostWindow, LeaderHost } from "./host";

class FakeWindow extends EventTarget {
    document = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
}

const hosts: LeaderHost[] = [];

function host(options: { buildImage?: string | null; tagPullPolicy?: PullPolicy } = {}) {
    const window = new FakeWindow();
    const kube = new FakeKube();
    const kubeConfigs: KubeClientConfig[] = [];
    const { deps } = fakeDeps();
    const createDeps = vi.fn(async (_options: JobDepsOptions) => deps);
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
        loadBuildRuntime: async () => ({
            image: options.buildImage ?? null,
            tagPullPolicy: options.tagPullPolicy ?? "Always",
        }),
        manager: { onError: () => undefined },
        backup: null,
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

    it("runs job pods with the build's runtime image unless the settings name one", async () => {
        const buildImage = `registry.example.org/planet-runtime@sha256:${"a".repeat(64)}`;
        const settingImage = `registry.example.org/custom-runtime@sha256:${"b".repeat(64)}`;
        const { host: running, kube, createDeps } = host({ buildImage });
        await configure();
        running.start();
        await settle(running);
        const { history, input } = await seedHistory();
        await seedJob(history.id, [input.id]);
        await settle(running);
        expect(kube.created).toHaveLength(1);
        const pod = kube.created[0]!.spec!.template.spec;
        expect(pod.initContainers!.map((container) => container.image)).toEqual([buildImage]);
        expect(pod.containers.find((container) => container.name === "stage-out")?.image).toBe(buildImage);
        // Tools without requirements run in the runtime image too.
        const resolve = createDeps.mock.lastCall![0].resolveContainer!;
        expect(await resolve({ requirements: [], containers: [] } as never)).toBe(buildImage);

        await settings.update({ cluster: { runtime_image: settingImage } });
        await settle(running);
        await seedJob(history.id, [input.id]);
        await settle(running);
        expect(kube.created).toHaveLength(2);
        expect(kube.created[1]!.spec!.template.spec.initContainers![0]!.image).toBe(settingImage);
        const resolveAfter = createDeps.mock.lastCall![0].resolveContainer!;
        expect(await resolveAfter({ requirements: [], containers: [] } as never)).toBe(settingImage);
    });

    it("does not run jobs while the build's runtime data cannot be read, and reads it again later", async () => {
        let failure: Error | null = new Error("Planet data file runtime.json could not be read.");
        const kube = new FakeKube();
        const failing = new LeaderHost({
            window: new FakeWindow() as unknown as HostWindow,
            locks: new FakeLocks(),
            channel: new Bus().channel(),
            protocol: new FakeProtocol(),
            createKube: () => kube,
            createDeps: async () => fakeDeps().deps,
            loadBuildRuntime: async () => {
                if (failure) {
                    throw failure;
                }
                return { image: null, tagPullPolicy: "Always" };
            },
            runtimeRetryMs: 50,
            manager: { onError: () => undefined },
            backup: null,
        });
        hosts.push(failing);
        await configure();
        failing.start();
        await settle(failing);
        expect(failing.election.isLeader).toBe(true);
        expect(failing.manager).toBeNull();
        expect(await leader.readStatus()).toMatchObject({
            state: "blocked",
            blocked_reason:
                "This tab cannot read its build's runtime image: Planet data file runtime.json could not be read.",
        });
        const { history, input } = await seedHistory();
        await seedJob(history.id, [input.id]);
        await waitFor(120);
        await settle(failing);
        expect(failing.manager).toBeNull();
        expect(kube.created).toHaveLength(0);

        failure = null;
        await vi.waitFor(() => expect(failing.manager?.active).toBe(true), { timeout: 5000, interval: 10 });
        await settle(failing);
        expect(await leader.readStatus()).toMatchObject({ blocked_reason: null });
        expect(kube.created).toHaveLength(1);
        expect(kube.created[0]!.spec!.template.spec.initContainers![0]).toMatchObject({
            image: DEFAULT_RUNTIME_IMAGE,
            imagePullPolicy: "Always",
        });
    });

    it("pulls runtime images without a digest every time unless the build allows node-local images", async () => {
        const { host: running, kube } = host({ buildImage: "planet-runtime:dev", tagPullPolicy: "IfNotPresent" });
        await configure();
        running.start();
        await settle(running);
        const { history, input } = await seedHistory();
        await seedJob(history.id, [input.id]);
        await settle(running);
        expect(kube.created[0]!.spec!.template.spec.initContainers![0]).toMatchObject({
            image: "planet-runtime:dev",
            imagePullPolicy: "IfNotPresent",
        });
    });

    it("keeps the leader status record current for status pages", async () => {
        const { host: running, kube } = host();
        running.start();
        await settle(running);
        expect(await leader.readStatus()).toMatchObject({
            epoch: running.election.epoch,
            tab_id: running.election.tabId,
            state: "blocked",
            blocked_reason: "The cluster settings are incomplete.",
        });

        await configure();
        await settle(running);
        expect(await leader.readStatus()).toMatchObject({ state: "idle", blocked_reason: null, last_error: null });

        const { history, input } = await seedHistory();
        kube.createError = new KubeError(503, "ServiceUnavailable", "The gateway is unavailable");
        const { job } = await seedJob(history.id, [input.id]);
        await settle(running);
        expect(await outbox.list()).toHaveLength(1);
        expect(await leader.readStatus()).toMatchObject({
            state: "active",
            last_error: { message: "The gateway is unavailable", job_id: job.id },
        });

        // The next reconciliation that gets through without an error clears it.
        kube.createError = null;
        await running.manager!.reconcile();
        await settle(running);
        expect(await leader.readStatus()).toMatchObject({ state: "active", last_error: null });

        kube.listJobs = async () => {
            throw new TypeError("Failed to fetch");
        };
        await running.manager!.reconcile();
        await settle(running);
        expect(await leader.readStatus()).toMatchObject({
            state: "blocked",
            blocked_reason: "The cluster could not be listed: Failed to fetch",
        });
    });
});
