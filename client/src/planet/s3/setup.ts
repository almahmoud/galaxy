import type { S3Client, S3RequestSpec } from "./client";
import { isS3Error, S3Error } from "./errors";
import { fullKey, isIpHost, isLoopbackHost, type ResolvedS3Config } from "./url";

export const CORS_ALLOWED_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE"];

export const CORS_ALLOWED_HEADERS = [
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
];

export const CORS_EXPOSE_HEADERS = [
    "ETag",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Date",
    "x-amz-request-id",
    "x-amz-version-id",
];

export const CORS_MAX_AGE_SECONDS = 3600;

const ORIGIN_PLACEHOLDER = "https://planet.example.org";
const PROBE_PREFIX = ".planet-probe/";
const CLOCK_WARNING_MS = 60 * 1000;

export interface S3CorsPolicy {
    origin: string;
    /** Body for `wrangler r2 bucket cors set <bucket> --file <file>`. */
    r2Wrangler: {
        rules: {
            allowed: { origins: string[]; methods: string[]; headers: string[] };
            exposeHeaders: string[];
            maxAgeSeconds: number;
        }[];
    };
    r2WranglerCommand: string;
    /** Body for `aws s3api put-bucket-cors --cors-configuration file://<file>`; also accepted by Garage. */
    awsPutBucketCors: {
        CORSRules: {
            AllowedOrigins: string[];
            AllowedMethods: string[];
            AllowedHeaders: string[];
            ExposeHeaders: string[];
            MaxAgeSeconds: number;
        }[];
    };
    awsCommand: string;
}

export type S3SetupCheckId =
    | "config"
    | "bucket"
    | "write"
    | "etag"
    | "read"
    | "range"
    | "multipart"
    | "delete"
    | "clock";

export type S3SetupStatus = "ok" | "warning" | "error" | "skipped";

export interface S3SetupCheck {
    id: S3SetupCheckId;
    status: S3SetupStatus;
    message: string;
    /** S3 error code or a Planet code such as network_blocked, cors_expose_etag or cors_expose_date. */
    code?: string;
}

export interface S3SetupReport {
    /** True when no check has status "error". */
    ok: boolean;
    checks: S3SetupCheck[];
    /** True when a failure points at a missing or incomplete bucket CORS policy. */
    corsSuspected: boolean;
    /** Server minus local clock in milliseconds, or null when the Date header was never readable. */
    clockOffsetMs: number | null;
    cors: S3CorsPolicy;
}

export interface S3SetupOptions {
    /** Origin to allow in the generated CORS policy. Defaults to the current origin. */
    origin?: string;
    signal?: AbortSignal;
}

/** @internal */
export interface SetupContext {
    config: ResolvedS3Config | null;
    configError: S3Error | null;
    send: (spec: S3RequestSpec) => Promise<Response>;
    client: S3Client;
    clockOffsetMs: () => number;
    now: () => number;
}

const SETUP_ORDER: S3SetupCheckId[] = [
    "config",
    "bucket",
    "write",
    "etag",
    "read",
    "range",
    "multipart",
    "delete",
    "clock",
];

function currentOrigin(): string | null {
    const location = (globalThis as { location?: { origin?: string } }).location;
    return location?.origin && location.origin !== "null" ? location.origin : null;
}

function isAwsEndpoint(endpoint: URL): boolean {
    return endpoint.hostname === "amazonaws.com" || endpoint.hostname.endsWith(".amazonaws.com");
}

export function buildCorsPolicy(origin: string, bucket = "<bucket>", endpoint?: URL): S3CorsPolicy {
    const endpointArg = endpoint && !isAwsEndpoint(endpoint) ? ` --endpoint-url ${endpoint.origin}` : "";
    return {
        origin,
        r2Wrangler: {
            rules: [
                {
                    allowed: {
                        origins: [origin],
                        methods: [...CORS_ALLOWED_METHODS],
                        headers: [...CORS_ALLOWED_HEADERS],
                    },
                    exposeHeaders: [...CORS_EXPOSE_HEADERS],
                    maxAgeSeconds: CORS_MAX_AGE_SECONDS,
                },
            ],
        },
        r2WranglerCommand: `npx wrangler r2 bucket cors set ${bucket} --file cors.json`,
        awsPutBucketCors: {
            CORSRules: [
                {
                    AllowedOrigins: [origin],
                    AllowedMethods: [...CORS_ALLOWED_METHODS],
                    AllowedHeaders: [...CORS_ALLOWED_HEADERS],
                    ExposeHeaders: [...CORS_EXPOSE_HEADERS],
                    MaxAgeSeconds: CORS_MAX_AGE_SECONDS,
                },
            ],
        },
        awsCommand: `aws s3api put-bucket-cors --bucket ${bucket} --cors-configuration file://cors.json${endpointArg}`,
    };
}

