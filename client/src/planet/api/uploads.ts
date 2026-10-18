/**
 * Uploads: Planet's upload sessions and Galaxy's `POST /api/tools/fetch`.
 *
 * - `POST /api/planet/uploads`: creates an upload session (`UploadRecord`) and, for files larger than one part, an S3
 *   multipart upload of `uploads/<id>`; answers with presigned URLs for the first parts. A request whose fingerprint
 *   matches an unfinished session resumes it, listing the parts the bucket already holds.
 * - `POST /api/planet/uploads/{id}/parts`: presigned URLs for more parts, or fresh ones for expiring URLs.
 * - `POST /api/planet/uploads/{id}/complete`: completes the upload and checks the object's size.
 * - `DELETE /api/planet/uploads/{id}`: aborts the upload and deletes what it stored.
 * - `POST /api/tools/fetch`: Galaxy's data fetch (`ToolsService.create_fetch` and `FetchUploadToolAction`): one
 *   `__DATA_FETCH__` job whose request names upload sessions with `"src": "planet"`, the pre-created datasets
 *   (`queued`, extension `auto` unless requested) and collections, and a `dispatch` outbox entry for the leader tab.
 *
 * The page sends the bytes to the bucket itself (`@/planet/upload`); the worker only signs URLs and makes the small
 * S3 requests that manage the upload (architecture invariant 3).
 */

import {
    collections,
    CONTENT_STORES,
    type DatasetRecord,
    type HdaRecord,
    hdas,
    type HdcaRecord,
    histories,
    JOB_STORES,
    type JobOutputAssociation,
    type JobOutputCollectionAssociation,
    type JobRecord,
    jobs,
    outbox,
    readTx,
    type UploadPartRecord,
    type UploadRecord,
    uploads,
    withTransaction,
    type WriteTx,
} from "@/planet/db";
import { uploadLimitProblem } from "@/planet/jobs/limits";
import { isNotFound, isS3Error, type S3Client } from "@/planet/s3";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import {
    type CompleteUploadResponse,
    MAX_OBJECT_SIZE,
    partBytes,
    partLayout,
    type PartUrl,
    type PresignPartsResponse,
    type UploadedPart,
    UPLOADS_PATH,
    type UploadSession,
} from "@/planet/upload/protocol";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { newId } from "@/planet/util/ids";

import { GALAXY_VERSION_MAJOR } from "./configuration";
import {
    asObject,
    ContentLoader,
    type DatatypeInfo,
    hdaElementObject,
    loadDatatypeInfo,
    normalizeTags,
    serializeHdcaInstance,
} from "./contents";
import { getStorageClient } from "./datasets";

/** Lifetime of presigned part URLs. The page renews them before they expire. */
export const PART_URL_SECONDS = 3600;
/** Part URLs handed out with a new session. */
export const INITIAL_PART_URLS = 16;
/** Part URLs one `/parts` request may ask for. */
export const MAX_PART_URLS = 100;

/** Galaxy's data fetch tool (`lib/galaxy/tools/data_fetch.xml`). */
export const DATA_FETCH_TOOL_ID = "__DATA_FETCH__";
export const DATA_FETCH_TOOL_VERSION = "0.1.0";

const MAX_TEXT_LENGTH = 4096;
const OPEN_STATES: ReadonlySet<UploadRecord["state"]> = new Set(["pending", "uploading"]);
const UPLOAD_STORES = [...JOB_STORES, "uploads"] as const;
const SERIALIZER_STORES = [...CONTENT_STORES, "jobs"] as const;

/** Galaxy's `COLLECTION_TYPE_REGEX`. */
const COLLECTION_TYPE = new RegExp(
    "^((list|paired|paired_or_unpaired|record)(:(list|paired|paired_or_unpaired|record))*" +
        "|sample_sheet|sample_sheet:paired|sample_sheet:record|sample_sheet:paired_or_unpaired)$",
);
/** URL schemes the upload pod fetches (`validate_and_normalize_targets` plus Galaxy's stock file sources). */
const URL_SCHEMES = ["http://", "https://", "ftp://", "ftps://", "base64://", "drs://", "zip://"];
/** Hash keys `replace_request_syntax_sugar` turns into `hashes` entries. */
const HASH_FUNCTIONS = ["MD5", "SHA-1", "SHA-256", "SHA-512"];
/** Element sources that derive their elements from an archive and cannot be linked to. */
const TRANSIENT_ELEMENTS_FROM = new Set(["archive", "bagit_archive"]);
/** Names `data_fetch.py` gives datasets that have none. */
const PASTED_NAME = "Pasted Entry";
const COMPOSITE_NAME = "Composite Dataset";
const UNNAMED_COLLECTION = "unnamed collection";

