import { afterEach, describe, expect, it, vi } from "vitest";

import { backupStatus, freshStatus, OTHER_DEVICE } from "../__tests__/backup";
import {
    BackupApiError,
    backupState,
    backupSummary,
    browserBackupServices,
    describeCounts,
    formatSize,
    offersRestore,
    rekeySummary,
} from "./backup";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("backup status", () => {
    it("names the state of the backups", () => {
        expect(backupState(null, false)).toBe("loading");
        expect(backupState(null, true)).toBe("unavailable");
        expect(backupState(freshStatus(), false)).toBe("not_set_up");
        expect(backupState(backupStatus({ storage_configured: false }), false)).toBe("not_set_up");
        expect(
            backupState(
                backupStatus({
                    lease: { state: "conflict", device_id: OTHER_DEVICE, renewed: null, checked: "", jobs_start: null },
                }),
                false,
            ),
        ).toBe("conflict");
        // Another device runs the instance's jobs even when this one has no passphrase.
        expect(
            backupState(
                freshStatus({
                    lease: { state: "conflict", device_id: OTHER_DEVICE, renewed: null, checked: "", jobs_start: null },
                }),
                false,
            ),
        ).toBe("conflict");
        expect(backupState(backupStatus({ last_error: { message: "x", time: "" } }), false)).toBe("error");
        expect(backupState(backupStatus({ requested: true }), false)).toBe("waiting");
        expect(backupState(backupStatus({ last_snapshot: null }), false)).toBe("waiting");
        expect(backupState(backupStatus(), false)).toBe("ok");
    });

    it("offers a restore only on a device without records of its own", () => {
        expect(offersRestore(freshStatus())).toBe(true);
        expect(offersRestore(freshStatus({ storage_configured: false }))).toBe(false);
        expect(offersRestore(backupStatus())).toBe(false);
        expect(
            offersRestore(
                freshStatus({ restored: { instance_id: "a1b2c3d4", created: "", time: "", forked_to: null } }),
            ),
        ).toBe(false);
    });

    it("says why no snapshots are written", () => {
        expect(backupSummary(freshStatus({ storage_configured: false }))).toMatch(/storage bucket/);
        expect(backupSummary(freshStatus())).toMatch(/Choose a passphrase/);
        expect(backupSummary(backupStatus({ writer_active: false }))).toMatch(/while a Planet tab is open/);
        expect(backupSummary(backupStatus({ requested: true }))).toMatch(/being written/);
    });

    it("reports what happened to the snapshots of the old passphrase", () => {
        const rekey = { mode: "reencrypt" as const, done: 0, skipped: 0, finished: null, last_error: null };
        expect(rekeySummary(null)).toBeNull();
        expect(rekeySummary(rekey)).toMatch(/re-encrypted after the next snapshot/);
        expect(rekeySummary({ ...rekey, mode: "delete" })).toMatch(/deleted after the next snapshot/);
        expect(rekeySummary({ ...rekey, done: 3, finished: "2026-10-13T12:00:00.000Z" })).toBe(
            "3 older snapshots re-encrypted.",
        );
        expect(rekeySummary({ ...rekey, done: 1, skipped: 2, finished: "x" })).toBe(
            "1 older snapshot re-encrypted. 2 older snapshots kept an earlier passphrase.",
        );
        expect(rekeySummary({ ...rekey, last_error: "Failed to fetch" })).toMatch(/could not be re-encrypted yet/);
    });

    it("formats sizes and counts", () => {
        expect(formatSize(512)).toBe("512 bytes");
        expect(formatSize(48_213)).toBe("48.2 kB");
        expect(formatSize(3_400_000)).toBe("3.4 MB");
        expect(describeCounts({ histories: 1, hdas: 2 })).toBe("1 history, 2 datasets, 0 collections, 0 jobs");
    });
});

describe("browserBackupServices", () => {
    function stubFetch(response: Response) {
        const fetch = vi.fn(async (_path: string, _init?: RequestInit) => response);
        vi.stubGlobal("fetch", fetch);
        return fetch;
    }

    it("sends a file as base64 and a bucket snapshot by name", async () => {
        const fetch = stubFetch(new Response("{}", { status: 200 }));
        const services = browserBackupServices();
        await services.restore({ file: new Uint8Array([1, 2, 3]) }, { passphrase: "p" });
        expect(fetch.mock.calls[0]![0]).toBe("/api/planet/backup/restore");
        expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ passphrase: "p", snapshot: "AQID" });
        fetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
        await services.restore({ bucket: { instance_id: "a1b2c3d4", name: "n" } }, { passphrase: "p", fork: true });
        expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({
            passphrase: "p",
            fork: true,
            bucket: { instance_id: "a1b2c3d4", name: "n" },
        });
    });

    it("turns error envelopes into errors with their reason and lease", async () => {
        stubFetch(
            new Response(
                JSON.stringify({
                    err_msg: "Another device writes the snapshots.",
                    err_code: 409001,
                    reason: "lease_conflict",
                    lease: { device_id: OTHER_DEVICE, renewed: "2026-10-13T11:00:00.000Z" },
                }),
                { status: 409 },
            ),
        );
        const error = await browserBackupServices()
            .listSnapshots()
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BackupApiError);
        expect(error).toMatchObject({
            status: 409,
            message: "Another device writes the snapshots.",
            reason: "lease_conflict",
            lease: { device_id: OTHER_DEVICE },
        });
    });

    it("carries the snapshot's cluster settings of a cluster_settings refusal", async () => {
        const cluster = { gateway_url: "https://k8s.example.org", runtime_image: "" };
        stubFetch(
            new Response(JSON.stringify({ err_msg: "Confirm them.", reason: "cluster_settings", cluster }), {
                status: 409,
            }),
        );
        const error = await browserBackupServices()
            .restore({ file: new Uint8Array([1]) }, { passphrase: "p" })
            .catch((caught: unknown) => caught);
        expect(error).toMatchObject({ reason: "cluster_settings", cluster });
    });

    it("reports an unreachable Service Worker", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );
        await expect(browserBackupServices().getStatus()).rejects.toMatchObject({ status: 0, reason: null });
    });

    it("names the exported file after the response", async () => {
        stubFetch(
            new Response(new Uint8Array([1]), {
                status: 200,
                headers: { "Content-Disposition": 'attachment; filename="planet-a1b2c3d4-x.json.gz.enc"' },
            }),
        );
        const exported = await browserBackupServices().exportSnapshot();
        expect(exported.filename).toBe("planet-a1b2c3d4-x.json.gz.enc");
        expect(exported.blob.size).toBe(1);
    });
});
