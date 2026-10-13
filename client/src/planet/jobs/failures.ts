/**
 * Reads how a job pod is doing from Kubernetes status and turns pods that failed without `results.json` into
 * {@link JobFailure}s with Galaxy's messages (`galaxy.jobs.runners.kubernetes`).
 */

import { type ContainerStatus, isKubeError, type Job as KubeJob, type KubeEvent, type Pod } from "@/planet/k8s";
import { isS3Error } from "@/planet/s3";

import { FAILURE_MESSAGES, type JobFailure } from "./ingest";
import { type DispatchKind, STAGE_IN_CONTAINER, STAGE_OUT_CONTAINER, STAGER_CONTAINER, TOOL_CONTAINER } from "./k8sJob";

/** Transient image pull errors are retried by the kubelet for this long before the job fails. */
export const IMAGE_PULL_GRACE_MS = 5 * 60 * 1000;
/** Container configuration errors are given this long to clear (for example a slow volume). */
export const CREATE_CONTAINER_GRACE_MS = 2 * 60 * 1000;

const MAX_DETAIL = 4096;
const IMAGE_NOT_FOUND =
    /not found|manifest unknown|name unknown|repository does not exist|does not exist or may require|404 Not Found/i;
const EXEC_FORMAT = /exec format error/i;

/** The main container of a job's pod, whose start marks the job running. */
export function mainContainer(kind: DispatchKind): string {
    return kind === "tool" ? TOOL_CONTAINER : STAGER_CONTAINER;
}

/** Status of a named container, init containers included. */
export function containerStatus(pod: Pod | undefined, name: string): ContainerStatus | undefined {
    const status = pod?.status;
    return [...(status?.initContainerStatuses ?? []), ...(status?.containerStatuses ?? [])].find(
        (container) => container.name === name,
    );
}

/** True once the container has started (it runs or ran). */
export function containerStarted(pod: Pod | undefined, name: string): boolean {
    const state = containerStatus(pod, name)?.state;
    return Boolean(state?.running || (state?.terminated && state.terminated.reason !== "StartError"));
}

/** The container's terminated state, if it ended. */
export function containerTerminated(pod: Pod | undefined, name: string) {
    return containerStatus(pod, name)?.state?.terminated;
}

/** `Complete` or `Failed` when the Kubernetes Job has finished, else null. */
export function jobOutcome(
    job: KubeJob | undefined,
): { type: "Complete" | "Failed"; reason?: string; message?: string } | null {
    for (const condition of job?.status?.conditions ?? []) {
        if ((condition.type === "Complete" || condition.type === "Failed") && condition.status === "True") {
            return { type: condition.type, reason: condition.reason, message: condition.message };
        }
    }
    return null;
}

/**
 * True for a pod Kubernetes ended for reasons of its own (preemption, node drain, taint eviction): the Job's
 * failure policy ignores it and starts a replacement, whose results count instead.
 */
export function isDisrupted(pod: Pod | undefined): boolean {
    return Boolean(pod?.status?.conditions?.some((c) => c.type === "DisruptionTarget" && c.status === "True"));
}

/**
 * True when the pod has done all it will do: the result document is written or can no longer be. A disrupted
 * pod is not finished; its replacement is awaited.
 */
export function podFinished(kind: DispatchKind, pod: Pod | undefined): boolean {
    if (!pod || isDisrupted(pod)) {
        return false;
    }
    if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") {
        return true;
    }
    const last = kind === "tool" ? STAGE_OUT_CONTAINER : STAGER_CONTAINER;
    if (containerTerminated(pod, last)) {
        return true;
    }
    const stageIn = kind === "tool" ? containerTerminated(pod, STAGE_IN_CONTAINER) : undefined;
    return Boolean(stageIn && stageIn.exitCode !== 0);
}

