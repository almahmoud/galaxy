// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, kv, leader, settings } from "@/planet/db";
import { closeEvents } from "@/planet/util/events";

import { bucketRef, leaseKey } from "../bucket";
import { FORK_KEY, forkMarkerKey } from "../forks";
import { InstanceLease, LEASE_CONFLICT_MESSAGE, LEASE_VALID_MS, TAKE_OVER_GRACE_MS } from "../lease";
import { deviceId, readState, updateState } from "../state";
import { configureStorage, MemoryBucket, resetDb } from "./helpers";

const START = Date.parse("2026-10-13T12:00:00.000Z");
const OTHER_DEVICE = "ffffffffffffffff";

let bucket: MemoryBucket;
let clock: number;
let failing: boolean;
const leases: InstanceLease[] = [];

function lease(): InstanceLease {
    const created = new InstanceLease({
        s3Client: (config) => {
            const client = bucket.factory(config);
            return new Proxy(client, {
                get(target, property) {
                    const value = Reflect.get(target, property) as unknown;
                    if (typeof value !== "function") {
                        return value;
                    }
                    return (...args: unknown[]) => {
                        if (failing) {
                            throw new TypeError("Failed to fetch");
                        }
                        return (value as (...a: unknown[]) => unknown).apply(target, args);
                    };
                },
            });
        },
        now: () => clock,
        channel: () => null,
        assertCurrent: async () => undefined,
        onError: () => undefined,
    });
    leases.push(created);
    return created;
}

function otherDeviceLease(instanceId: string): void {
    bucket.putJson(leaseKey(instanceId), {
        format: "planet-snapshot-lease",
        version: 1,
        instance_id: instanceId,
        device_id: OTHER_DEVICE,
        acquired: "2026-10-12T08:00:00.000Z",
        renewed: "2026-10-13T11:30:00.000Z",
    });
}

beforeEach(async () => {
    await resetDb();
    bucket = new MemoryBucket();
    clock = START;
    failing = false;
});

afterEach(async () => {
    await Promise.all(leases.splice(0).map((each) => each.stop()));
    await closeDb();
    closeEvents();
});

describe("instance lease", () => {
    it("takes a free lease and then lets this device run the instance's jobs", async () => {
        await configureStorage();
        const stored = await settings.getStored();
        const gate = lease();
        expect(gate.problem(stored)).toMatch(/^Checking/);
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        expect(gate.problem(stored)).toBeNull();
        expect(bucket.json(leaseKey(stored.instance_id))).toMatchObject({ device_id: await deviceId() });
        expect((await readState())?.lease).toMatchObject({ state: "held", taken_over: null });
    });

    it("refuses while another device holds the lease, and waits after a take-over", async () => {
        await configureStorage();
        const stored = await settings.getStored();
        otherDeviceLease(stored.instance_id);
        const gate = lease();
        let changes = 0;
        gate.subscribe(() => changes++);
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        expect(gate.problem(stored)).toContain(LEASE_CONFLICT_MESSAGE);
        expect((bucket.json(leaseKey(stored.instance_id)) as { device_id: string }).device_id).toBe(OTHER_DEVICE);
        expect(changes).toBeGreaterThan(0);

        await updateState(stored.instance_id, bucketRef(stored.storage), (state) => ({ ...state, take_over: true }));
        await gate.refresh();
        expect(bucket.json(leaseKey(stored.instance_id))).toMatchObject({
            device_id: await deviceId(),
            taken_from: OTHER_DEVICE,
        });
        expect(await readState()).toMatchObject({ take_over: false, lease: { state: "held", taken_over: START } });
        expect(gate.problem(stored)).toMatch(/took the instance over from another device/);

        // A reloaded tab keeps waiting: the take-over time is stored with the lease.
        clock = START + TAKE_OVER_GRACE_MS - 1000;
        const reloaded = lease();
        reloaded.start(await leader.claimEpoch());
        await reloaded.refresh();
        expect(reloaded.problem(stored)).toMatch(/took the instance over/);
        clock = START + TAKE_OVER_GRACE_MS;
        await reloaded.refresh();
        expect(reloaded.problem(stored)).toBeNull();
    });

    it("waits after a take-over another part of this device made, from the lease alone", async () => {
        await configureStorage();
        const stored = await settings.getStored();
        // The snapshot cycle took the lease over; this device's records of it are not written yet.
        bucket.putJson(leaseKey(stored.instance_id), {
            format: "planet-snapshot-lease",
            version: 1,
            instance_id: stored.instance_id,
            device_id: await deviceId(),
            acquired: new Date(START - 60_000).toISOString(),
            renewed: new Date(START - 60_000).toISOString(),
            taken_from: OTHER_DEVICE,
        });
        const gate = lease();
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        expect(gate.problem(stored)).toMatch(/took the instance over/);
        clock = START - 60_000 + TAKE_OVER_GRACE_MS;
        await gate.refresh();
        expect(gate.problem(stored)).toBeNull();
    });

    it("stops allowing jobs when another device took the lease since", async () => {
        await configureStorage();
        const stored = await settings.getStored();
        const gate = lease();
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        expect(gate.problem(stored)).toBeNull();
        otherDeviceLease(stored.instance_id);
        clock += 60_000;
        await gate.refresh();
        expect(gate.problem(stored)).toContain(LEASE_CONFLICT_MESSAGE);
    });

    it("allows jobs only while the lease was confirmed lately", async () => {
        await configureStorage();
        const stored = await settings.getStored();
        const gate = lease();
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        failing = true;
        clock += 60_000;
        await gate.refresh();
        expect(gate.view.state).toBe("failed");
        expect(gate.problem(stored)).toBeNull();
        clock = START + LEASE_VALID_MS;
        expect(gate.problem(stored)).toMatch(/could not be read to confirm.*Failed to fetch/);
        failing = false;
        await gate.refresh();
        expect(gate.problem(stored)).toBeNull();
    });

    it("answers for the current instance and bucket only", async () => {
        await configureStorage();
        const gate = lease();
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        const stored = await settings.getStored();
        expect(gate.problem(stored)).toBeNull();
        expect(gate.problem({ ...stored, storage: { ...stored.storage, bucket: "another-bucket" } })).toMatch(
            /^Checking/,
        );
        expect(gate.problem({ ...stored, instance_id: "0badc0de" })).toMatch(/^Checking/);
    });

    it("tells the original instance of a fork it has not been told of", async () => {
        await configureStorage();
        const stored = await settings.getStored();
        await kv.set(
            FORK_KEY as never,
            {
                from: "a1b2c3d4",
                to: stored.instance_id,
                time: "2026-10-13T11:00:00.000000",
                clock: 1_000_000,
                registered: false,
            } as never,
        );
        const gate = lease();
        gate.start(await leader.claimEpoch());
        await gate.refresh();
        expect(bucket.json(forkMarkerKey("a1b2c3d4", stored.instance_id))).toMatchObject({
            from: "a1b2c3d4",
            to: stored.instance_id,
            clock: 1_000_000,
        });
        expect(await kv.get(FORK_KEY as never)).toMatchObject({ registered: true });
    });
});
