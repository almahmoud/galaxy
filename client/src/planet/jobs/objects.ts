/**
 * Bucket objects of the job protocol: JSON documents, the presigned requests of a dataset, tool archives,
 * browser-created multipart uploads and the dispatch record that remembers them between dispatch and ingest.
 */

import { isNotFound, isS3Error, type S3Client } from "@/planet/s3";
import { sha256Hex } from "@/planet/util/digest";

import type { JobDeps } from "./deps";
import {
    datasetObjectKeys,
    extraObjectKey,
    jobObjectKeys,
    metadataFileKey,
    toolArchiveKey,
    toolArchiveStaticPath,
} from "./keys";
import {
    type DataUploadResult,
    type JobKind,
    type ManifestDatasetTargets,
    PROTOCOL_VERSION,
    ProtocolError,
    type ToolBundle,
} from "./schemas";

/** Requests in every dataset's `metadata_files` pool. */
export const METADATA_FILE_POOL = 8;
/** `extra_objects` pool of datasets whose datatype holds reports or media (HTML and composite datatypes). */
export const EXTRA_OBJECT_POOL = 64;
/** Largest object the pod uploads with a single PUT (R2 accepts up to 4.995 GiB). */
export const SINGLE_PUT_LIMIT = Math.floor(4.99 * 1024 ** 3);
/** Declared outputs of jobs whose inputs exceed this size also get a multipart upload. */
export const MULTIPART_INPUT_THRESHOLD = 4 * 1024 ** 3;

const MIB = 1024 ** 2;
const MIN_PART_SIZE = 5 * MIB;
const MAX_PART_SIZE = 5 * 1024 ** 3;
const MULTIPART_PARTS = 1000;
/** Multipart capacity: eight times the job's input size, at least 64 GiB. */
const MIN_MULTIPART_CAPACITY = 64 * 1024 ** 3;
const MULTIPART_CAPACITY_FACTOR = 8;

/**
 * A job that cannot be dispatched. `permanent` errors (invalid parameters, missing records, a tool archive that
 * does not match its bundle) fail the job; others are worth retrying later.
 */
export class DispatchError extends Error {
    constructor(
        message: string,
        readonly permanent: boolean,
    ) {
        super(message);
        this.name = "DispatchError";
    }
}

// ---------------------------------------------------------------------------------------------------------
// JSON documents

/**
 * Reads and parses a JSON object of the bucket.
 *
 * @returns null when the object does not exist
 * @throws ProtocolError when it is not JSON
 */
export async function readJson(s3: S3Client, key: string, signal?: AbortSignal): Promise<unknown> {
    let text: string;
    try {
        text = await (await s3.getObject(key, { signal })).text();
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ProtocolError(key.slice(key.lastIndexOf("/") + 1), "", "not valid JSON");
    }
}

export async function writeJson(s3: S3Client, key: string, value: unknown, signal?: AbortSignal): Promise<void> {
    await s3.putObject(key, JSON.stringify(value), { contentType: "application/json", signal });
}

// ---------------------------------------------------------------------------------------------------------
// Presigned requests

/** Presigns requests for pods: signed for the cluster endpoint, all with the same expiry. */
export class RequestSigner {
    constructor(
        private readonly s3: S3Client,
        readonly expirySeconds: number,
    ) {}

    get(key: string): Promise<string> {
        return this.s3.presignGet(key, this.expirySeconds, { endpoint: "cluster" });
    }

    put(key: string): Promise<string> {
        return this.s3.presignPut(key, this.expirySeconds, { endpoint: "cluster" });
    }

    uploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
        return this.s3.presignUploadPart(key, uploadId, partNumber, this.expirySeconds, { endpoint: "cluster" });
    }
}

/** A multipart upload the browser created for a declared output; the browser completes or aborts it. */
export interface MultipartUpload {
    output: string;
    uuid: string;
    key: string;
    upload_id: string;
    part_size: number;
    parts: number;
}

export interface TargetOptions {
    /** Give a data PUT (false for set-metadata jobs, which do not upload data). */
    data: boolean;
    /** Size of the `extra_objects` pool. */
    extraObjects: number;
    multipart?: MultipartUpload;
}

