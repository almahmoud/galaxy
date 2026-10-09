// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildCorsPolicy, createS3Client, type S3SetupReport } from ".";
import type { S3Config } from "./url";

const CONFIG: S3Config = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    clusterEndpoint: "",
    bucket: "planet-data",
    prefix: "planet",
    region: "auto",
    pathStyle: true,
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
};
const ORIGIN = "https://planet.example.org";

interface FakeServerOptions {
    exposed?: string[];
    blockedMethods?: string[];
    ignoreRange?: boolean;
    headBucketStatus?: number;
    serverSkewMs?: number;
}

/** In-memory path-style S3 endpoint that filters response headers like a CORS-limited browser fetch. */
function fakeServer(options: FakeServerOptions = {}) {
    const exposed = new Set(
        (options.exposed ?? ["etag", "date", "content-range", "content-length", "content-type"]).map((h) =>
            h.toLowerCase(),
        ),
    );
    const objects = new Map<string, string>();
    const uploads = new Set<string>();
    const log: string[] = [];
    const respond = (body: string | null, status: number, headers: Record<string, string> = {}) => {
        const all: Record<string, string> = {
            date: new Date(Date.now() + (options.serverSkewMs ?? 0)).toUTCString(),
            "content-type": "application/xml",
            ...headers,
        };
        const visible = Object.fromEntries(Object.entries(all).filter(([name]) => exposed.has(name)));
        return new Response(body, { status, headers: visible });
    };
    const fetch = async (input: string, init: RequestInit): Promise<Response> => {
        const method = init.method ?? "GET";
        const url = new URL(input);
        log.push(`${method} ${url.pathname}${url.search}`);
        if (options.blockedMethods?.includes(method)) {
            throw new TypeError("Failed to fetch");
        }
        const [, bucket, ...rest] = url.pathname.split("/");
        const key = decodeURIComponent(rest.join("/"));
        if (bucket !== "planet-data") {
            return respond("<Error><Code>NoSuchBucket</Code><Message>no</Message></Error>", 404);
        }
        if (!key) {
            return respond(null, options.headBucketStatus ?? 200);
        }
        const headers = new Headers(init.headers);
        if (method === "PUT") {
            objects.set(key, String(init.body));
            return respond(null, 200, { etag: '"etag-1"' });
        }
        if (method === "GET") {
            const value = objects.get(key);
            if (value === undefined) {
                return respond("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>", 404);
            }
            const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
            if (range && !options.ignoreRange) {
                const start = Number(range[1]);
                const end = Number(range[2]);
                return respond(value.slice(start, end + 1), 206, {
                    "content-range": `bytes ${start}-${end}/${value.length}`,
                });
            }
            return respond(value, 200);
        }
        if (method === "POST" && url.searchParams.has("uploads")) {
            uploads.add("UP-1");
            return respond(
                "<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>",
                200,
            );
        }
        if (method === "DELETE") {
            if (url.searchParams.has("uploadId")) {
                uploads.delete(url.searchParams.get("uploadId") ?? "");
            } else {
                objects.delete(key);
            }
            return respond(null, 204);
        }
        return respond("<Error><Code>NotImplemented</Code><Message>no</Message></Error>", 501);
    };
    return { fetch, objects, uploads, log };
}

function statuses(report: S3SetupReport): Record<string, string> {
    return Object.fromEntries(report.checks.map((check) => [check.id, check.status]));
}

async function run(server: ReturnType<typeof fakeServer>, config: Partial<S3Config> = {}) {
    const client = createS3Client({ ...CONFIG, ...config }, { fetch: server.fetch, sleep: async () => undefined });
    return client.checkSetup({ origin: ORIGIN });
}

