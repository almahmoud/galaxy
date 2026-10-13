/**
 * Uploads a file from the page straight to the bucket. The Service Worker opens an upload session and signs a URL
 * per part; this module cuts the file into the session's parts, sends up to three at a time, retries failed parts
 * with backoff and fresh URLs, renews URLs before they expire and completes the upload through the worker.
 *
 * Parts are always `Blob` slices, never the `File` itself: WebKit sends an empty body for disk-backed files from
 * pages a Service Worker controls (WebKit bug 319985). Streams are read in order, one part at a time.
 */

import { partBytes, type PartUrl, type UploadedPart, type UploadSession } from "./protocol";
import { abortError, isAbortError, type PutFunction, type UploadApi, UploadTransferError } from "./transport";

/** Parts sent at the same time. */
export const CONCURRENCY = 3;
/** Attempts per part (and per worker request) before the upload fails. */
export const MAX_ATTEMPTS = 8;
/** Part URLs requested at once. */
export const URL_BATCH = 16;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** URLs are renewed when less than this share of their lifetime, at most five minutes, remains. */
const RENEW_SHARE = 0.25;
const RENEW_MAX_MS = 300_000;

export type UploadSource = { kind: "blob"; blob: Blob } | { kind: "stream"; stream: ReadableStream<Uint8Array> };

export interface BucketUploadOptions {
    name: string;
    size: number;
    contentType: string | null;
    historyId: string | null;
    /** Identifies the file so an unfinished session can be resumed; null starts a new session. */
    fingerprint: string | null;
    source: UploadSource;
    signal?: AbortSignal;
    /** Bytes stored so far, never decreasing. */
    onProgress?: (uploaded: number, total: number) => void;
}

