// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, datasets, DB_VERSION, jobs, kv, LeaderFenceError, outbox, settings, tools } from "@/planet/db";
import { closeEvents } from "@/planet/util/events";

import { bucketRef, KEEP, latestKey, leaseKey, snapshotName } from "../bucket";
import { BackupError, isBackupError } from "../errors";
import { fromUtf8, openSnapshot, readSnapshotFile, sealSnapshot, utf8 } from "../format";
import { unlockKey } from "../keys";
import { collectState, isLocalKvKey } from "../payload";
import { FORK_KEY } from "../restore";
import { hasUnsavedChanges, localSummary, restoreSnapshot, runBackup } from "../snapshot";
import { deviceId, readKey, readRequest, readState, requestSnapshot, updateState } from "../state";
import {
    configureStorage,
    dump,
    MemoryBucket,
    PASSPHRASE,
    resetDb,
    SECRET,
    seed,
    type Seeded,
    setPassphrase,
    TOKEN,
    unreachable,
} from "./helpers";

// Every key derivation runs PBKDF2 with 600,000 iterations.
vi.setConfig({ testTimeout: 30_000 });

const START = Date.parse("2026-10-13T12:00:00.000Z");
const MINUTE = 60_000;
const OTHER_DEVICE = "ffffffffffffffff";

let bucket: MemoryBucket;
let clock: number;

const backup = (extra: Parameters<typeof runBackup>[0] = {}) =>
    runBackup({ s3Client: bucket.factory, now: () => clock, ...extra });

function snapshotKeys(instanceId: string): string[] {
    return bucket.keys(`state/${instanceId}/snapshots/`);
}

function newestSnapshot(instanceId: string): Uint8Array<ArrayBuffer> {
    const keys = snapshotKeys(instanceId);
    return bucket.objects.get(keys[keys.length - 1]!)!.slice();
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
    try {
        await promise;
        return null;
    } catch (error) {
        return isBackupError(error) ? error.code : `unexpected: ${String(error)}`;
    }
}

/** Every record except what a restore leaves to the device: secrets, local `kv` keys, live pod and node names. */
function portable(records: Record<string, unknown[]>): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [name, entries] of Object.entries(records)) {
        if (name === "secrets") {
            continue;
        }
        out[name] = (entries as [unknown, Record<string, unknown>][])
            .filter(([key]) => name !== "kv" || !isLocalKvKey(String(key)))
            .map(([key, value]) => {
                if (name === "jobs" && value.k8s) {
                    return [key, { ...value, k8s: { ...(value.k8s as object), pod_name: null, node_name: null } }];
                }
                return [key, value];
            });
    }
    return out;
}

/** A device with the bucket configured, a passphrase and seeded records; returns its instance id. */
async function device(withCluster = true): Promise<{ instanceId: string; seeded: Seeded }> {
    await configureStorage(withCluster);
    await setPassphrase();
    const seeded = await seed();
    return { instanceId: (await settings.getStored()).instance_id, seeded };
}

/** Wipes IndexedDB and enters the bucket settings again, as on a new device or after eviction. */
async function newDevice(withCluster = true): Promise<void> {
    await resetDb();
    await configureStorage(withCluster);
}

beforeEach(async () => {
    await resetDb();
    bucket = new MemoryBucket();
    clock = START;
});

afterEach(async () => {
    await closeDb();
    closeEvents();
});

