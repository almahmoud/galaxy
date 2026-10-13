/**
 * Messages between the page upload module and the Service Worker's `/api/planet/uploads` endpoints. The page sends
 * bytes straight to the bucket with the presigned URLs these endpoints return; the worker keeps the session in the
 * `uploads` store and talks to S3 only to create, inspect, complete or abort the upload.
 */

export const UPLOADS_PATH = "/api/planet/uploads";

/** Smallest part of a multipart upload. Files up to this size are sent with one presigned PUT. */
export const MIN_PART_SIZE = 8 * 1024 * 1024;
/** S3's limit on the parts of one upload. */
export const MAX_PARTS = 10_000;
/** S3's limit on the size of one object. */
export const MAX_OBJECT_SIZE = 5 * 1024 ** 4;

/** `POST /api/planet/uploads`. A fingerprint lets an unfinished session for the same file be resumed. */
export interface CreateUploadRequest {
    name: string;
    size: number;
    content_type: string | null;
    history_id: string | null;
    fingerprint: string | null;
}

export interface PartUrl {
    part_number: number;
    url: string;
}

/** A part already stored in the bucket. */
export interface UploadedPart {
    part_number: number;
    etag: string;
    size: number;
}

/**
 * An upload session. `multipart` sessions take `part_count` parts of `part_size` bytes (the last one smaller); a
 * `single` session takes the whole file as part 1, sent with a plain PUT. `parts` holds URLs for the first parts
 * still to send, valid for `expires_in` seconds; `uploaded` lists the parts a resumed session already has.
 */
export interface UploadSession {
    id: string;
    mode: "multipart" | "single";
    part_size: number;
    part_count: number;
    parts: PartUrl[];
    expires_in: number;
    uploaded: UploadedPart[];
}

/** `POST /api/planet/uploads/{id}/parts`: URLs for more parts, or fresh ones for parts whose URLs expire. */
export interface PresignPartsRequest {
    part_numbers: number[];
}

export interface PresignPartsResponse {
    parts: PartUrl[];
    expires_in: number;
}

/** `POST /api/planet/uploads/{id}/complete` with the ETag of every part. */
export interface CompleteUploadRequest {
    parts: { part_number: number; etag: string }[];
}

export interface CompleteUploadResponse {
    id: string;
    state: "uploaded";
    size: number;
}

/** Part size and count for a file: uniform parts of at least {@link MIN_PART_SIZE}, at most {@link MAX_PARTS}. */
export function partLayout(size: number): { partSize: number; partCount: number; multipart: boolean } {
    const mebibyte = 1024 * 1024;
    const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / mebibyte) * mebibyte);
    const partCount = Math.max(1, Math.ceil(size / partSize));
    return { partSize, partCount, multipart: partCount > 1 };
}

/** The size of part `partNumber` (1-based) of a file of `size` bytes cut into `partSize` parts. */
export function partBytes(size: number, partSize: number, partNumber: number): number {
    return Math.max(0, Math.min(partSize, size - (partNumber - 1) * partSize));
}
