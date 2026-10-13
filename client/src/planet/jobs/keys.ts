/**
 * Bucket keys of the job protocol and the time limits of a job: walltime, the Kubernetes deadline and the expiry of
 * the presigned requests the pod receives. Keys are relative to the configured prefix.
 */

import { datasetKeys } from "@/planet/db/records";
import { MAX_PRESIGN_EXPIRES_SECONDS } from "@/planet/s3";

/** Matches the manifest's `job.id` (manifest.schema.json `#/$defs/job`). */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Characters of tool ids and versions (planet/docs/tool-bundle.md), `/` separating segments. */
const TOOL_SEGMENT_PATTERN = /^[A-Za-z0-9._+@~-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Site directory the build publishes tool archives under (`source.repo_tar.path` is relative to it). */
export const TOOL_REPOS_ROOT = "/static/planet/toolrepos/";

/** Objects of one job. `dispatch` is the browser's own record of what it created for the current attempt. */
export interface JobObjectKeys {
    manifest: string;
    prepare: string;
    results: string;
    stdout: string;
    stderr: string;
    dispatch: string;
}

export function jobObjectKeys(jobId: string): JobObjectKeys {
    if (!JOB_ID_PATTERN.test(jobId)) {
        throw new RangeError(`Invalid job id ${JSON.stringify(jobId)}`);
    }
    const base = `jobs/${jobId}/`;
    return {
        manifest: `${base}manifest.json`,
        prepare: `${base}prepare.json`,
        results: `${base}results.json`,
        stdout: `${base}stdout`,
        stderr: `${base}stderr`,
        dispatch: `${base}dispatch.json`,
    };
}

/** Objects of one dataset. Metadata files and extra objects are numbered by their place in the manifest's pools. */
export interface DatasetObjectKeys {
    data: string;
    meta: string;
    extra: string;
    extraIndex: string;
    prefix: string;
}

export function datasetObjectKeys(uuid: string): DatasetObjectKeys {
    if (!UUID_PATTERN.test(uuid)) {
        throw new RangeError(`Invalid dataset uuid ${JSON.stringify(uuid)}`);
    }
    const { object_key, meta_key } = datasetKeys(uuid);
    const prefix = `datasets/${uuid}/`;
    return { data: object_key, meta: meta_key, extra: `${prefix}extra.tar`, extraIndex: `${prefix}extra.json`, prefix };
}

/** Key of the metadata file stored through the `index`th request of a dataset's `metadata_files` pool. */
export function metadataFileKey(uuid: string, index: number): string {
    return `${datasetObjectKeys(uuid).prefix}meta/${index}`;
}

/** Key of the extra file stored through the `index`th entry of a dataset's `extra_objects` pool. */
export function extraObjectKey(uuid: string, index: number): string {
    return `${datasetObjectKeys(uuid).prefix}extra/${index}`;
}

function toolSegments(toolId: string, version: string): string[] {
    const segments = [...toolId.split("/"), version];
    if (!segments.every((segment) => TOOL_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..")) {
        throw new RangeError(`Invalid tool id or version ${JSON.stringify(`${toolId} ${version}`)}`);
    }
    return segments;
}

/** Key of a tool version's archive (`tools/<id>/<version>/repo.tar`), the path the bundle generator uses too. */
export function toolArchiveKey(toolId: string, version: string): string {
    return `tools/${toolSegments(toolId, version).join("/")}/repo.tar`;
}

/** Site URL path of a curated tool archive, from the bundle's `source.repo_tar.path`. */
export function toolArchiveStaticPath(repoTarPath: string): string {
    const segments = repoTarPath.split("/");
    if (!segments.length || !segments.every((s) => TOOL_SEGMENT_PATTERN.test(s) && s !== "." && s !== "..")) {
        throw new RangeError(`Invalid tool archive path ${JSON.stringify(repoTarPath)}`);
    }
    return TOOL_REPOS_ROOT + segments.map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------------------------------------
// Time limits

/** Presigned requests outlive the Kubernetes deadline by this much (job-protocol.md). */
export const REQUEST_EXPIRY_MARGIN_SECONDS = 3600;
/** The longest deadline whose requests SigV4 can still sign: 7 days minus the margin. */
export const MAX_DEADLINE_SECONDS = MAX_PRESIGN_EXPIRES_SECONDS - REQUEST_EXPIRY_MARGIN_SECONDS;
/**
 * Time the pod needs besides the tool's walltime: scheduling and image pulls, stage-in (transfers retried for up
 * to 10 minutes) and stage-out (up to 30 minutes).
 */
export const DEADLINE_MARGIN_SECONDS = 2 * 3600;
/** Default expiry of the manifest GET: long enough for the pod to be scheduled and its images pulled. */
export const DEFAULT_MANIFEST_EXPIRY_SECONDS = 24 * 3600;
const MIN_WALLTIME_SECONDS = 60;

export interface JobTimeLimits {
    /** The tool container's walltime (`job.walltime_seconds`). */
    walltimeSeconds: number;
    /** The Kubernetes Job's `activeDeadlineSeconds`. */
    deadlineSeconds: number;
    /** Expiry of the requests in the manifest. */
    requestExpirySeconds: number;
    /** Expiry of the manifest GET (`PLANET_MANIFEST_URL`). */
    manifestExpirySeconds: number;
}

/**
 * Derives a job's time limits from the configured walltime. The deadline covers the walltime plus
 * {@link DEADLINE_MARGIN_SECONDS} and never exceeds {@link MAX_DEADLINE_SECONDS}, shortening the walltime when it
 * must; requests expire one hour after the deadline; the manifest GET expires after `manifestExpirySeconds`, never
 * after the deadline.
 */
export function jobTimeLimits(
    walltimeSeconds: number,
    manifestExpirySeconds: number = DEFAULT_MANIFEST_EXPIRY_SECONDS,
): JobTimeLimits {
    const requested = Number.isFinite(walltimeSeconds) ? Math.floor(walltimeSeconds) : MIN_WALLTIME_SECONDS;
    const walltime = Math.min(
        Math.max(requested, MIN_WALLTIME_SECONDS),
        MAX_DEADLINE_SECONDS - DEADLINE_MARGIN_SECONDS,
    );
    const deadline = walltime + DEADLINE_MARGIN_SECONDS;
    const manifest = Number.isFinite(manifestExpirySeconds) ? Math.floor(manifestExpirySeconds) : deadline;
    return {
        walltimeSeconds: walltime,
        deadlineSeconds: deadline,
        requestExpirySeconds: deadline + REQUEST_EXPIRY_MARGIN_SECONDS,
        manifestExpirySeconds: Math.min(Math.max(manifest, 1), deadline),
    };
}