describe("checkSetup", () => {
    it("passes against a correctly configured bucket and cleans up", async () => {
        const server = fakeServer();
        const report = await run(server);
        expect(report.ok).toBe(true);
        expect(report.corsSuspected).toBe(false);
        expect(statuses(report)).toEqual({
            config: "ok",
            bucket: "ok",
            write: "ok",
            etag: "ok",
            read: "ok",
            range: "ok",
            multipart: "ok",
            delete: "ok",
            clock: "ok",
        });
        expect(server.objects.size).toBe(0);
        expect(server.uploads.size).toBe(0);
        expect(server.log.some((line) => line.startsWith("PUT /planet-data/planet/.planet-probe/"))).toBe(true);
        expect(report.clockOffsetMs).not.toBeNull();
    });

    it("reports an unexposed ETag as a CORS error", async () => {
        const report = await run(fakeServer({ exposed: ["date", "content-range"] }));
        expect(report.ok).toBe(false);
        expect(report.corsSuspected).toBe(true);
        const etag = report.checks.find((check) => check.id === "etag");
        expect(etag).toMatchObject({ status: "error", code: "cors_expose_etag" });
    });

    it("warns when Date is not exposed", async () => {
        const report = await run(fakeServer({ exposed: ["etag", "content-range"] }));
        expect(report.ok).toBe(true);
        expect(report.corsSuspected).toBe(true);
        expect(report.clockOffsetMs).toBeNull();
        expect(report.checks.find((check) => check.id === "clock")).toMatchObject({
            status: "warning",
            code: "cors_expose_date",
        });
    });

    it("warns about clock skew", async () => {
        const report = await run(fakeServer({ serverSkewMs: 10 * 60 * 1000 }));
        expect(report.checks.find((check) => check.id === "clock")).toMatchObject({
            status: "warning",
            code: "clock_skew",
        });
        expect(report.checks.find((check) => check.id === "clock")?.message).toContain("behind");
    });

    it("stops after a blocked bucket request and returns the CORS policy", async () => {
        const report = await run(fakeServer({ blockedMethods: ["HEAD"] }));
        expect(report.ok).toBe(false);
        expect(report.corsSuspected).toBe(true);
        expect(statuses(report)).toMatchObject({ bucket: "error", write: "skipped", delete: "skipped" });
        expect(report.checks.find((check) => check.id === "bucket")?.code).toBe("network_blocked");
        expect(report.cors.r2Wrangler.rules[0]?.allowed.origins).toEqual([ORIGIN]);
    });

    it("reports a missing bucket", async () => {
        const report = await run(fakeServer(), { bucket: "missing-bucket" });
        expect(report.checks.find((check) => check.id === "bucket")).toMatchObject({
            status: "error",
            code: "NoSuchBucket",
        });
    });

    it("continues when HeadBucket is denied to object-scoped credentials", async () => {
        const report = await run(fakeServer({ headBucketStatus: 403 }));
        expect(report.ok).toBe(true);
        expect(statuses(report)).toMatchObject({ bucket: "warning", write: "ok", delete: "ok" });
    });

    it("reports blocked multipart uploads", async () => {
        const report = await run(fakeServer({ blockedMethods: ["POST"] }));
        expect(report.checks.find((check) => check.id === "multipart")).toMatchObject({
            status: "error",
            code: "network_blocked",
        });
        expect(report.checks.find((check) => check.id === "delete")?.status).toBe("ok");
    });

    it("warns when ranges are ignored", async () => {
        const report = await run(fakeServer({ ignoreRange: true }));
        expect(report.checks.find((check) => check.id === "range")?.status).toBe("warning");
    });

    it("reports mixed content and invalid settings without sending requests", async () => {
        const server = fakeServer();
        const mixed = await run(server, { endpoint: "http://storage.example.org" });
        expect(mixed.checks[0]).toMatchObject({ id: "config", status: "error", code: "mixed_content" });
        const invalid = await run(server, { secretAccessKey: "" });
        expect(invalid.checks[0]).toMatchObject({ id: "config", status: "error", code: "invalid_config" });
        expect(server.log).toEqual([]);

        const local = await run(fakeServer(), { endpoint: "http://localhost:3900" });
        expect(local.checks[0]).toMatchObject({ id: "config", status: "ok" });
    });
});

describe("buildCorsPolicy", () => {
    it("produces the wrangler and put-bucket-cors documents with explicit headers", () => {
        const policy = buildCorsPolicy(ORIGIN, "planet-data", new URL("http://localhost:3900"));
        expect(policy.r2Wrangler).toEqual({
            rules: [
                {
                    allowed: {
                        origins: [ORIGIN],
                        methods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
                        headers: [
                            "authorization",
                            "content-type",
                            "content-md5",
                            "content-disposition",
                            "range",
                            "x-amz-date",
                            "x-amz-content-sha256",
                            "x-amz-security-token",
                            "x-amz-copy-source",
                            "x-amz-copy-source-range",
                            "x-amz-user-agent",
                        ],
                    },
                    exposeHeaders: [
                        "ETag",
                        "Content-Length",
                        "Content-Range",
                        "Accept-Ranges",
                        "Date",
                        "x-amz-request-id",
                        "x-amz-version-id",
                    ],
                    maxAgeSeconds: 3600,
                },
            ],
        });
        const rule = policy.awsPutBucketCors.CORSRules[0]!;
        expect(rule.AllowedOrigins).toEqual([ORIGIN]);
        expect(rule.AllowedHeaders).toEqual(policy.r2Wrangler.rules[0]!.allowed.headers);
        expect(rule.ExposeHeaders).toEqual(policy.r2Wrangler.rules[0]!.exposeHeaders);
        expect(policy.r2WranglerCommand).toBe("npx wrangler r2 bucket cors set planet-data --file cors.json");
        expect(policy.awsCommand).toBe(
            "aws s3api put-bucket-cors --bucket planet-data --cors-configuration file://cors.json " +
                "--endpoint-url http://localhost:3900",
        );
        expect(buildCorsPolicy(ORIGIN, "b", new URL("https://s3.us-east-1.amazonaws.com")).awsCommand).not.toContain(
            "--endpoint-url",
        );
    });
});
