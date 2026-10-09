// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createS3Client, MAX_PRESIGN_EXPIRES_SECONDS } from ".";
import { S3Signer, sha256Hex } from "./signer";
import { encodeRfc3986 } from "./url";

const AWS_EXAMPLE = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
};
const AWS_EXAMPLE_TIME = Date.UTC(2013, 4, 24);

const textEncoder = new TextEncoder();

async function hmac(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const raw = typeof key === "string" ? textEncoder.encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data));
}

function hex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(data: string): Promise<string> {
    return hex(await crypto.subtle.digest("SHA-256", textEncoder.encode(data)));
}

function canonicalQuery(search: string, exclude: string[] = []): string {
    const pairs = search
        .replace(/^\?/, "")
        .split("&")
        .filter(Boolean)
        .map((pair) => {
            const [name = "", value = ""] = pair.split("=");
            return [decodeURIComponent(name), decodeURIComponent(value)] as const;
        })
        .filter(([name]) => !exclude.includes(name))
        .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const);
    pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
    return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/** Independent SigV4 implementation following the AWS documentation, used to cross-check aws4fetch. */
async function referenceSignature(input: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    signedHeaders: string[];
    payloadHash: string;
    datetime: string;
    region: string;
    secretAccessKey: string;
    excludeQuery?: string[];
}): Promise<string> {
    const canonicalHeaders = input.signedHeaders
        .map((name) => `${name}:${name === "host" ? input.url.host : (input.headers[name] ?? "").trim()}\n`)
        .join("");
    const canonicalRequest = [
        input.method,
        input.url.pathname,
        canonicalQuery(input.url.search, input.excludeQuery),
        canonicalHeaders,
        input.signedHeaders.join(";"),
        input.payloadHash,
    ].join("\n");
    const scope = `${input.datetime.slice(0, 8)}/${input.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", input.datetime, scope, await sha256(canonicalRequest)].join("\n");
    const dateKey = await hmac(`AWS4${input.secretAccessKey}`, input.datetime.slice(0, 8));
    const signingKey = await hmac(await hmac(await hmac(dateKey, input.region), "s3"), "aws4_request");
    return hex(await hmac(signingKey, stringToSign));
}

describe("SigV4 presigning", () => {
    it("matches the AWS documentation presigned GET example", async () => {
        const client = createS3Client(
            {
                endpoint: "https://s3.amazonaws.com",
                clusterEndpoint: "",
                bucket: "examplebucket",
                prefix: "",
                region: "us-east-1",
                pathStyle: false,
                accessKeyId: AWS_EXAMPLE.accessKeyId,
                secretAccessKey: AWS_EXAMPLE.secretAccessKey,
            },
            { now: () => AWS_EXAMPLE_TIME },
        );
        const url = await client.presignGet("test.txt", 86400);
        expect(url).toBe(
            "https://examplebucket.s3.amazonaws.com/test.txt" +
                "?X-Amz-Expires=86400" +
                "&X-Amz-Date=20130524T000000Z" +
                "&X-Amz-Algorithm=AWS4-HMAC-SHA256" +
                "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
                "&X-Amz-SignedHeaders=host" +
                "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
        );
    });

    it("caps expiry at seven days and signs response overrides with RFC 3986 encoding", async () => {
        const client = createS3Client(
            {
                endpoint: "https://acct.r2.cloudflarestorage.com",
                clusterEndpoint: "http://garage.planet-storage.svc:3900",
                bucket: "planet-data",
                prefix: "planet",
                region: "",
                pathStyle: true,
                accessKeyId: "AKID",
                secretAccessKey: "SECRET",
            },
            { now: () => Date.UTC(2026, 9, 9, 12, 0, 0) },
        );
        const disposition = 'attachment; filename="read 1+2.fastq"';
        const signed = new URL(
            await client.presignGet("datasets/abc/data", 10_000_000, { responseContentDisposition: disposition }),
        );
        expect(signed.searchParams.get("X-Amz-Expires")).toBe(String(MAX_PRESIGN_EXPIRES_SECONDS));
        expect(signed.searchParams.get("response-content-disposition")).toBe(disposition);
        expect(signed.search).not.toContain("+");
        expect(signed.search).toContain("read%201%2B2.fastq");
        expect(signed.searchParams.get("X-Amz-Credential")).toBe("AKID/20261009/auto/s3/aws4_request");
        const expected = await referenceSignature({
            method: "GET",
            url: signed,
            headers: {},
            signedHeaders: ["host"],
            payloadHash: "UNSIGNED-PAYLOAD",
            datetime: "20261009T120000Z",
            region: "auto",
            secretAccessKey: "SECRET",
            excludeQuery: ["X-Amz-Signature"],
        });
        expect(signed.searchParams.get("X-Amz-Signature")).toBe(expected);

        const cluster = new URL(await client.presignPut("datasets/abc/data", 3600, { endpoint: "cluster" }));
        expect(cluster.origin).toBe("http://garage.planet-storage.svc:3900");
        expect(cluster.pathname).toBe("/planet-data/planet/datasets/abc/data");
        expect(cluster.searchParams.get("X-Amz-Expires")).toBe("3600");
    });

    it("presigns upload parts with the part number and upload ID signed", async () => {
        const client = createS3Client(
            {
                endpoint: "https://acct.r2.cloudflarestorage.com",
                clusterEndpoint: "",
                bucket: "planet-data",
                prefix: "",
                region: "auto",
                pathStyle: true,
                accessKeyId: "AKID",
                secretAccessKey: "SECRET",
            },
            { now: () => Date.UTC(2026, 9, 9) },
        );
        const signed = new URL(await client.presignUploadPart("jobs/j1/out", "up/load+id==", 7, 600));
        expect(signed.searchParams.get("partNumber")).toBe("7");
        expect(signed.searchParams.get("uploadId")).toBe("up/load+id==");
        const expected = await referenceSignature({
            method: "PUT",
            url: signed,
            headers: {},
            signedHeaders: ["host"],
            payloadHash: "UNSIGNED-PAYLOAD",
            datetime: "20261009T000000Z",
            region: "auto",
            secretAccessKey: "SECRET",
            excludeQuery: ["X-Amz-Signature"],
        });
        expect(signed.searchParams.get("X-Amz-Signature")).toBe(expected);
        await expect(client.presignUploadPart("k", "id", 0, 60)).rejects.toThrow(RangeError);
    });
});

describe("SigV4 header signing", () => {
    function signature(headers: Headers): string {
        return /Signature=([0-9a-f]{64})/.exec(headers.get("authorization") ?? "")?.[1] ?? "";
    }

    it("matches the AWS documentation GET bucket lifecycle example", async () => {
        const signer = new S3Signer(AWS_EXAMPLE, () => AWS_EXAMPLE_TIME);
        const headers = await signer.signHeaders(
            "GET",
            new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"),
            new Headers(),
            await sha256Hex(""),
        );
        expect(headers.get("authorization")).toBe(
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
                "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
                "Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
        );
    });

    it("matches the AWS documentation GET bucket list example", async () => {
        const signer = new S3Signer(AWS_EXAMPLE, () => AWS_EXAMPLE_TIME);
        const headers = await signer.signHeaders(
            "GET",
            new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
            new Headers(),
            await sha256Hex(""),
        );
        expect(signature(headers)).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    });

    it("matches the AWS documentation PUT object example", async () => {
        const signer = new S3Signer(AWS_EXAMPLE, () => AWS_EXAMPLE_TIME);
        const headers = await signer.signHeaders(
            "PUT",
            new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
            new Headers({ date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }),
            await sha256Hex("Welcome to Amazon S3."),
        );
        expect(signature(headers)).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    });

    it("signs a request for a key with reserved characters", async () => {
        const requests: { url: string; init: RequestInit }[] = [];
        const client = createS3Client(
            {
                endpoint: "http://localhost:3900",
                clusterEndpoint: "",
                bucket: "planet",
                prefix: "p",
                region: "garage",
                pathStyle: true,
                accessKeyId: "GKID",
                secretAccessKey: "SECRET",
            },
            {
                now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
                fetch: async (url, init) => {
                    requests.push({ url, init });
                    return new Response(null, { status: 200, headers: { etag: '"e"' } });
                },
            },
        );
        await client.putObject("uploads/a b+c/é(1)!.txt", "hello", { contentDisposition: "attachment" });
        const request = requests[0]!;
        const url = new URL(request.url);
        expect(url.pathname).toBe("/planet/p/uploads/a%20b%2Bc/%C3%A9%281%29%21.txt");
        const headers = new Headers(request.init.headers);
        const payloadHash = await sha256("hello");
        expect(headers.get("x-amz-content-sha256")).toBe(payloadHash);
        const authorization = headers.get("authorization") ?? "";
        expect(authorization).toContain("SignedHeaders=content-disposition;host;x-amz-content-sha256;x-amz-date,");
        const expected = await referenceSignature({
            method: "PUT",
            url,
            headers: Object.fromEntries(headers.entries()),
            signedHeaders: ["content-disposition", "host", "x-amz-content-sha256", "x-amz-date"],
            payloadHash,
            datetime: "20260102T030405Z",
            region: "garage",
            secretAccessKey: "SECRET",
        });
        expect(authorization.endsWith(`Signature=${expected}`)).toBe(true);
    });
});
