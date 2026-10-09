import { errorFromResponse, networkBlockedError, S3Error } from "./errors";
import { runSetupCheck, type S3SetupOptions, type S3SetupReport } from "./setup";
import { S3Signer, sha256Hex, SKEW_RETRY_THRESHOLD_MS } from "./signer";
import {
    buildUrl,
    fullKey,
    fullListPrefix,
    type QueryParams,
    relativeKey,
    resolveConfig,
    type ResolvedS3Config,
    type S3Config,
} from "./url";
import { escapeXmlText, parseXml, xmlChildren, xmlChildText, type XmlElement } from "./xml";

export type S3Body = Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>;

export type S3Method = "GET" | "HEAD" | "PUT" | "POST" | "DELETE";

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface S3ClientOptions {
    /** Defaults to the global fetch. */
    fetch?: FetchFunction;
    /** Local clock in epoch milliseconds. Defaults to Date.now. */
    now?: () => number;
    /** Delay used between retries. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Retries for 5xx and 429 responses. Defaults to 3. */
    retries?: number;
}

export interface S3RequestOptions {
    signal?: AbortSignal;
}

/** Inclusive byte range, or a raw `bytes=` header value with a single range. */
export type S3Range = { start: number; end?: number } | string;

export interface S3GetOptions extends S3RequestOptions {
    range?: S3Range;
}

export interface S3PutOptions extends S3RequestOptions {
    contentType?: string;
    contentDisposition?: string;
}

export interface S3ObjectInfo {
    contentLength: number | null;
    contentType: string | null;
    etag: string | null;
    lastModified: string | null;
    versionId: string | null;
}

export interface S3PutResult {
    /** Null when the bucket CORS policy does not expose ETag. */
    etag: string | null;
    versionId: string | null;
}

export interface S3ListOptions extends S3RequestOptions {
    continuationToken?: string;
    /** 1 to 1000; the server default is 1000. */
    maxKeys?: number;
    delimiter?: string;
    /** Relative key after which listing starts. */
    startAfter?: string;
}

export interface S3ListedObject {
    /** Key relative to the configured prefix. */
    key: string;
    size: number;
    etag: string;
    lastModified: string;
}

export interface S3ListResult {
    objects: S3ListedObject[];
    /** Common prefixes relative to the configured prefix, present when a delimiter was given. */
    commonPrefixes: string[];
    isTruncated: boolean;
    nextContinuationToken: string | null;
}

export interface S3Part {
    partNumber: number;
    etag: string;
}

export interface S3ListedPart extends S3Part {
    size: number;
    lastModified: string;
}

export interface S3PresignOptions {
    /** Host the URL is signed for. "cluster" uses the cluster endpoint. Defaults to "browser". */
    endpoint?: "browser" | "cluster";
}

export interface S3PresignGetOptions extends S3PresignOptions {
    responseContentDisposition?: string;
    responseContentType?: string;
}

export interface S3Client {
    headBucket(options?: S3RequestOptions): Promise<{ region: string | null }>;
    /** Resolves with the 200 or 206 response; the caller consumes the body. */
    getObject(key: string, options?: S3GetOptions): Promise<Response>;
    headObject(key: string, options?: S3RequestOptions): Promise<S3ObjectInfo>;
    putObject(key: string, body: S3Body, options?: S3PutOptions): Promise<S3PutResult>;
    /** Succeeds when the object does not exist. */
    deleteObject(key: string, options?: S3RequestOptions): Promise<void>;
    listObjects(prefix: string, options?: S3ListOptions): Promise<S3ListResult>;
    presignGet(key: string, expiresSeconds: number, options?: S3PresignGetOptions): Promise<string>;
    presignPut(key: string, expiresSeconds: number, options?: S3PresignOptions): Promise<string>;
    /** Resolves with the upload ID. */
    createMultipartUpload(key: string, options?: S3PutOptions): Promise<string>;
    uploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        body: S3Body,
        options?: S3RequestOptions,
    ): Promise<S3Part>;
    presignUploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        expiresSeconds: number,
        options?: S3PresignOptions,
    ): Promise<string>;
    completeMultipartUpload(
        key: string,
        uploadId: string,
        parts: S3Part[],
        options?: S3RequestOptions,
    ): Promise<{ etag: string | null; location: string | null }>;
    /** Succeeds when the upload no longer exists. */
    abortMultipartUpload(key: string, uploadId: string, options?: S3RequestOptions): Promise<void>;
    listParts(key: string, uploadId: string, options?: S3RequestOptions): Promise<S3ListedPart[]>;
    checkSetup(options?: S3SetupOptions): Promise<S3SetupReport>;
    /** Current difference between the server clock and the local clock, in milliseconds. */
    readonly clockOffsetMs: number;
}