// ---------------------------------------------------------------------------------------------------------
// Storage

const calibrated = new WeakSet<S3Client>();

function invalid(message: string): ApiError {
    return ApiError.badRequest(message);
}

/** Converts a storage failure to a Galaxy error. S3 errors never carry presigned URLs. */
function storageFailure(error: unknown, action: string): ApiError {
    if (error instanceof ApiError) {
        return error;
    }
    if (isS3Error(error)) {
        if (error.code === "invalid_config") {
            return new ApiError(
                501,
                `Dataset storage is not configured correctly: ${error.message}`,
                ErrorCodes.SERVER_NOT_CONFIGURED_FOR_REQUEST,
            );
        }
        if (error.code === "network_blocked") {
            return new ApiError(502, error.message, ErrorCodes.UPSTREAM_PROXY_ERROR);
        }
        return new ApiError(
            502,
            `Your bucket refused to ${action}: ${error.code} (${error.message})`,
            ErrorCodes.UPSTREAM_PROXY_ERROR,
        );
    }
    console.error("Planet upload storage request failed", error);
    return new ApiError(502, `Could not ${action}.`, ErrorCodes.UPSTREAM_PROXY_ERROR);
}

/** Corrects the client's clock from the bucket's Date header before the first URL it signs. */
async function calibrate(client: S3Client, key: string): Promise<void> {
    if (calibrated.has(client)) {
        return;
    }
    try {
        await client.headObject(key);
    } catch (error) {
        if (!isNotFound(error)) {
            throw storageFailure(error, "answer a request");
        }
    }
    calibrated.add(client);
}

function partCountOf(record: UploadRecord): number {
    return Math.max(1, Math.ceil(record.size / record.part_size));
}

async function presignParts(
    client: S3Client,
    record: UploadRecord,
    partNumbers: readonly number[],
): Promise<PartUrl[]> {
    try {
        return await Promise.all(
            partNumbers.map(async (partNumber) => ({
                part_number: partNumber,
                url: record.upload_id
                    ? await client.presignUploadPart(record.key, record.upload_id, partNumber, PART_URL_SECONDS)
                    : await client.presignPut(record.key, PART_URL_SECONDS),
            })),
        );
    } catch (error) {
        throw storageFailure(error, "sign upload URLs");
    }
}

function missingParts(record: UploadRecord, uploaded: readonly UploadedPart[], limit: number): number[] {
    const done = new Set(uploaded.map((part) => part.part_number));
    const out: number[] = [];
    for (let partNumber = 1; partNumber <= partCountOf(record) && out.length < limit; partNumber++) {
        if (!done.has(partNumber)) {
            out.push(partNumber);
        }
    }
    return out;
}

async function sessionOf(client: S3Client, record: UploadRecord, uploaded: UploadedPart[]): Promise<UploadSession> {
    return {
        id: record.id,
        mode: record.upload_id ? "multipart" : "single",
        part_size: record.part_size,
        part_count: partCountOf(record),
        parts: await presignParts(client, record, missingParts(record, uploaded, INITIAL_PART_URLS)),
        expires_in: PART_URL_SECONDS,
        uploaded,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Upload sessions

/** Reads a JSON body sent by Planet's page module; a JSON content type keeps out bodies an HTML form can produce. */
async function pageJson(request: PlanetRequest): Promise<Record<string, unknown>> {
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
        throw invalid("Send this request with fetch and Content-Type: application/json.");
    }
    return asObject(await request.json());
}

function optionalText(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key] ?? null;
    if (value !== null && (typeof value !== "string" || value.length > MAX_TEXT_LENGTH)) {
        throw invalid(`${key} must be a string of at most ${MAX_TEXT_LENGTH} characters or null`);
    }
    return value || null;
}

interface CreateInput {
    name: string;
    size: number;
    content_type: string | null;
    history_id: string | null;
    fingerprint: string | null;
}