/** The JSON summary a stager writes as termination message (`stage`, `state`, `error`), if the text is one. */
export function parseTerminationMessage(text: string | undefined): Record<string, unknown> | null {
    if (!text) {
        return null;
    }
    try {
        const value = JSON.parse(text) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** Removes URLs (presigned requests carry signatures in their query) and shortens `text` to `length`. */
function truncate(text: string, length = MAX_DETAIL): string {
    const clean = text.replace(/https?:\/\/\S+/g, "<url>");
    return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}

/** Termination messages and states of every container, for `JobFailure.detail`. */
export function describePod(pod: Pod | undefined): string {
    if (!pod) {
        return "";
    }
    const lines: string[] = [];
    if (pod.status?.reason || pod.status?.message) {
        lines.push(`pod: ${[pod.status.reason, pod.status.message].filter(Boolean).join(": ")}`);
    }
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    for (const status of statuses) {
        const terminated = status.state?.terminated;
        const waiting = status.state?.waiting;
        if (terminated) {
            const message = terminated.message?.trim();
            lines.push(
                `${status.name}: ${terminated.reason ?? "terminated"} (exit code ${terminated.exitCode})` +
                    (message ? `: ${message}` : ""),
            );
        } else if (waiting?.reason) {
            lines.push(`${status.name}: ${waiting.reason}${waiting.message ? `: ${waiting.message}` : ""}`);
        }
    }
    return truncate(lines.join("\n"));
}

function stagerError(pod: Pod | undefined, container: string): string | null {
    const terminated = containerTerminated(pod, container);
    const summary = parseTerminationMessage(terminated?.message);
    if (summary && typeof summary.error === "string" && summary.error) {
        return truncate(summary.error, 1000);
    }
    const text = terminated?.message?.trim();
    return text ? truncate(text, 1000) : null;
}

function scheduled(pod: Pod | undefined): boolean {
    return Boolean(pod?.status?.conditions?.some((c) => c.type === "PodScheduled" && c.status === "True"));
}

/**
 * Classifies a job whose pod finished or whose Kubernetes Job failed without writing `results.json`.
 * `job` and `pod` may be missing (the Job was deleted, or no pod was ever created).
 */
export function classifyFailure(kind: DispatchKind, job: KubeJob | undefined, pod: Pod | undefined): JobFailure {
    const detail = describePod(pod) || undefined;
    const outcome = jobOutcome(job);
    const main = mainContainer(kind);
    const toolEnd = containerTerminated(pod, main);

    if (toolEnd?.reason === "OOMKilled") {
        return { reason: "oom", message: FAILURE_MESSAGES.oom, detail };
    }
    if (toolEnd?.reason === "StartError" || toolEnd?.reason === "ContainerCannotRun") {
        if (EXEC_FORMAT.test(toolEnd.message ?? "")) {
            return {
                reason: "wrong_architecture",
                message:
                    `The tool's container image (${containerStatus(pod, main)?.image ?? "unknown"}) is not built for ` +
                    "the CPU architecture of the node it was scheduled on. Set the architecture policy to amd64-only " +
                    "in Planet's settings, or add amd64 nodes to the cluster.",
                detail,
            };
        }
        return {
            reason: "unknown",
            message: `The tool container could not start: ${toolEnd.message ?? ""}`.trim(),
            detail,
        };
    }
    if (pod?.status?.reason === "Evicted") {
        return {
            reason: "evicted",
            message: `Kubernetes evicted the job's pod: ${pod.status.message ?? "no reason given"}`,
            detail,
        };
    }
    if (outcome?.type === "Failed" && outcome.reason === "DeadlineExceeded") {
        return pod && !scheduled(pod)
            ? { reason: "unschedulable", message: FAILURE_MESSAGES.unschedulable, detail }
            : { reason: "walltime", message: FAILURE_MESSAGES.walltime, detail };
    }
    if (kind === "tool") {
        const stageIn = containerTerminated(pod, STAGE_IN_CONTAINER);
        if (stageIn && stageIn.exitCode !== 0) {
            if (stageIn.reason === "OOMKilled") {
                return { reason: "stage_in", message: "Preparing the job failed: stage-in ran out of memory.", detail };
            }
            const error = stagerError(pod, STAGE_IN_CONTAINER);
            return { reason: "stage_in", message: `Preparing the job failed${error ? `: ${error}` : "."}`, detail };
        }
        const stageOut = containerTerminated(pod, STAGE_OUT_CONTAINER);
        if (stageOut) {
            const error = stagerError(pod, STAGE_OUT_CONTAINER);
            return {
                reason: "stage_out",
                message: `Collecting the job's results failed${error ? `: ${error}` : "."}`,
                detail,
            };
        }
    } else {
        const stager = containerTerminated(pod, STAGER_CONTAINER);
        if (stager) {
            const error = stagerError(pod, STAGER_CONTAINER);
            return {
                reason: "stage_out",
                message: `The ${kind === "upload" ? "upload" : "metadata"} job failed${error ? `: ${error}` : "."}`,
                detail,
            };
        }
    }
    if (outcome?.type === "Failed" && outcome.message) {
        return { reason: "unknown", message: `${FAILURE_MESSAGES.unknown} (${outcome.message})`, detail };
    }
    return { reason: "unknown", message: FAILURE_MESSAGES.unknown, detail };
}

/** Where a waiting container stands: fail now, keep waiting, or nothing to report. */
export type PendingVerdict = { failure: JobFailure } | { waitingSince: string } | null;

/**
 * Checks a pod that has not finished for problems that will not resolve: images that do not exist, pulls that
 * keep failing for {@link IMAGE_PULL_GRACE_MS}, and container configuration errors that last longer than
 * {@link CREATE_CONTAINER_GRACE_MS}. `firstSeen(key)` returns when this leader first saw a waiting reason
 * (milliseconds since the epoch), so grace periods survive repeated checks.
 */
export function pendingFailure(
    pod: Pod | undefined,
    now: number,
    firstSeen: (key: string) => number,
): JobFailure | null {
    if (!pod) {
        return null;
    }
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    for (const status of statuses) {
        const waiting = status.state?.waiting;
        if (!waiting?.reason) {
            continue;
        }
        const key = `${pod.metadata.uid ?? pod.metadata.name}/${status.name}/${waiting.reason}`;
        const message = waiting.message ?? "";
        const image = status.image || "unknown";
        if (waiting.reason === "InvalidImageName") {
            return {
                reason: "image_not_found",
                message: `The container image ${image} is not a valid image name.`,
                detail: truncate(message),
            };
        }
        if (waiting.reason === "ErrImagePull" || waiting.reason === "ImagePullBackOff") {
            if (IMAGE_NOT_FOUND.test(message)) {
                return {
                    reason: "image_not_found",
                    message: `The container image ${image} does not exist or is not public.`,
                    detail: truncate(message),
                };
            }
            if (now - firstSeen(key) >= IMAGE_PULL_GRACE_MS) {
                return {
                    reason: "image_pull",
                    message: `Pulling the container image ${image} failed for ${Math.round(IMAGE_PULL_GRACE_MS / 60000)} minutes.`,
                    detail: truncate(message),
                };
            }
            continue;
        }
        if (waiting.reason === "CreateContainerConfigError" || waiting.reason === "CreateContainerError") {
            if (now - firstSeen(key) >= CREATE_CONTAINER_GRACE_MS) {
                return {
                    reason: "rejected",
                    message: `Kubernetes could not create the ${status.name} container: ${message || waiting.reason}`,
                    detail: describePod(pod) || undefined,
                };
            }
        }
    }
    return null;
}

const QUOTA_PATTERN = /exceeded quota: [^,]+, requested: ([^,]+(?:,[^,:]+=[^,]+)*), used: .*?, limited: (.+)$/s;

function quantities(text: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const part of text.split(",")) {
        const [name, value] = part.split("=");
        if (name && value) {
            result.set(name.trim(), value.trim());
        }
    }
    return result;
}

/** True for a quota rejection that can succeed later, once running jobs free their share. */
export function quotaCanClear(message: string, parse: (quantity: string) => number): boolean {
    const match = QUOTA_PATTERN.exec(message);
    if (!match) {
        return false;
    }
    const requested = quantities(match[1] ?? "");
    const limited = quantities(match[2] ?? "");
    for (const [name, value] of requested) {
        const limit = limited.get(name);
        if (limit !== undefined && parse(value) > parse(limit)) {
            return false;
        }
    }
    return true;
}

/**
 * Reads a Kubernetes Job's events for a pod creation the API server keeps refusing (`FailedCreate`: Pod Security,
 * LimitRange or quota). Returns the failure, null when there is none, or "wait" when only a quota that running
 * jobs will free blocks the pod.
 */
export function failedCreate(
    events: readonly KubeEvent[],
    parse: (quantity: string) => number,
): JobFailure | "wait" | null {
    const failures = events
        .filter((event) => event.reason === "FailedCreate" && event.type !== "Normal")
        .sort((a, b) => eventTime(b) - eventTime(a));
    const latest = failures[0];
    if (!latest) {
        return null;
    }
    const message = latest.message ?? "Kubernetes refused to create the job's pod.";
    if (quotaCanClear(message, parse)) {
        return "wait";
    }
    return {
        reason: "rejected",
        message: `Kubernetes refused to create the job's pod: ${truncate(message, 1000)}`,
        detail: truncate(message),
    };
}

function eventTime(event: KubeEvent): number {
    const time = event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata.creationTimestamp;
    return time ? Date.parse(time) || 0 : 0;
}

/** True when a Kubernetes API error means the request itself is unacceptable, so retrying cannot help. */
export function isRejection(error: unknown): boolean {
    if (!isKubeError(error)) {
        return false;
    }
    if (error.status === 400 || error.status === 422) {
        return true;
    }
    // Admission policies and webhooks deny with 403; plain RBAC denials (also 403) are a settings problem.
    return error.status === 403 && /admission|denied request|denied the request/i.test(error.message);
}

/**
 * True for errors worth retrying: network failures, unavailable or rate-limited services and missing or
 * expired credentials, which the user can fix in the settings without resubmitting.
 */
export function isTransient(error: unknown): boolean {
    if (isKubeError(error)) {
        return !isRejection(error);
    }
    if (isS3Error(error)) {
        return (
            error.status === 0 ||
            error.status === 401 ||
            error.status === 403 ||
            error.status === 408 ||
            error.status === 429 ||
            error.status >= 500
        );
    }
    if (error && typeof error === "object") {
        const { transient, permanent } = error as { transient?: unknown; permanent?: unknown };
        if (typeof transient === "boolean") {
            return transient;
        }
        // The protocol module's DispatchError: not permanent means "not yet" (inputs or uploads not ready).
        if (permanent === false) {
            return true;
        }
    }
    return error instanceof TypeError;
}

/** True for errors that will not go away: the job fails. */
export function isPermanent(error: unknown): boolean {
    if (isRejection(error)) {
        return true;
    }
    return Boolean(error && typeof error === "object" && (error as { permanent?: unknown }).permanent === true);
}

/** A short description of an error for job messages and `last_error`; never includes URLs. */
export function errorMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
    return truncate(text, 1000);
}
