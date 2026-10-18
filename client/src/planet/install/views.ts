/**
 * What the tool installation endpoints (`api/toolshed.ts`) report: installation jobs and installed tools, in shapes the
 * welcome page shows as they are. Every string comes from a repository or a pod and is shown as text only.
 */

import type { JobRecord, JobState, ToolRecord } from "@/planet/db/types";

import { type InstallSource, parseInstallSource, sourceLabel, sourcePageUrl, sourceRevision } from "./source";

/** What became of one tool file of a repository (`results.json` `tools`, as ingest checked it). */
export interface InstallToolOutcome {
    /** The tool file, relative to the repository root. */
    path: string;
    id: string | null;
    version: string | null;
    name: string | null;
    /** `installed`: in the tool panel; `rejected`: Planet cannot run it; `failed`: it could not be read or stored. */
    state: "installed" | "rejected" | "failed";
    errors: string[];
    warnings: string[];
}

/**
 * An installation as people see it: `queued` until its pod runs, `running`, then `installed` (every tool),
 * `partial` (some tools), `failed` (none, or the job failed) or `cancelled`.
 */
export type InstallPhase = "queued" | "running" | "installed" | "partial" | "failed" | "cancelled";

export interface InstallView {
    /** The installation's job id. */
    id: string;
    state: JobState;
    phase: InstallPhase;
    source: InstallSource | null;
    /** `owner/name` of the repository. */
    label: string;
    /** The changeset or commit as requested; `revision` once the pod resolved it. */
    requested_revision: string | null;
    revision: string | null;
    page_url: string | null;
    create_time: string;
    update_time: string;
    /** Why the installation failed, or what it reported first. */
    message: string | null;
    tools: InstallToolOutcome[];
}

export interface InstalledToolView {
    id: string;
    version: string;
    name: string;
    description: string | null;
    /** `owner/name` of the repository it came from, or null when the bundle does not say. */
    repository: string | null;
    revision: string | null;
    page_url: string | null;
    install_time: string;
}

/** The install job's state as stored by ingest in `params`. */
export interface InstallParams {
    source: InstallSource;
    /** Set by ingest. */
    revision?: string | null;
    tools?: InstallToolOutcome[];
    /** Set when someone dismissed the finished installation from the list. */
    dismissed?: boolean;
}

export const QUEUED_STATES: readonly JobState[] = ["new", "upload", "waiting", "queued", "resubmitted"];
export const RUNNING_STATES: readonly JobState[] = ["running", "finishing"];
export const CANCELLED_STATES: readonly JobState[] = ["deleting", "deleted", "stop", "stopped"];
/** States in which an installation can still change. */
export const UNFINISHED_STATES: readonly JobState[] = [...QUEUED_STATES, ...RUNNING_STATES];

const MAX_MESSAGE_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Outcomes stored in a job's `params.tools`, skipping malformed ones. */
export function storedOutcomes(value: unknown): InstallToolOutcome[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter(isRecord).flatMap((item): InstallToolOutcome[] => {
        const state = item.state;
        if (typeof item.path !== "string" || (state !== "installed" && state !== "rejected" && state !== "failed")) {
            return [];
        }
        return [
            {
                path: item.path,
                id: stringOrNull(item.id),
                version: stringOrNull(item.version),
                name: stringOrNull(item.name),
                state,
                errors: strings(item.errors),
                warnings: strings(item.warnings),
            },
        ];
    });
}

function storedSource(params: Record<string, unknown>): InstallSource | null {
    try {
        return parseInstallSource(params.source);
    } catch {
        return null;
    }
}

function firstMessage(job: JobRecord): string | null {
    for (const message of job.job_messages) {
        if (isRecord(message) && typeof message.desc === "string" && message.desc.trim()) {
            return message.desc;
        }
    }
    const stderr = job.job_stderr?.trim().split("\n")[0];
    return job.info || stderr || null;
}

export function installPhase(state: JobState, tools: readonly InstallToolOutcome[]): InstallPhase {
    if (QUEUED_STATES.includes(state)) {
        return "queued";
    }
    if (RUNNING_STATES.includes(state)) {
        return "running";
    }
    if (CANCELLED_STATES.includes(state)) {
        return "cancelled";
    }
    const installed = tools.filter((tool) => tool.state === "installed").length;
    if (state !== "ok" || !installed) {
        return "failed";
    }
    return installed === tools.length ? "installed" : "partial";
}

export function installView(job: JobRecord): InstallView {
    const params = isRecord(job.params) ? job.params : {};
    const source = storedSource(params);
    const tools = storedOutcomes(params.tools);
    const phase = installPhase(job.state, tools);
    const message = phase === "queued" || phase === "running" ? job.info : firstMessage(job);
    return {
        id: job.id,
        state: job.state,
        phase,
        source,
        label: source ? sourceLabel(source) : "Unknown repository",
        requested_revision: source ? sourceRevision(source) : null,
        revision: stringOrNull(params.revision),
        page_url: source ? sourcePageUrl(source) : null,
        create_time: job.create_time,
        update_time: job.update_time,
        message: message ? message.slice(0, MAX_MESSAGE_LENGTH) : null,
        tools,
    };
}

/** A ToolRecord of an installed tool as the installed tools list shows it, or null for other records. */
export function installedToolView(record: ToolRecord): InstalledToolView | null {
    if (record.source !== "installed" || record.status !== "ready" || !isRecord(record.bundle)) {
        return null;
    }
    const bundle = record.bundle;
    const repository = isRecord(bundle.tool_shed_repository) ? bundle.tool_shed_repository : null;
    const origin = isRecord(bundle.source) ? bundle.source : null;
    const owner = stringOrNull(repository?.owner);
    const name = stringOrNull(repository?.name);
    const url = stringOrNull(origin?.repository);
    let label: string | null = owner && name ? `${owner}/${name}` : null;
    if (!label && url?.startsWith("https://github.com/")) {
        label = url.slice("https://github.com/".length);
    }
    const revision = stringOrNull(repository?.changeset_revision) ?? stringOrNull(origin?.commit);
    return {
        id: record.tool_id,
        version: record.tool_version,
        name: stringOrNull(bundle.name) ?? record.tool_id,
        description: stringOrNull(bundle.description),
        repository: label,
        revision,
        page_url: url && /^https:\/\/[^/]+\//.test(url) ? url : null,
        install_time: record.create_time,
    };
}
