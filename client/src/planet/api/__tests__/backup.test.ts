// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leaseKey, readKey, readSnapshotFile, readState, restoreSnapshot, runBackup, toBase64 } from "@/planet/backup";
import {
    configureStorage,
    MemoryBucket,
    PASSPHRASE,
    resetDb,
    seed,
    setPassphrase,
    unreachable,
} from "@/planet/backup/__tests__/helpers";
import { closeDb, jobs, kv, settings } from "@/planet/db";
import { Router } from "@/planet/sw/router";
import type { BackupStatus, SnapshotListing } from "@/planet/ui/lib/backup";
import { closeEvents } from "@/planet/util/events";

import { type BackupClients, register } from "../backup";

// Every key derivation runs PBKDF2 with 600,000 iterations.
vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "https://planet.test";
const START = Date.parse("2026-10-13T12:00:00.000Z");

let bucket: MemoryBucket;
let clock: number;

function router(extra: BackupClients = {}): Router {
    const instance = new Router();
    register(instance, { s3Client: bucket.factory, now: () => clock, newInstanceId: () => "0badc0de", ...extra });
    return instance;
}

async function send(
    target: Router,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await target.handle(
        new Request(`${ORIGIN}${path}`, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function status(target = router()): Promise<BackupStatus> {
    const answer = await send(target, "GET", "/api/planet/backup");
    expect(answer.status).toBe(200);
    return answer.body as unknown as BackupStatus;
}

async function snapshotNow(): Promise<void> {
    expect(await runBackup({ s3Client: bucket.factory, now: () => clock })).toBe("written");
}

async function newDevice(): Promise<void> {
    await resetDb();
    await configureStorage(true);
}

/** Restores a snapshot file on this device, taking its instance over. */
async function restoreSnapshotFrom(bytes: Uint8Array<ArrayBuffer>, passphrase: string): Promise<void> {
    await restoreSnapshot(bytes, passphrase, { takeOver: true, replaceUnsaved: true });
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

describe("GET /api/planet/backup", () => {
    it("reports a device that is not set up", async () => {
        const current = await status();
        expect(current).toMatchObject({
            passphrase: { set: false, key_id: null },
            storage_configured: false,
            interval_minutes: 15,
            keep: 10,
            last_snapshot: null,
            lease: null,
            requested: false,
            writer_active: false,
            local: { has_content: false, unfinished_jobs: 0 },
            restored: null,
        });
        expect(current.device_id).toMatch(/^[0-9a-f]{16}$/);
        expect(current.device_id).toBe((await status()).device_id);
    });

    it("reports the last snapshot and the lease", async () => {
        await configureStorage(true);
        await setPassphrase();
        await seed();
        await snapshotNow();
        const current = await status();
        expect(current).toMatchObject({
            passphrase: { set: true },
            storage_configured: true,
            last_snapshot: { name: "20261013T120000000Z.json.gz.enc", time: "2026-10-13T12:00:00.000Z" },
            checked: "2026-10-13T12:00:00.000Z",
            lease: { state: "held", device_id: current.device_id },
            local: { has_content: true, unfinished_jobs: 1 },
        });
        expect(current.last_snapshot!.counts.jobs).toBe(2);
    });
});

describe("POST /api/planet/backup", () => {
    it("sets the passphrase and asks for a snapshot when the bucket is set up", async () => {
        await configureStorage(true);
        const weak = await send(router(), "POST", "/api/planet/backup", {
            action: "set_passphrase",
            passphrase: "short",
        });
        expect(weak.status).toBe(400);
        expect(weak.body).toMatchObject({ reason: "weak_passphrase", err_data: { passphrase: expect.any(String) } });

        const answer = await send(router(), "POST", "/api/planet/backup", {
            action: "set_passphrase",
            passphrase: PASSPHRASE,
        });
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
            passphrase: { set: true, key_id: expect.stringMatching(/^[0-9a-f]{16}$/) },
        });
        expect(answer.body.requested).toBe(true);
        expect(JSON.stringify(await kv.get("backup:key" as never))).not.toContain(PASSPHRASE);
    });

    it("changes the passphrase only with the current one", async () => {
        const key = await setPassphrase();
        const change = { action: "set_passphrase", passphrase: "another long passphrase" };
        const missing = await send(router(), "POST", "/api/planet/backup", change);
        expect(missing.status).toBe(403);
        expect(missing.body).toMatchObject({ reason: "wrong_passphrase" });
        const wrong = await send(router(), "POST", "/api/planet/backup", {
            ...change,
            current_passphrase: "nope nope nope",
        });
        expect(wrong.status).toBe(403);
        const right = await send(router(), "POST", "/api/planet/backup", { ...change, current_passphrase: PASSPHRASE });
        expect(right.status).toBe(200);
        expect((right.body as unknown as BackupStatus).passphrase.key_id).not.toBe(key.key_id);
    });

    it("removes the passphrase only with the current one", async () => {
        await setPassphrase();
        const missing = await send(router(), "POST", "/api/planet/backup", { action: "remove_passphrase" });
        expect(missing).toMatchObject({ status: 403, body: { reason: "wrong_passphrase" } });
        const wrong = await send(router(), "POST", "/api/planet/backup", {
            action: "remove_passphrase",
            current_passphrase: "nope nope nope",
        });
        expect(wrong.status).toBe(403);
        expect((await status()).passphrase.set).toBe(true);
        const answer = await send(router(), "POST", "/api/planet/backup", {
            action: "remove_passphrase",
            current_passphrase: PASSPHRASE,
        });
        expect((answer.body as unknown as BackupStatus).passphrase.set).toBe(false);
    });

    it("refuses passphrases that are easy to guess", async () => {
        const answer = await send(router(), "POST", "/api/planet/backup", {
            action: "set_passphrase",
            passphrase: "aaaaaaaaaaaaaaaa",
        });
        expect(answer).toMatchObject({ status: 400, body: { reason: "weak_passphrase" } });
    });

    it("re-encrypts the snapshots of the old passphrase after a change", async () => {
        await configureStorage(true);
        await setPassphrase();
        await seed();
        await snapshotNow();
        clock += 60_000;
        await kv.set("preferences", { theme: "light" });
        clock += 15 * 60_000;
        await snapshotNow();
        const instanceId = (await settings.getStored()).instance_id;
        const prefix = `state/${instanceId}/snapshots/`;
        const oldKeyId = (await readKey())!.key_id;
        const NEW = "an entirely different passphrase";

        const bad = await send(router(), "POST", "/api/planet/backup", {
            action: "set_passphrase",
            passphrase: NEW,
            current_passphrase: PASSPHRASE,
            older_snapshots: "shred",
        });
        expect(bad.status).toBe(400);
        const changed = await send(router(), "POST", "/api/planet/backup", {
            action: "set_passphrase",
            passphrase: NEW,
            current_passphrase: PASSPHRASE,
            older_snapshots: "reencrypt",
        });
        expect(changed.body).toMatchObject({ rekey: { mode: "reencrypt", finished: null } });
        clock += 60_000;
        await snapshotNow();
        const newKeyId = (await readKey())!.key_id;
        const names = bucket.keys(prefix);
        expect(names).toHaveLength(3);
        for (const key of names) {
            const file = readSnapshotFile(bucket.objects.get(key)!.slice());
            expect(file.header.key_id).toBe(newKeyId);
        }
        expect(newKeyId).not.toBe(oldKeyId);
        expect(await status()).toMatchObject({ rekey: { mode: "reencrypt", done: 2, skipped: 0 } });
        expect((await status()).rekey?.finished).toEqual(expect.any(String));
        expect(await kv.get("backup:previous_keys" as never)).toBeUndefined();
        // The re-encrypted snapshots restore with the new passphrase on another device.
        const oldest = bucket.objects.get(names[0]!)!.slice();
        await newDevice();
        await restoreSnapshotFrom(oldest, NEW);
    });

    it("deletes the snapshots of the old passphrase after a change when asked to", async () => {
        const NEW = "an entirely different passphrase";
        await configureStorage(true);
        await setPassphrase();
        await seed();
        await snapshotNow();
        const deleted = await send(router(), "POST", "/api/planet/backup", {
            action: "set_passphrase",
            passphrase: NEW,
            current_passphrase: PASSPHRASE,
            older_snapshots: "delete",
        });
        expect(deleted.status).toBe(200);
        clock += 60_000;
        await snapshotNow();
        const remaining = bucket.keys(`state/${(await settings.getStored()).instance_id}/snapshots/`);
        expect(remaining).toHaveLength(1);
        expect(readSnapshotFile(bucket.objects.get(remaining[0]!)!.slice()).header.key_id).toBe(
            (await readKey())!.key_id,
        );
    });

    it("asks the leading tab for a snapshot", async () => {
        const unset = await send(router(), "POST", "/api/planet/backup", { action: "snapshot" });
        expect(unset).toMatchObject({ status: 409, body: { reason: "no_passphrase" } });
        await setPassphrase();
        expect(await send(router(), "POST", "/api/planet/backup", { action: "snapshot" })).toMatchObject({
            status: 409,
            body: { reason: "not_configured" },
        });
        await configureStorage(true);
        const answer = await send(router(), "POST", "/api/planet/backup", { action: "snapshot" });
        expect(answer).toMatchObject({ status: 200, body: { requested: true } });
    });

    it("takes the lease over, also without a passphrase, or forks a new instance", async () => {
        const unset = await send(router(), "POST", "/api/planet/backup", { action: "take_over" });
        expect(unset).toMatchObject({ status: 409, body: { reason: "not_configured" } });
        await configureStorage(true);
        await seed();
        const taken = await send(router(), "POST", "/api/planet/backup", { action: "take_over" });
        expect(taken.status).toBe(200);
        expect((await readState())?.take_over).toBe(true);

        const before = (await settings.getStored()).instance_id;
        const forked = await send(router(), "POST", "/api/planet/backup", { action: "fork" });
        expect(forked.status).toBe(200);
        expect(forked.body).toMatchObject({ instance_id: "0badc0de", requested: true, local: { unfinished_jobs: 0 } });
        expect(await kv.get("instance_fork" as never)).toMatchObject({
            from: before,
            to: "0badc0de",
            registered: true,
        });
        expect(bucket.json(`state/${before}/forks/0badc0de.json`)).toMatchObject({ from: before, to: "0badc0de" });
    });

    it("resumes the jobs a restore paused", async () => {
        await configureStorage(true);
        await setPassphrase();
        const { historyId } = await seed();
        const pending = await jobs.create({ tool_id: "cat1", tool_version: "1.0.0", history_id: historyId });
        await snapshotNow();
        const instanceId = (await settings.getStored()).instance_id;
        const snapshot = bucket.objects.get(bucket.keys(`state/${instanceId}/snapshots/`)[0]!)!.slice();
        await newDevice();
        const restored = await send(router(), "POST", "/api/planet/backup/restore", {
            passphrase: PASSPHRASE,
            snapshot: toBase64(snapshot),
            take_over: true,
        });
        expect(restored.body).toMatchObject({ parked_jobs: 1 });
        expect(await status()).toMatchObject({ parked_jobs: 1 });
        expect((await jobs.get(pending.id))?.state).toBe("paused");
        const resumed = await send(router(), "POST", "/api/planet/backup", { action: "resume_restored_jobs" });
        expect(resumed.body).toMatchObject({ parked_jobs: 0 });
        expect((await jobs.get(pending.id))?.state).toBe("new");
    });

    it("refuses unknown actions and bodies that are not JSON objects", async () => {
        expect((await send(router(), "POST", "/api/planet/backup", { action: "delete_bucket" })).status).toBe(400);
        expect((await send(router(), "POST", "/api/planet/backup", ["snapshot"])).status).toBe(400);
        const form = await router().handle(
            new Request(`${ORIGIN}/api/planet/backup`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "action=snapshot",
            }),
        );
        expect(form.status).toBe(400);
    });
});

describe("GET /api/planet/backup/snapshots", () => {
    it("lists the instances and snapshots in the bucket, newest first", async () => {
        expect(await send(router(), "GET", "/api/planet/backup/snapshots")).toMatchObject({
            status: 409,
            body: { reason: "not_configured" },
        });
        await configureStorage(true);
        await setPassphrase();
        await seed();
        await snapshotNow();
        clock += 60_000;
        await kv.set("preferences", { theme: "light" });
        clock += 15 * 60_000;
        await snapshotNow();
        const instanceId = (await settings.getStored()).instance_id;
        bucket.putJson("state/notaninstance/latest.json", {});

        const answer = await send(router(), "GET", "/api/planet/backup/snapshots");
        expect(answer.status).toBe(200);
        const listing = answer.body as unknown as SnapshotListing;
        expect(listing.truncated).toBe(false);
        expect(listing.instances).toHaveLength(1);
        expect(listing.instances[0]).toMatchObject({
            instance_id: instanceId,
            current: true,
            latest: { snapshot: "20261013T121600000Z.json.gz.enc", schema_version: expect.any(Number) },
            lease: { this_device: true },
        });
        expect(listing.instances[0]!.snapshots.map((snapshot) => snapshot.name)).toEqual([
            "20261013T121600000Z.json.gz.enc",
            "20261013T120000000Z.json.gz.enc",
        ]);
        expect(JSON.stringify(listing)).not.toMatch(/X-Amz|https?:/);
    });

    it("answers 502 when the bucket cannot be reached", async () => {
        await configureStorage(true);
        const answer = await send(router({ s3Client: unreachable() }), "GET", "/api/planet/backup/snapshots");
        expect(answer).toMatchObject({ status: 502, body: { reason: "bucket" } });
    });
});

describe("POST /api/planet/backup/restore", () => {
    async function snapshotted(): Promise<{ instanceId: string; name: string }> {
        await configureStorage(true);
        await setPassphrase();
        await seed();
        await snapshotNow();
        return { instanceId: (await settings.getStored()).instance_id, name: "20261013T120000000Z.json.gz.enc" };
    }

    it("restores a bucket snapshot on a new device after it confirms the other device's lease", async () => {
        const { instanceId, name } = await snapshotted();
        await newDevice();
        const request = { passphrase: PASSPHRASE, bucket: { instance_id: instanceId, name } };

        const conflict = await send(router(), "POST", "/api/planet/backup/restore", request);
        expect(conflict.status).toBe(409);
        expect(conflict.body).toMatchObject({
            reason: "lease_conflict",
            lease: { device_id: expect.stringMatching(/^[0-9a-f]{16}$/), renewed: "2026-10-13T12:00:00.000Z" },
        });
        expect((await settings.getStored()).instance_id).not.toBe(instanceId);

        const answer = await send(router(), "POST", "/api/planet/backup/restore", { ...request, take_over: true });
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ instance_id: instanceId, forked: false, failed_jobs: 0 });
        expect((await settings.getStored()).instance_id).toBe(instanceId);
        expect(await status()).toMatchObject({
            instance_id: instanceId,
            restored: { instance_id: instanceId, forked_to: null },
            local: { has_content: true },
        });
    });

    it("restores as a new instance without touching the lease", async () => {
        const { instanceId, name } = await snapshotted();
        const lease = bucket.objects.get(leaseKey(instanceId));
        await newDevice();
        const answer = await send(router(), "POST", "/api/planet/backup/restore", {
            passphrase: PASSPHRASE,
            bucket: { instance_id: instanceId, name },
            fork: true,
        });
        expect(answer.body).toMatchObject({
            instance_id: "0badc0de",
            source_instance_id: instanceId,
            forked: true,
            failed_jobs: 1,
        });
        expect(bucket.objects.get(leaseKey(instanceId))).toEqual(lease);
    });

    it("asks before replacing records that are in no snapshot", async () => {
        const { instanceId, name } = await snapshotted();
        await kv.set("preferences", { theme: "light" });
        const request = { passphrase: PASSPHRASE, bucket: { instance_id: instanceId, name } };
        const refused = await send(router(), "POST", "/api/planet/backup/restore", request);
        expect(refused).toMatchObject({ status: 409, body: { reason: "unsaved_changes" } });
        const answer = await send(router(), "POST", "/api/planet/backup/restore", {
            ...request,
            replace_unsaved: true,
        });
        expect(answer.status).toBe(200);
        expect(await kv.get("preferences")).toEqual({ theme: "dark" });
    });

    it("exports a file that restores on another device", async () => {
        await snapshotted();
        const response = await router().handle(new Request(`${ORIGIN}/api/planet/backup/export`));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toMatch(
            /^attachment; filename="planet-[0-9a-f]{8}-20261013T120000000Z\.json\.gz\.enc"$/,
        );
        const file = new Uint8Array(await response.arrayBuffer());
        await resetDb();
        const request = { passphrase: PASSPHRASE, snapshot: toBase64(file) };
        // This device has no cluster settings; the snapshot's gateway is shown before it is used.
        const asked = await send(router(), "POST", "/api/planet/backup/restore", request);
        expect(asked).toMatchObject({
            status: 409,
            body: {
                reason: "cluster_settings",
                cluster: { gateway_url: "https://k8s.planet.test", runtime_image: "" },
            },
        });
        const malformed = await send(router(), "POST", "/api/planet/backup/restore", {
            ...request,
            cluster_settings: { gateway_url: "https://k8s.planet.test" },
        });
        expect(malformed.status).toBe(400);
        const answer = await send(router(), "POST", "/api/planet/backup/restore", {
            ...request,
            cluster_settings: { gateway_url: "https://k8s.planet.test", runtime_image: "" },
        });
        expect(answer.status).toBe(200);
        expect((await status()).local.has_content).toBe(true);
        expect((await settings.get()).cluster.gateway_url).toBe("https://k8s.planet.test");
    });

    it("explains a wrong passphrase, a damaged file and a missing snapshot", async () => {
        const { instanceId, name } = await snapshotted();
        const target = router();
        const wrong = await send(target, "POST", "/api/planet/backup/restore", {
            passphrase: "certainly not it",
            bucket: { instance_id: instanceId, name },
        });
        expect(wrong).toMatchObject({ status: 403, body: { reason: "wrong_passphrase" } });
        const garbage = await send(target, "POST", "/api/planet/backup/restore", {
            passphrase: PASSPHRASE,
            snapshot: toBase64(new TextEncoder().encode("hello")),
        });
        expect(garbage).toMatchObject({ status: 400, body: { reason: "format" } });
        const missing = await send(target, "POST", "/api/planet/backup/restore", {
            passphrase: PASSPHRASE,
            bucket: { instance_id: instanceId, name: "20200101T000000000Z.json.gz.enc" },
        });
        expect(missing).toMatchObject({ status: 404, body: { reason: "not_found" } });
    });

    it("refuses malformed requests", async () => {
        await configureStorage(true);
        const target = router();
        for (const body of [
            { passphrase: PASSPHRASE },
            { passphrase: PASSPHRASE, snapshot: "AAAA", bucket: { instance_id: "a1b2c3d4", name: "x" } },
            { passphrase: PASSPHRASE, bucket: { instance_id: "../a1b2c3d4", name: "20200101T000000000Z.json.gz.enc" } },
            { passphrase: PASSPHRASE, bucket: { instance_id: "a1b2c3d4", name: "../../datasets/x/data" } },
            { passphrase: 42, snapshot: "AAAA" },
            { passphrase: PASSPHRASE, snapshot: "AAAA", fork: "yes" },
        ]) {
            expect((await send(target, "POST", "/api/planet/backup/restore", body)).status).toBe(400);
        }
        expect(bucket.log.filter((entry) => entry.startsWith("GET"))).toEqual([]);
    });
});