function parseCreate(payload: Record<string, unknown>): CreateInput {
    const { size } = payload;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw invalid("size must be a non-negative integer");
    }
    if (size > MAX_OBJECT_SIZE) {
        throw invalid("Files larger than 5 TiB cannot be uploaded.");
    }
    const name = optionalText(payload, "name");
    if (name === null) {
        throw invalid("name must be a non-empty string");
    }
    return {
        name,
        size,
        content_type: optionalText(payload, "content_type"),
        history_id: optionalText(payload, "history_id"),
        fingerprint: optionalText(payload, "fingerprint"),
    };
}

/** Parts the bucket holds for a multipart upload, keeping only those of the expected size. */
async function storedParts(client: S3Client, record: UploadRecord): Promise<UploadedPart[] | null> {
    let listed;
    try {
        listed = await client.listParts(record.key, record.upload_id!);
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw storageFailure(error, "list the parts of an upload");
    }
    const count = partCountOf(record);
    return listed
        .filter(
            (part) =>
                part.partNumber >= 1 &&
                part.partNumber <= count &&
                part.etag !== "" &&
                part.size === partBytes(record.size, record.part_size, part.partNumber),
        )
        .map((part) => ({ part_number: part.partNumber, etag: part.etag, size: part.size }));
}

/** Resumes the newest unfinished session for the same file, or returns null. */
async function resume(client: S3Client, input: CreateInput): Promise<UploadSession | null> {
    const open = [...(await uploads.listByState("pending")), ...(await uploads.listByState("uploading"))]
        .filter(
            (record) =>
                record.fingerprint === input.fingerprint &&
                record.size === input.size &&
                record.name === input.name &&
                record.history_id === input.history_id,
        )
        .sort((a, b) => (a.update_time < b.update_time ? 1 : a.update_time > b.update_time ? -1 : 0));
    for (const record of open) {
        let uploaded: UploadedPart[] = [];
        if (record.upload_id) {
            const stored = await storedParts(client, record);
            if (stored === null) {
                await uploads.update(record.id, { state: "aborted", message: "The upload expired in the bucket." });
                continue;
            }
            uploaded = stored;
        } else {
            await calibrate(client, record.key);
        }
        const parts: UploadPartRecord[] = uploaded.map(({ part_number, etag, size }) => ({ part_number, etag, size }));
        const resumed = await uploads.update(record.id, { state: "uploading", parts });
        return sessionOf(client, resumed, uploaded);
    }
    return null;
}

async function createUpload(request: PlanetRequest): Promise<UploadSession> {
    const input = parseCreate(await pageJson(request));
    const client = await getStorageClient();
    if (input.fingerprint) {
        const resumed = await resume(client, input);
        if (resumed) {
            return resumed;
        }
    }
    const { partSize, multipart } = partLayout(input.size);
    const id = newId();
    const key = `uploads/${id}`;
    let uploadId: string | null = null;
    if (multipart) {
        try {
            uploadId = await client.createMultipartUpload(key);
        } catch (error) {
            throw storageFailure(error, "start an upload");
        }
        calibrated.add(client);
    } else {
        await calibrate(client, key);
    }
    const record = await uploads.create({
        id,
        key,
        name: input.name,
        size: input.size,
        content_type: input.content_type,
        history_id: input.history_id,
        fingerprint: input.fingerprint,
        upload_id: uploadId,
        part_size: partSize,
    });
    return sessionOf(client, record, []);
}

function openRecord(record: UploadRecord): UploadRecord {
    if (!OPEN_STATES.has(record.state)) {
        throw ApiError.conflict(`The upload session is ${record.state}.`);
    }
    return record;
}

function parsePartNumbers(payload: Record<string, unknown>, count: number): number[] {
    const numbers = payload.part_numbers;
    if (
        !Array.isArray(numbers) ||
        numbers.length === 0 ||
        numbers.length > MAX_PART_URLS ||
        !numbers.every((value) => Number.isInteger(value) && value >= 1 && value <= count)
    ) {
        throw invalid(`part_numbers must list 1 to ${MAX_PART_URLS} part numbers from 1 to ${count}`);
    }
    return [...new Set(numbers as number[])];
}

async function renewParts(request: PlanetRequest): Promise<PresignPartsResponse> {
    const payload = await pageJson(request);
    let record = openRecord(await uploads.getOrThrow(request.params.upload_id!));
    const partNumbers = parsePartNumbers(payload, partCountOf(record));
    const client = await getStorageClient();
    await calibrate(client, record.key);
    if (record.state === "pending") {
        record = await uploads.update(record.id, { state: "uploading" });
    }
    return { parts: await presignParts(client, record, partNumbers), expires_in: PART_URL_SECONDS };
}