function isPrivateHost(hostname: string): boolean {
    return (
        hostname.endsWith(".local") ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^\[f[cd]/i.test(hostname)
    );
}

/** Returns a problem with the page-to-endpoint transport, such as mixed content, or null. */
function transportProblem(origin: string, endpoint: URL): { status: S3SetupStatus; message: string } | null {
    if (!origin.startsWith("https:") || endpoint.protocol !== "http:" || isLoopbackHost(endpoint.hostname)) {
        return null;
    }
    if (isPrivateHost(endpoint.hostname)) {
        return {
            status: "warning",
            message:
                `${endpoint.origin} uses http:// from an https:// page. Chrome allows this for private addresses ` +
                "once local network access is granted; other browsers block it. Prefer an https:// endpoint.",
        };
    }
    if (isIpHost(endpoint.hostname)) {
        return {
            status: "error",
            message: `${endpoint.origin} uses http://; browsers block it from an https:// page.`,
        };
    }
    return {
        status: "error",
        message: `${endpoint.origin} uses http://; browsers block it from an https:// page. Use an https:// endpoint.`,
    };
}

function describe(error: unknown): { message: string; code?: string } {
    if (error instanceof S3Error) {
        return { message: error.message, code: error.code };
    }
    return { message: error instanceof Error ? error.message : String(error) };
}

function randomHex(bytes: number): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runSetupCheck(context: SetupContext, options: S3SetupOptions): Promise<S3SetupReport> {
    const origin = options.origin ?? currentOrigin() ?? ORIGIN_PLACEHOLDER;
    const config = context.config;
    const cors = buildCorsPolicy(origin, config?.bucket, config?.endpoint);
    const checks = new Map<S3SetupCheckId, S3SetupCheck>();
    let corsSuspected = false;
    let dateReadable = false;
    const signal = options.signal;

    const record = (id: S3SetupCheckId, status: S3SetupStatus, message: string, code?: string) => {
        checks.set(id, code === undefined ? { id, status, message } : { id, status, message, code });
    };
    const fail = (id: S3SetupCheckId, error: unknown, prefix: string) => {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }
        const { message, code } = describe(error);
        if (code === "network_blocked") {
            corsSuspected = true;
        }
        record(id, "error", prefix ? `${prefix} ${message}` : message, code);
    };
    const observe = (response: Response) => {
        if (response.headers.get("date")) {
            dateReadable = true;
        }
    };
    const finish = (): S3SetupReport => {
        const ordered = SETUP_ORDER.map(
            (id) =>
                checks.get(id) ?? {
                    id,
                    status: "skipped" as const,
                    message: "Not run because an earlier check failed.",
                },
        );
        return {
            ok: ordered.every((check) => check.status !== "error"),
            checks: ordered,
            corsSuspected,
            clockOffsetMs: dateReadable ? context.clockOffsetMs() : null,
            cors,
        };
    };

    if (!config) {
        record(
            "config",
            "error",
            context.configError?.message ?? "The storage settings are invalid.",
            "invalid_config",
        );
        return finish();
    }
    const transport = transportProblem(origin, config.endpoint);
    if (transport?.status === "error") {
        record("config", "error", transport.message, "mixed_content");
        return finish();
    }
    if (transport) {
        record("config", "warning", transport.message, "mixed_content");
    } else if (!config.pathStyle && config.bucket.includes(".") && config.endpoint.protocol === "https:") {
        record(
            "config",
            "warning",
            "Bucket names with dots do not match the endpoint's TLS certificate in virtual-hosted style; use path-style.",
        );
    } else {
        record("config", "ok", `Using ${config.endpoint.origin}, bucket ${config.bucket}, region ${config.region}.`);
    }

    try {
        await context.send({ method: "HEAD", notFoundCode: "NoSuchBucket", signal, onResponse: observe });
        record("bucket", "ok", `Bucket ${config.bucket} is reachable.`);
    } catch (error) {
        if (signal?.aborted || !isS3Error(error) || error.status !== 403) {
            fail("bucket", error, isS3Error(error, "NoSuchBucket") ? "The bucket does not exist." : "");
            return finish();
        }
        // Object-scoped credentials (such as R2 object read/write tokens) may not allow HeadBucket.
        record(
            "bucket",
            "warning",
            "HeadBucket was denied; continuing with object checks. The credentials may be scoped to objects.",
            error.code,
        );
    }

    const probeKey = `${PROBE_PREFIX}${randomHex(8)}`;
    const probeBody = `planet storage probe ${new Date(context.now()).toISOString()}`;
    let written = false;
    try {
        const put = await context.send({
            method: "PUT",
            key: fullKey(config.prefix, probeKey),
            headers: { "content-type": "text/plain" },
            body: probeBody,
            signal,
            onResponse: observe,
        });
        written = true;
        record("write", "ok", `Wrote ${fullKey(config.prefix, probeKey)}.`);
        if (put.headers.get("etag")) {
            record("etag", "ok", "The ETag response header is readable.");
        } else {
            corsSuspected = true;
            record(
                "etag",
                "error",
                "The ETag response header is not readable; multipart uploads cannot complete. Add ETag to the CORS expose headers.",
                "cors_expose_etag",
            );
        }

        try {
            const response = await context.client.getObject(probeKey, { signal });
            observe(response);
            const text = await response.text();
            if (text === probeBody) {
                record("read", "ok", "Read the probe object back.");
            } else {
                record("read", "error", "The probe object read back with different content.", "content_mismatch");
            }
        } catch (error) {
            fail("read", error, "Reading the probe object failed.");
        }

        try {
            const response = await context.client.getObject(probeKey, { range: { start: 0, end: 4 }, signal });
            const text = await response.text();
            if (response.status !== 206 || text !== probeBody.slice(0, 5)) {
                record("range", "warning", "The endpoint ignored the Range header; partial reads will be slower.");
            } else if (!response.headers.get("content-range")) {
                corsSuspected = true;
                record(
                    "range",
                    "warning",
                    "Content-Range is not readable. Add Content-Range to the CORS expose headers.",
                    "cors_expose_content_range",
                );
            } else {
                record("range", "ok", "Range requests work.");
            }
        } catch (error) {
            fail("range", error, "The range request failed.");
        }

        try {
            const uploadId = await context.client.createMultipartUpload(probeKey, { signal });
            await context.client.abortMultipartUpload(probeKey, uploadId, { signal });
            record("multipart", "ok", "Created and aborted a multipart upload.");
        } catch (error) {
            fail("multipart", error, "Multipart uploads failed.");
        }
    } catch (error) {
        fail("write", error, "Writing the probe object failed.");
    } finally {
        if (written) {
            try {
                await context.client.deleteObject(probeKey, { signal });
                record("delete", "ok", "Deleted the probe object.");
            } catch (error) {
                fail("delete", error, "Deleting the probe object failed.");
            }
        }
    }

    if (!dateReadable) {
        corsSuspected = true;
        record(
            "clock",
            "warning",
            "The Date response header is not readable, so clock differences cannot be corrected. Add Date to the CORS expose headers.",
            "cors_expose_date",
        );
    } else {
        const offset = context.clockOffsetMs();
        if (Math.abs(offset) >= CLOCK_WARNING_MS) {
            const minutes = (Math.abs(offset) / 60000).toFixed(1);
            const direction = offset > 0 ? "behind" : "ahead of";
            record(
                "clock",
                "warning",
                `This device's clock is ${minutes} minutes ${direction} the storage server; signed requests are corrected for it.`,
                "clock_skew",
            );
        } else {
            record("clock", "ok", "The device clock matches the storage server.");
        }
    }
    return finish();
}
