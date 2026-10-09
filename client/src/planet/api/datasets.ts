/**
 * Datasets: GET /api/datasets, GET /api/datasets/{dataset_id} and its parameters_display, metrics, storage,
 * inheritance_chain, get_content_as_text and extra_files sub-resources; the display, download and metadata_file
 * routes (also under /api/histories/{history_id}/contents/{history_content_id}); and the legacy controllers
 * /datasets/{dataset_id}/display[/{filename}], /dataset/display, /dataset/get_metadata_file, /dataset/get_edit and
 * /dataset/set_edit.
 *
 * Dataset bytes live in the user's bucket. The worker never streams whole datasets (architecture invariant 3):
 * downloads and full-file displays answer 302 with a presigned GET URL, previews read a bounded prefix with a
 * Range request, and tabular chunks read 64 KiB extended to the next newline, as Galaxy's `get_chunk` does.
 *
 * Dataset content never becomes active content on the app origin. Previews are `text/plain`, chunk JSON or a
 * redirect to the bucket (raster images). HTML datasets are served as documents with a `sandbox` Content Security
 * Policy and no `allow-same-origin`, so they run in an opaque origin; because a sandboxed document's own requests
 * bypass the worker, their relative subresources are rewritten to presigned URLs (extra files stored as single
 * objects) or inlined from the dataset's extra files archive.
 */

import type { components } from "@/api/schema";
import {
    CONTENT_STORES,
    contents,
    type DatasetRecord,
    type HdaRecord,
    hdas,
    histories,
    JOB_STORES,
    type JobRecord,
    jobs,
    type ReadTx,
    readTx,
    settings,
    withTransaction,
} from "@/planet/db";
import { createS3Client, isS3Error, type S3Client } from "@/planet/s3";
import { buildCsp, type CspDirectives } from "@/planet/sw/csp";
import { html, json, passthrough, redirect, text, type TypedResponse } from "@/planet/sw/responses";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { parseContentsFilters } from "@/planet/util/filters";
import { escapeHtml } from "@/planet/util/html";
import { JOB_STATES, TERMINAL_JOB_STATES } from "@/planet/util/states";

import {
    changeDatatype,
    ContentLoader,
    HDA_VIEWS,
    type HdaView,
    HDCA_VIEWS,
    type HdcaView,
    loadDatatypeInfo,
    pagination,
    resolveKeys,
    serializationParams,
    serializeHda,
    serializeHdca,
} from "./contents";
import {
    DatatypeClass,
    type DatatypeInfo,
    getAllDatatypeDetails,
    getDatatype,
    queryBool,
    queryInt,
    stringAsBool,
} from "./datatypes";
import { genomeBuilds } from "./genomes";
import { summarizeJobParameters } from "./jobs";

type DatasetStorageDetails = components["schemas"]["DatasetStorageDetails"];
type DatasetTextContentDetails = components["schemas"]["DatasetTextContentDetails"];
type JobDisplayParametersSummary = components["schemas"]["JobDisplayParametersSummary"];
type HdaWithDataset = hdas.HdaWithDataset;

/** Galaxy's `INVALID_FILE_FORMAT` error code. */
const INVALID_FILE_FORMAT = 500005;
/** Default page size of `GET /api/datasets`. */
const DEFAULT_LIST_LIMIT = 500;
/** Galaxy's `DEFAULT_MAX_PEEK_SIZE`: text previews show at most this many bytes. */
export const MAX_PEEK_SIZE = 1_000_000;
/** Preview size for binary datatypes and sequences (`Binary`, `Sequence.display_data`). */
export const BINARY_PEEK_SIZE = 100_000;
/** Galaxy's `display_chunk_size`. */
export const CHUNK_SIZE = 65_536;
/** Largest `ck_size` a chunk request may ask for. */
const MAX_CHUNK_SIZE = 1_048_576;
/** How far a chunk is extended to reach the end of its last line. */
const LINE_EXTENSION_LIMIT = 1_048_576;
const LINE_EXTENSION_STEP = 16_384;
/** Decompressed bytes a compressed tabular chunk may skip and read. */
const GZIP_SCAN_LIMIT = 64 * 1024 * 1024;
/** HTML documents larger than this are previewed as truncated text. */
export const HTML_DOCUMENT_LIMIT = 16 * 1024 * 1024;
/** Largest extra file the worker serves itself (extra files live inside one archive per dataset). */
export const EXTRA_FILE_LIMIT = 64 * 1024 * 1024;
/** Inlined subresources of a sandboxed document: per file and in total. */
export const INLINE_FILE_LIMIT = 2 * 1024 * 1024;
export const INLINE_TOTAL_LIMIT = 8 * 1024 * 1024;
/** Lifetime of presigned URLs the worker hands out. */
export const PRESIGN_SECONDS = 900;

/**
 * Policy for dataset documents: scripts may run, but in an opaque origin (no `allow-same-origin`), and nothing but
 * inline content, `data:` images and fonts, and https resources may load.
 */
const DATASET_DOCUMENT_DIRECTIVES: CspDirectives = {
    sandbox: ["allow-scripts", "allow-popups", "allow-forms"],
    "default-src": ["'none'"],
    "img-src": ["data:", "https:"],
    "style-src": ["'unsafe-inline'", "https:"],
    "script-src": ["'unsafe-inline'", "https:"],
    "media-src": ["https:"],
    "font-src": ["https:", "data:"],
};

export const DATASET_DOCUMENT_CSP = buildCsp(DATASET_DOCUMENT_DIRECTIVES);

const STORAGE_NOT_CONFIGURED =
    "Dataset storage is not configured. Open the Planet setup page on the home page and enter your " +
    "S3-compatible bucket: endpoint, bucket name, access key ID and secret access key.";

/** Galaxy's `FILENAME_VALID_CHARS`. */
const FILENAME_VALID_CHARS = new Set(".,^_-()[]0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");

/** Raster image types a preview may be served as. */
const RASTER_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/avif",
    "image/tiff",
]);

const IMAGE_EXTENSIONS: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
    tif: "image/tiff",
    tiff: "image/tiff",
};

/** Types inlined subresources may use in `data:` URIs: images (SVG renders as an image there) and fonts. */
const INLINE_TYPES: Record<string, string> = {
    ...IMAGE_EXTENSIONS,
    svg: "image/svg+xml",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
};

const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);

const TEXT_EXTENSIONS = new Set([
    "txt",
    "text",
    "log",
    "csv",
    "tsv",
    "tab",
    "tabular",
    "json",
    "xml",
    "svg",
    "md",
    "css",
    "js",
    "py",
    "r",
    "sh",
    "fasta",
    "fa",
    "fastq",
    "fq",
    "bed",
    "gff",
    "gff3",
    "gtf",
    "vcf",
    "sam",
    "html",
    "htm",
]);

/** File extensions of metadata files whose spec names one (`MetadataElement(file_ext=...)`). */
const METADATA_FILE_EXTENSIONS: Record<string, string> = {
    bam_index: "bai",
    bam_csi_index: "bam.csi",
    cram_index: "crai",
    bcf_index: "csi",
    tabix_index: "tbi",
    hyper_params: "tabular",
};

// ---------------------------------------------------------------------------------------------------------
// Storage

let cachedClient: { fingerprint: string; client: S3Client } | null = null;
const calibrated = new WeakSet<S3Client>();

/**
 * Returns an S3 client for the configured bucket, reused while the settings stay the same so its clock offset
 * is kept.
 *
 * @throws ApiError 501 (`SERVER_NOT_CONFIGURED_FOR_REQUEST`) when no bucket is configured
 */
export async function getStorageClient(): Promise<S3Client> {
    const { stored, secrets } = await readTx(["settings", "secrets"], async (tx) => ({
        stored: await settings.getStored(tx),
        secrets: await settings.getSecrets(tx),
    }));
    const storage = stored.storage;
    const secret = secrets.storage_secret_access_key;
    if (!storage.endpoint || !storage.bucket || !storage.access_key_id || !secret) {
        throw new ApiError(501, STORAGE_NOT_CONFIGURED, ErrorCodes.SERVER_NOT_CONFIGURED_FOR_REQUEST);
    }
    const config = {
        endpoint: storage.endpoint,
        clusterEndpoint: storage.cluster_endpoint,
        bucket: storage.bucket,
        prefix: storage.prefix,
        region: storage.region,
        pathStyle: storage.path_style,
        accessKeyId: storage.access_key_id,
        secretAccessKey: secret,
    };
    const fingerprint = JSON.stringify(config);
    if (cachedClient?.fingerprint !== fingerprint) {
        cachedClient = { fingerprint, client: createS3Client(config) };
    }
    return cachedClient.client;
}

/** The origin of the configured browser endpoint, when it is plain http (local storage such as Garage). */
async function insecureStorageOrigin(): Promise<string | null> {
    const stored = await settings.getStored();
    try {
        const url = new URL(stored.storage.endpoint);
        return url.protocol === "http:" ? url.origin : null;
    } catch {
        return null;
    }
}