function parseCompletedParts(payload: Record<string, unknown>, count: number): { partNumber: number; etag: string }[] {
    const parts = payload.parts;
    if (!Array.isArray(parts) || parts.length !== count) {
        throw invalid(`parts must list all ${count} parts of the upload`);
    }
    const seen = new Set<number>();
    const out = parts.map((part: unknown) => {
        const entry = typeof part === "object" && part !== null ? (part as Record<string, unknown>) : {};
        const partNumber = entry.part_number;
        const etag = entry.etag;
        if (!Number.isInteger(partNumber) || (partNumber as number) < 1 || (partNumber as number) > count) {
            throw invalid(`part_number must be an integer from 1 to ${count}`);
        }
        if (typeof etag !== "string" || !etag || etag.length > 256) {
            throw invalid(`Part ${partNumber} has no ETag`);
        }
        if (seen.has(partNumber as number)) {
            throw invalid(`Part ${partNumber} is listed more than once`);
        }
        seen.add(partNumber as number);
        return { partNumber: partNumber as number, etag };
    });
    return out.sort((a, b) => a.partNumber - b.partNumber);
}

async function failUpload(record: UploadRecord, client: S3Client, message: string): Promise<never> {
    await uploads.update(record.id, { state: "failed", message });
    await client.deleteObject(record.key).catch(() => undefined);
    throw invalid(message);
}

async function completeUpload(request: PlanetRequest): Promise<CompleteUploadResponse> {
    const payload = await pageJson(request);
    const record = await uploads.getOrThrow(request.params.upload_id!);
    if (record.state === "uploaded") {
        return { id: record.id, state: "uploaded", size: record.size };
    }
    openRecord(record);
    const count = partCountOf(record);
    const parts = parseCompletedParts(payload, count);
    const client = await getStorageClient();
    if (record.upload_id) {
        try {
            await client.completeMultipartUpload(record.key, record.upload_id, parts);
        } catch (error) {
            // A completion whose response was lost leaves the object in place; the size check below decides.
            if (!isS3Error(error, "NoSuchUpload")) {
                if (isS3Error(error) && error.status === 400) {
                    await uploads.update(record.id, { state: "failed", message: error.message });
                    await client.abortMultipartUpload(record.key, record.upload_id).catch(() => undefined);
                    throw invalid(`The bucket could not assemble ${record.name}: ${error.code} (${error.message})`);
                }
                throw storageFailure(error, "complete an upload");
            }
        }
    }
    let stored: number | null;
    try {
        stored = (await client.headObject(record.key)).contentLength;
    } catch (error) {
        if (isNotFound(error)) {
            return failUpload(record, client, `${record.name} is missing from your bucket. Upload the file again.`);
        }
        throw storageFailure(error, "check an upload");
    }
    if (stored !== record.size) {
        return failUpload(
            record,
            client,
            `Your bucket holds ${stored ?? "an unknown number of"} bytes of ${record.name}, expected ${record.size}. ` +
                "Upload the file again.",
        );
    }
    await uploads.update(record.id, {
        state: "uploaded",
        message: null,
        parts: parts.map(({ partNumber, etag }) => ({
            part_number: partNumber,
            etag,
            size: partBytes(record.size, record.part_size, partNumber),
        })),
    });
    return { id: record.id, state: "uploaded", size: record.size };
}

async function abortUpload(request: PlanetRequest): Promise<void> {
    const record = await uploads.getOrThrow(request.params.upload_id!);
    if (record.state === "aborted") {
        return;
    }
    await uploads.update(record.id, { state: "aborted", message: "The upload was cancelled." });
    const client = await getStorageClient();
    try {
        if (record.upload_id && record.state !== "uploaded") {
            await client.abortMultipartUpload(record.key, record.upload_id);
        } else {
            await client.deleteObject(record.key);
        }
    } catch (error) {
        throw storageFailure(error, "cancel an upload");
    }
}

