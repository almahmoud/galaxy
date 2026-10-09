// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createS3Client, isNotFound, type S3ClientOptions, S3Error } from ".";
import type { S3Config } from "./url";

const CONFIG: S3Config = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    clusterEndpoint: "",
    bucket: "planet-data",
    prefix: "planet",
    region: "",
    pathStyle: true,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "super-secret-key",
};
const OBJECT_URL = "https://acct.r2.cloudflarestorage.com/planet-data/planet";
const LOCAL_NOW = Date.UTC(2026, 0, 1);

interface Call {
    url: string;
    method: string;
    headers: Headers;
    body: BodyInit | null | undefined;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

function setup(responders: Responder | Responder[], options: S3ClientOptions = {}, config: Partial<S3Config> = {}) {
    const calls: Call[] = [];
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
            throw init.signal.reason;
        }
        const call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body };
        calls.push(call);
        const index = calls.length - 1;
        const responder = Array.isArray(responders) ? responders[index] : responders;
        if (!responder) {
            throw new Error(`unexpected request ${index}: ${call.method} ${url}`);
        }
        return responder(call, index);
    });
    const client = createS3Client({ ...CONFIG, ...config }, { fetch, sleep, now: () => LOCAL_NOW, ...options });
    return { client, calls, fetch, sleep };
}

function xml(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers: { "content-type": "application/xml", ...headers } });
}

