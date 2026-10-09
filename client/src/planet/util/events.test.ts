// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    closeEvents,
    isPlanetEvent,
    PLANET_CHANNEL,
    type PlanetEvent,
    publish,
    subscribe,
    subscribeTo,
} from "./events";

/** Same-thread BroadcastChannel: the shared test setup replaces the real one with a no-op. */
class LocalChannel {
    static open = new Set<LocalChannel>();
    onmessage: ((event: { data: unknown }) => void) | null = null;

    constructor(readonly name: string) {
        LocalChannel.open.add(this);
    }

    postMessage(data: unknown): void {
        const copy = structuredClone(data);
        for (const channel of LocalChannel.open) {
            if (channel !== this && channel.name === this.name) {
                setTimeout(() => channel.onmessage?.({ data: copy }));
            }
        }
    }

    close(): void {
        LocalChannel.open.delete(this);
    }
}

function nextMessage(channel: BroadcastChannel): Promise<unknown> {
    return new Promise((resolve) => {
        channel.onmessage = (event) => resolve(event.data);
    });
}

describe("events", () => {
    beforeEach(() => {
        vi.stubGlobal("BroadcastChannel", LocalChannel);
    });

    afterEach(() => {
        closeEvents();
        vi.unstubAllGlobals();
    });

    it("delivers to local listeners once and to other contexts over the channel", async () => {
        const other = new BroadcastChannel(PLANET_CHANNEL);
        const received: PlanetEvent[] = [];
        subscribe((event) => received.push(event));
        const remote = nextMessage(other);
        publish({ type: "history-changed", historyId: "0123456789abcdef" });
        expect(await remote).toEqual({ type: "history-changed", historyId: "0123456789abcdef" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(received).toEqual([{ type: "history-changed", historyId: "0123456789abcdef" }]);
        other.close();
    });

    it("receives valid events from other contexts and drops malformed ones", async () => {
        const other = new BroadcastChannel(PLANET_CHANNEL);
        const received: string[] = [];
        subscribeTo("job-changed", (event) => received.push(`${event.jobId}:${event.state}`));
        other.postMessage({ type: "job-changed", jobId: "j1" });
        other.postMessage({ type: "unknown" });
        other.postMessage({ type: "job-changed", jobId: "j1", state: "running" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(received).toEqual(["j1:running"]);
        other.close();
    });

    it("validates event shapes", () => {
        expect(isPlanetEvent({ type: "settings-changed" })).toBe(true);
        expect(isPlanetEvent({ type: "history-changed" })).toBe(false);
        expect(isPlanetEvent(null)).toBe(false);
    });
});