describe("snapshot round trip", () => {
    it("restores every record of a wiped database except this device's secrets and local state", async () => {
        const { instanceId, seeded } = await device();
        expect(await backup()).toBe("written");
        const before = portable(await dump());

        await newDevice();
        const secretsBefore = (await dump()).secrets;
        const result = await restoreSnapshot(newestSnapshot(instanceId), PASSPHRASE, { now: () => clock });

        expect(result).toMatchObject({ instance_id: instanceId, source_instance_id: instanceId, forked: false });
        const after = await dump();
        expect(portable(after)).toEqual(before);
        expect(after.secrets).toEqual(secretsBefore);
        const running = await jobs.get(seeded.runningJobId);
        expect(running?.state).toBe("running");
        expect(running?.k8s).toMatchObject({ name: "planet-a1b2c3d4-job-a1", pod_name: null, node_name: null });
        const key = (await readKey())!;
        expect(key.key.extractable).toBe(false);
        expect((await unlockKey(PASSPHRASE, key)).key_id).toBe(key.key_id);
    });

    it("writes the snapshot, latest.json and the lease under state/<instance>/", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        const name = snapshotName(START);
        expect(bucket.keys(`state/${instanceId}/`)).toEqual([
            latestKey(instanceId),
            leaseKey(instanceId),
            `state/${instanceId}/snapshots/${name}`,
        ]);
        expect(name).toBe("20261013T120000000Z.json.gz.enc");
        const latest = bucket.json(latestKey(instanceId)) as Record<string, unknown>;
        expect(latest).toMatchObject({
            format: "planet-snapshot-pointer",
            instance_id: instanceId,
            snapshot: name,
            time: "2026-10-13T12:00:00.000Z",
            size: bucket.objects.get(`state/${instanceId}/snapshots/${name}`)!.byteLength,
            schema_version: DB_VERSION,
            counts: { histories: 3, hdas: 2, jobs: 2, outbox: 1, uploads: 1, tools: 1 },
        });
        expect(latest).not.toHaveProperty("stores");
        expect(bucket.json(leaseKey(instanceId))).toMatchObject({
            format: "planet-snapshot-lease",
            instance_id: instanceId,
        });
        expect(await readState()).toMatchObject({
            instance_id: instanceId,
            last_snapshot: { name, size: latest.size },
            lease: { state: "held" },
            last_error: null,
        });
    });

    it("never puts the bucket secret or cluster token into the bucket", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        for (const bytes of bucket.objects.values()) {
            const text = Buffer.from(bytes).toString("latin1");
            expect(text).not.toContain(SECRET);
            expect(text).not.toContain(TOKEN);
        }
        const key = (await readKey())!;
        const payload = fromUtf8(await openSnapshot(readSnapshotFile(newestSnapshot(instanceId)), key.key));
        expect(payload).not.toContain(SECRET);
        expect(payload).not.toContain(TOKEN);
        expect(payload).not.toContain("planet-a1b2c3d4-job-a1-xyz");
        expect(JSON.parse(payload).stores).not.toHaveProperty("secrets");
    });

    it("takes the cluster settings from the snapshot when this device has no cluster token yet", async () => {
        const { instanceId } = await device(true);
        expect(await backup()).toBe("written");
        await newDevice(false);
        await restoreSnapshot(newestSnapshot(instanceId), PASSPHRASE);
        const restored = await settings.get();
        expect(restored.cluster).toMatchObject({ gateway_url: "https://k8s.planet.test", has_token: false });
        expect(restored.storage).toMatchObject({ bucket: "planet-data", has_secret: true });
    });

    it("refuses a wrong passphrase and leaves the records alone", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        await newDevice();
        const before = await dump();
        expect(await errorCode(restoreSnapshot(newestSnapshot(instanceId), "a different passphrase"))).toBe(
            "wrong_passphrase",
        );
        expect(await dump()).toEqual(before);
    });

    it("refuses a tampered snapshot", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        const bytes = newestSnapshot(instanceId);
        bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 0xff;
        await newDevice();
        expect(await errorCode(restoreSnapshot(bytes, PASSPHRASE))).toBe("damaged");
    });

    it("refuses snapshots of another database schema version", async () => {
        const { instanceId } = await device();
        const key = (await readKey())!;
        const collected = await collectState(START);
        const meta = { instance_id: instanceId, created: collected.created };
        const newer = await sealSnapshot(collected.bytes, key.key, key, { ...meta, schema_version: DB_VERSION + 1 });
        expect(await errorCode(restoreSnapshot(newer, PASSPHRASE, { replaceUnsaved: true }))).toBe("schema_version");

        const payload = JSON.parse(fromUtf8(collected.bytes)) as Record<string, unknown>;
        const mislabeled = await sealSnapshot(
            utf8(JSON.stringify({ ...payload, schema_version: DB_VERSION - 1 })),
            key.key,
            key,
            { ...meta, schema_version: DB_VERSION },
        );
        expect(await errorCode(restoreSnapshot(mislabeled, PASSPHRASE, { replaceUnsaved: true }))).toBe(
            "schema_version",
        );
    });

    it("refuses payloads whose records have no valid keys", async () => {
        const { instanceId } = await device();
        const key = (await readKey())!;
        const collected = await collectState(START);
        const payload = JSON.parse(fromUtf8(collected.bytes)) as { stores: Record<string, unknown[]> };
        payload.stores.hdas!.push({ name: "no id" });
        const bad = await sealSnapshot(utf8(JSON.stringify(payload)), key.key, key, {
            instance_id: instanceId,
            created: collected.created,
            schema_version: DB_VERSION,
        });
        expect(await errorCode(restoreSnapshot(bad, PASSPHRASE, { replaceUnsaved: true }))).toBe("format");
    });

    it("refuses to replace records that are in no snapshot unless asked to", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        const snapshot = newestSnapshot(instanceId);
        expect(await hasUnsavedChanges()).toBe(false);
        await kv.set("preferences", { theme: "light" });
        expect(await hasUnsavedChanges()).toBe(true);
        expect(await errorCode(restoreSnapshot(snapshot, PASSPHRASE))).toBe("unsaved_changes");
        await restoreSnapshot(snapshot, PASSPHRASE, { replaceUnsaved: true });
        expect(await kv.get("preferences")).toEqual({ theme: "dark" });
    });

    it("needs no confirmation on a new device", async () => {
        await device();
        expect(await backup()).toBe("written");
        await newDevice();
        expect(await hasUnsavedChanges()).toBe(false);
    });

    it("counts installed tools as records of this device, curated ones not", async () => {
        const tool = {
            tool_id: "cat1",
            tool_version: "1.0.0",
            status: "ready" as const,
            message: null,
            bundle: { id: "cat1" },
            bundle_url: null,
            panel_section_id: null,
            panel_section_name: null,
            hidden: false,
        };
        await tools.put({ ...tool, source: "curated" });
        expect(await localSummary()).toEqual({ has_content: false, unfinished_jobs: 0 });
        await tools.put({ ...tool, tool_version: "2.0.0", source: "installed" });
        expect((await localSummary()).has_content).toBe(true);
    });
});