// ---------------------------------------------------------------------------------------------------------
// Data fetch: request validation and rewriting

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Calls `fn` on every object with a `src`, then on the objects inside it (Galaxy's `_for_each_src`). */
function forEachSrc(value: unknown, fn: (item: JsonObject) => void): void {
    if (Array.isArray(value)) {
        value.forEach((item) => forEachSrc(item, fn));
    } else if (isObject(value)) {
        if ("src" in value) {
            fn(value);
        }
        Object.values(value).forEach((item) => forEachSrc(item, fn));
    }
}

/** Objects whose `src` is `src`, depth first and not inside one another, in Galaxy's `replace_file_srcs` order. */
function itemsWithSrc(value: unknown, src: string, out: JsonObject[] = []): JsonObject[] {
    if (Array.isArray(value)) {
        value.forEach((item) => itemsWithSrc(item, src, out));
    } else if (isObject(value)) {
        if (value.src === src) {
            out.push(value);
        } else {
            Object.values(value).forEach((item) => itemsWithSrc(item, src, out));
        }
    }
    return out;
}

/** Galaxy's `replace_request_syntax_sugar`: `items` and `items_from` aliases and hash keys become `hashes`. */
function replaceSyntaxSugar(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach(replaceSyntaxSugar);
        return;
    }
    if (!isObject(value)) {
        return;
    }
    for (const [alias, key] of [
        ["items", "elements"],
        ["items_from", "elements_from"],
    ] as const) {
        if (alias in value) {
            value[key] = value[alias];
            delete value[alias];
        }
    }
    Object.values(value).forEach(replaceSyntaxSugar);
    if ("src" in value || "filename" in value) {
        const hashes: JsonObject[] = [];
        for (const name of HASH_FUNCTIONS) {
            for (const key of [name, name.toLowerCase()]) {
                if (value[key] !== null && value[key] !== undefined) {
                    hashes.push({ hash_function: name, hash_value: value[key] });
                    delete value[key];
                }
            }
        }
        if (!Array.isArray(value.hashes)) {
            value.hashes = [];
        }
        (value.hashes as unknown[]).push(...hashes);
    }
}

/**
 * Galaxy's `check_src` for a single-user Planet: no server paths, FTP, libraries or deferred datasets. Items without
 * `deferred` take the request's (`UploadConfig.get_option`).
 */
function checkSource(item: JsonObject, datatypes: DatatypeInfo, deferredByDefault: boolean): void {
    const ext = item.ext;
    if (
        typeof ext === "string" &&
        ext &&
        ext !== "auto" &&
        ext !== "data" &&
        datatypes.available &&
        !datatypes.has(ext)
    ) {
        throw invalid(`Requested extension '${ext}' unknown, cannot upload dataset.`);
    }
    const src = item.src;
    if (src === "url") {
        if (typeof item.url !== "string") {
            throw invalid("src specified as 'url' but 'url' not specified");
        }
        if (item.url.startsWith("file://")) {
            throw ApiError.forbidden(
                "Uploading files via filesystem paths is not available in Planet",
                ErrorCodes.CONFIG_DOES_NOT_ALLOW,
            );
        }
    }
    if (src === "pasted") {
        if (item.url !== undefined && item.url !== null) {
            throw invalid("Cannot specify a 'url' when fetching data with pasted content 'src'");
        }
        if (!("paste_content" in item)) {
            throw invalid("src of type 'pasted' requires paste_content field");
        }
    } else if ("paste_content" in item) {
        throw invalid("'paste_content' field can only be specified with src of type 'pasted'");
    }
    if (item.link_data_only && TRANSIENT_ELEMENTS_FROM.has(String(item.elements_from))) {
        throw invalid(`link_data_only is invalid for derived elements from [${String(item.elements_from)}]`);
    }
    switch (src) {
        case "url": {
            const url = item.url as string;
            if (!URL_SCHEMES.some((scheme) => url.startsWith(scheme))) {
                throw invalid(`Invalid URL [${url}] found in src definition.`);
            }
            if ("deferred" in item ? item.deferred === true : deferredByDefault) {
                throw invalid(
                    "Planet cannot defer datasets: it stores every dataset in your bucket. " +
                        "Import the URL without deferring it.",
                );
            }
            item.in_place = false;
            break;
        }
        case "files":
            item.in_place = false;
            item.purge_source = true;
            break;
        case "pasted":
        case "composite":
            break;
        case "path":
        case "server_dir":
            throw ApiError.forbidden(
                "Uploading files via filesystem paths is not available in Planet",
                ErrorCodes.CONFIG_DOES_NOT_ALLOW,
            );
        case "ftp_import":
            throw ApiError.forbidden(
                "FTP import not permitted or FTP upload directory not configured",
                ErrorCodes.CONFIG_DOES_NOT_ALLOW,
            );
        default:
            throw invalid(`Unsupported src [${String(src)}] in fetch request.`);
    }
    if (!("purge_source" in item)) {
        item.purge_source = false;
    }
}