/** Converts a storage failure to a Galaxy error the user can act on. */
function storageError(error: unknown, what: string): ApiError {
    if (error instanceof ApiError) {
        return error;
    }
    if (isS3Error(error)) {
        if (error.code === "invalid_config") {
            return new ApiError(
                501,
                `${STORAGE_NOT_CONFIGURED} ${error.message}`,
                ErrorCodes.SERVER_NOT_CONFIGURED_FOR_REQUEST,
            );
        }
        if (error.status === 404) {
            return ApiError.notFound(`The file of ${what} is missing from your bucket.`);
        }
        if (error.code === "network_blocked") {
            return new ApiError(502, error.message, ErrorCodes.UPSTREAM_PROXY_ERROR);
        }
        return new ApiError(
            502,
            `Your bucket refused to read ${what}: ${error.code} (${error.message})`,
            ErrorCodes.UPSTREAM_PROXY_ERROR,
        );
    }
    console.error("Planet storage request failed", error);
    return new ApiError(502, `Could not read ${what} from your bucket.`, ErrorCodes.UPSTREAM_PROXY_ERROR);
}

/**
 * Presigns a GET of `key`. The first URL a client signs is preceded by a HEAD of the object, which also corrects
 * the client's clock from the bucket's Date header so the URL is not rejected for clock skew.
 */
async function presign(
    client: S3Client,
    key: string,
    options: { responseContentDisposition?: string; responseContentType?: string },
    what: string,
): Promise<string> {
    try {
        if (!calibrated.has(client)) {
            await client.headObject(key);
            calibrated.add(client);
        }
        return await client.presignGet(key, PRESIGN_SECONDS, options);
    } catch (error) {
        throw storageError(error, what);
    }
}

async function readBody(response: Response, limit: number): Promise<Uint8Array> {
    if (!response.body) {
        return new Uint8Array(await response.arrayBuffer()).slice(0, limit);
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < limit) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            parts.push(value);
            total += value.byteLength;
        }
    } finally {
        reader.cancel().catch(() => undefined);
    }
    return concat(parts, Math.min(total, limit));
}

function concat(parts: readonly Uint8Array[], length?: number): Uint8Array {
    const total = length ?? parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        if (offset >= total) {
            break;
        }
        const take = Math.min(part.byteLength, total - offset);
        out.set(take === part.byteLength ? part : part.subarray(0, take), offset);
        offset += take;
    }
    return out;
}

/** Reads `length` bytes from `start` (fewer at the end of the object, none past it). */
async function readRange(client: S3Client, key: string, start: number, length: number): Promise<Uint8Array> {
    if (length <= 0) {
        return new Uint8Array(0);
    }
    try {
        const response = await client.getObject(key, { range: { start, end: start + length - 1 } });
        return await readBody(response, length);
    } catch (error) {
        if (isS3Error(error) && error.status === 416) {
            return new Uint8Array(0);
        }
        throw error;
    }
}

/** Reads up to `limit` bytes of the object, gunzipped when `gzip` is set; `truncated` when more data follows. */
async function readPrefix(
    client: S3Client,
    key: string,
    limit: number,
    gzip: boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const bytes = gzip ? await gunzipRange(client, key, 0, limit + 1) : await readRange(client, key, 0, limit + 1);
    return bytes.byteLength > limit
        ? { bytes: bytes.subarray(0, limit), truncated: true }
        : { bytes, truncated: false };
}

/**
 * Returns decompressed bytes `[skip, skip + length)` of a gzip object, reading it from the start. A stream that
 * stops early (truncated data, or decoders that stop after the first gzip member) yields what was decoded.
 */
async function gunzipRange(client: S3Client, key: string, skip: number, length: number): Promise<Uint8Array> {
    const Decompressor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
    if (!Decompressor) {
        throw ApiError.notImplemented("This browser cannot decompress gzip data; download the dataset to view it.");
    }
    const response = await client.getObject(key);
    if (!response.body) {
        return new Uint8Array(0);
    }
    const reader = response.body.pipeThrough(new Decompressor("gzip")).getReader();
    const parts: Uint8Array[] = [];
    let position = 0;
    let taken = 0;
    try {
        while (taken < length) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try {
                chunk = await reader.read();
            } catch {
                if (position === 0) {
                    throw new ApiError(
                        500,
                        "Dataset appears to be a truncated or corrupt compressed file, cannot display.",
                        INVALID_FILE_FORMAT,
                    );
                }
                break;
            }
            if (chunk.done) {
                break;
            }
            const value = chunk.value;
            const end = position + value.byteLength;
            if (end > skip) {
                const from = Math.max(0, skip - position);
                const slice = value.subarray(from, Math.min(value.byteLength, from + (length - taken)));
                parts.push(slice);
                taken += slice.byteLength;
            }
            position = end;
        }
    } finally {
        reader.cancel().catch(() => undefined);
    }
    return concat(parts);
}

// ---------------------------------------------------------------------------------------------------------
// Datasets

const SERIALIZER_STORES = [...CONTENT_STORES, "jobs"] as const;

/** `GET /api/datasets/{dataset_id}`: the HDA serializer, detailed view by default. */
async function showDataset(id: string, query: URLSearchParams): Promise<HdaView> {
    if (query.get("hda_ldda") === "ldda") {
        throw ApiError.notFound("Library datasets do not exist in Planet.");
    }
    const dataType = query.get("data_type");
    if (dataType) {
        throw ApiError.notImplemented(`data_type=${dataType} is not available in Planet.`);
    }
    const keys = resolveKeys(HDA_VIEWS, serializationParams(query), "detailed");
    const datatypes = await loadDatatypeInfo();
    return readTx(SERIALIZER_STORES, async (tx) =>
        serializeHda(await new ContentLoader(tx).hdaItemById(id), keys, datatypes),
    );
}

/**
 * `GET /api/datasets`: datasets and collections across histories (or in `history_id`), filtered with `q`/`qv`,
 * ordered by `order` (default `create_time-dsc`) and paginated, with Galaxy's `total_matches` header.
 */
async function listDatasets(query: URLSearchParams): Promise<TypedResponse<(HdaView | HdcaView)[]>> {
    const params = serializationParams(query);
    const hdaKeys = resolveKeys(HDA_VIEWS, params, "summary");
    const hdcaKeys = resolveKeys(HDCA_VIEWS, params, "summary");
    const order = contents.parseContentsOrder(query.get("order"), "create_time");
    const { offset, limit } = pagination(query);
    const filters = parseContentsFilters(query);
    const historyId = query.get("history_id");
    const datatypes = await loadDatatypeInfo();
    const { items, total } = await readTx(SERIALIZER_STORES, async (tx) => {
        const historyIds = historyId
            ? [(await histories.getOrThrow(historyId, tx)).id]
            : (await tx.store("histories").getAll()).map((history) => history.id);
        const rows: contents.ContentRow[] = [];
        for (const id of historyIds) {
            rows.push(...(await contents.list(id, { filters, order }, tx)).rows);
        }
        rows.sort((a, b) => contents.compareRows(a, b, order));
        const loader = new ContentLoader(tx);
        const page = rows.slice(offset, offset + (limit || DEFAULT_LIST_LIMIT));
        const serialized: (HdaView | HdcaView)[] = [];
        for (const row of page) {
            serialized.push(
                row.type === "dataset"
                    ? serializeHda(await loader.hdaItem(row.hda, row.dataset), hdaKeys, datatypes)
                    : await serializeHdca(row.hdca, hdcaKeys, loader, datatypes),
            );
        }
        return { items: serialized, total: rows.length };
    });
    return json(items, { headers: { total_matches: String(total) } });
}

/** Loads an HDA with its dataset, or throws Galaxy's 404. */
export async function loadDataset(id: string): Promise<HdaWithDataset> {
    return hdas.getWithDatasetOrThrow(id);
}

/** Galaxy's `ensure_dataset_on_disk`: refuses datasets that have no readable data. */
export function ensureDatasetOnDisk(row: HdaWithDataset): void {
    const { hda, dataset, state } = row;
    if (hda.purged || dataset.purged) {
        throw ApiError.badRequest("The dataset you are attempting to view has been purged.", ErrorCodes.UNKNOWN);
    }
    switch (state) {
        case "upload":
            throw ApiError.conflict("Please wait until this dataset finishes uploading before attempting to view it.");
        case "new":
        case "queued":
            throw ApiError.conflict(`The dataset you are attempting to view is ${state} and has no data.`);
        case "discarded":
            throw ApiError.badRequest("The dataset you are attempting to view has been discarded.", ErrorCodes.UNKNOWN);
        case "deferred":
            throw ApiError.conflict(
                "The dataset you are attempting to view has deferred data. You can only use this dataset as input for jobs.",
            );
        case "paused":
            throw ApiError.conflict(
                "The dataset you are attempting to view is in paused state. One of the inputs for the job that creates this dataset has failed.",
            );
        case "running":
            throw ApiError.conflict(
                "The dataset you are attempting to view is still being created and has no data yet.",
            );
        case "error":
            if (!dataset.file_size) {
                throw ApiError.badRequest("The dataset is in error and has no data.");
            }
            break;
        default:
            break;
    }
}

/** Python's `os.path.splitext` for `/`-separated paths. */
function splitExt(path: string): [string, string] {
    const sep = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    if (dot > sep) {
        for (let index = sep + 1; index < dot; index++) {
            if (path[index] !== ".") {
                return [path.slice(0, dot), path.slice(dot)];
            }
        }
    }
    return [path, ""];
}