export interface UploaderDependencies {
    api: UploadApi;
    put: PutFunction;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Resolves once the browser is online. */
    waitOnline?: (signal: AbortSignal) => Promise<void>;
    now?: () => number;
    random?: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function defaultWaitOnline(signal: AbortSignal): Promise<void> {
    if (typeof navigator === "undefined" || navigator.onLine !== false || typeof window === "undefined") {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const done = () => {
            window.removeEventListener("online", onOnline);
            signal.removeEventListener("abort", onAbort);
        };
        const onOnline = () => {
            done();
            resolve();
        };
        const onAbort = () => {
            done();
            reject(abortError());
        };
        window.addEventListener("online", onOnline);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/** Counts stored bytes: finished parts plus the progress of parts in flight. */
class Progress {
    private readonly inflight = new Map<number, number>();
    private reported = -1;

    constructor(
        private readonly total: number,
        private finished: number,
        private readonly listener?: (uploaded: number, total: number) => void,
    ) {}

    sending(partNumber: number, loaded: number): void {
        this.inflight.set(partNumber, loaded);
        this.report();
    }

    finish(partNumber: number, size: number): void {
        this.inflight.delete(partNumber);
        this.finished += size;
        this.report();
    }

    restart(partNumber: number): void {
        this.inflight.delete(partNumber);
    }

    report(): void {
        let uploaded = this.finished;
        for (const loaded of this.inflight.values()) {
            uploaded += loaded;
        }
        uploaded = Math.min(this.total, uploaded);
        if (uploaded > this.reported) {
            this.reported = uploaded;
            this.listener?.(uploaded, this.total);
        }
    }
}

/** Presigned part URLs with their expiry, fetched in batches and renewed before they expire. */
class PartUrls {
    private readonly urls = new Map<number, { url: string; renewAt: number }>();
    private readonly requests = new Map<number, Promise<void>>();

    constructor(
        private readonly api: UploadApi,
        private readonly id: string,
        private readonly now: () => number,
        private readonly signal: AbortSignal,
    ) {}

    store(parts: readonly PartUrl[], expiresIn: number, issuedAt: number): void {
        const lifetime = expiresIn * 1000;
        const renewAt = issuedAt + lifetime - Math.min(RENEW_MAX_MS, lifetime * RENEW_SHARE);
        for (const { part_number, url } of parts) {
            this.urls.set(part_number, { url, renewAt });
        }
    }

    private valid(partNumber: number): string | undefined {
        const entry = this.urls.get(partNumber);
        return entry && entry.renewAt > this.now() ? entry.url : undefined;
    }

    /**
     * Returns a URL for `partNumber`. A missing or expiring URL is fetched along with those of the `upcoming` parts;
     * `fresh` asks for a new URL even if the current one is still valid.
     */
    async get(partNumber: number, upcoming: readonly number[], fresh: boolean): Promise<string> {
        if (fresh) {
            this.urls.delete(partNumber);
        }
        for (;;) {
            const url = this.valid(partNumber);
            if (url) {
                return url;
            }
            const pending = this.requests.get(partNumber);
            if (pending) {
                await pending;
                continue;
            }
            const batch = [partNumber];
            for (const next of upcoming) {
                if (batch.length >= URL_BATCH) {
                    break;
                }
                if (next !== partNumber && !this.valid(next) && !this.requests.has(next)) {
                    batch.push(next);
                }
            }
            const issuedAt = this.now();
            const request = this.api.presign(this.id, batch, this.signal).then((response) => {
                this.store(response.parts, response.expires_in, issuedAt);
            });
            batch.forEach((number) => this.requests.set(number, request));
            try {
                await request;
            } finally {
                batch.forEach((number) => this.requests.delete(number));
            }
            if (!this.urls.has(partNumber)) {
                throw new UploadTransferError("The upload service returned no URL for a part.", 500);
            }
        }
    }
}

/** Limits how many parts are in flight. */
class Slots {
    private free: number;
    private readonly waiting: (() => void)[] = [];

    constructor(count: number) {
        this.free = count;
    }

    async acquire(): Promise<void> {
        if (this.free > 0) {
            this.free--;
            return;
        }
        await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    release(): void {
        const next = this.waiting.shift();
        if (next) {
            next();
        } else {
            this.free++;
        }
    }
}

/** Reads a stream in pieces of exact sizes. */
class StreamParts {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private carry: Uint8Array = new Uint8Array(0);

    constructor(stream: ReadableStream<Uint8Array>) {
        this.reader = stream.getReader();
    }

    /** The next `size` bytes as a Blob. */
    async read(size: number): Promise<Blob> {
        const pieces: Uint8Array[] = [];
        await this.take(size, (piece) => pieces.push(piece));
        return new Blob(pieces as BlobPart[]);
    }

    /** Discards the next `size` bytes. */
    async skip(size: number): Promise<void> {
        await this.take(size, () => undefined);
    }

    private async take(size: number, keep: (piece: Uint8Array) => void): Promise<void> {
        let collected = 0;
        while (collected < size) {
            let chunk = this.carry;
            this.carry = new Uint8Array(0);
            if (chunk.byteLength === 0) {
                const { done, value } = await this.reader.read();
                if (done) {
                    throw new UploadTransferError("The file ended before its stated size.", 400);
                }
                chunk = value;
            }
            const take = Math.min(chunk.byteLength, size - collected);
            keep(chunk.subarray(0, take));
            this.carry = chunk.subarray(take);
            collected += take;
        }
    }

    /** Fails when the stream has data beyond the stated size. */
    async finish(): Promise<void> {
        let extra = this.carry.byteLength > 0;
        while (!extra) {
            const { done, value } = await this.reader.read();
            if (done) {
                return;
            }
            extra = value.byteLength > 0;
        }
        throw new UploadTransferError("The file is longer than its stated size.", 400);
    }

    cancel(): void {
        this.reader.cancel().catch(() => undefined);
    }
}

/**
 * Uploads a file to the bucket through an upload session and resolves with the session id, which
 * `POST /api/tools/fetch` accepts as `files_N|file_data.session_id`. An aborted signal aborts the session.
 */
export async function uploadToBucket(
    options: BucketUploadOptions,
    dependencies: UploaderDependencies,
): Promise<{ id: string }> {
    const { api, put } = dependencies;
    const sleep = dependencies.sleep ?? defaultSleep;
    const waitOnline = dependencies.waitOnline ?? defaultWaitOnline;
    const now = dependencies.now ?? Date.now;
    const random = dependencies.random ?? Math.random;
    const { size } = options;
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new UploadTransferError("The file has no valid size.", 400);
    }
    const controller = new AbortController();
    const { signal } = controller;
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) {
        throw abortError();
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const backoff = (attempt: number) => {
        const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        return ceiling / 2 + random() * (ceiling / 2);
    };

    /** Runs `operation`, retrying failures that may pass, with backoff and a wait for connectivity. */
    async function withRetries<T>(operation: (attempt: number) => Promise<T>, onFailure?: () => void): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            signal.throwIfAborted();
            try {
                return await operation(attempt);
            } catch (error) {
                onFailure?.();
                if (signal.aborted || isAbortError(error)) {
                    throw abortError();
                }
                if (!(error instanceof UploadTransferError) || !error.retryable || attempt >= MAX_ATTEMPTS) {
                    throw error;
                }
                await waitOnline(signal);
                await sleep(backoff(attempt), signal);
            }
        }
    }

    let session: UploadSession | undefined;
    let stream: StreamParts | undefined;
    try {
        const created = await withRetries(() =>
            api.create(
                {
                    name: options.name,
                    size,
                    content_type: options.contentType,
                    history_id: options.historyId,
                    fingerprint: options.fingerprint,
                },
                signal,
            ),
        );
        session = created;
        if (signal.aborted) {
            throw abortError();
        }
        const etags = new Map<number, string>(created.uploaded.map((part) => [part.part_number, part.etag]));
        const stored = created.uploaded.reduce((sum: number, part: UploadedPart) => sum + part.size, 0);
        const progress = new Progress(size, stored, options.onProgress);
        progress.report();
        const urls = new PartUrls(api, created.id, now, signal);
        urls.store(created.parts, created.expires_in, now());
        const remaining: number[] = [];
        for (let partNumber = 1; partNumber <= created.part_count; partNumber++) {
            if (!etags.has(partNumber)) {
                remaining.push(partNumber);
            }
        }

        const sendPart = async (partNumber: number, body: Blob): Promise<void> => {
            let fresh = false;
            const etag = await withRetries(
                async () => {
                    const upcoming = remaining.filter((number) => number > partNumber && !etags.has(number));
                    const url = await urls.get(partNumber, upcoming, fresh);
                    fresh = true;
                    const result = await put(url, body, {
                        signal,
                        onProgress: (loaded) => progress.sending(partNumber, loaded),
                    });
                    return result.etag;
                },
                () => progress.restart(partNumber),
            );
            etags.set(partNumber, etag);
            progress.finish(partNumber, body.size);
        };

        let failure: Error | undefined;
        const fail = (error: unknown) => {
            failure ??= error instanceof Error ? error : new Error(String(error));
            controller.abort();
        };

        if (options.source.kind === "blob") {
            const { blob } = options.source;
            const queue = [...remaining];
            const worker = async () => {
                for (let partNumber = queue.shift(); partNumber !== undefined; partNumber = queue.shift()) {
                    const start = (partNumber - 1) * created.part_size;
                    await sendPart(partNumber, blob.slice(start, start + created.part_size));
                }
            };
            const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker().catch(fail));
            await Promise.all(workers);
        } else {
            stream = new StreamParts(options.source.stream);
            const slots = new Slots(CONCURRENCY);
            const tasks: Promise<void>[] = [];
            for (let partNumber = 1; partNumber <= created.part_count && failure === undefined; partNumber++) {
                const bytes = partBytes(size, created.part_size, partNumber);
                if (etags.has(partNumber)) {
                    await stream.skip(bytes);
                    continue;
                }
                await slots.acquire();
                if (failure !== undefined) {
                    break;
                }
                let body: Blob;
                try {
                    body = await stream.read(bytes);
                } catch (error) {
                    slots.release();
                    throw error;
                }
                tasks.push(
                    sendPart(partNumber, body)
                        .catch(fail)
                        .finally(() => slots.release()),
                );
            }
            if (failure === undefined) {
                await stream.finish();
            }
            await Promise.all(tasks);
        }
        if (failure !== undefined) {
            throw failure;
        }
        signal.throwIfAborted();

        const parts = [...etags.entries()]
            .sort(([a], [b]) => a - b)
            .map(([part_number, etag]) => ({ part_number, etag }));
        await withRetries(() => api.complete(created.id, { parts }, signal));
        progress.report();
        return { id: created.id };
    } catch (error) {
        controller.abort();
        stream?.cancel();
        if (options.signal?.aborted || isAbortError(error)) {
            if (session) {
                await api.abort(session.id).catch(() => undefined);
            }
            throw abortError();
        }
        throw error;
    } finally {
        options.signal?.removeEventListener("abort", onAbort);
    }
}