/** A `files_N|file_data` reference to an upload session. */
interface FileReference {
    sessionId: string;
    name: string | null;
}

/** Collects `files_N|file_data` session references in index order (Galaxy's `files` repeat). */
function fileReferences(payload: JsonObject): FileReference[] {
    const indexed: { index: number; reference: FileReference }[] = [];
    for (const [key, value] of Object.entries(payload)) {
        const match = /^files_(\d+)\|file_data$/.exec(key);
        if (!match) {
            continue;
        }
        if (!isObject(value) || typeof value.session_id !== "string" || !value.session_id) {
            throw invalid(`${key} must give the session_id of an upload.`);
        }
        const name = typeof value.name === "string" && value.name ? value.name : null;
        indexed.push({ index: Number(match[1]), reference: { sessionId: value.session_id, name } });
    }
    return indexed.sort((a, b) => a.index - b.index).map(({ reference }) => reference);
}

/** An item that reads an uploaded object: `{"src": "planet", "file": <upload id>}`. */
function useUpload(item: JsonObject, upload: UploadRecord, name: string): void {
    delete item.paste_content;
    item.src = "planet";
    item.file = upload.id;
    item.name = name;
    item.in_place = false;
    item.purge_source = true;
}

/**
 * Points `files` items at their upload sessions in order, as `FetchUploadToolAction.replace_file_srcs` does. Galaxy's
 * client sends pasted text through the same upload path and keeps it inline as well; when the request has no `files`
 * items and one session per `pasted` item, those items read the uploaded copies instead of carrying the text.
 */
function attachUploads(targets: unknown, references: readonly FileReference[], records: Map<string, UploadRecord>) {
    const files = itemsWithSrc(targets, "files");
    if (files.length > references.length) {
        throw invalid("Failed to find uploaded file matching target with src='files'");
    }
    files.forEach((item, index) => {
        const reference = references[index]!;
        const upload = records.get(reference.sessionId)!;
        const name = typeof item.name === "string" ? item.name : (reference.name ?? upload.name);
        useUpload(item, upload, name);
    });
    if (files.length === 0 && references.length > 0) {
        const pasted = itemsWithSrc(targets, "pasted");
        if (pasted.length === references.length) {
            pasted.forEach((item, index) => {
                const name = typeof item.name === "string" && item.name ? item.name : PASTED_NAME;
                useUpload(item, records.get(references[index]!.sessionId)!, name);
            });
        }
    }
}

/** The name Galaxy gives a pre-created dataset (`_precreate_fetched_hdas`), or the one `data_fetch.py` will. */
function datasetName(item: JsonObject): string {
    if (typeof item.name === "string") {
        return item.name;
    }
    switch (item.src) {
        case "url":
            return String(item.url).split("/").pop() ?? "";
        case "pasted":
            return PASTED_NAME;
        case "composite":
            return COMPOSITE_NAME;
        default:
            return "";
    }
}

function tagsOf(item: JsonObject): string[] {
    const tags = item.tags;
    return Array.isArray(tags) ? normalizeTags(tags.filter((tag): tag is string => typeof tag === "string")) : [];
}

type PlannedOutput =
    | { kind: "hda"; item: JsonObject; name: string; ext: string; dbkey: string; tags: string[] }
    | {
          kind: "hdca";
          name: string;
          collectionType: string;
          tags: string[];
          columnDefinitions: unknown[] | null;
      };