/** Python's `urllib.parse.quote(value, safe="")`. */
function pyQuote(value: string): string {
    const wellFormed = Array.from(value)
        .map((char) => {
            const code = char.codePointAt(0)!;
            return code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : char;
        })
        .join("");
    return encodeURIComponent(wellFormed).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

/** Galaxy's `to_content_disposition`. */
export function toContentDisposition(target: string, disposition: "attachment" | "inline" = "attachment"): string {
    const [filename, ext] = splitExt(target.trim());
    const limit = 255 - Array.from(ext).length;
    const sanitized =
        Array.from(filename)
            .map((char) => (FILENAME_VALID_CHARS.has(char) ? char : "_"))
            .slice(0, limit)
            .join("") + ext;
    const encoded = pyQuote(filename.replace(/[/\\?%*:|"<>]/g, "_")).slice(0, limit) + ext;
    return `${disposition}; filename="${sanitized}"; filename*=UTF-8''${encoded}`;
}

/** Galaxy's download file name: `Galaxy{hid}-[{name}].{ext}`. */
export function downloadFilename(hda: HdaRecord, toExt?: string | null): string {
    const ext = !toExt || toExt === "data" ? hda.extension : toExt;
    return `Galaxy${hda.hid}-[${hda.name}].${ext}`;
}

function contentDisposition(hda: HdaRecord, toExt: string | null, disposition: "attachment" | "inline"): string {
    return toContentDisposition(downloadFilename(hda, toExt), disposition);
}

/** Checks a `to_ext` value: it becomes part of a header, so only extension characters are allowed. */
function checkExtension(toExt: string | null): string | null {
    if (toExt === null || toExt === "") {
        return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(toExt)) {
        throw ApiError.badRequest(`Invalid extension '${toExt}'.`);
    }
    return toExt;
}

function isArchiveDownload(info: DatatypeInfo): boolean {
    return (
        Boolean(info.details?.composite_files?.length) ||
        ["html", "tool_markdown", "data_manager_json", "directory", "zarr"].includes(info.extension)
    );
}

/** The type a full-file redirect may be served with: a raster image type, text or opaque bytes. */
function safeContentType(info: DatatypeInfo): string {
    const mimetype = info.details?.mimetype?.toLowerCase() ?? "";
    if (RASTER_IMAGE_TYPES.has(mimetype)) {
        return mimetype;
    }
    if (info.isA(DatatypeClass.BINARY) || info.details?.is_binary === true) {
        return "application/octet-stream";
    }
    return "text/plain; charset=utf-8";
}

function isHtmlDocument(info: DatatypeInfo): boolean {
    return (
        info.isA(DatatypeClass.HTML) ||
        info.details?.mimetype?.toLowerCase() === "text/html" ||
        info.extension.endsWith("html")
    );
}

function decodeText(bytes: Uint8Array): string {
    return new TextDecoder("utf-8").decode(bytes);
}

/** A whole-file redirect to the bucket. */
async function redirectToObject(
    row: HdaWithDataset,
    disposition: "attachment" | "inline",
    contentType: string,
    toExt: string | null,
): Promise<TypedResponse<never>> {
    const client = await getStorageClient();
    const url = await presign(
        client,
        row.dataset.object_key,
        {
            responseContentDisposition: contentDisposition(row.hda, toExt, disposition),
            responseContentType: contentType,
        },
        `dataset ${row.hda.hid}`,
    );
    return redirect(url);
}

/** Download headers for HEAD requests (Galaxy's `download_head_headers`). */
function downloadHeadResponse(row: HdaWithDataset, info: DatatypeInfo, toExt: string | null): Response {
    const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition(row.hda, toExt, "attachment"),
        "Accept-Ranges": "bytes",
    };
    if (!isArchiveDownload(info) && row.dataset.file_size) {
        headers["Content-Length"] = String(row.dataset.file_size);
    }
    return new Response(null, { status: 200, headers });
}

async function download(request: PlanetRequest, row: HdaWithDataset, toExt: string | null): Promise<Response> {
    ensureDatasetOnDisk(row);
    const info = await getDatatype(row.hda.extension);
    if (request.method === "HEAD") {
        return downloadHeadResponse(row, info, toExt);
    }
    if (isArchiveDownload(info) && row.dataset.extra_files) {
        throw ApiError.notImplemented(
            "Downloading a dataset with extra files as an archive is not available in Planet yet; download its files from the dataset's details.",
        );
    }
    return redirectToObject(row, "attachment", "application/octet-stream", toExt);
}

// ---------------------------------------------------------------------------------------------------------
// Previews and chunks

function textPreview(body: Uint8Array, truncatedAt: number | null, row: HdaWithDataset): TypedResponse<never> {
    const headers: Record<string, string> = {
        "Content-Disposition": contentDisposition(row.hda, null, "inline"),
    };
    if (truncatedAt !== null) {
        headers["x-content-truncated"] = String(truncatedAt);
    }
    return text(decodeText(body), { headers });
}

/** A bounded text preview: the first `limit` bytes, with `x-content-truncated` when the dataset is longer. */
async function boundedPreview(
    request: PlanetRequest,
    row: HdaWithDataset,
    limit: number,
    gzip: boolean,
    alwaysMark = false,
): Promise<Response> {
    const size = row.dataset.file_size;
    if (request.method === "HEAD" && size !== null && !gzip) {
        const truncated = alwaysMark || size > limit;
        const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
        if (truncated) {
            headers["x-content-truncated"] = String(limit);
        }
        return new Response(null, { headers });
    }
    const client = await getStorageClient();
    let prefix: { bytes: Uint8Array; truncated: boolean };
    try {
        prefix = await readPrefix(client, row.dataset.object_key, limit, gzip);
    } catch (error) {
        throw storageError(error, `dataset ${row.hda.hid}`);
    }
    const truncated = prefix.truncated || (alwaysMark && size !== null && size > limit);
    return textPreview(prefix.bytes, truncated ? limit : null, row);
}

function decodeChunk(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new ApiError(500, "Dataset appears to contain binary data, cannot display.", INVALID_FILE_FORMAT);
    }
}

/**
 * Galaxy's `TabularData.get_chunk`: `size` bytes from `offset`, extended to the end of the last line. Returns the
 * chunk and the offset after it.
 */
export async function readChunk(
    client: S3Client,
    key: string,
    offset: number,
    size: number,
    gzip: boolean,
): Promise<{ data: string; offset: number }> {
    if (gzip) {
        if (offset + size + LINE_EXTENSION_LIMIT > GZIP_SCAN_LIMIT) {
            throw ApiError.badRequest(
                "This part of a compressed dataset is too far from its start to be shown; download the dataset instead.",
            );
        }
        const bytes = await gunzipRange(client, key, offset, size + LINE_EXTENSION_LIMIT);
        let end = Math.min(size, bytes.byteLength);
        if (end > 0 && bytes[end - 1] !== 0x0a) {
            const newline = bytes.indexOf(0x0a, end);
            end = newline === -1 ? bytes.byteLength : newline + 1;
        }
        return { data: decodeChunk(bytes.subarray(0, end)), offset: offset + end };
    }
    const parts = [await readRange(client, key, offset, size)];
    let total = parts[0]!.byteLength;
    let last = parts[0]!;
    if (total === size) {
        while (total - size < LINE_EXTENSION_LIMIT && last.byteLength > 0 && last[last.byteLength - 1] !== 0x0a) {
            const more = await readRange(client, key, offset + total, LINE_EXTENSION_STEP);
            if (more.byteLength === 0) {
                break;
            }
            const newline = more.indexOf(0x0a);
            const take = newline === -1 ? more : more.subarray(0, newline + 1);
            parts.push(take);
            total += take.byteLength;
            last = take;
            if (newline !== -1 || more.byteLength < LINE_EXTENSION_STEP) {
                break;
            }
        }
    }
    return { data: decodeChunk(concat(parts)), offset: offset + total };
}

function dataLineOffset(info: DatatypeInfo): number {
    return info.isA(DatatypeClass.SRA_MANIFEST) ? 1 : 0;
}

async function chunkResponse(
    row: HdaWithDataset,
    info: DatatypeInfo,
    offset: number,
    size: number,
    headers: Record<string, string> = {},
): Promise<Response> {
    const client = await getStorageClient();
    let chunk: { data: string; offset: number };
    try {
        chunk = await readChunk(client, row.dataset.object_key, offset, size, info.isA(DatatypeClass.GZIP));
    } catch (error) {
        throw storageError(error, `dataset ${row.hda.hid}`);
    }
    return json({ ck_data: chunk.data, offset: chunk.offset, data_line_offset: dataLineOffset(info) }, { headers });
}

function metadataColumns(hda: HdaRecord): number {
    const columns = hda.metadata.columns;
    return typeof columns === "number" ? columns : Number(columns) || 0;
}

// ---------------------------------------------------------------------------------------------------------
// Extra files

/** A member of a dataset's extra files archive (`extra.json`, written by the cluster's finishing step). */
export interface ExtraFileEntry {
    path: string;
    type: "file" | "directory" | "symlink";
    /** Byte offset of the member's data in the archive. */
    offset?: number;
    size?: number;
    target?: string;
    /** Key of a copy stored as its own object, relative to the prefix, when the dataset has one. */
    key?: string;
}

const extraIndexes = new Map<string, Promise<Map<string, ExtraFileEntry>>>();
const EXTRA_INDEX_CACHE = 32;

function normalizeMemberPath(path: string): string | null {
    const segments: string[] = [];
    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (!segments.length) {
                return null;
            }
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.length ? segments.join("/") : null;
}

/**
 * Parses an extra files index. The index is written next to tool output, so it is validated like untrusted input:
 * paths are normalized inside the archive, sizes must be non-negative integers, and single-object `key`s must lie in
 * the dataset's own `datasets/<uuid>/` prefix.
 */
function parseExtraIndex(value: unknown, keyPrefix: string): Map<string, ExtraFileEntry> {
    const entries = new Map<string, ExtraFileEntry>();
    const list = typeof value === "object" && value !== null ? (value as { entries?: unknown }).entries : undefined;
    if (!Array.isArray(list)) {
        throw new Error("extra files index has no entries");
    }
    for (const raw of list) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }
        const item = raw as Record<string, unknown>;
        const path = typeof item.path === "string" ? normalizeMemberPath(item.path) : null;
        if (!path || !["file", "directory", "symlink"].includes(item.type as string)) {
            continue;
        }
        const entry: ExtraFileEntry = { path, type: item.type as ExtraFileEntry["type"] };
        if (entry.type === "file") {
            const offset = item.offset;
            const size = item.size;
            if (
                !Number.isSafeInteger(offset) ||
                !Number.isSafeInteger(size) ||
                (offset as number) < 0 ||
                (size as number) < 0
            ) {
                continue;
            }
            entry.offset = offset as number;
            entry.size = size as number;
            if (typeof item.key === "string" && item.key.startsWith(keyPrefix)) {
                const relative = normalizeMemberPath(item.key.slice(keyPrefix.length));
                if (relative && `${keyPrefix}${relative}` === item.key) {
                    entry.key = item.key;
                }
            }
        } else if (entry.type === "symlink") {
            if (typeof item.target !== "string") {
                continue;
            }
            entry.target = item.target;
        }
        entries.set(path, entry);
    }
    return entries;
}

