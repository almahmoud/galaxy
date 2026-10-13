/**
 * Planet's replacement for `@/utils/tusUpload` (swapped in by the Planet Vite build). Same exports, but files go
 * straight to the user's bucket through an upload session of the Service Worker (`./multipart`), and the resolved
 * `sessionId` is the session id that `POST /api/tools/fetch` accepts. The part size is chosen by the worker, so
 * `chunkSize` is not used. Files and file streams resume an unfinished session for the same file and history;
 * blobs without a modification time (pasted text) always start a new one.
 */

import { type UploadSource, uploadToBucket } from "./multipart";
import { UPLOADS_PATH } from "./protocol";
import { abortError, createUploadApi, isAbortError, xhrPut } from "./transport";

/**
 * Represents a file stream for upload.
 * Used when uploading content from ReadableStream sources (e.g., ZIP file entries).
 */
export interface FileStream {
    name: string;
    size: number;
    type?: string;
    lastModified: number;
    stream: ReadableStream<Uint8Array>;
    isStream: true;
}

/**
 * Represents a Blob with a name property.
 * TypeScript doesn't natively support extending Blob with name,
 * so we use this interface for type safety.
 */
export interface NamedBlob extends Blob {
    name: string;
}

/**
 * Union type for all uploadable file types.
 */
export type UploadableFile = File | NamedBlob | FileStream;

/**
 * Options for creating an upload.
 */
export interface TusUploadOptions {
    /** The file to upload */
    file: UploadableFile;
    /** Galaxy's TUS endpoint; its app root locates Planet's upload endpoints */
    endpoint: string;
    /** The Galaxy history ID for fingerprinting */
    historyId: string;
    /** Size of upload chunks in bytes (unused: the Service Worker chooses the part size) */
    chunkSize: number;
    /** Called with upload progress percentage (0-100) */
    onProgress: (percentage: number) => void;
    /** Called when an error occurs */
    onError: (error: Error) => void;
    /** Optional AbortSignal to cancel the upload */
    signal?: AbortSignal;
}

/**
 * Result of a successful upload.
 */
export interface TusUploadResult {
    /** The upload session ID, passed to /api/tools/fetch as files_N|file_data.session_id */
    sessionId: string;
    /** The name of the uploaded file */
    fileName: string;
}

/**
 * Builds a fingerprint function for upload resumption.
 * The fingerprint uniquely identifies an upload and allows it to be resumed.
 *
 * @param file - The file being uploaded
 * @param historyId - The Galaxy history ID
 * @returns A function that returns the fingerprint string
 */
export function buildUploadFingerprint(file: UploadableFile, historyId: string) {
    return async (): Promise<string> => {
        const fingerprint = [
            "tus-br",
            file.name,
            "type" in file ? file.type : undefined,
            file.size,
            "lastModified" in file ? file.lastModified : undefined,
            historyId,
        ].join("-");

        return fingerprint;
    };
}

const TUS_PATH = /api\/upload\/resumable_upload\/?$/;

/** Fingerprints of uploads running in this page, which are not resumed a second time. */
const running = new Set<string>();

/** `<app root>api/planet/uploads`, from Galaxy's `<app root>api/upload/resumable_upload/`. */
export function uploadsUrl(endpoint: string): string {
    if (!TUS_PATH.test(endpoint)) {
        return UPLOADS_PATH;
    }
    return `${endpoint.replace(TUS_PATH, "")}${UPLOADS_PATH.slice(1)}`;
}

function isFileStream(file: UploadableFile): file is FileStream {
    return "isStream" in file && file.isStream === true;
}

/** Files and streams carry a modification time; a blob of pasted text does not and is never resumed. */
function isResumable(file: UploadableFile): boolean {
    return "lastModified" in file && typeof file.lastModified === "number";
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * Uploads a file to the bucket.
 *
 * @param options - Upload configuration options
 * @returns Promise resolving to upload result with session ID and file name
 * @throws Error when the upload fails; a DOMException named AbortError when it was aborted
 */
export async function createTusUpload(options: TusUploadOptions): Promise<TusUploadResult> {
    const { file, endpoint, historyId, onProgress, onError, signal } = options;

    if (signal?.aborted) {
        const error = abortError();
        onError(error);
        throw error;
    }

    let fingerprint = isResumable(file) ? await buildUploadFingerprint(file, historyId)() : null;
    if (fingerprint !== null && running.has(fingerprint)) {
        fingerprint = null;
    }
    if (fingerprint !== null) {
        running.add(fingerprint);
    }
    const source: UploadSource = isFileStream(file)
        ? { kind: "stream", stream: file.stream }
        : { kind: "blob", blob: file };
    let reported = -1;
    try {
        const { id } = await uploadToBucket(
            {
                name: file.name,
                size: file.size,
                contentType: ("type" in file && file.type) || null,
                historyId,
                fingerprint,
                source,
                signal,
                onProgress: (uploaded, total) => {
                    const percentage = total > 0 ? Math.floor((uploaded / total) * 100) : 100;
                    if (percentage > reported) {
                        reported = percentage;
                        onProgress(percentage);
                    }
                },
            },
            { api: createUploadApi(uploadsUrl(endpoint)), put: xhrPut },
        );
        return { sessionId: id, fileName: file.name };
    } catch (error) {
        const failure = isAbortError(error) ? abortError() : asError(error);
        onError(failure);
        throw failure;
    } finally {
        if (fingerprint !== null) {
            running.delete(fingerprint);
        }
    }
}