/** The datasets and collections Galaxy pre-creates for the targets, in target order. */
function planOutputs(targets: JsonObject[]): PlannedOutput[] {
    const planned: PlannedOutput[] = [];
    for (const target of targets) {
        const type = (target.destination as JsonObject).type;
        if (type === "hdas") {
            if (target.elements_from) {
                continue;
            }
            const elements = target.elements ?? [];
            if (!Array.isArray(elements)) {
                throw invalid("The elements of a target must be a list.");
            }
            for (const item of elements) {
                if (!isObject(item) || typeof item.src !== "string") {
                    throw invalid("Each element of an hdas target needs a src.");
                }
                planned.push({
                    kind: "hda",
                    item,
                    name: datasetName(item),
                    ext: typeof item.ext === "string" && item.ext ? item.ext : "auto",
                    dbkey: typeof item.dbkey === "string" && item.dbkey ? item.dbkey : "?",
                    tags: tagsOf(item),
                });
            }
        } else {
            const collectionType = target.collection_type;
            if (typeof collectionType !== "string" || !collectionType) {
                throw invalid("Must specify an HDCA collection_type");
            }
            if (!COLLECTION_TYPE.test(collectionType)) {
                throw invalid(`Invalid collection type: [${collectionType}]`);
            }
            planned.push({
                kind: "hdca",
                name: typeof target.name === "string" && target.name ? target.name : UNNAMED_COLLECTION,
                collectionType,
                tags: tagsOf(target),
                columnDefinitions: Array.isArray(target.column_definitions) ? target.column_definitions : null,
            });
        }
    }
    return planned;
}

function checkTargets(targets: unknown): JsonObject[] {
    if (!Array.isArray(targets) || targets.length === 0) {
        throw invalid("targets must be a non-empty list");
    }
    return targets.map((target) => {
        if (!isObject(target)) {
            throw invalid("Each target must be an object");
        }
        const destination = target.destination;
        if (!isObject(destination) || typeof destination.type !== "string") {
            throw invalid("Each target must specify a 'destination' with a 'type'");
        }
        if (destination.type === "library" || destination.type === "library_folder") {
            throw ApiError.forbidden("Planet has no data libraries.", ErrorCodes.CONFIG_DOES_NOT_ALLOW);
        }
        if (destination.type !== "hdas" && destination.type !== "hdca") {
            throw invalid(`Invalid target destination type [${destination.type}]`);
        }
        return target;
    });
}

/** The parsed body of a fetch request: the request the job runs and the upload sessions it names. */
interface FetchRequest {
    historyId: string;
    request: JsonObject;
    targets: JsonObject[];
    references: FileReference[];
}

function parseFetch(body: unknown, datatypes: DatatypeInfo): FetchRequest {
    const payload = asObject(body);
    const historyId = payload.history_id;
    if (typeof historyId !== "string" || !historyId) {
        throw ApiError.missingParameter("history_id is required");
    }
    const references = fileReferences(payload);
    const request: JsonObject = {};
    for (const [key, value] of Object.entries(payload)) {
        if (key !== "history_id" && key !== "key" && !key.startsWith("files_") && !key.startsWith("__files_")) {
            request[key] = structuredClone(value);
        }
    }
    request.check_content = true;
    const targets = checkTargets(request.targets);
    replaceSyntaxSugar(targets);
    forEachSrc(targets, (item) => checkSource(item, datatypes, request.deferred === true));
    const tooLarge = uploadLimitProblem(targets);
    if (tooLarge) {
        throw invalid(tooLarge);
    }
    return { historyId, request, targets, references };
}

// ---------------------------------------------------------------------------------------------------------
// Data fetch: records and response

interface CreatedOutputs {
    job: JobRecord;
    datasets: { name: string; hda: HdaRecord; dataset: DatasetRecord }[];
    collections: { name: string; hdca: HdcaRecord }[];
}

async function sessionsOf(references: readonly FileReference[], tx: WriteTx): Promise<Map<string, UploadRecord>> {
    const records = new Map<string, UploadRecord>();
    for (const { sessionId } of references) {
        const record = records.get(sessionId) ?? (await uploads.get(sessionId, tx));
        if (!record) {
            throw invalid(`Upload session ${sessionId} was not found. Upload the file again.`);
        }
        if (record.state !== "uploaded") {
            throw invalid(`Upload session ${sessionId} is ${record.state}, not uploaded.`);
        }
        records.set(sessionId, record);
    }
    return records;
}

