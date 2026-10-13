/**
 * Network access of the page upload module: the Service Worker's upload session endpoints (JSON over `fetch`) and
 * presigned PUTs to the bucket (`XMLHttpRequest`, for upload progress). Error messages never contain URLs: a
 * presigned URL is a credential until it expires.
 */

import type {
    CompleteUploadRequest,
    CompleteUploadResponse,
    CreateUploadRequest,
    PresignPartsResponse,
    UploadSession,
} from "./protocol";

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([0, 403, 408, 425, 429, 500, 502, 503, 504]);

/** A failed request. `status` is the HTTP status, or 0 when no response arrived. */
export class UploadTransferError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "UploadTransferError";
    }

    /** Network failures, timeouts, throttling, transient server errors and 403 (an expired URL) may pass later. */
    get retryable(): boolean {
        return RETRYABLE_STATUSES.has(this.status);
    }
}

/** The worker's upload session endpoints. */
export interface UploadApi {
    create(request: CreateUploadRequest, signal?: AbortSignal): Promise<UploadSession>;
    presign(id: string, partNumbers: number[], signal?: AbortSignal): Promise<PresignPartsResponse>;
    complete(id: string, request: CompleteUploadRequest, signal?: AbortSignal): Promise<CompleteUploadResponse>;
    abort(id: string): Promise<void>;
}

export interface PutOptions {
    signal: AbortSignal;
    /** Bytes of the body sent so far. */
    onProgress: (loaded: number) => void;
}

/** Sends `body` to a presigned PUT URL and resolves with the object's or part's ETag. */
export type PutFunction = (url: string, body: Blob, options: PutOptions) => Promise<{ etag: string }>;

export function abortError(): DOMException {
    return new DOMException("Upload aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

async function errorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { err_msg?: unknown };
        if (typeof body.err_msg === "string" && body.err_msg) {
            return body.err_msg;
        }
    } catch {
        // Not a Galaxy error document.
    }
    return `The upload service answered ${response.status}.`;
}

/** Calls the worker's endpoints under `base` (`<app root>api/planet/uploads`). */
export function createUploadApi(
    base: string,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): UploadApi {
    async function call<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        let response: Response;
        try {
            response = await fetchImpl(`${base}${path}`, {
                method,
                headers: {
                    Accept: "application/json",
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                credentials: "same-origin",
                signal,
            });
        } catch {
            if (signal?.aborted) {
                throw abortError();
            }
            throw new UploadTransferError("The upload service could not be reached.", 0);
        }
        if (!response.ok) {
            throw new UploadTransferError(await errorMessage(response), response.status);
        }
        return (response.status === 204 ? undefined : await response.json()) as T;
    }

    return {
        create: (request, signal) => call<UploadSession>("", "POST", request, signal),
        presign: (id, partNumbers, signal) =>
            call<PresignPartsResponse>(
                `/${encodeURIComponent(id)}/parts`,
                "POST",
                { part_numbers: partNumbers },
                signal,
            ),
        complete: (id, request, signal) =>
            call<CompleteUploadResponse>(`/${encodeURIComponent(id)}/complete`, "POST", request, signal),
        abort: (id) => call<void>(`/${encodeURIComponent(id)}`, "DELETE"),
    };
}

/** The S3 error code of an error document, if the bucket sent one and CORS let the page read it. */
function s3ErrorCode(text: string): string | null {
    return /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(text)?.[1] ?? null;
}

/** {@link PutFunction} over XMLHttpRequest, which reports upload progress. */
export const xhrPut: PutFunction = (url, body, { signal, onProgress }) =>
    new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(abortError());
            return;
        }
        const xhr = new XMLHttpRequest();
        const onAbort = () => xhr.abort();
        const settle = (outcome: () => void) => {
            signal.removeEventListener("abort", onAbort);
            outcome();
        };
        xhr.open("PUT", url);
        xhr.upload.onprogress = (event) => onProgress(event.loaded);
        xhr.onload = () =>
            settle(() => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    const etag = xhr.getResponseHeader("ETag");
                    if (etag) {
                        resolve({ etag });
                    } else {
                        reject(
                            new UploadTransferError(
                                "The bucket did not expose the ETag header. Add ETag to the ExposeHeaders of its CORS policy.",
                                400,
                            ),
                        );
                    }
                    return;
                }
                const code = s3ErrorCode(typeof xhr.responseText === "string" ? xhr.responseText : "");
                reject(
                    new UploadTransferError(
                        `The bucket refused the upload: ${code ?? `HTTP ${xhr.status}`}.`,
                        xhr.status,
                    ),
                );
            });
        xhr.onerror = () => settle(() => reject(new UploadTransferError("The upload to the bucket failed.", 0)));
        xhr.ontimeout = () => settle(() => reject(new UploadTransferError("The upload to the bucket timed out.", 0)));
        xhr.onabort = () => settle(() => reject(abortError()));
        signal.addEventListener("abort", onAbort, { once: true });
        xhr.send(body);
    });