describe("restoring as a new instance", () => {
    it("fails unfinished jobs and their outputs, empties the outbox and records the fork", async () => {
        const { instanceId, seeded } = await device();
        expect(await backup()).toBe("written");
        await newDevice();
        const result = await restoreSnapshot(newestSnapshot(instanceId), PASSPHRASE, {
            fork: true,
            newInstanceId: () => "0badc0de",
        });
        expect(result).toMatchObject({
            instance_id: "0badc0de",
            source_instance_id: instanceId,
            forked: true,
            failed_jobs: 1,
        });
        expect((await settings.getStored()).instance_id).toBe("0badc0de");
        expect(await jobs.get(seeded.runningJobId)).toMatchObject({ state: "error", k8s: null });
        expect((await jobs.get(seeded.finishedJobId))?.state).toBe("ok");
        expect((await datasets.get(seeded.runningOutputDatasetId))?.state).toBe("error");
        expect(await outbox.list()).toEqual([]);
        expect(await kv.get(FORK_KEY as never)).toMatchObject({ from: instanceId, to: "0badc0de" });

        expect(await backup()).toBe("written");
        expect(snapshotKeys("0badc0de")).toHaveLength(1);
        expect(snapshotKeys(instanceId)).toHaveLength(1);
    });
});

describe("periodic snapshots", () => {
    it("does nothing without a passphrase or bucket", async () => {
        await configureStorage(true);
        expect(await backup()).toBe("no_passphrase");
        await resetDb();
        await setPassphrase();
        expect(await backup()).toBe("not_configured");
        expect(bucket.objects.size).toBe(0);
    });

    it("checks every 15 minutes and writes only when the records changed", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        clock += 5 * MINUTE;
        expect(await backup()).toBe("not_due");
        clock += 10 * MINUTE;
        expect(await backup()).toBe("unchanged");
        await kv.set("preferences", { theme: "light" });
        clock += 5 * MINUTE;
        expect(await backup()).toBe("not_due");
        clock += 10 * MINUTE;
        expect(await backup()).toBe("written");
        expect(snapshotKeys(instanceId)).toHaveLength(2);
    });

    it("writes on request, even when nothing changed if forced", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        clock += MINUTE;
        await requestSnapshot(false, clock);
        expect(await backup()).toBe("unchanged");
        expect(await readRequest()).toBeNull();
        clock += MINUTE;
        await requestSnapshot(true, clock);
        expect(await backup()).toBe("written");
        expect(snapshotKeys(instanceId)).toHaveLength(2);
    });

    it(`keeps the newest ${KEEP} snapshots`, async () => {
        const { instanceId } = await device();
        const names: string[] = [];
        for (let index = 0; index < KEEP + 3; index++) {
            await requestSnapshot(true, clock);
            expect(await backup()).toBe("written");
            names.push(snapshotName(clock));
            clock += MINUTE;
        }
        expect(snapshotKeys(instanceId).map((key) => key.split("/").pop())).toEqual(names.slice(3));
        expect((bucket.json(latestKey(instanceId)) as { snapshot: string }).snapshot).toBe(names[names.length - 1]);
    });

    it("records a failure and waits before trying again unasked", async () => {
        await device();
        bucket = new MemoryBucket();
        const failing = () => runBackup({ s3Client: unreachable(), now: () => clock });
        expect(await failing()).toBe("failed");
        expect((await readState())?.last_error?.message).toMatch(/.+/);
        clock += 20 * MINUTE;
        expect(await failing()).toBe("failed");
        clock += MINUTE;
        expect(await failing()).toBe("not_due");
        clock += 5 * MINUTE;
        expect(await backup()).toBe("written");
        expect((await readState())?.last_error).toBeNull();
    });

    it("stops once another tab leads", async () => {
        const { instanceId } = await device();
        const superseded = await runBackup({
            s3Client: bucket.factory,
            now: () => clock,
            assertCurrent: async () => {
                throw new LeaderFenceError(1, 2);
            },
        });
        expect(superseded).toBe("superseded");
        expect(snapshotKeys(instanceId)).toEqual([]);
    });
});

