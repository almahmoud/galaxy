/** What the setup page shows about the job runner, the browser tab that sends jobs to the cluster. */

import {
    faCheckCircle,
    faCircleNotch,
    faExclamationTriangle,
    faMinusCircle,
    faPauseCircle,
    faTimesCircle,
} from "@fortawesome/free-solid-svg-icons";

import type { CheckTarget, PlanetStatus } from "./api";
import type { PillInfo } from "./display";

export type RunnerState = "checking" | "not_configured" | "waiting" | "blocked" | "active" | "failing";

export const RUNNER_STATES: Record<RunnerState, PillInfo> = {
    checking: { label: "Checking", tone: "info", icon: faCircleNotch, spin: true },
    not_configured: { label: "Not configured", tone: "neutral", icon: faMinusCircle },
    waiting: { label: "Waiting for a Planet tab", tone: "warning", icon: faPauseCircle },
    blocked: { label: "Blocked", tone: "danger", icon: faTimesCircle },
    active: { label: "Active in this browser", tone: "success", icon: faCheckCircle },
    failing: { label: "Active, with errors", tone: "warning", icon: faExclamationTriangle },
};

/** The card's action: open a setup section, or follow a link. */
export type RunnerAction =
    | { kind: "setup"; target: CheckTarget; label: string }
    | { kind: "link"; href: string; label: string };

export interface RunnerError {
    message: string;
    /** "5 minutes ago", or null when the time is unknown. */
    when: string | null;
    /** Galaxy's page of the job the error concerns. */
    jobHref: string | null;
}

export interface RunnerView {
    state: RunnerState;
    detail: string;
    action: RunnerAction | null;
    error: RunnerError | null;
}

export interface RunnerOptions {
    /** The page is shown inside Galaxy (the welcome frame), so a Planet tab is open. */
    framed: boolean;
    /** Milliseconds since the epoch. */
    now: number;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday"; null for an unreadable time. */
export function timeAgo(iso: string, now: number): string | null {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) {
        return null;
    }
    const seconds = Math.max(0, (now - then) / 1000);
    if (seconds < 60) {
        return "just now";
    }
    if (seconds < 3600) {
        return relative.format(-Math.round(seconds / 60), "minute");
    }
    if (seconds < 86400) {
        return relative.format(-Math.round(seconds / 3600), "hour");
    }
    return relative.format(-Math.round(seconds / 86400), "day");
}

function jobs(count: number): string {
    return count === 1 ? "1 job" : `${count} jobs`;
}

function counts({ queued, running }: PlanetStatus["jobs"]): string {
    if (!queued && !running) {
        return "No jobs are waiting or running.";
    }
    return `${running} running, ${queued} waiting.`;
}

function lastError(status: PlanetStatus, now: number): RunnerError | null {
    const error = status.leader.last_error;
    if (!error) {
        return null;
    }
    return {
        message: error.message,
        when: error.time ? timeAgo(error.time, now) : null,
        jobHref: error.job_id ? `/jobs/${encodeURIComponent(error.job_id)}/view` : null,
    };
}

/** The job runner card for `status`, or its loading state when the status is not known yet. */
export function runnerView(status: PlanetStatus | null, { framed, now }: RunnerOptions): RunnerView {
    if (!status) {
        return { state: "checking", detail: "Loading…", action: null, error: null };
    }
    const error = lastError(status, now);
    const { configured, leader } = status;
    if (!configured.cluster || !configured.storage) {
        return {
            state: "not_configured",
            detail: "Jobs start once the cluster and the storage bucket are connected.",
            action: { kind: "setup", target: configured.cluster ? "storage" : "cluster", label: "Set up" },
            error,
        };
    }
    if (!leader.active) {
        const unfinished = status.jobs.queued + status.jobs.running;
        const waiting = unfinished ? ` ${jobs(unfinished)} ${unfinished === 1 ? "is" : "are"} unfinished.` : "";
        return framed
            ? {
                  state: "waiting",
                  detail: `No Planet tab is running jobs right now; this tab takes over within two minutes.${waiting}`,
                  action: null,
                  error,
              }
            : {
                  state: "waiting",
                  detail: `Jobs run only while Planet is open in a tab of this browser.${waiting}`,
                  action: { kind: "link", href: "/", label: "Open Planet" },
                  error,
              };
    }
    if (leader.state === "blocked") {
        return {
            state: "blocked",
            detail: leader.blocked_reason ?? "The job runner cannot start.",
            action: { kind: "setup", target: "cluster", label: "Review settings" },
            error,
        };
    }
    return {
        state: error ? "failing" : "active",
        detail: `A Planet tab in this browser sends your jobs to the cluster. ${counts(status.jobs)}`,
        action: null,
        error,
    };
}
