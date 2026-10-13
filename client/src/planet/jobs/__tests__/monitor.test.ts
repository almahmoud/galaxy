// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { type KubeClient, KubeError, type WatchResult } from "@/planet/k8s";

import { appendOutput, CONSOLE_TRUNCATED_NOTE, newLines } from "../console";
import { ClusterMonitor } from "../monitor";
import { FakeKube, waitFor } from "./fakes";

function labelled(name: string, jobId: string) {
    return {
        metadata: { name, labels: { "planet.dev/job-id": jobId, "planet.dev/instance": "a1b2c3d4" } },
        spec: { template: { metadata: { labels: { "planet.dev/job-id": jobId } }, spec: { containers: [] } } },
    };
}

describe("cluster monitor", () => {
    it("lists, then follows watch events and reports the Planet jobs they concern", async () => {
        const kube = new FakeKube();
        await kube.createJob(labelled("planet-a1b2c3d4-0000000000000001-a1", "0000000000000001"));
        const changed: string[] = [];
        const monitor = new ClusterMonitor(kube, "a1b2c3d4", { onChange: (id) => changed.push(id) });

        await monitor.resync();
        expect(changed).toEqual(["0000000000000001"]);
        expect(monitor.ready).toBe(true);
        monitor.start();
        await waitFor(1);
        expect(kube.openWatches()).toBe(2);

        kube.setPod("planet-a1b2c3d4-0000000000000001-a1", { phase: "Running" });
        await waitFor(1);
        expect(monitor.podFor("planet-a1b2c3d4-0000000000000001-a1")?.status?.phase).toBe("Running");
        kube.dropJob("planet-a1b2c3d4-0000000000000001-a1");
        await waitFor(1);
        expect(monitor.job("planet-a1b2c3d4-0000000000000001-a1")).toBeUndefined();
        expect(changed.filter((id) => id === "0000000000000001").length).toBeGreaterThanOrEqual(3);

        await monitor.stop();
        expect(kube.openWatches()).toBe(0);
    });

    it("re-lists when a resource version expired or a stream dropped, and backs off on errors", async () => {
        const kube = new FakeKube();
        const listJobs = vi.spyOn(kube, "listJobs");
        const results: (WatchResult | Error)[] = [
            new KubeError(410, "Expired", "too old resource version"),
            { resourceVersion: "5", end: "interrupted" },
            new KubeError(500, "InternalError", "etcd"),
        ];
        const watchJobs = vi.fn(async (_s: string, _v: string, _h: unknown, signal?: AbortSignal) => {
            const next = results.shift();
            if (next instanceof Error) {
                throw next;
            }
            if (next) {
                return next;
            }
            return new Promise<WatchResult>((resolve) =>
                signal?.addEventListener("abort", () => resolve({ resourceVersion: "9", end: "aborted" })),
            );
        });
        const client = Object.assign(Object.create(kube) as KubeClient, { watchJobs });
        const sleeps: number[] = [];
        const errors: unknown[] = [];
        const monitor = new ClusterMonitor(client, "a1b2c3d4", {
            onChange: () => undefined,
            onError: (error) => errors.push(error),
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });
        await monitor.resync();
        monitor.start();
        await waitFor(5);
        await monitor.stop();

        // One list from resync and one after each of the three failures.
        expect(listJobs).toHaveBeenCalledTimes(4);
        expect(sleeps).toEqual([2000, 4000]);
        expect(errors).toHaveLength(1);
    });
});

describe("console tails", () => {
    it("keeps lines after the last timestamp", () => {
        const log = [
            "2026-10-13T10:00:00Z first",
            "2026-10-13T10:00:00.25Z second",
            "2026-10-13T10:00:01.000000001Z third",
            "",
        ].join("\n");
        expect(newLines(log, null)).toEqual({
            lines: ["first", "second", "third"],
            last: "2026-10-13T10:00:01.000000001Z",
        });
        expect(newLines(log, "2026-10-13T10:00:00.250000000Z").lines).toEqual(["third"]);
    });

    it("only grows, up to a limit", () => {
        expect(appendOutput("a\n", "b\n", 10)).toBe("a\nb\n");
        const full = appendOutput("12345\n", "67890\n", 8);
        expect(full).toBe(`12345\n67${CONSOLE_TRUNCATED_NOTE}`);
        expect(appendOutput(full, "more", 8)).toBe(full);
    });
});