describe("leases", () => {
    async function otherDeviceLease(instanceId: string): Promise<void> {
        bucket.putJson(leaseKey(instanceId), {
            format: "planet-snapshot-lease",
            version: 1,
            instance_id: instanceId,
            device_id: OTHER_DEVICE,
            acquired: "2026-10-12T08:00:00.000Z",
            renewed: "2026-10-13T11:30:00.000Z",
        });
    }

    it("does not write over another device's snapshots", async () => {
        const { instanceId } = await device();
        await otherDeviceLease(instanceId);
        expect(await backup()).toBe("lease_conflict");
        expect(snapshotKeys(instanceId)).toEqual([]);
        expect((bucket.json(leaseKey(instanceId)) as { device_id: string }).device_id).toBe(OTHER_DEVICE);
        expect((await readState())?.lease).toMatchObject({
            state: "conflict",
            device_id: OTHER_DEVICE,
            renewed: "2026-10-13T11:30:00.000Z",
        });
    });

    it("takes the lease over when asked to", async () => {
        const { instanceId } = await device();
        await otherDeviceLease(instanceId);
        expect(await backup()).toBe("lease_conflict");
        const stored = await settings.getStored();
        await updateState(instanceId, bucketRef(stored.storage), (state) => ({ ...state, take_over: true }));
        await requestSnapshot(true, clock);
        expect(await backup()).toBe("written");
        expect((bucket.json(leaseKey(instanceId)) as { device_id: string }).device_id).not.toBe(OTHER_DEVICE);
        expect(await readState()).toMatchObject({ take_over: false, lease: { state: "held" } });
    });

    it("notices when another device took the lease since", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        await otherDeviceLease(instanceId);
        await requestSnapshot(true, clock);
        expect(await backup()).toBe("lease_conflict");
        expect(snapshotKeys(instanceId)).toHaveLength(1);
    });

    it("restoring onto a new device checks the lease unless taking over or forking", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        const snapshot = newestSnapshot(instanceId);
        await newDevice();
        const checked: string[] = [];
        const checkLease = async (id: string) => {
            checked.push(id);
            throw new BackupError("lease_conflict", "Another device holds the lease.");
        };
        expect(await errorCode(restoreSnapshot(snapshot, PASSPHRASE, { checkLease }))).toBe("lease_conflict");
        expect(checked).toEqual([instanceId]);
        await restoreSnapshot(snapshot, PASSPHRASE, { checkLease, takeOver: true });
        expect(checked).toEqual([instanceId]);
        expect(await readState()).toMatchObject({
            take_over: true,
            last_snapshot: { time: "2026-10-13T12:00:00.000Z" },
        });

        // The next cycle takes the lease without writing the unchanged records again.
        clock += MINUTE;
        expect(await backup()).toBe("unchanged");
        expect(snapshotKeys(instanceId)).toHaveLength(1);
        expect((bucket.json(leaseKey(instanceId)) as { device_id: string }).device_id).toBe(await deviceId());
    });

    it("a restored device without take-over finds the old device's lease and stays off", async () => {
        const { instanceId } = await device();
        expect(await backup()).toBe("written");
        const snapshot = newestSnapshot(instanceId);
        await newDevice();
        await restoreSnapshot(snapshot, PASSPHRASE);
        expect(await readRequest()).toMatchObject({ force: false });
        clock += MINUTE;
        expect(await backup()).toBe("lease_conflict");
        expect(snapshotKeys(instanceId)).toHaveLength(1);
    });
});
