// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupScheduler, FIRST_RUN_MS, TICK_MS } from "../scheduler";
import type { BackupOutcome, BackupRunOptions } from "../snapshot";

class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    closed = false;

    close() {
        this.closed = true;
    }

    deliver(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
    }
}

function scheduler(run: (options: BackupRunOptions) => Promise<BackupOutcome>) {
    const channel = new FakeChannel();
    const errors: unknown[] = [];
    const instance = new BackupScheduler({
        run: run as never,
        channel: () => channel,
        onError: (error) => errors.push(error),
    });
    return { instance, channel, errors };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("BackupScheduler", () => {
    it("runs shortly after it starts leading and then every minute, with its epoch", async () => {
        const runs: BackupRunOptions[] = [];
        const { instance } = scheduler(async (options) => {
            runs.push(options);
            return "not_due";
        });
        instance.start(7);
        await vi.advanceTimersByTimeAsync(FIRST_RUN_MS - 1);
        expect(runs).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ epoch: 7 });
        await vi.advanceTimersByTimeAsync(TICK_MS * 2);
        expect(runs).toHaveLength(3);
        await instance.stop();
        await vi.advanceTimersByTimeAsync(TICK_MS * 3);
        expect(runs).toHaveLength(3);
    });

    it("runs when the Service Worker announces a request", async () => {
        const run = vi.fn(async () => "written" as const);
        const { instance, channel } = scheduler(run);
        instance.start(1);
        channel.deliver({ type: "something-else" });
        expect(run).not.toHaveBeenCalled();
        channel.deliver({ type: "snapshot-requested" });
        await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(1);
        await instance.stop();
        expect(channel.closed).toBe(true);
    });

    it("runs one cycle at a time and once more after a request during a cycle", async () => {
        let release: () => void = () => undefined;
        let active = 0;
        let most = 0;
        const run = vi.fn(async () => {
            active += 1;
            most = Math.max(most, active);
            await new Promise<void>((resolve) => (release = resolve));
            active -= 1;
            return "written" as const;
        });
        const { instance } = scheduler(run);
        instance.start(1);
        void instance.tick();
        void instance.tick();
        void instance.tick();
        release();
        await vi.advanceTimersByTimeAsync(0);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(2);
        expect(most).toBe(1);
        await instance.stop();
    });

    it("aborts the running cycle on stop and waits for it", async () => {
        let signal: AbortSignal | undefined;
        let finished = false;
        const { instance } = scheduler(
            (options) =>
                new Promise((resolve) => {
                    signal = options.signal;
                    options.signal?.addEventListener("abort", () => {
                        finished = true;
                        resolve("superseded");
                    });
                }),
        );
        instance.start(1);
        void instance.tick();
        await instance.stop();
        expect(signal?.aborted).toBe(true);
        expect(finished).toBe(true);
        expect(await instance.tick()).toBeNull();
    });

    it("reports failures and keeps running", async () => {
        const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("unchanged");
        const { instance, errors } = scheduler(run);
        instance.start(1);
        expect(await instance.tick()).toBeNull();
        expect(errors).toEqual([new Error("boom")]);
        expect(await instance.tick()).toBe("unchanged");
        await instance.stop();
    });
});
