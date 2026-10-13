/** Labels and tones for connection states on the setup page. */

import {
    faCheckCircle,
    faCircleNotch,
    faExclamationTriangle,
    faMinusCircle,
    faQuestionCircle,
    faTimesCircle,
} from "@fortawesome/free-solid-svg-icons";

import type { CheckItem, CheckStatus, ComponentState, StorageReport } from "./checks";

/** A component's state as a status card shows it. */
export type CardState = ComponentState | "checking" | "unknown";
export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** What a status pill shows. */
export interface PillInfo {
    label: string;
    tone: Tone;
    icon: typeof faCheckCircle;
    /** Spins the icon while something is in progress. */
    spin?: boolean;
}

export const CARD_STATES: Record<CardState, PillInfo> = {
    ok: { label: "Connected", tone: "success", icon: faCheckCircle },
    warning: { label: "Connected with warnings", tone: "warning", icon: faExclamationTriangle },
    error: { label: "Needs attention", tone: "danger", icon: faTimesCircle },
    not_configured: { label: "Not configured", tone: "neutral", icon: faMinusCircle },
    checking: { label: "Checking", tone: "info", icon: faCircleNotch, spin: true },
    unknown: { label: "Not checked", tone: "neutral", icon: faQuestionCircle },
};

export const CHECK_STATUSES: Record<CheckStatus, PillInfo> = {
    ok: { label: "Passed", tone: "success", icon: faCheckCircle },
    warning: { label: "Warning", tone: "warning", icon: faExclamationTriangle },
    error: { label: "Failed", tone: "danger", icon: faTimesCircle },
    skipped: { label: "Skipped", tone: "neutral", icon: faMinusCircle },
};

/** The first failed check, or the first warning when nothing failed. */
export function firstProblem(checks: readonly CheckItem[]): CheckItem | undefined {
    return checks.find((check) => check.status === "error") ?? checks.find((check) => check.status === "warning");
}

/** True when a report's failures concern the bucket's CORS policy. */
export function needsCorsPolicy(report: StorageReport | null | undefined): boolean {
    return Boolean(report?.cors_suspected && report.cors);
}