/** Presigned destinations of a dataset (`#/$defs/dataset_targets`), each to its fixed key under `datasets/<uuid>/`. */
export async function datasetTargets(
    sign: RequestSigner,
    uuid: string,
    options: TargetOptions,
): Promise<ManifestDatasetTargets> {
    const keys = datasetObjectKeys(uuid);
    const range = (count: number) => Array.from({ length: count }, (_, index) => index);
    const [meta, extra, extraIndex, metadataFiles, extraObjects] = await Promise.all([
        sign.put(keys.meta),
        sign.put(keys.extra),
        sign.put(keys.extraIndex),
        Promise.all(range(METADATA_FILE_POOL).map((index) => sign.put(metadataFileKey(uuid, index)))),
        Promise.all(
            range(options.extraObjects).map(async (index) => {
                const key = extraObjectKey(uuid, index);
                return { key, request: await sign.put(key) };
            }),
        ),
    ]);
    const targets: ManifestDatasetTargets = { uuid };
    if (options.data) {
        const data: NonNullable<ManifestDatasetTargets["data"]> = { put: await sign.put(keys.data) };
        const multipart = options.multipart;
        if (multipart) {
            data.multipart = {
                part_size: multipart.part_size,
                parts: await Promise.all(
                    range(multipart.parts).map((index) => sign.uploadPart(keys.data, multipart.upload_id, index + 1)),
                ),
            };
        }
        targets.data = data;
    }
    Object.assign(targets, { meta, extra, extra_index: extraIndex, metadata_files: metadataFiles });
    if (extraObjects.length) {
        targets.extra_objects = extraObjects;
    }
    return targets;
}

// ---------------------------------------------------------------------------------------------------------
// Multipart uploads

/** Uniform part size and count giving room for outputs much larger than the job's inputs. */
export function multipartLayout(inputBytes: number): { partSize: number; parts: number } {
    const capacity = Math.max(MIN_MULTIPART_CAPACITY, inputBytes * MULTIPART_CAPACITY_FACTOR);
    const partSize = Math.min(
        MAX_PART_SIZE,
        Math.max(MIN_PART_SIZE, Math.ceil(capacity / MULTIPART_PARTS / MIB) * MIB),
    );
    return { partSize, parts: Math.min(10_000, Math.ceil(capacity / partSize)) };
}

export async function createMultipartUpload(
    s3: S3Client,
    output: string,
    uuid: string,
    inputBytes: number,
    signal?: AbortSignal,
): Promise<MultipartUpload> {
    const key = datasetObjectKeys(uuid).data;
    const { partSize, parts } = multipartLayout(inputBytes);
    const uploadId = await s3.createMultipartUpload(key, { signal });
    return { output, uuid, key, upload_id: uploadId, part_size: partSize, parts };
}

/**
 * Completes a multipart upload from the parts a pod reports, reading missing ETags from ListParts. Completing an
 * upload that was already completed succeeds when the object exists.
 */
export async function completeMultipartUpload(
    s3: S3Client,
    upload: MultipartUpload,
    reported: NonNullable<DataUploadResult["parts"]>,
    signal?: AbortSignal,
): Promise<void> {
    let parts = [...reported].sort((a, b) => a.part_number - b.part_number);
    try {
        if (parts.some((part) => !part.etag)) {
            const listed = new Map(
                (await s3.listParts(upload.key, upload.upload_id, { signal })).map((p) => [p.partNumber, p.etag]),
            );
            parts = parts.map((part) => ({ ...part, etag: part.etag || listed.get(part.part_number) || null }));
        }
        const missing = parts.find((part) => !part.etag);
        if (missing) {
            throw new Error(`part ${missing.part_number} has no ETag`);
        }
        await s3.completeMultipartUpload(
            upload.key,
            upload.upload_id,
            parts.map((part) => ({ partNumber: part.part_number, etag: part.etag! })),
            { signal },
        );
    } catch (error) {
        if (isS3Error(error, "NoSuchUpload") && (await objectExists(s3, upload.key, signal))) {
            return;
        }
        throw error;
    }
}

/** Aborts uploads, ignoring failures: the bucket's lifecycle rule removes incomplete uploads that remain. */
export async function abortMultipartUploads(
    s3: S3Client,
    uploads: readonly Pick<MultipartUpload, "key" | "upload_id">[],
    signal?: AbortSignal,
): Promise<void> {
    await Promise.allSettled(
        uploads.map((upload) => s3.abortMultipartUpload(upload.key, upload.upload_id, { signal })),
    );
}

