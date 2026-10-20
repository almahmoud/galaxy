// @vitest-environment node
import { describe, expect, it } from "vitest";

import { forkClock, forkMarkerKey, parseForkRecord, sharedBefore, writeForkMarker } from "../forks";
import { MemoryBucket } from "./helpers";

const ORIGIN = "a1b2c3d4";

describe("fork boundaries", () => {
    it("is 0 for an instance that takes part in no fork", async () => {
        const bucket = new MemoryBucket();
        expect(await sharedBefore(bucket.client(), ORIGIN, null)).toBe(0);
    });

    it("takes the newest boundary of the instance's origin and of the forks made from it", async () => {
        const bucket = new MemoryBucket();
        const s3 = bucket.client();
        await writeForkMarker(s3, { from: ORIGIN, to: "0badc0de", time: "2026-10-13T12:00:00.000000", clock: 2000 });
        await writeForkMarker(s3, { from: ORIGIN, to: "0badf00d", time: "2026-10-13T12:00:00.000000", clock: 5000 });
        await writeForkMarker(s3, { from: "ffffffff", to: ORIGIN, time: "2026-10-13T12:00:00.000000", clock: 9000 });
        const origin = { from: "ffffffff", to: ORIGIN, time: "2026-10-13T11:00:00.000000", clock: 3000 };
        expect(await sharedBefore(s3, ORIGIN, null)).toBe(5000);
        expect(await sharedBefore(s3, ORIGIN, origin)).toBe(5000);
        expect(await sharedBefore(s3, ORIGIN, { ...origin, clock: 7000 })).toBe(7000);
        // A record of a fork into another instance is not this instance's origin.
        expect(await sharedBefore(s3, ORIGIN, { ...origin, to: "0badc0de", clock: 7000 })).toBe(5000);
    });

    it("keeps every object when a marker is unreadable, and reads each marker once", async () => {
        const bucket = new MemoryBucket();
        const s3 = bucket.client();
        bucket.putJson(forkMarkerKey(ORIGIN, "0badc0de"), { format: "something else" });
        const cache = new Map<string, number>();
        expect(await sharedBefore(s3, ORIGIN, null, cache)).toBe(Number.POSITIVE_INFINITY);
        const reads = bucket.log.filter((entry) => entry.startsWith("GET")).length;
        await sharedBefore(s3, ORIGIN, null, cache);
        expect(bucket.log.filter((entry) => entry.startsWith("GET")).length).toBe(reads);
    });

    it("reads fork records defensively", () => {
        expect(parseForkRecord({ from: ORIGIN, to: "0badc0de", time: "t" })).toEqual({
            from: ORIGIN,
            to: "0badc0de",
            time: "t",
            registered: false,
        });
        expect(parseForkRecord({ from: "../x", to: "0badc0de", time: "t" })).toBeNull();
        expect(forkClock({ time: "2026-10-13T12:00:00.000001" })).toBe(Date.parse("2026-10-13T12:00:00Z") * 1000 + 1);
        expect(forkClock({ time: "not a time" })).toBe(Number.POSITIVE_INFINITY);
    });
});