/** Loads the dataset's extra files index (cached per dataset), or returns null when it has no extra files. */
async function extraFiles(client: S3Client, dataset: DatasetRecord): Promise<Map<string, ExtraFileEntry> | null> {
    const location = dataset.extra_files;
    if (!location) {
        return null;
    }
    const cacheKey = `${dataset.id}:${location.index_key}:${dataset.update_time}`;
    let pending = extraIndexes.get(cacheKey);
    if (!pending) {
        pending = (async () => {
            const response = await client.getObject(location.index_key);
            return parseExtraIndex(await response.json(), `datasets/${dataset.uuid}/`);
        })();
        extraIndexes.set(cacheKey, pending);
        pending.catch(() => extraIndexes.delete(cacheKey));
        while (extraIndexes.size > EXTRA_INDEX_CACHE) {
            extraIndexes.delete(extraIndexes.keys().next().value!);
        }
    }
    try {
        return await pending;
    } catch (error) {
        throw storageError(error, "the dataset's extra files index");
    }
}

/** Finds a member, following symbolic links inside the archive. */
function findMember(index: Map<string, ExtraFileEntry>, path: string): ExtraFileEntry | undefined {
    let current = path;
    for (let hops = 0; hops < 8; hops++) {
        const entry = index.get(current);
        if (!entry || entry.type !== "symlink") {
            return entry;
        }
        const base = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
        const next = entry.target!.startsWith("/") ? null : normalizeMemberPath(`${base}/${entry.target}`);
        if (!next) {
            return undefined;
        }
        current = next;
    }
    return undefined;
}

async function readMember(client: S3Client, dataset: DatasetRecord, entry: ExtraFileEntry): Promise<Uint8Array> {
    if (entry.key) {
        const response = await client.getObject(entry.key);
        return readBody(response, entry.size ?? EXTRA_FILE_LIMIT);
    }
    return readRange(client, dataset.extra_files!.key, entry.offset!, entry.size!);
}

function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The type an extra file is served with when requested directly. */
function memberContentType(path: string): string {
    const ext = extensionOf(path);
    if (IMAGE_EXTENSIONS[ext]) {
        return IMAGE_EXTENSIONS[ext]!;
    }
    if (TEXT_EXTENSIONS.has(ext)) {
        return "text/plain; charset=utf-8";
    }
    return "application/octet-stream";
}

/** Galaxy's listing of an extra files directory, as a sandboxed document. */
function directoryListing(index: Map<string, ExtraFileEntry>, directory: string): string {
    const prefix = `${directory}/`;
    const names = [...index.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => path.slice(prefix.length))
        .sort();
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    const rows = names
        .map((item, position) => {
            const color = position % 2 === 0 ? "#D8D8D8" : "#FFFFFF";
            return `<tr bgcolor="${color}"><td>${escapeHtml(item)}</td></tr>\n`;
        })
        .join("");
    return (
        `<html><head><h3>Directory ${escapeHtml(name)} contents: ${names.length} items</h3></head>\n` +
        `<body><p/><table cellpadding="2">\n${rows}</table></body></html>\n`
    );
}

// ---------------------------------------------------------------------------------------------------------
// Sandboxed documents: subresource rewriting

/** What a subresource is used as; it decides whether and how the content may be inlined. */
export type SubresourceKind = "image" | "font" | "style" | "script" | "media";

/** A rewritten subresource: an absolute URL, or the bytes to inline. */
export type Subresource = { url: string } | { bytes: Uint8Array };

export interface SubresourceResolver {
    /** Resolves a normalized path relative to the extra files root, or returns null to leave the reference. */
    resolve(path: string, kind: SubresourceKind): Promise<Subresource | null>;
}

/**
 * Resolves `reference` (an attribute or CSS URL) against `baseDir` inside the extra files. Returns null for
 * absolute, root-relative, fragment-only and `data:` references and for paths that leave the extra files.
 */
