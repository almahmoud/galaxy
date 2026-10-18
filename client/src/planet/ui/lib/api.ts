/** Client for Planet's own endpoints, which the Service Worker answers. */

import type { SettingsUpdate } from "@/planet/db/settings";
import type { PlanetSettings } from "@/planet/db/types";

import type { CheckMode, CheckReport } from "./checks";
import type { FieldErrors } from "./rules";
import type { RuntimeSource } from "./runtime";

export type CheckTarget = "cluster" | "storage";

/** Body of `POST /api/planet/settings/check`. `settings` overrides stored values for this check only. */
export interface CheckRequest {
    targets?: CheckTarget[];
    mode?: CheckMode;
    settings?: SettingsUpdate;
}

/** The last error the job runner recorded, kept after the leading tab stopped. */
export interface LeaderError {
    message: string;
    /** The job it concerns, if any. */
    job_id: string | null;
    /** ISO 8601 UTC time, if recorded. */
    time: string | null;
}

/** The job runner: the browser tab that leads job processing, from its heartbeat record. */
export interface LeaderStatus {
    /** A tab of this browser sent a heartbeat recently enough to count as running. */
    active: boolean;
    /** The latest leader epoch, or null before any tab led. */
    epoch: number | null;
    /** Seconds since the last heartbeat, or null without one. */
    heartbeat_age_seconds: number | null;
    /** What the current leader reports (`LeaderStatusRecord`): "idle", "active" or "blocked"; null without one. */
    state: string | null;
    /** Why the leader cannot process jobs, when it reports "blocked". */
    blocked_reason: string | null;
    last_error: LeaderError | null;
}

/** The planet-runtime image job pods run Galaxy's steps in. */
export interface RuntimeStatus {
    image: string;
    source: RuntimeSource;
    /** The image used while the cluster setting is empty: `build_image`, else Planet's fallback tag. */
    default_image: string;
    /** The image this build names (`/static/planet/data/runtime.json`), or null. */
    build_image: string | null;
    /** Whether `image` names a sha256 digest. */
    pinned: boolean;
}

/** `GET /api/planet/status`. */
export interface PlanetStatus {
    configured: { cluster: boolean; storage: boolean };
    build_id: string;
    instance_id: string;
    leader: LeaderStatus;
    /** Unfinished jobs: `queued` have not started yet, `running` are running or finishing. */
    jobs: { queued: number; running: number };
    runtime: RuntimeStatus;
}

export class PlanetApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly errCode: number = 0,
        readonly fieldErrors: FieldErrors = {},
    ) {
        super(message);
        this.name = "PlanetApiError";
    }
}

function fieldErrorsOf(value: unknown): FieldErrors {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
}

/** Calls a Planet endpoint and returns its JSON answer; failures become a {@link PlanetApiError}. */
export async function call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method,
            cache: "no-store",
            credentials: "same-origin",
            headers:
                body === undefined
                    ? { Accept: "application/json" }
                    : { Accept: "application/json", "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new PlanetApiError(0, "Planet did not answer. Reload the page and try again.");
    }
    let data: unknown = null;
    try {
        data = await response.json();
    } catch {
        // Handled below: a successful response must be JSON, an error falls back to its status.
    }
    if (!response.ok) {
        const envelope = (data ?? {}) as { err_msg?: unknown; err_code?: unknown; err_data?: unknown };
        throw new PlanetApiError(
            response.status,
            typeof envelope.err_msg === "string" ? envelope.err_msg : `Planet answered with HTTP ${response.status}.`,
            typeof envelope.err_code === "number" ? envelope.err_code : 0,
            fieldErrorsOf(envelope.err_data),
        );
    }
    if (data === null) {
        throw new PlanetApiError(response.status, "Planet sent an unreadable answer. Reload the page and try again.");
    }
    return data as T;
}

export function getSettings(): Promise<PlanetSettings> {
    return call("GET", "/api/planet/settings");
}

export function saveSettings(change: SettingsUpdate): Promise<PlanetSettings> {
    return call("PUT", "/api/planet/settings", change);
}

export function getStatus(): Promise<PlanetStatus> {
    return call("GET", "/api/planet/status");
}

export function runChecks(request: CheckRequest): Promise<CheckReport> {
    return call("POST", "/api/planet/settings/check", request);
}
