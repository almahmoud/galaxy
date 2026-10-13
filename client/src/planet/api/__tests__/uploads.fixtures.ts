/**
 * An in-memory S3 bucket with multipart uploads, behind a stubbed `fetch`, for the upload tests. It accepts any
 * signature and records each request, noting whether it came through a presigned URL.
 */

import { vi } from "vitest";

import { CONFIG, GENOMES, MAPPING, ORIGIN } from "./contents.fixtures";
import { BUCKET, PREFIX, S3_ENDPOINT } from "./datasets.fixtures";

export { BUCKET, configureStorage, PREFIX, S3_ENDPOINT } from "./datasets.fixtures";

const MIN_PART = 5 * 1024 * 1024;

export interface S3Request {
    method: string;
    /** Key relative to {@link PREFIX}. */
    key: string;
    query: URLSearchParams;
    presigned: boolean;
}

interface MultipartUpload {
    key: string;
    parts: Map<number, { data: Uint8Array; etag: string }>;
}

function xml(body: string, status = 200): Response {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
        status,
        headers: { "Content-Type": "application/xml", Date: new Date().toUTCString() },
    });
}

function s3Error(status: number, code: string): Response {
    return xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);
}

async function bytesOf(body: BodyInit | null | undefined): Promise<Uint8Array> {
    if (body === undefined || body === null) {
        return new Uint8Array(0);
    }
    return new Uint8Array(await new Response(body).arrayBuffer());
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

export class FakeS3 {
    /** Objects by key relative to {@link PREFIX}. */
    readonly objects = new Map<string, Uint8Array>();
    readonly uploads = new Map<string, MultipartUpload>();
    readonly requests: S3Request[] = [];
    /** Returns a response to send instead of handling the request, for injecting failures. */
    intercept: ((request: S3Request) => Response | undefined) | null = null;
    private counter = 0;

    requestsFor(method: string, key?: string): S3Request[] {
        return this.requests.filter(
            (request) => request.method === method && (key === undefined || request.key === key),
        );
    }

    async handle(url: URL, init: RequestInit = {}): Promise<Response> {
        const [, bucket, ...segments] = url.pathname.split("/");
        const fullKey = segments.map(decodeURIComponent).join("/");
        const key = fullKey.startsWith(`${PREFIX}/`) ? fullKey.slice(PREFIX.length + 1) : fullKey;
        const method = (init.method ?? "GET").toUpperCase();
        const query = url.searchParams;
        const request = { method, key, query, presigned: query.has("X-Amz-Signature") };
        this.requests.push(request);
        if (bucket !== BUCKET) {
            return s3Error(404, "NoSuchBucket");
        }
        const intercepted = this.intercept?.(request);
        if (intercepted) {
            return intercepted;
        }
        const uploadId = query.get("uploadId");
        if (method === "POST" && query.has("uploads")) {
            const id = `upload-${++this.counter}`;
            this.uploads.set(id, { key, parts: new Map() });
            return xml(
                `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${fullKey}</Key>` +
                    `<UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
            );
        }
        if (uploadId !== null) {
            const upload = this.uploads.get(uploadId);
            if (!upload || upload.key !== key) {
                return s3Error(404, "NoSuchUpload");
            }
            if (method === "PUT") {
                const partNumber = Number(query.get("partNumber"));
                const data = await bytesOf(init.body);
                const etag = `"part-${partNumber}-${data.byteLength}-${++this.counter}"`;
                upload.parts.set(partNumber, { data, etag });
                return new Response(null, { headers: { ETag: etag, Date: new Date().toUTCString() } });
            }
            if (method === "GET") {
                const items = [...upload.parts.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(
                        ([number, part]) =>
                            `<Part><PartNumber>${number}</PartNumber><ETag>${part.etag.replace(/"/g, "&quot;")}</ETag>` +
                            `<Size>${part.data.byteLength}</Size><LastModified>2026-10-13T00:00:00.000Z</LastModified></Part>`,
                    );
                return xml(`<ListPartsResult><IsTruncated>false</IsTruncated>${items.join("")}</ListPartsResult>`);
            }
            if (method === "DELETE") {
                this.uploads.delete(uploadId);
                return new Response(null, { status: 204, headers: { Date: new Date().toUTCString() } });
            }
            if (method === "POST") {
                const body = new TextDecoder().decode(await bytesOf(init.body));
                const listed = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g)].map(
                    (match) => ({ number: Number(match[1]), etag: match[2]!.replace(/&quot;/g, '"') }),
                );
                const chunks: Uint8Array[] = [];
                for (const [index, { number, etag }] of listed.entries()) {
                    const part = upload.parts.get(number);
                    if (!part || part.etag !== etag) {
                        return s3Error(400, "InvalidPart");
                    }
                    if (index < listed.length - 1 && part.data.byteLength < MIN_PART) {
                        return s3Error(400, "EntityTooSmall");
                    }
                    chunks.push(part.data);
                }
                this.objects.set(key, concat(chunks));
                this.uploads.delete(uploadId);
                return xml(
                    `<CompleteMultipartUploadResult><Key>${fullKey}</Key><ETag>"done-${++this.counter}"</ETag>` +
                        `</CompleteMultipartUploadResult>`,
                );
            }
        }
        const date = { Date: new Date().toUTCString() };
        if (method === "PUT") {
            const data = await bytesOf(init.body);
            this.objects.set(key, data);
            return new Response(null, { headers: { ...date, ETag: `"object-${++this.counter}"` } });
        }
        if (method === "DELETE") {
            this.objects.delete(key);
            return new Response(null, { status: 204, headers: date });
        }
        const object = this.objects.get(key);
        if (!object) {
            return method === "HEAD" ? new Response(null, { status: 404, headers: date }) : s3Error(404, "NoSuchKey");
        }
        const headers = { ...date, "Content-Length": String(object.byteLength), ETag: '"object"' };
        return new Response(method === "HEAD" ? null : object.slice(), { headers });
    }
}

const STATIC_FILES: Record<string, unknown> = {
    "/static/planet/data/config.json": CONFIG,
    "/static/planet/data/datatypes/mapping.json": MAPPING,
    "/static/planet/data/genomes.json": GENOMES,
};

/** Replaces `fetch`: bucket requests reach `s3`, others get the static data files. */
export function stubUploadNetwork(s3: FakeS3) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
        if (url.origin === S3_ENDPOINT) {
            return s3.handle(url, init);
        }
        if (Object.hasOwn(STATIC_FILES, url.pathname)) {
            return new Response(JSON.stringify(STATIC_FILES[url.pathname]), {
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

/** Deterministic bytes: `size` bytes starting at `seed`. */
export function sampleBytes(size: number, seed = 0): Uint8Array {
    const out = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        out[index] = (index * 31 + seed) & 0xff;
    }
    return out;
}

/** Compares bytes without letting a failed assertion print megabytes. */
export function sameBytes(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
    return (
        actual !== undefined &&
        actual.byteLength === expected.byteLength &&
        actual.every((byte, index) => byte === expected[index])
    );
}
