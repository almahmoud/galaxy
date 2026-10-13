// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobs } from "@/planet/db";
import type { KubeClient, PodLogOptions } from "@/planet/k8s";

import { CONSOLE_CHUNK_BYTES, CONSOLE_POLL_INTERVAL_MS, ConsoleTails, newLines } from "../console";
import { resetDb, seedHistory, seedJob } from "./fakes";

/** A pod log that honours `sinceTime` (whole seconds), `tailLines` and `limitBytes` like the kubelet. */
class LogServer {
    lines: string[] = [];
    readonly requests: PodLogOptions[] = [];

    readonly kube = {
        getPodLog: async (_pod: string, options: PodLogOptions) => {
            this.requests.push(options);
            let lines = this.lines;
            if (options.sinceTime) {
                lines = lines.filter((line) => `${line.slice(0, 19)}Z` >= options.sinceTime!);
            } else if (options.tailLines) {
                lines = lines.slice(-options.tailLines);
            }
            const bytes = new TextEncoder().encode(lines.map((line) => `${line}\n`).join(""));
            return new TextDecoder().decode(bytes.slice(0, options.limitBytes ?? bytes.byteLength));
        },
    } as unknown as KubeClient;
}

beforeEach(resetDb);
afterEach(resetDb);

async function runningJob(): Promise<string> {
    const { history, input } = await seedHistory();
    const { job } = await seedJob(history.id, [input.id]);
    await jobs.update(job.id, { state: "running" });
    return job.id;
}

describe("live console output", () => {
    it("drops a line cut short by limitBytes and reads it whole next time", () => {
        const log = "2026-10-13T10:00:00.1Z first\n2026-10-13T10:00:00.2Z sec";
        expect(newLines(log, null, true)).toEqual({ lines: ["first"], last: "2026-10-13T10:00:00.100000000Z" });
        expect(newLines(log, null, false).lines).toEqual(["first", "sec"]);
    });

    it("keeps advancing when more than a response of lines share one second", async () => {
        const jobId = await runningJob();
        const server = new LogServer();
        const clock = { now: 1_000_000 };
        const tails = new ConsoleTails(server.kube, () => clock.now);
        const filler = "x".repeat(200);
        // Far more than one response of output within 10:00:00, then a line one second later.
        const busy = Array.from({ length: 400 }, (_, index) => {
            const nanos = String(index + 1).padStart(9, "0");
            return `2026-10-13T10:00:00.${nanos}Z ${index} ${filler}`;
        });
        server.lines = [...busy, "2026-10-13T10:00:01.000000001Z done"];

        const poll = async () => {
            clock.now += CONSOLE_POLL_INTERVAL_MS;
            await tails.poll(jobId, "pod", "tool");
        };
        await poll();
        const first = (await jobs.get(jobId))?.tool_stdout ?? "";
        expect(first.length).toBeGreaterThan(0);
        expect(first.split("\n").every((line) => line === "" || line.endsWith(filler))).toBe(true);

        for (let round = 0; round < 5; round++) {
            await poll();
        }
        const text = (await jobs.get(jobId))?.tool_stdout ?? "";
        expect(text.endsWith("done\n")).toBe(true);
        expect(server.requests.at(-1)?.sinceTime).toBe("2026-10-13T10:00:01Z");
        expect(server.requests.every((request) => request.limitBytes === CONSOLE_CHUNK_BYTES)).toBe(true);
        // Every stored line is complete.
        expect(text.split("\n").every((line) => line === "" || line === "done" || line.endsWith(filler))).toBe(true);
    });

    it("removes signed URLs from live output", async () => {
        const jobId = await runningJob();
        const server = new LogServer();
        server.lines = ["2026-10-13T10:00:00Z GET https://s3.test/k?X-Amz-Signature=0123456789abcdef0123 ok"];
        await new ConsoleTails(server.kube, () => 1_000_000).poll(jobId, "pod", "tool");
        expect((await jobs.get(jobId))?.tool_stdout).toBe("GET https://s3.test/k?[redacted] ok\n");
    });
});