export function resolveReference(baseDir: string, reference: string): { path: string; suffix: string } | null {
    const trimmed = reference.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
        return null;
    }
    const cut = trimmed.search(/[?#]/);
    const rawPath = cut === -1 ? trimmed : trimmed.slice(0, cut);
    const hash = trimmed.indexOf("#");
    const suffix = hash === -1 ? "" : trimmed.slice(hash);
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch {
        return null;
    }
    const path = normalizeMemberPath(baseDir ? `${baseDir}/${decoded}` : decoded);
    return path ? { path, suffix } : null;
}

interface HtmlAttribute {
    name: string;
    value: string;
    /** The whole attribute, name to end of value. */
    start: number;
    end: number;
    /** The value including its quotes; -1 when the attribute has no value. */
    valueStart: number;
    valueEnd: number;
}

interface HtmlTag {
    name: string;
    closing: boolean;
    start: number;
    end: number;
    attributes: HtmlAttribute[];
    /** Raw text content of `script` and `style` elements. */
    content?: { start: number; end: number };
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes"]);

/** Splits an HTML document into tags with attribute positions (a tokenizer, not a parser). */
export function scanHtml(source: string): HtmlTag[] {
    const tags: HtmlTag[] = [];
    const length = source.length;
    let i = 0;
    while (i < length) {
        const lt = source.indexOf("<", i);
        if (lt === -1) {
            break;
        }
        if (source.startsWith("<!--", lt)) {
            const end = source.indexOf("-->", lt + 4);
            i = end === -1 ? length : end + 3;
            continue;
        }
        const next = source[lt + 1] ?? "";
        if (next === "!" || next === "?") {
            const end = source.indexOf(">", lt);
            i = end === -1 ? length : end + 1;
            continue;
        }
        const closing = next === "/";
        const nameStart = closing ? lt + 2 : lt + 1;
        if (!/[A-Za-z]/.test(source[nameStart] ?? "")) {
            i = lt + 1;
            continue;
        }
        let j = nameStart;
        while (j < length && !/[\s/>]/.test(source[j]!)) {
            j++;
        }
        const name = source.slice(nameStart, j).toLowerCase();
        const attributes: HtmlAttribute[] = [];
        for (;;) {
            while (j < length && /[\s/]/.test(source[j]!)) {
                j++;
            }
            if (j >= length) {
                break;
            }
            if (source[j] === ">") {
                j++;
                break;
            }
            const attrStart = j;
            j++;
            while (j < length && !/[\s/>=]/.test(source[j]!)) {
                j++;
            }
            const attrName = source.slice(attrStart, j).toLowerCase();
            let k = j;
            while (k < length && /\s/.test(source[k]!)) {
                k++;
            }
            let value = "";
            let valueStart = -1;
            let valueEnd = -1;
            if (source[k] === "=") {
                k++;
                while (k < length && /\s/.test(source[k]!)) {
                    k++;
                }
                const quote = source[k];
                if (quote === '"' || quote === "'") {
                    const close = source.indexOf(quote, k + 1);
                    const stop = close === -1 ? length : close;
                    value = source.slice(k + 1, stop);
                    valueStart = k;
                    valueEnd = Math.min(length, stop + 1);
                    j = valueEnd;
                } else {
                    let stop = k;
                    while (stop < length && !/[\s>]/.test(source[stop]!)) {
                        stop++;
                    }
                    value = source.slice(k, stop);
                    valueStart = k;
                    valueEnd = stop;
                    j = stop;
                }
            }
            attributes.push({ name: attrName, value, start: attrStart, end: j, valueStart, valueEnd });
        }
        const tag: HtmlTag = { name, closing, start: lt, end: j, attributes };
        tags.push(tag);
        i = j;
        if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
            const pattern = new RegExp(`</${name}[\\s/>]`, "ig");
            pattern.lastIndex = j;
            const close = pattern.exec(source);
            const contentEnd = close ? close.index : length;
            tag.content = { start: j, end: contentEnd };
            i = contentEnd;
        }
    }
    return tags;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00A0" };

function decodeEntities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let index = 0; index < bytes.byteLength; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

function dataUri(path: string, bytes: Uint8Array): string | null {
    const type = INLINE_TYPES[extensionOf(path)];
    return type ? `data:${type};base64,${base64(bytes)}` : null;
}

function cssString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}

function escapeRawText(value: string, element: "script" | "style"): string {
    const pattern = element === "script" ? /<(\/script|!--)/gi : /<\/style/gi;
    return value.replace(pattern, (match) => `<\\${match.slice(1)}`);
}

interface Edit {
    start: number;
    end: number;
    text: string;
}

function applyEdits(source: string, edits: Edit[]): string {
    edits.sort((a, b) => a.start - b.start);
    let out = "";
    let position = 0;
    for (const edit of edits) {
        if (edit.start < position) {
            continue;
        }
        out += source.slice(position, edit.start) + edit.text;
        position = edit.end;
    }
    return out + source.slice(position);
}

function dirname(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
}

/** Concurrent subresource lookups while rewriting one document. */
const RESOLVE_CONCURRENCY = 6;

/** Resolves each path and kind once, with at most {@link RESOLVE_CONCURRENCY} lookups in flight. */
class ReferenceTable {
    private readonly lookups = new Map<string, Promise<Subresource | null>>();
    private readonly waiting: (() => void)[] = [];
    private active = 0;

    constructor(private readonly resolver: SubresourceResolver) {}

    get(path: string, kind: SubresourceKind): Promise<Subresource | null> {
        const key = `${kind}\u0000${path}`;
        let pending = this.lookups.get(key);
        if (!pending) {
            pending = this.limited(() => this.resolver.resolve(path, kind)).catch(() => null);
            this.lookups.set(key, pending);
        }
        return pending;
    }

    /** Runs `task` when a slot is free; a finished task hands its slot to the next waiting one. */
    private async limited<T>(task: () => Promise<T>): Promise<T> {
        if (this.active < RESOLVE_CONCURRENCY) {
            this.active++;
        } else {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        try {
            return await task();
        } finally {
            const next = this.waiting.shift();
            if (next) {
                next();
            } else {
                this.active--;
            }
        }
    }
}

/** Rewrites CSS `url()` references and `@import` rules; imported archive members are inlined (three levels). */
export function rewriteCss(css: string, baseDir: string, resolver: SubresourceResolver): Promise<string> {
    return rewriteCssWith(css, baseDir, new ReferenceTable(resolver), 0);
}

async function rewriteCssWith(css: string, baseDir: string, table: ReferenceTable, depth: number): Promise<string> {
    const edits: Edit[] = [];
    const pending: Promise<void>[] = [];
    const lower = css.toLowerCase();
    let nextUrl = lower.indexOf("url(");
    let nextImport = lower.indexOf("@import");
    let i = 0;
    while (nextUrl !== -1 || nextImport !== -1) {
        if (nextImport !== -1 && (nextUrl === -1 || nextImport < nextUrl)) {
            const importAt = nextImport;
            const semicolon = css.indexOf(";", importAt);
            const end = semicolon === -1 ? css.length : semicolon + 1;
            const rule = css.slice(importAt + 7, semicolon === -1 ? css.length : semicolon);
            const match = /^\s*(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?\s*(.*)$/s.exec(rule);
            const target = match ? resolveReference(baseDir, match[2]!) : null;
            if (target) {
                const media = match![3]!.trim();
                pending.push(
                    table.get(target.path, "style").then(async (found) => {
                        if (!found) {
                            return;
                        }
                        if ("url" in found) {
                            const suffix = media ? ` ${media}` : "";
                            edits.push({
                                start: importAt,
                                end,
                                text: `@import url(${cssString(found.url)})${suffix};`,
                            });
                        } else if (depth < 3) {
                            const nested = await rewriteCssWith(
                                decodeText(found.bytes),
                                dirname(target.path),
                                table,
                                depth + 1,
                            );
                            edits.push({
                                start: importAt,
                                end,
                                text: media ? `@media ${media} {\n${nested}\n}` : nested,
                            });
                        }
                    }),
                );
            }
            i = end;
        } else {
            const urlAt = nextUrl;
            let j = urlAt + 4;
            if (urlAt > 0 && /[\w-]/.test(css[urlAt - 1]!)) {
                i = j;
            } else {
                while (j < css.length && /\s/.test(css[j]!)) {
                    j++;
                }
                let value: string;
                let end: number;
                const quote = css[j];
                if (quote === '"' || quote === "'") {
                    let k = j + 1;
                    while (k < css.length && css[k] !== quote) {
                        k += css[k] === "\\" ? 2 : 1;
                    }
                    value = css.slice(j + 1, k).replace(/\\(.)/g, "$1");
                    const close = css.indexOf(")", k);
                    end = close === -1 ? css.length : close + 1;
                } else {
                    const close = css.indexOf(")", j);
                    end = close === -1 ? css.length : close + 1;
                    value = css.slice(j, close === -1 ? css.length : close).trim();
                }
                const target = resolveReference(baseDir, value);
                if (target) {
                    const kind: SubresourceKind = FONT_EXTENSIONS.has(extensionOf(target.path)) ? "font" : "image";
                    pending.push(
                        table.get(target.path, kind).then((found) => {
                            const replacement =
                                found && ("url" in found ? found.url : dataUri(target.path, found.bytes));
                            if (replacement) {
                                edits.push({ start: urlAt, end, text: `url(${cssString(replacement)})` });
                            }
                        }),
                    );
                }
                i = end;
            }
        }
        if (nextUrl !== -1 && nextUrl < i) {
            nextUrl = lower.indexOf("url(", i);
        }
        if (nextImport !== -1 && nextImport < i) {
            nextImport = lower.indexOf("@import", i);
        }
    }
    await Promise.all(pending);
    return applyEdits(css, edits);
}

function quoteAttribute(value: string): string {
    return `"${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
}

/**
 * Rewrites the relative subresources of an HTML document stored in a dataset's extra files: `src`, `srcset`,
 * `poster`, `background`, stylesheet and icon `href`, and CSS in `<style>` elements and `style` attributes. Links
 * (`<a>`, `<area>`, `<form>`) stay relative; they navigate to the dataset's display route.
 */
export async function rewriteHtml(source: string, baseDir: string, resolver: SubresourceResolver): Promise<string> {
    const table = new ReferenceTable(resolver);
    const tags = scanHtml(source);
    const edits: Edit[] = [];
    const pending: Promise<void>[] = [];
    let mediaDepth = 0;

    const rewriteAttribute = (attribute: HtmlAttribute, kind: SubresourceKind) => {
        const target = resolveReference(baseDir, decodeEntities(attribute.value));
        if (!target || attribute.valueStart < 0) {
            return;
        }
        pending.push(
            table.get(target.path, kind).then((found) => {
                const replacement =
                    found && ("url" in found ? found.url + target.suffix : dataUri(target.path, found.bytes));
                if (replacement) {
                    edits.push({
                        start: attribute.valueStart,
                        end: attribute.valueEnd,
                        text: quoteAttribute(replacement),
                    });
                }
            }),
        );
    };

    const rewriteSrcset = (attribute: HtmlAttribute) => {
        const value = decodeEntities(attribute.value);
        if (attribute.valueStart < 0 || value.includes("data:")) {
            return;
        }
        const candidates = value
            .split(",")
            .map((candidate) => candidate.trim())
            .filter(Boolean)
            .map((candidate) => {
                const [url = "", ...descriptor] = candidate.split(/\s+/);
                return { url, descriptor: descriptor.join(" ") };
            });
        pending.push(
            Promise.all(
                candidates.map(async ({ url, descriptor }) => {
                    const target = resolveReference(baseDir, url);
                    const found = target ? await table.get(target.path, "image") : null;
                    const replacement =
                        found && target && ("url" in found ? found.url : dataUri(target.path, found.bytes));
                    return `${replacement || url}${descriptor ? ` ${descriptor}` : ""}`;
                }),
            ).then((rewritten) => {
                edits.push({
                    start: attribute.valueStart,
                    end: attribute.valueEnd,
                    text: quoteAttribute(rewritten.join(", ")),
                });
            }),
        );
    };

    for (const tag of tags) {
        if (tag.name === "video" || tag.name === "audio") {
            mediaDepth = Math.max(0, mediaDepth + (tag.closing ? -1 : 1));
        }
        if (tag.closing) {
            continue;
        }
        const attribute = (name: string) => tag.attributes.find((item) => item.name === name);
        const rewrite = (name: string, kind: SubresourceKind) => {
            const item = attribute(name);
            if (item) {
                rewriteAttribute(item, kind);
            }
        };
        const rewriteSet = () => {
            const item = attribute("srcset");
            if (item) {
                rewriteSrcset(item);
            }
        };
        for (const item of tag.attributes) {
            if (item.name === "style" && item.valueStart >= 0) {
                const css = decodeEntities(item.value);
                pending.push(
                    rewriteCssWith(css, baseDir, table, 0).then((rewritten) => {
                        if (rewritten !== css) {
                            edits.push({ start: item.valueStart, end: item.valueEnd, text: quoteAttribute(rewritten) });
                        }
                    }),
                );
            }
        }
        switch (tag.name) {
            case "img":
                rewrite("src", "image");
                rewriteSet();
                break;
            case "source":
                if (mediaDepth > 0) {
                    rewrite("src", "media");
                } else {
                    rewrite("src", "image");
                    rewriteSet();
                }
                break;
            case "input":
                if (attribute("type")?.value.toLowerCase() === "image") {
                    rewrite("src", "image");
                }
                break;
            case "video":
                rewrite("poster", "image");
                rewrite("src", "media");
                break;
            case "audio":
            case "track":
                rewrite("src", "media");
                break;
            case "body":
            case "table":
            case "td":
            case "th":
                rewrite("background", "image");
                break;
            case "link": {
                const rel = (attribute("rel")?.value ?? "").toLowerCase().split(/\s+/);
                const href = attribute("href");
                if (!href) {
                    break;
                }
                if (rel.includes("stylesheet")) {
                    const target = resolveReference(baseDir, decodeEntities(href.value));
                    if (!target) {
                        break;
                    }
                    const media = attribute("media")?.value;
                    pending.push(
                        table.get(target.path, "style").then(async (found) => {
                            if (!found) {
                                return;
                            }
                            if ("url" in found) {
                                edits.push({
                                    start: href.valueStart,
                                    end: href.valueEnd,
                                    text: quoteAttribute(found.url),
                                });
                                return;
                            }
                            const css = await rewriteCssWith(decodeText(found.bytes), dirname(target.path), table, 1);
                            const mediaAttribute = media ? ` media=${quoteAttribute(decodeEntities(media))}` : "";
                            edits.push({
                                start: tag.start,
                                end: tag.end,
                                text: `<style${mediaAttribute}>${escapeRawText(css, "style")}</style>`,
                            });
                        }),
                    );
                } else if (rel.includes("icon")) {
                    rewriteAttribute(href, "image");
                }
                break;
            }
            case "script": {
                const src = attribute("src");
                const content = tag.content;
                const target = src ? resolveReference(baseDir, decodeEntities(src.value)) : null;
                if (!src || !target || !content) {
                    break;
                }
                pending.push(
                    table.get(target.path, "script").then((found) => {
                        if (!found) {
                            return;
                        }
                        if ("url" in found) {
                            edits.push({ start: src.valueStart, end: src.valueEnd, text: quoteAttribute(found.url) });
                            return;
                        }
                        edits.push({ start: src.start, end: src.end, text: "" });
                        edits.push({
                            start: content.start,
                            end: content.end,
                            text: escapeRawText(decodeText(found.bytes), "script"),
                        });
                    }),
                );
                break;
            }
            case "style":
                if (tag.content) {
                    const { start, end } = tag.content;
                    const css = source.slice(start, end);
                    pending.push(
                        rewriteCssWith(css, baseDir, table, 0).then((rewritten) => {
                            if (rewritten !== css) {
                                edits.push({ start, end, text: escapeRawText(rewritten, "style") });
                            }
                        }),
                    );
                }
                break;
            default:
                break;
        }
    }
    await Promise.all(pending);
    return applyEdits(source, edits);
}

/** Resolves subresources to presigned URLs (single objects) or bounded bytes from the extra files archive. */
function archiveResolver(
    client: S3Client,
    dataset: DatasetRecord,
    index: Map<string, ExtraFileEntry>,
): SubresourceResolver {
    let inlined = 0;
    return {
        async resolve(path, kind) {
            const entry = findMember(index, path);
            if (!entry || entry.type !== "file") {
                return null;
            }
            if (entry.key) {
                const type = INLINE_TYPES[extensionOf(path)];
                const contentType =
                    kind === "style"
                        ? "text/css"
                        : kind === "script"
                          ? "text/javascript"
                          : kind === "media"
                            ? undefined
                            : type;
                return {
                    url: await client.presignGet(entry.key, PRESIGN_SECONDS, { responseContentType: contentType }),
                };
            }
            const size = entry.size ?? 0;
            if (kind === "media" || size > INLINE_FILE_LIMIT || inlined + size > INLINE_TOTAL_LIMIT) {
                return null;
            }
            inlined += size;
            return { bytes: await readMember(client, dataset, entry) };
        },
    };
}

function charsetOf(bytes: Uint8Array): string {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const match = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head);
    if (match) {
        try {
            return new TextDecoder(match[1]!).encoding;
        } catch {
            return "utf-8";
        }
    }
    return "utf-8";
}

/** The document policy; a plain-http storage endpoint (local storage) is allowed next to https. */
async function sandboxPolicy(): Promise<string> {
    const origin = await insecureStorageOrigin().catch(() => null);
    if (!origin) {
        return DATASET_DOCUMENT_CSP;
    }
    const extra = Object.fromEntries(
        ["img-src", "style-src", "script-src", "media-src", "font-src"].map((directive) => [directive, [origin]]),
    );
    return buildCsp(DATASET_DOCUMENT_DIRECTIVES, extra);
}

/** Serves an HTML document from the dataset (the primary file, or an archive member at `memberPath`). */
async function sandboxedDocument(
    request: PlanetRequest,
    row: HdaWithDataset,
    memberPath: string | null,
    bytesOf: (client: S3Client) => Promise<Uint8Array>,
): Promise<Response> {
    const csp = await sandboxPolicy();
    const headers = { "Content-Disposition": contentDisposition(row.hda, null, "inline") };
    if (request.method === "HEAD") {
        return html("", { csp, headers });
    }
    const client = await getStorageClient();
    let source: string;
    let index: Map<string, ExtraFileEntry> | null;
    try {
        const bytes = await bytesOf(client);
        source = new TextDecoder(charsetOf(bytes)).decode(bytes);
        index = await extraFiles(client, row.dataset);
    } catch (error) {
        throw storageError(error, `dataset ${row.hda.hid}`);
    }
    const body = index
        ? await rewriteHtml(source, memberPath ? dirname(memberPath) : "", archiveResolver(client, row.dataset, index))
        : source;
    return html(body, { csp, headers });
}

// ---------------------------------------------------------------------------------------------------------
// Display

interface DisplayOptions {
    preview: boolean;
    filename: string | null;
    toExt: string | null;
    raw: boolean;
    offset: number | null;
    chunkSize: number | null;
}

async function displayMember(
    request: PlanetRequest,
    row: HdaWithDataset,
    filename: string,
    raw: boolean,
): Promise<Response> {
    const path = normalizeMemberPath(filename);
    if (!path) {
        throw ApiError.badRequest(`Invalid extra file name '${filename}'.`);
    }
    const client = await getStorageClient();
    const index = await extraFiles(client, row.dataset);
    const entry = index ? findMember(index, path) : undefined;
    if (!index || !entry) {
        throw ApiError.notFound(`Could not find '${filename}' on the extra files path.`);
    }
    if (entry.type === "directory") {
        const csp = await sandboxPolicy();
        return html(request.method === "HEAD" ? "" : directoryListing(index, path), { csp });
    }
    const ext = extensionOf(path);
    if (!raw && (ext === "html" || ext === "htm")) {
        if ((entry.size ?? 0) > HTML_DOCUMENT_LIMIT) {
            throw ApiError.badRequest(`'${filename}' is too large to display.`);
        }
        return sandboxedDocument(request, row, path, (c) => readMember(c, row.dataset, entry));
    }
    const contentType = raw ? "application/octet-stream" : memberContentType(path);
    const disposition = contentType === "application/octet-stream" ? "attachment" : "inline";
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (entry.key) {
        const url = await presign(
            client,
            entry.key,
            { responseContentType: contentType, responseContentDisposition: toContentDisposition(name, disposition) },
            `'${filename}'`,
        );
        return redirect(url);
    }
    const size = entry.size ?? 0;
    if (size > EXTRA_FILE_LIMIT) {
        throw ApiError.badRequest(
            `'${filename}' is larger than ${EXTRA_FILE_LIMIT / 1024 / 1024} MiB and cannot be served from the dataset's extra files archive.`,
        );
    }
    const headers = {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Content-Disposition": toContentDisposition(name, disposition),
    };
    if (request.method === "HEAD" || size === 0) {
        return new Response(null, { headers });
    }
    try {
        const response = await client.getObject(row.dataset.extra_files!.key, {
            range: { start: entry.offset!, end: entry.offset! + size - 1 },
        });
        return new Response(response.body, { headers });
    } catch (error) {
        throw storageError(error, `'${filename}'`);
    }
}

/** Galaxy's `datatype.display_data`, with the bytes rules described at the top of this module. */
export async function display(request: PlanetRequest, row: HdaWithDataset, options: DisplayOptions): Promise<Response> {
    ensureDatasetOnDisk(row);
    const filename = options.filename?.replace(/^\/+/, "") || null;
    if (filename && filename !== "index") {
        return displayMember(request, row, filename, options.raw);
    }
    const info = await getDatatype(row.hda.extension);
    const toExt = checkExtension(options.toExt);
    if (options.raw) {
        return redirectToObject(row, "inline", "application/octet-stream", null);
    }
    if (toExt) {
        return download(request, row, toExt);
    }
    const gzip = info.isA(DatatypeClass.GZIP);

    if (info.isA(DatatypeClass.TABULAR_DATA)) {
        if (options.offset !== null) {
            const size = Math.min(options.chunkSize ?? CHUNK_SIZE, MAX_CHUNK_SIZE);
            return chunkResponse(row, info, options.offset, size);
        }
        if (!options.preview) {
            return redirectToObject(row, "attachment", "application/octet-stream", row.hda.extension);
        }
        if (metadataColumns(row.hda) > 100) {
            return boundedPreview(request, row, MAX_PEEK_SIZE, gzip);
        }
        if (request.method === "HEAD") {
            return new Response(null, { headers: { "Content-Type": "application/json", "x-content-chunked": "true" } });
        }
        return chunkResponse(row, info, 0, CHUNK_SIZE, { "x-content-chunked": "true" });
    }

    if (isHtmlDocument(info)) {
        const size = row.dataset.file_size;
        if (size !== null && size > HTML_DOCUMENT_LIMIT) {
            return boundedPreview(request, row, MAX_PEEK_SIZE, false, true);
        }
        return sandboxedDocument(request, row, null, (client) =>
            readRange(client, row.dataset.object_key, 0, HTML_DOCUMENT_LIMIT),
        );
    }

    if (!options.preview) {
        return redirectToObject(row, "inline", safeContentType(info), null);
    }

    if (info.isA(DatatypeClass.SEQUENCE)) {
        return boundedPreview(request, row, BINARY_PEEK_SIZE, gzip);
    }

    const mimetype = info.details?.mimetype?.toLowerCase() ?? "";
    if (info.isA(DatatypeClass.IMAGE) && RASTER_IMAGE_TYPES.has(mimetype)) {
        return redirectToObject(row, "inline", mimetype, null);
    }

    const binary =
        info.isA(DatatypeClass.BINARY) || info.className === DatatypeClass.DATA || info.isA(DatatypeClass.IMAGE);
    if (binary) {
        const limit =
            info.isA(DatatypeClass.BINARY) || info.isA(DatatypeClass.IMAGE) ? BINARY_PEEK_SIZE : MAX_PEEK_SIZE;
        return boundedPreview(request, row, limit, false);
    }
    return boundedPreview(request, row, MAX_PEEK_SIZE, gzip);
}

function displayOptions(query: URLSearchParams, legacy: boolean, filename: string | null = null): DisplayOptions {
    const bool = (name: string) => (legacy ? stringAsBool(query.get(name)) : queryBool(query, name, false));
    const offset = legacy && !query.get("offset") ? null : queryInt(query, "offset", null, 0);
    const chunkSize = legacy && !query.get("ck_size") ? null : queryInt(query, "ck_size", null, 1);
    return {
        preview: bool("preview"),
        filename: filename ?? query.get("filename"),
        toExt: query.get("to_ext"),
        raw: bool("raw"),
        offset,
        chunkSize,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Text content, metadata files and extra file listings

/** `GET /api/datasets/{dataset_id}/get_content_as_text` (Galaxy's `text_data`, first 1 MB). */
async function contentAsText(row: HdaWithDataset, filename: string | null): Promise<DatasetTextContentDetails> {
    if (row.state === "upload") {
        throw ApiError.conflict("Please wait until this dataset finishes uploading");
    }
    const itemUrl = `/datasets/${row.hda.id}/display?preview=False`;
    const info = await getDatatype(row.hda.extension);
    const client = await getStorageClient();
    const decode = (bytes: Uint8Array) => {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            throw ApiError.badRequest("Cannot generate text preview for dataset.");
        }
    };
    if (filename && filename !== "index") {
        const path = normalizeMemberPath(filename);
        const index = path ? await extraFiles(client, row.dataset) : null;
        const entry = path && index ? findMember(index, path) : undefined;
        if (!entry || entry.type !== "file") {
            throw ApiError.notFound(`Could not find '${filename}' on the extra files path.`);
        }
        const size = entry.size ?? 0;
        let member: Uint8Array;
        try {
            member = entry.key
                ? await readBody(await client.getObject(entry.key), MAX_PEEK_SIZE)
                : await readRange(client, row.dataset.extra_files!.key, entry.offset!, Math.min(size, MAX_PEEK_SIZE));
        } catch (error) {
            throw storageError(error, `'${filename}'`);
        }
        return { item_data: decode(member), truncated: size > MAX_PEEK_SIZE, item_url: itemUrl };
    }
    if (!info.isA(DatatypeClass.TEXT)) {
        return { item_data: null, truncated: false, item_url: itemUrl };
    }
    if (row.dataset.file_size === 0) {
        return { item_data: "", truncated: false, item_url: itemUrl };
    }
    let prefix: { bytes: Uint8Array; truncated: boolean };
    try {
        prefix = await readPrefix(client, row.dataset.object_key, MAX_PEEK_SIZE, info.isA(DatatypeClass.GZIP));
    } catch (error) {
        throw storageError(error, `dataset ${row.hda.hid}`);
    }
    return {
        item_data: decode(prefix.bytes),
        truncated: (row.dataset.file_size ?? 0) > MAX_PEEK_SIZE || prefix.truncated,
        item_url: itemUrl,
    };
}

async function metadataFile(request: PlanetRequest, row: HdaWithDataset, name: string | null): Promise<Response> {
    if (!name) {
        throw ApiError.missingParameter("Required parameter 'metadata_file' is missing.");
    }
    ensureDatasetOnDisk(row);
    const file = Object.hasOwn(row.dataset.metadata_files, name) ? row.dataset.metadata_files[name] : undefined;
    if (!file) {
        throw ApiError.badRequest(`Metadata file ${name} is not set for this dataset`);
    }
    const fileExt = METADATA_FILE_EXTENSIONS[name] ?? name;
    const datasetName = Array.from(row.hda.name || "Unnamed dataset")
        .map((char) => (FILENAME_VALID_CHARS.has(char) ? char : "_"))
        .slice(0, 150)
        .join("");
    const disposition = `attachment; filename="Galaxy${row.hda.hid}-[${datasetName}].${fileExt}"`;
    if (request.method === "HEAD") {
        const headers: Record<string, string> = {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": disposition,
        };
        if (file.file_size !== null) {
            headers["Content-Length"] = String(file.file_size);
        }
        return new Response(null, { headers });
    }
    const client = await getStorageClient();
    const url = await presign(
        client,
        file.key,
        { responseContentDisposition: disposition, responseContentType: "application/octet-stream" },
        `metadata file ${name}`,
    );
    return redirect(url);
}

async function extraFilesListing(row: HdaWithDataset): Promise<{ class: "File" | "Directory"; path: string }[]> {
    if (["new", "upload", "queued", "running", "setting_metadata"].includes(row.state) || !row.dataset.extra_files) {
        return [];
    }
    const client = await getStorageClient();
    const index = await extraFiles(client, row.dataset);
    return [...(index?.values() ?? [])].map((entry) => ({
        class: entry.type === "directory" ? ("Directory" as const) : ("File" as const),
        path: entry.path,
    }));
}

// ---------------------------------------------------------------------------------------------------------
// Edit attributes (legacy /dataset/get_edit and /dataset/set_edit)

const UNFINISHED_JOB_STATES = JOB_STATES.filter((state) => !TERMINAL_JOB_STATES.has(state));

/** Galaxy's `ok_to_edit_metadata`: no job outside a terminal state uses the dataset as input or output. */
async function okToEditMetadata(hda: HdaRecord, tx: ReadTx): Promise<boolean> {
    const active = await jobs.listByState(UNFINISHED_JOB_STATES, tx);
    return !active.some(
        (job) =>
            job.inputs.some((input) => input.src === "hda" && input.id === hda.id) ||
            job.outputs.some((output) => output.id === hda.id),
    );
}

async function datatypeChangeAllowed(extension: string): Promise<boolean> {
    const info = await getDatatype(extension);
    return Boolean(info.details) && !info.details?.composite_files?.length;
}

async function editForm(row: HdaWithDataset): Promise<Record<string, unknown>> {
    if (row.dataset.state === "upload") {
        throw ApiError.badRequest(
            "Please wait until this dataset finishes uploading before attempting to edit its metadata.",
            ErrorCodes.UNKNOWN,
        );
    }
    const { hda } = row;
    const [builds, details] = await Promise.all([genomeBuilds(), getAllDatatypeDetails()]);
    const dbkey = hda.dbkey || "?";
    const changeable = Object.entries(details)
        .filter(([, item]) => !item.composite_files?.length)
        .map(([extension]) => extension)
        .sort();
    const currentChangeable = await datatypeChangeAllowed(hda.extension);
    return {
        display_name: hda.name,
        message: null,
        status: null,
        dataset_id: hda.id,
        metadata_disable: !["ok", "failed_metadata"].includes(row.state),
        attribute_inputs: [
            { name: "name", type: "text", label: "Name", value: hda.name },
            { name: "info", type: "text", area: true, label: "Info", value: hda.info },
            {
                name: "annotation",
                type: "text",
                area: true,
                label: "Annotation",
                optional: true,
                value: hda.annotation ?? "",
                help: "Add an annotation or notes to a dataset; annotations are available when a history is viewed.",
            },
            {
                type: "select",
                multiple: false,
                optional: null,
                name: "dbkey",
                label: "Database/Build",
                options: builds.map(([name, key]) => [name, key, key === dbkey]),
                value: dbkey,
            },
        ],
        conversion_inputs: [
            {
                type: "select",
                name: "target_type",
                label: "Target datatype",
                help: "This will create a new dataset with the contents of this dataset converted to a new format.",
                options: [],
            },
        ],
        conversion_disable: true,
        datatype_inputs: [
            {
                type: "select",
                name: "datatype",
                label: "New Type",
                options: changeable.map((extension) => [extension, extension]),
                value: currentChangeable ? hda.extension : null,
                help: "This will change the datatype of the existing dataset but not modify its contents. Use this if Galaxy has incorrectly guessed the type of your dataset.",
            },
        ],
        datatype_disable: changeable.length === 0,
        permission_inputs: [
            {
                name: "access_public",
                type: "hidden",
                label: "This dataset is accessible by everyone (it is public).",
                readonly: true,
            },
        ],
        permission_disable: true,
    };
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

async function setEdit(payload: Record<string, unknown>): Promise<{ status: string; message: string }> {
    const operation = payloadString(payload, "operation");
    const datasetId = payloadString(payload, "dataset_id");
    if (!datasetId) {
        throw ApiError.badRequest("You must provide a dataset id to edit attributes.", ErrorCodes.UNKNOWN);
    }
    const row = await hdas.getWithDataset(datasetId);
    if (!row) {
        throw ApiError.badRequest("The dataset id is invalid.", ErrorCodes.UNKNOWN);
    }
    switch (operation) {
        case "attributes":
            return withTransaction(JOB_STORES, "readwrite", async (tx) => {
                const patch: hdas.HdaPatch = {
                    name: payloadString(payload, "name") ?? row.hda.name,
                    info: payloadString(payload, "info"),
                };
                const editable = await okToEditMetadata(row.hda, tx);
                if (editable) {
                    const dbkey = payloadString(payload, "dbkey") || "?";
                    patch.dbkey = dbkey;
                    patch.metadata = { ...row.hda.metadata, dbkey };
                    const annotation = payloadString(payload, "annotation");
                    if (annotation) {
                        patch.annotation = annotation;
                    }
                }
                await hdas.update(row.hda.id, patch, tx);
                return editable
                    ? { status: "success", message: "Attributes updated." }
                    : {
                          status: "warning",
                          message:
                              "Attributes updated, but metadata could not be changed because this dataset is currently being used as input or output. You must cancel or wait for these jobs to complete before changing metadata.",
                      };
            });
        case "datatype": {
            const datatype = payloadString(payload, "datatype");
            if (!(await datatypeChangeAllowed(row.hda.extension))) {
                throw ApiError.badRequest("The current datatype does not allow datatype changes.");
            }
            if (!datatype || !(await getDatatype(datatype)).details) {
                throw ApiError.badRequest("The target datatype does not exist.");
            }
            if (!(await datatypeChangeAllowed(datatype))) {
                throw ApiError.badRequest("The target datatype does not allow datatype changes.");
            }
            return withTransaction(JOB_STORES, "readwrite", async (tx) => {
                if (!(await okToEditMetadata(row.hda, tx))) {
                    throw ApiError.badRequest(
                        "Dataset metadata could not be updated because it is used as input or output of a running job.",
                    );
                }
                await changeDatatype(row.hda.id, datatype, tx);
                return { status: "success", message: `Changed the type to ${datatype}.` };
            });
        }
        case "datatype_detect": {
            if (!(await datatypeChangeAllowed(row.hda.extension))) {
                throw ApiError.badRequest(
                    `Changing datatype "${row.hda.extension}" is not allowed.`,
                    ErrorCodes.UNKNOWN,
                );
            }
            return withTransaction(JOB_STORES, "readwrite", async (tx) => {
                await changeDatatype(row.hda.id, "auto", tx);
                return {
                    status: "success",
                    message: "Datatype detection submitted; the dataset updates when it finishes.",
                };
            });
        }
        case "autodetect":
            return withTransaction(JOB_STORES, "readwrite", async (tx) => {
                await changeDatatype(row.hda.id, row.hda.extension, tx);
                return { status: "success", message: "Auto-detect operation successfully submitted." };
            });
        case "conversion":
            throw ApiError.badRequest("Datatype conversion is not available in Planet yet.", ErrorCodes.UNKNOWN);
        case "permission":
            throw ApiError.badRequest(
                "Planet has a single user; dataset permissions do not apply.",
                ErrorCodes.UNKNOWN,
            );
        default:
            throw ApiError.badRequest(`Invalid operation identifier (${operation}).`, ErrorCodes.UNKNOWN);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Storage details and job-derived views

async function storageDetails(row: HdaWithDataset): Promise<DatasetStorageDetails> {
    return {
        object_store_id: null,
        name: "Your bucket",
        description:
            "Dataset files are kept in the S3-compatible bucket configured in Planet's settings. Only this browser holds the bucket credentials.",
        shareable: true,
        private: false,
        relocatable: false,
        percent_used: null,
        dataset_state: row.dataset.state,
        hashes: row.dataset.hashes.map((hash) => ({ model_class: "DatasetHash", ...hash })),
        sources: row.dataset.sources.map((source) => ({ model_class: "DatasetSource", ...source })),
        quota: { source: null, enabled: false },
        badges: [],
    };
}

/** Applies `view` to the job that created the HDA, or returns `empty` when no job did. */
async function creatingJobView<T>(id: string, empty: T, view: (job: JobRecord, tx: ReadTx) => Promise<T>): Promise<T> {
    return readTx([...CONTENT_STORES, "jobs"], async (tx) => {
        const hda = await hdas.getOrThrow(id, tx);
        const job = hda.creating_job_id ? await jobs.get(hda.creating_job_id, tx) : undefined;
        return job ? view(job, tx) : empty;
    });
}

const EMPTY_PARAMETERS: JobDisplayParametersSummary = { parameters: [], has_parameter_errors: false, outputs: {} };

// ---------------------------------------------------------------------------------------------------------
// Handlers

export function register(router: Router): void {
    router.route("/api/datasets", "get", async ({ query }) => passthrough(await listDatasets(query)));
    router.route("/api/datasets/{dataset_id}", "get", ({ params, query }) => showDataset(params.dataset_id, query));

    router.route("/api/datasets/{dataset_id}/parameters_display", "get", ({ params }) =>
        creatingJobView(params.dataset_id, EMPTY_PARAMETERS, summarizeJobParameters),
    );

    router.route("/api/datasets/{dataset_id}/metrics", "get", ({ params }) =>
        creatingJobView(params.dataset_id, [], async (job) => job.metrics),
    );

    router.route("/api/datasets/{dataset_id}/storage", "get", async ({ params }) =>
        storageDetails(await loadDataset(params.dataset_id)),
    );

    router.route("/api/datasets/{dataset_id}/inheritance_chain", "get", async ({ params }) => {
        await hdas.getOrThrow(params.dataset_id);
        return [];
    });

    router.route("/api/datasets/{dataset_id}/get_content_as_text", "get", async ({ params, query }) =>
        contentAsText(await loadDataset(params.dataset_id), query.get("filename")),
    );

    router.route("/api/datasets/{dataset_id}/extra_files", "get", async ({ params }) =>
        extraFilesListing(await loadDataset(params.dataset_id)),
    );
    router.route("/api/histories/{history_id}/contents/{history_content_id}/extra_files", "get", async ({ params }) =>
        extraFilesListing(await loadDataset(params.history_content_id)),
    );
    router.untyped("/api/datasets/{dataset_id}/extra_files/raw/{filename:path}", "get", async (request) =>
        display(request, await loadDataset(request.params.dataset_id!), {
            ...displayOptions(request.query, false),
            filename: request.params.filename!,
            raw: true,
        }),
    );

    const apiDisplay = async (request: PlanetRequest, id: string) =>
        passthrough(await display(request, await loadDataset(id), displayOptions(request.query, false)));
    router.route("/api/datasets/{history_content_id}/display", "get", (request) =>
        apiDisplay(request, request.params.history_content_id),
    );
    router.route("/api/histories/{history_id}/contents/{history_content_id}/display", "get", (request) =>
        apiDisplay(request, request.params.history_content_id),
    );

    const apiDownload = async (request: PlanetRequest, id: string) =>
        passthrough(
            await download(request, await loadDataset(id), checkExtension(request.query.get("to_ext")) ?? "data"),
        );
    const apiMetadataFile = async (request: PlanetRequest, id: string) =>
        passthrough(await metadataFile(request, await loadDataset(id), request.query.get("metadata_file")));
    router.route("/api/datasets/{history_content_id}/download", "get", (request) =>
        apiDownload(request, request.params.history_content_id),
    );
    router.route("/api/histories/{history_id}/contents/{history_content_id}/download", "get", (request) =>
        apiDownload(request, request.params.history_content_id),
    );

    router.route("/api/datasets/{history_content_id}/metadata_file", "get", (request) =>
        apiMetadataFile(request, request.params.history_content_id),
    );
    router.route("/api/histories/{history_id}/contents/{history_content_id}/metadata_file", "get", (request) =>
        apiMetadataFile(request, request.params.history_content_id),
    );

    router.untyped("/datasets/{dataset_id}/display", "get", async (request) =>
        display(request, await loadDataset(request.params.dataset_id!), displayOptions(request.query, true)),
    );
    router.untyped("/datasets/{dataset_id}/display/{filename:path}", "get", async (request) =>
        display(
            request,
            await loadDataset(request.params.dataset_id!),
            displayOptions(request.query, true, request.params.filename!),
        ),
    );
    router.untyped("/dataset/display", "get", async (request) => {
        const id = request.query.get("dataset_id");
        if (!id) {
            throw ApiError.notFound("Invalid reference dataset id: None.");
        }
        return display(request, await loadDataset(id), displayOptions(request.query, true));
    });
    router.untyped("/dataset/get_metadata_file", "get", async (request) => {
        const id = request.query.get("hda_id");
        const name = request.query.get("metadata_name");
        if (!id || !name) {
            throw ApiError.badRequest("Required parameters 'hda_id' and 'metadata_name' are missing.");
        }
        return metadataFile(request, await loadDataset(id), name);
    });

    router.untyped("/dataset/get_edit", "get", async ({ query }) => {
        const id = query.get("dataset_id");
        if (!id) {
            throw ApiError.badRequest("You must provide a dataset id to edit attributes.", ErrorCodes.UNKNOWN);
        }
        const row = await hdas.getWithDataset(id);
        if (!row) {
            throw ApiError.badRequest("The dataset id is invalid.", ErrorCodes.UNKNOWN);
        }
        return editForm(row);
    });
    router.untyped("/dataset/set_edit", "put", async ({ json: body }) => {
        const payload = await body();
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            throw ApiError.badRequest("Invalid payload.");
        }
        return setEdit(payload as Record<string, unknown>);
    });
}
