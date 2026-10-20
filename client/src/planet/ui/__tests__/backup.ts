/** Fake backup services and statuses for the backup section's tests. */

import { vi } from "vitest";

import type { BackupServices, BackupStatus, BucketInstance, RestoreResponse, SnapshotListing } from "../lib/backup";

export const INSTANCE = "a1b2c3d4";
export const DEVICE = "0123456789abcdef";
export const OTHER_DEVICE = "fedcba9876543210";

/** A device whose records are in a recent snapshot; `extra` replaces parts of it. */
export function backupStatus(extra: Partial<BackupStatus> = {}): BackupStatus {
    return {
        passphrase: { set: true, key_id: "1111222233334444", created: "2026-10-01T09:00:00.000Z" },
        storage_configured: true,
        instance_id: INSTANCE,
        device_id: DEVICE,
        schema_version: 2,
        min_schema_version: 1,
        interval_minutes: 15,
        keep: 10,
        last_snapshot: {
            name: "20261013T120000000Z.json.gz.enc",
            time: "2026-10-13T12:00:00.000Z",
            size: 48_213,
            counts: { histories: 3, hdas: 12, hdcas: 1, jobs: 4 },
        },
        checked: "2026-10-13T12:00:00.000Z",
        last_error: null,
        requested: false,
        lease: {
            state: "held",
            device_id: DEVICE,
            renewed: "2026-10-13T12:00:00.000Z",
            checked: "2026-10-13T12:00:00.000Z",
            jobs_start: null,
        },
        writer_active: true,
        local: { has_content: true, unfinished_jobs: 0 },
        restored: null,
        parked_jobs: 0,
        rekey: null,
        ...extra,
    };
}

/** A new device: the bucket is set up, nothing else. */
export function freshStatus(extra: Partial<BackupStatus> = {}): BackupStatus {
    return backupStatus({
        passphrase: { set: false, key_id: null, created: null },
        last_snapshot: null,
        checked: null,
        lease: null,
        local: { has_content: false, unfinished_jobs: 0 },
        ...extra,
    });
}

export function bucketInstance(extra: Partial<BucketInstance> = {}): BucketInstance {
    return {
        instance_id: INSTANCE,
        current: false,
        latest: {
            snapshot: "20261013T120000000Z.json.gz.enc",
            time: "2026-10-13T12:00:00.000Z",
            size: 48_213,
            schema_version: 2,
            counts: { histories: 3, hdas: 12, jobs: 4 },
        },
        lease: { device_id: OTHER_DEVICE, renewed: "2026-10-13T12:00:00.000Z", this_device: false },
        snapshots: [
            { name: "20261013T120000000Z.json.gz.enc", time: "2026-10-13T12:00:00.000Z", size: 48_213 },
            { name: "20261012T080000000Z.json.gz.enc", time: "2026-10-12T08:00:00.000Z", size: 40_002 },
        ],
        ...extra,
    };
}

export const RESTORED: RestoreResponse = {
    instance_id: INSTANCE,
    source_instance_id: INSTANCE,
    created: "2026-10-13T12:00:00.000Z",
    forked: false,
    failed_jobs: 0,
    parked_jobs: 0,
    counts: { histories: 3, hdas: 12, jobs: 4 },
};

/** Services that answer with `status` (by default a backed-up device, or a device without a bucket). */
export function fakeBackupServices(options: { storageConfigured?: boolean; status?: BackupStatus } = {}) {
    let status =
        options.status ??
        (options.storageConfigured === false
            ? freshStatus({ storage_configured: false, writer_active: false })
            : backupStatus());
    const listing: SnapshotListing = { instances: [bucketInstance()], truncated: false };
    const services = {
        getStatus: vi.fn(async () => status),
        act: vi.fn(async () => status),
        listSnapshots: vi.fn(async () => listing),
        restore: vi.fn(async () => RESTORED),
        exportSnapshot: vi.fn(async () => ({
            blob: new Blob([new Uint8Array([1, 2, 3])]),
            filename: `planet-${INSTANCE}-20261013T120000000Z.json.gz.enc`,
        })),
        readFile: vi.fn(async (file: File) => new Uint8Array(await file.arrayBuffer())),
        save: vi.fn(),
        reload: vi.fn(),
    } satisfies BackupServices;
    return {
        services,
        listing,
        setStatus(next: BackupStatus) {
            status = next;
        },
    };
}
