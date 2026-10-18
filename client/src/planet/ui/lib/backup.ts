/** Client for the backup endpoints (`/api/planet/backup*`) and what the setup page shows about backups. */

import {
    faCheckCircle,
    faCircleNotch,
    faClock,
    faExclamationTriangle,
    faMinusCircle,
    faQuestionCircle,
    faTimesCircle,
} from "@fortawesome/free-solid-svg-icons";
import { inject, type InjectionKey } from "vue";

import { toBase64 } from "@/planet/backup/format";

import { PlanetApiError } from "./api";
import type { PillInfo } from "./display";

/** `GET /api/planet/backup`. Times are ISO 8601 UTC. */
export interface BackupStatus {
    passphrase: { set: boolean; key_id: string | null; created: string | null };
    storage_configured: boolean;
    instance_id: string;
    device_id: string;
    /** IndexedDB schema version of this build; only snapshots of the same version can be restored. */
    schema_version: number;
    interval_minutes: number;
    /** Snapshots kept per instance. */
    keep: number;
    last_snapshot: { name: string; time: string; size: number; counts: Record<string, number> } | null;
    /** When the job runner last compared the records with the last snapshot. */
    checked: string | null;
    last_error: { message: string; time: string } | null;
    /** A snapshot was requested and not written yet. */
    requested: boolean;
    /** The lease as this device last read it: `conflict` when another device writes the instance's snapshots. */
    lease: { state: "held" | "conflict"; device_id: string; renewed: string | null; checked: string } | null;
    /** A Planet tab leads job processing, so snapshots are written. */
    writer_active: boolean;
    local: { has_content: boolean; unfinished_jobs: number };
    restored: { instance_id: string; created: string; time: string; forked_to: string | null } | null;
}

export interface BucketSnapshot {
    /** File name under `state/<instance>/snapshots/`. */
    name: string;
    time: string;
    /** Bytes. */
    size: number;
}

export interface BucketInstance {
    instance_id: string;
    /** This device's instance. */
    current: boolean;
    latest: {
        snapshot: string;
        time: string;
        size: number;
        schema_version: number;
        counts: Record<string, number>;
    } | null;
    lease: { device_id: string; renewed: string; this_device: boolean } | null;
    /** Newest first. */
    snapshots: BucketSnapshot[];
}

/** `GET /api/planet/backup/snapshots`. */
export interface SnapshotListing {
    instances: BucketInstance[];
    /** More instances exist than were listed. */
    truncated: boolean;
}

/** Body of `POST /api/planet/backup`. */
export type BackupAction =
    | { action: "snapshot" }
    | { action: "set_passphrase"; passphrase: string; current_passphrase?: string }
    | { action: "remove_passphrase" }
    | { action: "take_over" }
    | { action: "fork" };

/** Where a restore reads its snapshot from. */
export type RestoreSource = { file: Uint8Array } | { bucket: { instance_id: string; name: string } };

export interface RestoreOptions {
    passphrase: string;
    /** Restore as a new instance instead of continuing the snapshot's instance here. */
    fork?: boolean;
    /** Replace records of this device that are in no snapshot. */
    replace_unsaved?: boolean;
    /** Continue the instance here although another device holds its lease. */
    take_over?: boolean;
}

/** Body of `POST /api/planet/backup/restore`: `snapshot` (the file as base64) or `bucket`. */
export interface RestoreRequest extends RestoreOptions {
    snapshot?: string;
    bucket?: { instance_id: string; name: string };
}

export interface RestoreResponse {
    instance_id: string;
    source_instance_id: string;
    created: string;
    forked: boolean;
    failed_jobs: number;
    counts: Record<string, number>;
}

/** Why a backup request failed: `reason` is a backup error code; `lease` comes with `lease_conflict`. */
export class BackupApiError extends PlanetApiError {
    constructor(
        status: number,
        message: string,
        readonly reason: string | null,
        readonly lease: { device_id: string; renewed: string } | null = null,
    ) {
        super(status, message);
        this.name = "BackupApiError";
    }
}

function leaseOf(value: unknown): { device_id: string; renewed: string } | null {
    const lease = value as { device_id?: unknown; renewed?: unknown } | null | undefined;
    return typeof lease?.device_id === "string" && typeof lease.renewed === "string"
        ? { device_id: lease.device_id, renewed: lease.renewed }
        : null;
}

async function failure(response: Response): Promise<BackupApiError> {
    const envelope = (await response.json().catch(() => ({}))) as {
        err_msg?: unknown;
        reason?: unknown;
        lease?: unknown;
    } | null;
    return new BackupApiError(
        response.status,
        typeof envelope?.err_msg === "string" ? envelope.err_msg : `Planet answered with HTTP ${response.status}.`,
        typeof envelope?.reason === "string" ? envelope.reason : null,
        leaseOf(envelope?.lease),
    );
}

const UNREACHABLE = "Planet did not answer. Reload the page and try again.";

async function send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...init });
    } catch {
        throw new BackupApiError(0, UNREACHABLE, null);
    }
    if (!response.ok) {
        throw await failure(response);
    }
    return response;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await send(path, {
        method,
        headers:
            body === undefined
                ? { Accept: "application/json" }
                : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
        return (await response.json()) as T;
    } catch {
        throw new BackupApiError(
            response.status,
            "Planet sent an unreadable answer. Reload the page and try again.",
            null,
        );
    }
}

