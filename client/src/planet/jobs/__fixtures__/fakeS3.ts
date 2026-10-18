/**
 * In-memory S3 client for the job protocol tests. Presigned URLs are readable descriptions of the request
 * (`https://<endpoint>.s3.test/<key>?method=PUT&expires=97200`), so tests can check targets and expiries.
 */

import type { S3Body, S3Client, S3ListedPart, S3ListOptions, S3ListResult, S3ObjectInfo, S3Part } from "@/planet/s3";
import { S3Error } from "@/planet/s3";

interface PendingUpload {
    key: string;
    parts: Map<number, { etag: string; bytes: Uint8Array }>;
}

const encoder = new TextEncoder();

async function toBytes(body: S3Body): Promise<Uint8Array> {
    if (typeof body === "string") {
        return encoder.encode(body);
    }
    if (body instanceof Blob) {
        return new Uint8Array(await body.arrayBuffer());
    }
    if (body instanceof ArrayBuffer) {
        return new Uint8Array(body.slice(0));
    }
    if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    return new Uint8Array(await new Response(body).arrayBuffer());
}

function notFound(code: string, key: string): S3Error {
    return new S3Error(404, code, `${key} does not exist`);
}

export class FakeS3 implements S3Client {
    readonly objects = new Map<string, Uint8Array>();
    readonly uploads = new Map<string, PendingUpload>();
    readonly aborted: string[] = [];
    readonly completed: string[] = [];
    /** Every operation, as `<METHOD> <key>`. */
    readonly log: string[] = [];
    private nextUpload = 1;

    get clockOffsetMs(): number {
        return 0;
    }

    put(key: string, value: unknown): void {
        this.objects.set(key, encoder.encode(typeof value === "string" ? value : JSON.stringify(value)));
    }

    json<T = unknown>(key: string): T {
        const bytes = this.objects.get(key);
        if (!bytes) {
            throw new Error(`${key} was not written`);
        }
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    }

    /** Uploads a part as a pod would through a presigned UploadPart URL; returns its ETag. */
    uploadPartAsPod(uploadId: string, partNumber: number, content: string): string {
        const upload = this.uploads.get(uploadId);
        if (!upload) {
            throw new Error(`no upload ${uploadId}`);
        }
        const etag = `"etag-${uploadId}-${partNumber}"`;
        upload.parts.set(partNumber, { etag, bytes: encoder.encode(content) });
        return etag;
    }

    async headBucket(): Promise<{ region: string | null }> {
        return { region: null };
    }

    async getObject(key: string): Promise<Response> {
        this.log.push(`GET ${key}`);
        const bytes = this.objects.get(key);
        if (!bytes) {
            throw notFound("NoSuchKey", key);
        }
        return new Response(bytes.slice(0));
    }

    async headObject(key: string): Promise<S3ObjectInfo> {
        this.log.push(`HEAD ${key}`);
        const bytes = this.objects.get(key);
        if (!bytes) {
            throw notFound("NoSuchKey", key);
        }
        return { contentLength: bytes.byteLength, contentType: null, etag: null, lastModified: null, versionId: null };
    }

    async putObject(key: string, body: S3Body): Promise<{ etag: string | null; versionId: string | null }> {
        this.log.push(`PUT ${key}`);
        this.objects.set(key, await toBytes(body));
        return { etag: null, versionId: null };
    }

    async deleteObject(key: string): Promise<void> {
        this.log.push(`DELETE ${key}`);
        this.objects.delete(key);
    }

    async listObjects(prefix: string, options: S3ListOptions = {}): Promise<S3ListResult> {
        this.log.push(`LIST ${prefix}`);
        const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = options.continuationToken ? keys.indexOf(options.continuationToken) : 0;
        const limit = options.maxKeys ?? 1000;
        const page = keys.slice(start, start + limit);
        const next = keys[start + limit];
        return {
            objects: page.map((key) => ({ key, size: this.objects.get(key)!.byteLength, etag: "", lastModified: "" })),
            commonPrefixes: [],
            isTruncated: next !== undefined,
            nextContinuationToken: next ?? null,
        };
    }

    async presignGet(key: string, expiresSeconds: number, options: { endpoint?: string } = {}): Promise<string> {
        return `https://${options.endpoint ?? "browser"}.s3.test/${key}?method=GET&expires=${expiresSeconds}`;
    }

    async presignPut(key: string, expiresSeconds: number, options: { endpoint?: string } = {}): Promise<string> {
        return `https://${options.endpoint ?? "browser"}.s3.test/${key}?method=PUT&expires=${expiresSeconds}`;
    }

    async createMultipartUpload(key: string): Promise<string> {
        this.log.push(`CREATE-MULTIPART ${key}`);
        const id = `upload-${this.nextUpload++}`;
        this.uploads.set(id, { key, parts: new Map() });
        return id;
    }

    async uploadPart(): Promise<S3Part> {
        throw new Error("not used by the job protocol");
    }

    async presignUploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        expiresSeconds: number,
        options: { endpoint?: string } = {},
    ): Promise<string> {
        const endpoint = options.endpoint ?? "browser";
        return `https://${endpoint}.s3.test/${key}?method=PUT&expires=${expiresSeconds}&uploadId=${uploadId}&partNumber=${partNumber}`;
    }

    async completeMultipartUpload(
        key: string,
        uploadId: string,
        parts: S3Part[],
    ): Promise<{ etag: string | null; location: string | null }> {
        this.log.push(`COMPLETE-MULTIPART ${key}`);
        const upload = this.uploads.get(uploadId);
        if (!upload || upload.key !== key) {
            throw notFound("NoSuchUpload", key);
        }
        const chunks: Uint8Array[] = [];
        for (const part of parts) {
            const stored = upload.parts.get(part.partNumber);
            if (!stored || stored.etag !== part.etag) {
                throw new S3Error(400, "InvalidPart", `part ${part.partNumber} does not match`);
            }
            chunks.push(stored.bytes);
        }
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        this.objects.set(key, bytes);
        this.uploads.delete(uploadId);
        this.completed.push(uploadId);
        return { etag: null, location: null };
    }

    async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
        this.log.push(`ABORT-MULTIPART ${key}`);
        if (this.uploads.get(uploadId)?.key === key) {
            this.uploads.delete(uploadId);
            this.aborted.push(uploadId);
        }
    }

    async listParts(key: string, uploadId: string): Promise<S3ListedPart[]> {
        const upload = this.uploads.get(uploadId);
        if (!upload || upload.key !== key) {
            throw notFound("NoSuchUpload", key);
        }
        return [...upload.parts].map(([partNumber, part]) => ({
            partNumber,
            etag: part.etag,
            size: part.bytes.byteLength,
            lastModified: "",
        }));
    }

    async checkSetup(): Promise<never> {
        throw new Error("not used by the job protocol");
    }
}