async function createFetchJob(parsed: FetchRequest, tx: WriteTx): Promise<CreatedOutputs> {
    const history = await histories.getOrThrow(parsed.historyId, tx);
    if (history.purged || history.archived) {
        throw ApiError.forbidden("History is immutable", ErrorCodes.ITEM_IS_IMMUTABLE);
    }
    attachUploads(parsed.targets, parsed.references, await sessionsOf(parsed.references, tx));
    const planned = planOutputs(parsed.targets);
    const jobId = newId();
    const created: Omit<CreatedOutputs, "job"> = { datasets: [], collections: [] };
    const outputs: JobOutputAssociation[] = [];
    const outputCollections: JobOutputCollectionAssociation[] = [];
    let genomeBuild: string | null = null;
    for (const [index, output] of planned.entries()) {
        const name = `output${index}`;
        if (output.kind === "hda") {
            const { hda, dataset } = await hdas.createWithDataset(
                {
                    history_id: history.id,
                    name: output.name,
                    extension: output.ext,
                    dbkey: output.dbkey,
                    tags: output.tags,
                    creating_job_id: jobId,
                },
                { state: "queued", job_id: jobId },
                tx,
            );
            output.item.object_id = hda.id;
            outputs.push({ name, src: "hda", id: hda.id });
            created.datasets.push({ name, hda, dataset });
            if (output.dbkey !== "?") {
                genomeBuild = output.dbkey;
            }
        } else {
            const { hdca } = await collections.createHdca(
                {
                    hdca: {
                        history_id: history.id,
                        name: output.name,
                        tags: output.tags,
                        job_source_id: jobId,
                        job_source_type: "Job",
                    },
                    collection: {
                        collection_type: output.collectionType,
                        populated_state: "new",
                        column_definitions: output.columnDefinitions,
                        elements: [],
                    },
                },
                tx,
            );
            outputCollections.push({ name, src: "hdca", id: hdca.id });
            created.collections.push({ name, hdca });
        }
    }
    if (genomeBuild !== null && history.genome_build !== genomeBuild) {
        await histories.update(history.id, { genome_build: genomeBuild }, tx);
    }
    const job = await jobs.create(
        {
            id: jobId,
            tool_id: DATA_FETCH_TOOL_ID,
            tool_version: DATA_FETCH_TOOL_VERSION,
            history_id: history.id,
            state: "new",
            params: {
                request_version: "1",
                request_json: JSON.stringify(parsed.request),
                file_count: String(parsed.references.length),
            },
            request: parsed.request,
            outputs,
            output_collections: outputCollections,
        },
        tx,
    );
    await outbox.enqueue({ kind: "dispatch", job_id: job.id }, tx);
    return { job, ...created };
}

/** `Job.to_dict(view="collection")`. */
function jobCollectionView(job: JobRecord): Record<string, unknown> {
    return {
        model_class: "Job",
        id: job.id,
        state: job.state,
        exit_code: job.exit_code,
        update_time: job.update_time,
        create_time: job.create_time,
        galaxy_version: GALAXY_VERSION_MAJOR,
        tool_id: job.tool_id,
        tool_version: job.tool_version,
        history_id: job.history_id,
    };
}

/** Galaxy's `JobCreateResponse` for a fetch: `to_dict()` of each dataset and collection with its output name. */
async function fetchResponse(created: CreatedOutputs, datatypes: DatatypeInfo): Promise<Record<string, unknown>> {
    return readTx(SERIALIZER_STORES, async (tx) => {
        const loader = new ContentLoader(tx);
        const outputCollections = [];
        for (const { name, hdca } of created.collections) {
            outputCollections.push({
                ...(await serializeHdcaInstance(hdca, "element", loader, datatypes)),
                output_name: name,
            });
        }
        return {
            outputs: created.datasets.map(({ name, hda, dataset }) => ({
                ...hdaElementObject({ hda, dataset, job: created.job }, datatypes),
                output_name: name,
            })),
            output_collections: outputCollections,
            jobs: [jobCollectionView(created.job)],
            implicit_collections: [],
            produces_entry_points: false,
        };
    });
}

async function fetchData(request: PlanetRequest): Promise<Record<string, unknown>> {
    const datatypes = await loadDatatypeInfo();
    const parsed = parseFetch(await request.json(), datatypes);
    const created = await withTransaction(UPLOAD_STORES, "readwrite", (tx) => createFetchJob(parsed, tx));
    return fetchResponse(created, datatypes);
}

export function register(router: Router): void {
    router.untyped(UPLOADS_PATH, "post", createUpload);
    router.untyped(`${UPLOADS_PATH}/{upload_id}/parts`, "post", renewParts);
    router.untyped(`${UPLOADS_PATH}/{upload_id}/complete`, "post", completeUpload);
    router.untyped(`${UPLOADS_PATH}/{upload_id}`, "delete", abortUpload);
    router.route("/api/tools/fetch", "post", fetchData);
}
