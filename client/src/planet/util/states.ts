import type { components } from "@/api/schema";

export type DatasetState = components["schemas"]["DatasetState"];
export type JobState = components["schemas"]["JobState"];
export type PopulatedState = components["schemas"]["DatasetCollectionPopulatedState"];
export type ValidatedState = components["schemas"]["DatasetValidatedState"];

/** Every dataset state (`galaxy.model.Dataset.states`). */
export const DATASET_STATES: readonly DatasetState[] = [
    "new",
    "upload",
    "queued",
    "running",
    "ok",
    "empty",
    "error",
    "paused",
    "setting_metadata",
    "failed_metadata",
    "deferred",
    "discarded",
];

/** Every job state (`galaxy.model.Job.states`). */
export const JOB_STATES: readonly JobState[] = [
    "new",
    "resubmitted",
    "upload",
    "waiting",
    "queued",
    "running",
    "finishing",
    "ok",
    "error",
    "failed",
    "paused",
    "deleting",
    "deleted",
    "stop",
    "stopped",
    "skipped",
];

/** `Job.terminal_states`: the job will not change state again. */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(["ok", "error", "deleted"]);

/** `Job.finished_states`: terminal states plus `deleting`. */
export const FINISHED_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(["ok", "error", "deleted", "deleting"]);

/** `Job.non_ready_states`: the job has not finished and its outputs may still change. */
export const NON_READY_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
    "new",
    "resubmitted",
    "upload",
    "waiting",
    "queued",
    "running",
    "finishing",
]);

/** `Dataset.terminal_states`. */
export const TERMINAL_DATASET_STATES: ReadonlySet<DatasetState> = new Set<DatasetState>([
    "ok",
    "empty",
    "error",
    "deferred",
    "discarded",
    "failed_metadata",
]);

/** `Dataset.non_ready_states`: data or metadata is still being produced. */
export const NON_READY_DATASET_STATES: ReadonlySet<DatasetState> = new Set<DatasetState>([
    "new",
    "upload",
    "queued",
    "running",
    "setting_metadata",
]);

const DATASET_STATE_SET: ReadonlySet<string> = new Set(DATASET_STATES);
const JOB_STATE_SET: ReadonlySet<string> = new Set(JOB_STATES);

export function isDatasetState(value: unknown): value is DatasetState {
    return typeof value === "string" && DATASET_STATE_SET.has(value);
}

export function isJobState(value: unknown): value is JobState {
    return typeof value === "string" && JOB_STATE_SET.has(value);
}