function errorXml(code: string, message: string, status: number, extra = "", headers: Record<string, string> = {}) {
    return xml(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message>` +
            `${extra}<RequestId>REQ1</RequestId></Error>`,
        status,
        headers,
    );
}

function amzDate(headers: Headers): string {
    return headers.get("x-amz-date") ?? "";
}

describe("object operations", () => {
    it("puts an object with a signed payload hash and returns its ETag", async () => {
        const { client, calls } = setup(() => new Response(null, { status: 200, headers: { etag: '"abc"' } }));
        const result = await client.putObject("datasets/u1/meta.json", '{"a":1}', { contentType: "application/json" });
        expect(result).toEqual({ etag: '"abc"', versionId: null });
        const call = calls[0]!;
        expect(call.method).toBe("PUT");
        expect(call.url).toBe(`${OBJECT_URL}/datasets/u1/meta.json`);
        expect(call.headers.get("content-type")).toBe("application/json");
        expect(call.headers.get("x-amz-content-sha256")).toMatch(/^[0-9a-f]{64}$/);
        expect(call.headers.get("authorization")).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
        );
    });

    it("uses UNSIGNED-PAYLOAD for Blob bodies", async () => {
        const { client, calls } = setup(() => new Response(null, { headers: { etag: '"p1"' } }));
        const part = await client.uploadPart("uploads/x", "UPLOAD", 3, new Blob(["0123456789"]));
        expect(part).toEqual({ partNumber: 3, etag: '"p1"' });
        expect(calls[0]!.url).toBe(`${OBJECT_URL}/uploads/x?partNumber=3&uploadId=UPLOAD`);
        expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    });

    it("fails an uploaded part whose ETag is not exposed", async () => {
        const { client } = setup(() => new Response(null, { status: 200 }));
        await expect(client.uploadPart("uploads/x", "UPLOAD", 1, new Blob(["x"]))).rejects.toMatchObject({
            code: "etag_not_exposed",
        });
    });

    it("gets objects with a Range header and accepts 206", async () => {
        const { client, calls } = setup(() => new Response("0123", { status: 206 }));
        const response = await client.getObject("datasets/u1/data", { range: { start: 0, end: 3 } });
        expect(await response.text()).toBe("0123");
        expect(calls[0]!.headers.get("range")).toBe("bytes=0-3");
        await expect(client.getObject("k", { range: "bytes=0-1,4-5" })).rejects.toThrow(RangeError);
        await expect(client.getObject("k", { range: { start: 5, end: 2 } })).rejects.toThrow(RangeError);
    });

    it("reads object metadata", async () => {
        const { client, calls } = setup(
            () =>
                new Response(null, {
                    headers: {
                        "content-length": "42",
                        "content-type": "text/plain",
                        etag: '"e"',
                        "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
                    },
                }),
        );
        expect(await client.headObject("a")).toEqual({
            contentLength: 42,
            contentType: "text/plain",
            etag: '"e"',
            lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
            versionId: null,
        });
        expect(calls[0]!.method).toBe("HEAD");
    });

    it("maps a HEAD 404 without a body to NoSuchKey", async () => {
        const { client } = setup(() => new Response(null, { status: 404 }));
        const error = await client.headObject("missing").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(S3Error);
        expect(error).toMatchObject({ status: 404, code: "NoSuchKey" });
        expect(isNotFound(error)).toBe(true);
    });

    it("treats deleting a missing object as success", async () => {
        const { client, calls } = setup([
            () => new Response(null, { status: 204 }),
            () => errorXml("NoSuchKey", "x", 404),
        ]);
        await client.deleteObject("a");
        await client.deleteObject("b");
        expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
    });

    it("lists objects with the full prefix and returns relative keys", async () => {
        const { client, calls } = setup(() =>
            xml(
                "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>planet/datasets/u/data</Key>" +
                    '<Size>5</Size><ETag>"e"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>' +
                    "</ListBucketResult>",
            ),
        );
        const result = await client.listObjects("datasets/", { maxKeys: 10, continuationToken: "tok+/=" });
        expect(result.objects).toEqual([
            { key: "datasets/u/data", size: 5, etag: '"e"', lastModified: "2026-01-01T00:00:00.000Z" },
        ]);
        expect(calls[0]!.url).toBe(
            "https://acct.r2.cloudflarestorage.com/planet-data" +
                "?list-type=2&prefix=planet%2Fdatasets%2F&continuation-token=tok%2B%2F%3D&max-keys=10",
        );
        await expect(client.listObjects("", { maxKeys: 0 })).rejects.toThrow(RangeError);
    });
});

describe("multipart uploads", () => {
    it("creates, completes and aborts uploads", async () => {
        const { client, calls } = setup([
            () =>
                xml(
                    "<InitiateMultipartUploadResult><Bucket>planet-data</Bucket><Key>planet/uploads/u</Key>" +
                        "<UploadId>UP-1</UploadId></InitiateMultipartUploadResult>",
                ),
            () =>
                xml(
                    "<CompleteMultipartUploadResult><Location>https://x/planet/uploads/u</Location>" +
                        '<ETag>"final-2"</ETag></CompleteMultipartUploadResult>',
                ),
            () => new Response(null, { status: 204 }),
        ]);
        const uploadId = await client.createMultipartUpload("uploads/u", { contentType: "application/gzip" });
        expect(uploadId).toBe("UP-1");
        expect(calls[0]!.method).toBe("POST");
        expect(calls[0]!.url).toBe(`${OBJECT_URL}/uploads/u?uploads`);
        expect(calls[0]!.headers.get("content-type")).toBe("application/gzip");

        const completed = await client.completeMultipartUpload("uploads/u", uploadId, [
            { partNumber: 2, etag: '"b"' },
            { partNumber: 1, etag: '"a"' },
        ]);
        expect(completed).toEqual({ etag: '"final-2"', location: "https://x/planet/uploads/u" });
        expect(calls[1]!.url).toBe(`${OBJECT_URL}/uploads/u?uploadId=UP-1`);
        expect(calls[1]!.headers.get("content-type")).toBe("application/xml");
        expect(calls[1]!.body).toBe(
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
                '<Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part>' +
                '<Part><PartNumber>2</PartNumber><ETag>"b"</ETag></Part>' +
                "</CompleteMultipartUpload>",
        );

        await client.abortMultipartUpload("uploads/u", uploadId);
        expect(calls[2]!.method).toBe("DELETE");
        expect(calls[2]!.url).toBe(`${OBJECT_URL}/uploads/u?uploadId=UP-1`);
    });

    it("throws for an Error document in a 200 completion response and retries internal errors", async () => {
        const { client, calls } = setup([
            () => errorXml("InternalError", "try again", 200),
            () => errorXml("InvalidPart", "One or more of the specified parts could not be found.", 200),
        ]);
        const error = await client
            .completeMultipartUpload("u", "UP", [{ partNumber: 1, etag: '"a"' }])
            .catch((e: unknown) => e);
        expect(error).toMatchObject({ code: "InvalidPart", status: 200 });
        expect(calls).toHaveLength(2);
    });

    it("lists all parts across pages", async () => {
        const part = (n: number) =>
            `<Part><PartNumber>${n}</PartNumber><ETag>"e${n}"</ETag><Size>5242880</Size>` +
            `<LastModified>2026-01-01T00:00:00.000Z</LastModified></Part>`;
        const { client, calls } = setup([
            () =>
                xml(
                    `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>` +
                        `${part(1)}${part(2)}</ListPartsResult>`,
                ),
            () => xml(`<ListPartsResult><IsTruncated>false</IsTruncated>${part(3)}</ListPartsResult>`),
        ]);
        const parts = await client.listParts("u", "UP");
        expect(parts.map((p) => [p.partNumber, p.etag, p.size])).toEqual([
            [1, '"e1"', 5242880],
            [2, '"e2"', 5242880],
            [3, '"e3"', 5242880],
        ]);
        expect(calls[1]!.url).toBe(`${OBJECT_URL}/u?uploadId=UP&part-number-marker=2`);
    });

    it("treats aborting a missing upload as success", async () => {
        const { client } = setup(() => errorXml("NoSuchUpload", "gone", 404));
        await expect(client.abortMultipartUpload("u", "UP")).resolves.toBeUndefined();
    });
});

describe("clock skew", () => {
    const serverTime = LOCAL_NOW + 60 * 60 * 1000;
    const serverDate = new Date(serverTime).toUTCString();

    it("re-signs once with the server time after RequestTimeTooSkewed", async () => {
        const { client, calls } = setup([
            () =>
                errorXml("RequestTimeTooSkewed", "too skewed", 403, "", {
                    date: serverDate,
                }),
            () => new Response(null, { headers: { etag: '"x"', date: serverDate } }),
        ]);
        await client.putObject("a", "body");
        expect(amzDate(calls[0]!.headers)).toBe("20260101T000000Z");
        expect(amzDate(calls[1]!.headers)).toBe("20260101T010000Z");
        expect(Math.abs(client.clockOffsetMs - 3600_000)).toBeLessThan(1000);
    });

    it("uses ServerTime from the error body when Date is not exposed", async () => {
        const { client, calls } = setup([
            () =>
                errorXml(
                    "RequestTimeTooSkewed",
                    "too skewed",
                    403,
                    `<ServerTime>${new Date(serverTime).toISOString()}</ServerTime>`,
                ),
            () => new Response(null, { headers: { etag: '"x"' } }),
        ]);
        await client.putObject("a", "body");
        expect(amzDate(calls[1]!.headers)).toBe("20260101T010000Z");
    });

    it("retries a bodiless 403 when the Date header shows a large skew", async () => {
        const { client, calls } = setup([
            () => new Response(null, { status: 403, headers: { date: serverDate } }),
            () => new Response(null, { status: 200, headers: { date: serverDate } }),
        ]);
        await client.headBucket();
        expect(calls).toHaveLength(2);
        expect(amzDate(calls[1]!.headers)).toBe("20260101T010000Z");
    });

    it("does not retry a 403 when the clock is already correct", async () => {
        const { client, calls } = setup(() =>
            errorXml("SignatureDoesNotMatch", "bad signature", 403, "", { date: new Date(LOCAL_NOW).toUTCString() }),
        );
        await expect(client.headObject("a")).rejects.toMatchObject({ status: 403 });
        expect(calls).toHaveLength(1);
    });

    it("retries skew at most once", async () => {
        let skew = 0;
        const { client, calls } = setup(() => {
            skew += 3600_000;
            return errorXml("RequestTimeTooSkewed", "too skewed", 403, "", {
                date: new Date(LOCAL_NOW + skew).toUTCString(),
            });
        });
        await expect(client.putObject("a", "b")).rejects.toMatchObject({ code: "RequestTimeTooSkewed" });
        expect(calls).toHaveLength(2);
    });

    it("signs presigned URLs with the corrected clock", async () => {
        const { client } = setup(() => new Response(null, { headers: { date: serverDate } }));
        await client.headBucket();
        const url = new URL(await client.presignGet("a", 60));
        expect(url.searchParams.get("X-Amz-Date")).toBe("20260101T010000Z");
    });
});

describe("retries and errors", () => {
    it("retries 5xx and 429 responses with backoff", async () => {
        const { client, calls, sleep } = setup([
            () => errorXml("InternalError", "oops", 500),
            () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
            () => new Response(null, { headers: { etag: '"x"' } }),
        ]);
        await client.putObject("a", new Uint8Array([1, 2, 3]));
        expect(calls).toHaveLength(3);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep.mock.calls[1]).toEqual([2000, undefined]);
    });

    it("gives up after the configured retries", async () => {
        const { client, calls } = setup(() => errorXml("ServiceUnavailable", "down", 503), { retries: 2 });
        await expect(client.headObject("a")).rejects.toMatchObject({ status: 503, code: "ServiceUnavailable" });
        expect(calls).toHaveLength(3);
    });

    it("does not retry stream bodies", async () => {
        const { client, calls } = setup(() => errorXml("InternalError", "oops", 500));
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1]));
                controller.close();
            },
        });
        await expect(client.putObject("a", stream)).rejects.toMatchObject({ code: "InternalError" });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    });

    it("parses S3 error documents", async () => {
        const { client } = setup(() => errorXml("NoSuchKey", "The specified key does not exist.", 404));
        const error = await client.getObject("missing").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(S3Error);
        expect(error).toMatchObject({
            status: 404,
            code: "NoSuchKey",
            message: "The specified key does not exist.",
            requestId: "REQ1",
        });
    });

    it("falls back to the HTTP status for non-XML errors", async () => {
        const { client } = setup(() => new Response("<html>Forbidden</html>", { status: 403 }));
        await expect(client.getObject("a")).rejects.toMatchObject({ status: 403, code: "AccessDenied" });
    });

    it("maps fetch TypeErrors to network_blocked without leaking secrets", async () => {
        const { client } = setup(() => {
            throw new TypeError("Failed to fetch");
        });
        const error = (await client.headBucket().catch((e: unknown) => e)) as S3Error;
        expect(error).toBeInstanceOf(S3Error);
        expect(error.status).toBe(0);
        expect(error.code).toBe("network_blocked");
        expect(error.message).toContain("https://acct.r2.cloudflarestorage.com");
        expect(error.message).toContain("CORS");
        expect(error.message).toContain("local network access");
        expect(error.message).not.toContain("super-secret-key");
        expect(error.cause).toBeInstanceOf(TypeError);
    });

    it("rejects with the abort reason, not network_blocked", async () => {
        const controller = new AbortController();
        controller.abort();
        const { client, fetch } = setup(() => new Response(null));
        await expect(client.getObject("a", { signal: controller.signal })).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(fetch).not.toHaveBeenCalled();

        const late = new AbortController();
        const { client: other } = setup(() => {
            late.abort();
            throw new TypeError("network error");
        });
        await expect(other.getObject("a", { signal: late.signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("rejects every call when the configuration is invalid", async () => {
        const { client, fetch } = setup(() => new Response(null), {}, { endpoint: "nope" });
        await expect(client.headBucket()).rejects.toMatchObject({ code: "invalid_config" });
        await expect(client.presignGet("a", 60)).rejects.toMatchObject({ code: "invalid_config" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects keys that would be rewritten by URL normalisation", async () => {
        const { client, fetch } = setup(() => new Response(null));
        await expect(client.getObject("datasets/../secrets")).rejects.toMatchObject({ code: "invalid_config" });
        expect(fetch).not.toHaveBeenCalled();
    });
});