/** Everything the backup section calls outside itself; tests provide their own under {@link BACKUP_SERVICES}. */
export interface BackupServices {
    getStatus(): Promise<BackupStatus>;
    act(action: BackupAction): Promise<BackupStatus>;
    listSnapshots(): Promise<SnapshotListing>;
    restore(source: RestoreSource, options: RestoreOptions): Promise<RestoreResponse>;
    /** An encrypted snapshot of this device's records, made with the stored passphrase. */
    exportSnapshot(): Promise<{ blob: Blob; filename: string }>;
    /** Reads a file the user picked. */
    readFile(file: File): Promise<Uint8Array>;
    /** Offers a file to the user to save. */
    save(blob: Blob, filename: string): void;
    /** Reloads Planet after a restore (the whole Galaxy page when this page is its welcome frame). */
    reload(): void;
}

export const BACKUP_SERVICES: InjectionKey<BackupServices> = Symbol("planet-backup-services");

function filenameOf(response: Response): string {
    const match = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
    return match?.[1] ?? "planet-snapshot.json.gz.enc";
}

export function browserBackupServices(): BackupServices {
    return {
        getStatus: () => call("GET", "/api/planet/backup"),
        act: (action) => call("POST", "/api/planet/backup", action),
        listSnapshots: () => call("GET", "/api/planet/backup/snapshots"),
        restore(source, options) {
            const request: RestoreRequest =
                "file" in source
                    ? { ...options, snapshot: toBase64(source.file) }
                    : { ...options, bucket: source.bucket };
            return call("POST", "/api/planet/backup/restore", request);
        },
        async exportSnapshot() {
            const response = await send("/api/planet/backup/export", { method: "GET" });
            return { blob: await response.blob(), filename: filenameOf(response) };
        },
        async readFile(file) {
            return new Uint8Array(await file.arrayBuffer());
        },
        save(blob, filename) {
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.rel = "noopener";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        },
        reload() {
            try {
                if (window.top && window.top !== window.self) {
                    window.top.location.reload();
                    return;
                }
            } catch {
                // A cross-origin parent: reload this page only.
            }
            window.location.reload();
        },
    };
}

export function useBackupServices(): BackupServices {
    const services = inject(BACKUP_SERVICES, null);
    if (!services) {
        throw new Error("The setup page's backup services are not provided.");
    }
    return services;
}

const UNITS = ["bytes", "kB", "MB", "GB"] as const;

/** "512 bytes", "1.4 MB" (decimal units). */
export function formatSize(bytes: number): string {
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < UNITS.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** "13 Oct 2026, 14:05" in the browser's time zone. */
export function formatTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** "3 histories, 12 datasets, 4 jobs" from snapshot record counts. */
export function describeCounts(counts: Record<string, number>): string {
    const parts: [number, string, string][] = [
        [counts.histories ?? 0, "history", "histories"],
        [counts.hdas ?? 0, "dataset", "datasets"],
        [counts.hdcas ?? 0, "collection", "collections"],
        [counts.jobs ?? 0, "job", "jobs"],
    ];
    return parts.map(([count, one, many]) => `${count} ${count === 1 ? one : many}`).join(", ");
}

/** The state of the backup section's pill. */
export type BackupState = "loading" | "unavailable" | "not_set_up" | "conflict" | "error" | "waiting" | "ok";

export const BACKUP_STATES: Record<BackupState, PillInfo> = {
    loading: { label: "Checking", tone: "info", icon: faCircleNotch, spin: true },
    unavailable: { label: "Unknown", tone: "neutral", icon: faQuestionCircle },
    not_set_up: { label: "Not set up", tone: "neutral", icon: faMinusCircle },
    conflict: { label: "Another device", tone: "warning", icon: faExclamationTriangle },
    error: { label: "Failing", tone: "danger", icon: faTimesCircle },
    waiting: { label: "Waiting", tone: "info", icon: faClock },
    ok: { label: "Backed up", tone: "success", icon: faCheckCircle },
};

export function backupState(status: BackupStatus | null, failed: boolean): BackupState {
    if (!status) {
        return failed ? "unavailable" : "loading";
    }
    if (!status.passphrase.set || !status.storage_configured) {
        return "not_set_up";
    }
    if (status.lease?.state === "conflict") {
        return "conflict";
    }
    if (status.last_error) {
        return "error";
    }
    if (!status.last_snapshot || status.requested) {
        return "waiting";
    }
    return "ok";
}

/** A fresh device: the bucket is set up but nothing was made or restored here yet. */
export function offersRestore(status: BackupStatus | null): boolean {
    return Boolean(status?.storage_configured && !status.local.has_content && !status.restored);
}

/** One line on what the snapshots are doing. */
export function backupSummary(status: BackupStatus): string {
    if (!status.storage_configured) {
        return "Set up the storage bucket; snapshots are written there.";
    }
    if (!status.passphrase.set) {
        return "Choose a passphrase to encrypt snapshots of Planet's records in your bucket.";
    }
    if (status.lease?.state === "conflict") {
        return "Another device writes this instance's snapshots, so this device does not.";
    }
    const last = status.last_snapshot
        ? `Last snapshot ${formatTime(status.last_snapshot.time)}, ${formatSize(status.last_snapshot.size)}.`
        : "No snapshot yet.";
    if (!status.writer_active) {
        return `${last} Snapshots are written while a Planet tab is open.`;
    }
    if (status.requested) {
        return `${last} A snapshot is being written.`;
    }
    return `${last} Checked for changes every ${status.interval_minutes} minutes.`;
}

/** The message to show for a failed request. */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