/** @internal Request description shared with the setup check. */
export interface S3RequestSpec {
    method: S3Method;
    /** Full key; omitted for bucket-level requests. */
    key?: string;
    query?: QueryParams;
    headers?: Record<string, string>;
    body?: S3Body;
    signal?: AbortSignal;
    notFoundCode?: string;
    acceptStatus?: (status: number) => boolean;
    onResponse?: (response: Response) => void;
}

const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 8000;
const RETRY_AFTER_MAX_MS = 20000;
const MAX_PART_NUMBER = 10000;
const S3_XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RETRYABLE_BODY_ERRORS = new Set(["InternalError", "SlowDown", "ServiceUnavailable"]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isStream(body: S3Body | undefined): body is ReadableStream<Uint8Array> {
    return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

async function payloadHash(body: S3Body | undefined): Promise<string | undefined> {
    if (body === undefined) {
        return EMPTY_SHA256;
    }
    if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return sha256Hex(body);
    }
    return undefined;
}

function rangeHeader(range: S3Range): string {
    if (typeof range === "string") {
        if (!/^bytes=(\d+-\d*|-\d+)$/.test(range)) {
            throw new RangeError(`Unsupported range '${range}'; use a single bytes= range.`);
        }
        return range;
    }
    const { start, end } = range;
    if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))
    ) {
        throw new RangeError("Range start and end must be integers with 0 <= start <= end.");
    }
    return `bytes=${start}-${end ?? ""}`;
}

function checkPartNumber(partNumber: number): void {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
        throw new RangeError(`Part numbers must be integers from 1 to ${MAX_PART_NUMBER}.`);
    }
}

function checkUploadId(uploadId: string): void {
    if (!uploadId) {
        throw new RangeError("An upload ID is required.");
    }
}

function successful(status: number): boolean {
    return status >= 200 && status < 300;
}

function backoffDelay(attempt: number, response: Response): number {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(retryAfter * 1000, RETRY_AFTER_MAX_MS);
    }
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
    return ceiling / 2 + Math.random() * (ceiling / 2);
}

async function discard(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // The body is irrelevant once the request is retried.
    }
}

async function readXml(response: Response, expectedRoot: string): Promise<XmlElement> {
    const text = await response.text();
    let root: XmlElement;
    try {
        root = parseXml(text);
    } catch (error) {
        throw new S3Error(response.status, "InvalidResponse", `Could not parse the ${expectedRoot} response.`, {
            cause: error,
        });
    }
    if (root.name === "Error") {
        throw new S3Error(
            response.status,
            xmlChildText(root, "Code")?.trim() || "InternalError",
            xmlChildText(root, "Message")?.trim() || `The ${expectedRoot} request failed.`,
            { requestId: xmlChildText(root, "RequestId")?.trim() || null },
        );
    }
    if (root.name !== expectedRoot) {
        throw new S3Error(response.status, "InvalidResponse", `Expected ${expectedRoot}, got ${root.name}.`);
    }
    return root;
}

function decodeListValue(value: string, urlEncoded: boolean): string {
    return urlEncoded ? decodeURIComponent(value.replace(/\+/g, " ")) : value;
}