async function objectExists(s3: S3Client, key: string, signal?: AbortSignal): Promise<boolean> {
    try {
        await s3.headObject(key, { signal });
        return true;
    } catch (error) {
        if (isNotFound(error)) {
            return false;
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Tool archives

const publishedArchives = new WeakMap<S3Client, Set<string>>();

/**
 * Makes sure the tool's archive is at `tools/<id>/<version>/repo.tar` in the bucket: an object of the expected size
 * is kept, otherwise the build's copy is fetched, checked against the bundle's SHA-256 and uploaded.
 *
 * @returns the key and digest for the manifest's `tool.archive`, or null for tools without an archive
 * @throws DispatchError (permanent) when the build's copy is missing or does not match the bundle
 */
export async function ensureToolArchive(
    deps: Pick<JobDeps, "s3" | "fetchStatic" | "signal">,
    bundle: ToolBundle,
): Promise<{ key: string; sha256: string } | null> {
    const archive = bundle.source?.repo_tar;
    if (!archive) {
        return null;
    }
    const key = toolArchiveKey(bundle.id, bundle.version);
    const published = publishedArchives.get(deps.s3) ?? new Set<string>();
    publishedArchives.set(deps.s3, published);
    if (published.has(`${key}\n${archive.sha256}`)) {
        return { key, sha256: archive.sha256 };
    }
    let present = false;
    try {
        present = (await deps.s3.headObject(key, { signal: deps.signal })).contentLength === archive.size;
    } catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
    }
    if (!present) {
        const response = await deps.fetchStatic(toolArchiveStaticPath(archive.path));
        if (!response.ok) {
            throw new DispatchError(
                `The archive of tool ${bundle.id} ${bundle.version} is not available (HTTP ${response.status}).`,
                response.status === 404,
            );
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== archive.size || (await sha256Hex(bytes)) !== archive.sha256) {
            throw new DispatchError(
                `The archive of tool ${bundle.id} ${bundle.version} does not match its bundle; reload Planet.`,
                true,
            );
        }
        await deps.s3.putObject(key, bytes, { contentType: "application/x-tar", signal: deps.signal });
    }
    published.add(`${key}\n${archive.sha256}`);
    return { key, sha256: archive.sha256 };
}

// ---------------------------------------------------------------------------------------------------------
// Dispatch record

/**
 * What the browser created when it dispatched the current attempt (`jobs/<job>/dispatch.json`): ingest needs the
 * attempt, the slot UUIDs, the allocated resources and the multipart uploads it must complete or abort.
 */
export interface DispatchRecord {
    protocol: typeof PROTOCOL_VERSION;
    job_id: string;
    attempt: number;
    kind: JobKind;
    create_time: string;
    walltime_seconds: number;
    deadline_seconds: number;
    slots: number;
    memory_mb: number | null;
    slot_uuids: string[];
    multipart: MultipartUpload[];
}

function isDispatchRecord(value: unknown, jobId: string): value is DispatchRecord {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Partial<DispatchRecord>;
    return (
        record.protocol === PROTOCOL_VERSION &&
        record.job_id === jobId &&
        Number.isSafeInteger(record.attempt) &&
        Array.isArray(record.slot_uuids) &&
        record.slot_uuids.every((uuid) => typeof uuid === "string") &&
        Array.isArray(record.multipart) &&
        record.multipart.every(
            (upload) =>
                typeof upload?.output === "string" &&
                typeof upload.key === "string" &&
                typeof upload.upload_id === "string" &&
                upload.key === datasetObjectKeys(upload.uuid).data,
        )
    );
}

/** Returns the job's dispatch record, or null when there is none or it is unreadable. */
export async function readDispatchRecord(
    s3: S3Client,
    jobId: string,
    signal?: AbortSignal,
): Promise<DispatchRecord | null> {
    let value: unknown;
    try {
        value = await readJson(s3, jobObjectKeys(jobId).dispatch, signal);
    } catch (error) {
        if (error instanceof ProtocolError) {
            return null;
        }
        throw error;
    }
    try {
        return isDispatchRecord(value, jobId) ? value : null;
    } catch {
        return null;
    }
}

export function writeDispatchRecord(s3: S3Client, record: DispatchRecord, signal?: AbortSignal): Promise<void> {
    return writeJson(s3, jobObjectKeys(record.job_id).dispatch, record, signal);
}