export function parseListObjectsV2(root: XmlElement, prefix: string): S3ListResult {
    const urlEncoded = xmlChildText(root, "EncodingType")?.trim() === "url";
    const objects: S3ListedObject[] = [];
    for (const item of xmlChildren(root, "Contents")) {
        const key = relativeKey(prefix, decodeListValue(xmlChildText(item, "Key") ?? "", urlEncoded));
        if (key === null || key === "") {
            continue;
        }
        objects.push({
            key,
            size: Number(xmlChildText(item, "Size") ?? "0"),
            etag: xmlChildText(item, "ETag")?.trim() ?? "",
            lastModified: xmlChildText(item, "LastModified")?.trim() ?? "",
        });
    }
    const commonPrefixes: string[] = [];
    for (const item of xmlChildren(root, "CommonPrefixes")) {
        const value = relativeKey(prefix, decodeListValue(xmlChildText(item, "Prefix") ?? "", urlEncoded));
        if (value !== null) {
            commonPrefixes.push(value);
        }
    }
    return {
        objects,
        commonPrefixes,
        isTruncated: xmlChildText(root, "IsTruncated")?.trim() === "true",
        nextContinuationToken: xmlChildText(root, "NextContinuationToken") || null,
    };
}

export function buildCompleteMultipartUploadXml(parts: S3Part[]): string {
    if (parts.length === 0) {
        throw new RangeError("At least one part is required to complete a multipart upload.");
    }
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    let previous = 0;
    const items = sorted.map(({ partNumber, etag }) => {
        checkPartNumber(partNumber);
        if (partNumber === previous) {
            throw new RangeError(`Part ${partNumber} is listed more than once.`);
        }
        if (!etag) {
            throw new RangeError(`Part ${partNumber} has no ETag.`);
        }
        previous = partNumber;
        return `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXmlText(etag)}</ETag></Part>`;
    });
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<CompleteMultipartUpload xmlns="${S3_XMLNS}">${items.join("")}</CompleteMultipartUpload>`
    );
}

class S3ClientImpl implements S3Client {
    private readonly config: ResolvedS3Config | null;
    private readonly configError: S3Error | null;
    private readonly signer: S3Signer;
    private readonly fetchImpl: FetchFunction;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly retries: number;

    constructor(config: S3Config, options: S3ClientOptions) {
        let resolved: ResolvedS3Config | null = null;
        let error: S3Error | null = null;
        try {
            resolved = resolveConfig(config);
        } catch (e) {
            if (!(e instanceof S3Error)) {
                throw e;
            }
            error = e;
        }
        this.config = resolved;
        this.configError = error;
        this.signer = new S3Signer(
            {
                accessKeyId: resolved?.accessKeyId ?? "",
                secretAccessKey: resolved?.secretAccessKey ?? "",
                region: resolved?.region ?? "",
            },
            options.now ?? Date.now,
        );
        this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.sleep = options.sleep ?? defaultSleep;
        this.retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
    }

    get clockOffsetMs(): number {
        return this.signer.clockOffsetMs;
    }

    private get resolved(): ResolvedS3Config {
        if (!this.config) {
            throw this.configError ?? new S3Error(0, "invalid_config", "The storage settings are invalid.");
        }
        return this.config;
    }

    private key(key: string): string {
        return fullKey(this.resolved.prefix, key);
    }

    /** Signs and sends a request, retrying 5xx/429 responses and once after a clock-skew correction. */
    async send(spec: S3RequestSpec): Promise<Response> {
        const config = this.resolved;
        const url = buildUrl(config.endpoint, config.bucket, config.pathStyle, spec.key, spec.query);
        const replayable = !isStream(spec.body);
        const contentSha256 = await payloadHash(spec.body);
        const accept = spec.acceptStatus ?? successful;
        let attempt = 0;
        let skewRetried = false;
        for (;;) {
            spec.signal?.throwIfAborted();
            const signedOffset = this.signer.clockOffsetMs;
            const headers = await this.signer.signHeaders(spec.method, url, new Headers(spec.headers), contentSha256);
            const init: RequestInit & { duplex?: "half" } = {
                method: spec.method,
                headers,
                body: spec.body as BodyInit | undefined,
                signal: spec.signal,
                cache: "no-store",
                credentials: "omit",
                redirect: "manual",
                referrerPolicy: "no-referrer",
            };
            if (!replayable) {
                init.duplex = "half";
            }
            const sentAt = this.signer.localNow();
            let response: Response;
            try {
                response = await this.fetchImpl(url.href, init);
            } catch (error) {
                if (spec.signal?.aborted) {
                    throw spec.signal.reason ?? error;
                }
                if (error instanceof TypeError) {
                    throw networkBlockedError(config.endpoint, error);
                }
                throw error;
            }
            this.signer.observeDate(response.headers.get("date"), sentAt, this.signer.localNow());
            spec.onResponse?.(response);
            if (response.type === "opaqueredirect") {
                throw new S3Error(
                    0,
                    "Redirect",
                    "The storage endpoint answered with a redirect. Check the endpoint, region and addressing style.",
                );
            }
            if (accept(response.status)) {
                return response;
            }
            if ((response.status >= 500 || response.status === 429) && attempt < this.retries && replayable) {
                await discard(response);
                await this.sleep(backoffDelay(attempt, response), spec.signal);
                attempt++;
                continue;
            }
            const error = await errorFromResponse(response, spec.notFoundCode);
            if (!skewRetried && replayable && this.correctedForSkew(error, signedOffset)) {
                skewRetried = true;
                continue;
            }
            throw error;
        }
    }

    private correctedForSkew(error: S3Error, signedOffset: number): boolean {
        if (error.code === "RequestTimeTooSkewed") {
            if (error.serverTime !== null) {
                this.signer.observeServerTime(error.serverTime, this.signer.localNow());
            }
            return this.signer.clockOffsetMs !== signedOffset;
        }
        return error.status === 403 && Math.abs(this.signer.clockOffsetMs - signedOffset) >= SKEW_RETRY_THRESHOLD_MS;
    }

    private presignUrl(
        method: S3Method,
        key: string,
        expiresSeconds: number,
        endpoint: S3PresignOptions["endpoint"],
        query: QueryParams,
    ): Promise<string> {
        const config = this.resolved;
        const base = endpoint === "cluster" ? config.clusterEndpoint : config.endpoint;
        const url = buildUrl(base, config.bucket, config.pathStyle, this.key(key), query);
        return this.signer.presign(method, url, expiresSeconds);
    }

    async headBucket(options: S3RequestOptions = {}): Promise<{ region: string | null }> {
        const response = await this.send({ method: "HEAD", notFoundCode: "NoSuchBucket", signal: options.signal });
        return { region: response.headers.get("x-amz-bucket-region") };
    }

    async getObject(key: string, options: S3GetOptions = {}): Promise<Response> {
        const headers: Record<string, string> = {};
        if (options.range !== undefined) {
            headers.range = rangeHeader(options.range);
        }
        return this.send({
            method: "GET",
            key: this.key(key),
            headers,
            signal: options.signal,
            notFoundCode: "NoSuchKey",
            acceptStatus: (status) => status === 200 || status === 206,
        });
    }

    async headObject(key: string, options: S3RequestOptions = {}): Promise<S3ObjectInfo> {
        const response = await this.send({
            method: "HEAD",
            key: this.key(key),
            signal: options.signal,
            notFoundCode: "NoSuchKey",
        });
        const length = response.headers.get("content-length");
        return {
            contentLength: length === null ? null : Number(length),
            contentType: response.headers.get("content-type"),
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
            versionId: response.headers.get("x-amz-version-id"),
        };
    }

    async putObject(key: string, body: S3Body, options: S3PutOptions = {}): Promise<S3PutResult> {
        const response = await this.send({
            method: "PUT",
            key: this.key(key),
            headers: contentHeaders(options),
            body,
            signal: options.signal,
        });
        await discard(response);
        return { etag: response.headers.get("etag"), versionId: response.headers.get("x-amz-version-id") };
    }

    async deleteObject(key: string, options: S3RequestOptions = {}): Promise<void> {
        const response = await this.send({
            method: "DELETE",
            key: this.key(key),
            signal: options.signal,
            acceptStatus: (status) => successful(status) || status === 404,
        });
        await discard(response);
    }

    async listObjects(prefix: string, options: S3ListOptions = {}): Promise<S3ListResult> {
        const config = this.resolved;
        const query: QueryParams = [["list-type", "2"]];
        const listPrefix = fullListPrefix(config.prefix, prefix);
        if (listPrefix) {
            query.push(["prefix", listPrefix]);
        }
        if (options.delimiter) {
            query.push(["delimiter", options.delimiter]);
        }
        if (options.continuationToken) {
            query.push(["continuation-token", options.continuationToken]);
        }
        if (options.maxKeys !== undefined) {
            if (!Number.isInteger(options.maxKeys) || options.maxKeys < 1 || options.maxKeys > 1000) {
                throw new RangeError("maxKeys must be an integer from 1 to 1000.");
            }
            query.push(["max-keys", String(options.maxKeys)]);
        }
        if (options.startAfter) {
            query.push(["start-after", this.key(options.startAfter)]);
        }
        const response = await this.send({
            method: "GET",
            query,
            signal: options.signal,
            notFoundCode: "NoSuchBucket",
        });
        return parseListObjectsV2(await readXml(response, "ListBucketResult"), config.prefix);
    }

    async presignGet(key: string, expiresSeconds: number, options: S3PresignGetOptions = {}): Promise<string> {
        const query: QueryParams = [];
        if (options.responseContentDisposition) {
            query.push(["response-content-disposition", options.responseContentDisposition]);
        }
        if (options.responseContentType) {
            query.push(["response-content-type", options.responseContentType]);
        }
        return this.presignUrl("GET", key, expiresSeconds, options.endpoint, query);
    }

    async presignPut(key: string, expiresSeconds: number, options: S3PresignOptions = {}): Promise<string> {
        return this.presignUrl("PUT", key, expiresSeconds, options.endpoint, []);
    }

    async createMultipartUpload(key: string, options: S3PutOptions = {}): Promise<string> {
        const response = await this.send({
            method: "POST",
            key: this.key(key),
            query: [["uploads", ""]],
            headers: contentHeaders(options),
            signal: options.signal,
        });
        const root = await readXml(response, "InitiateMultipartUploadResult");
        const uploadId = xmlChildText(root, "UploadId")?.trim();
        if (!uploadId) {
            throw new S3Error(response.status, "InvalidResponse", "The server returned no upload ID.");
        }
        return uploadId;
    }

    async uploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        body: S3Body,
        options: S3RequestOptions = {},
    ): Promise<S3Part> {
        checkUploadId(uploadId);
        checkPartNumber(partNumber);
        const response = await this.send({
            method: "PUT",
            key: this.key(key),
            query: [
                ["partNumber", String(partNumber)],
                ["uploadId", uploadId],
            ],
            body,
            signal: options.signal,
            notFoundCode: "NoSuchUpload",
        });
        await discard(response);
        const etag = response.headers.get("etag");
        if (!etag) {
            throw new S3Error(
                response.status,
                "etag_not_exposed",
                "The part was uploaded but its ETag is not readable. Add ETag to the bucket CORS ExposeHeaders.",
            );
        }
        return { partNumber, etag };
    }

    async presignUploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        expiresSeconds: number,
        options: S3PresignOptions = {},
    ): Promise<string> {
        checkUploadId(uploadId);
        checkPartNumber(partNumber);
        return this.presignUrl("PUT", key, expiresSeconds, options.endpoint, [
            ["partNumber", String(partNumber)],
            ["uploadId", uploadId],
        ]);
    }

    async completeMultipartUpload(
        key: string,
        uploadId: string,
        parts: S3Part[],
        options: S3RequestOptions = {},
    ): Promise<{ etag: string | null; location: string | null }> {
        checkUploadId(uploadId);
        const body = buildCompleteMultipartUploadXml(parts);
        for (let attempt = 0; ; attempt++) {
            const response = await this.send({
                method: "POST",
                key: this.key(key),
                query: [["uploadId", uploadId]],
                headers: { "content-type": "application/xml" },
                body,
                signal: options.signal,
                notFoundCode: "NoSuchUpload",
            });
            try {
                // S3 may report a failed completion as a 200 response with an Error document.
                const root = await readXml(response, "CompleteMultipartUploadResult");
                return {
                    etag: xmlChildText(root, "ETag")?.trim() || null,
                    location: xmlChildText(root, "Location")?.trim() || null,
                };
            } catch (error) {
                if (error instanceof S3Error && RETRYABLE_BODY_ERRORS.has(error.code) && attempt < this.retries) {
                    await this.sleep(BACKOFF_BASE_MS * 2 ** attempt, options.signal);
                    continue;
                }
                throw error;
            }
        }
    }

    async abortMultipartUpload(key: string, uploadId: string, options: S3RequestOptions = {}): Promise<void> {
        checkUploadId(uploadId);
        const response = await this.send({
            method: "DELETE",
            key: this.key(key),
            query: [["uploadId", uploadId]],
            signal: options.signal,
            acceptStatus: (status) => successful(status) || status === 404,
        });
        await discard(response);
    }

    async listParts(key: string, uploadId: string, options: S3RequestOptions = {}): Promise<S3ListedPart[]> {
        checkUploadId(uploadId);
        const parts: S3ListedPart[] = [];
        let marker: string | null = null;
        for (let page = 0; page <= MAX_PART_NUMBER; page++) {
            const query: QueryParams = [["uploadId", uploadId]];
            if (marker) {
                query.push(["part-number-marker", marker]);
            }
            const response = await this.send({
                method: "GET",
                key: this.key(key),
                query,
                signal: options.signal,
                notFoundCode: "NoSuchUpload",
            });
            const root = await readXml(response, "ListPartsResult");
            for (const part of xmlChildren(root, "Part")) {
                parts.push({
                    partNumber: Number(xmlChildText(part, "PartNumber")),
                    etag: xmlChildText(part, "ETag")?.trim() ?? "",
                    size: Number(xmlChildText(part, "Size") ?? "0"),
                    lastModified: xmlChildText(part, "LastModified")?.trim() ?? "",
                });
            }
            const nextMarker = xmlChildText(root, "NextPartNumberMarker")?.trim() || null;
            if (xmlChildText(root, "IsTruncated")?.trim() !== "true" || !nextMarker || nextMarker === marker) {
                break;
            }
            marker = nextMarker;
        }
        return parts;
    }

    async checkSetup(options: S3SetupOptions = {}): Promise<S3SetupReport> {
        return runSetupCheck(
            {
                config: this.config,
                configError: this.configError,
                send: (spec) => this.send(spec),
                client: this,
                clockOffsetMs: () => this.signer.clockOffsetMs,
                now: () => this.signer.now(),
            },
            options,
        );
    }
}

function contentHeaders(options: S3PutOptions): Record<string, string> {
    const headers: Record<string, string> = {};
    if (options.contentType) {
        headers["content-type"] = options.contentType;
    }
    if (options.contentDisposition) {
        headers["content-disposition"] = options.contentDisposition;
    }
    return headers;
}

export function createS3Client(config: S3Config, options: S3ClientOptions = {}): S3Client {
    return new S3ClientImpl(config, options);
}
