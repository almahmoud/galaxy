/**
 * An in-memory S3 bucket behind a stubbed `fetch`, for the dataset and collection handler tests. Requests to
 * {@link S3_ENDPOINT} reach the bucket (path-style, Range and HEAD supported); other requests are served from static
 * data files keyed by path.
 */

import { vi } from "vitest";

import { settings } from "@/planet/db";

export const S3_ENDPOINT = "https://s3.test";
export const BUCKET = "bucket";
export const PREFIX = "planet";

const encoder = new TextEncoder();

export interface BucketRequest {
    method: string;
    key: string;
    range: string | null;
}

export class FakeBucket {
    readonly objects = new Map<string, Uint8Array>();
    readonly requests: BucketRequest[] = [];

    /** Stores an object under `key`, relative to {@link PREFIX}. */
    put(key: string, body: string | Uint8Array): void {
        this.objects.set(`${PREFIX}/${key}`, typeof body === "string" ? encoder.encode(body) : body);
    }

    /** Requests for one key (relative to the prefix). */
    requestsFor(key: string): BucketRequest[] {
        return this.requests.filter((request) => request.key === `${PREFIX}/${key}`);
    }

    handle(url: URL, init: RequestInit = {}): Response {
        const [, bucket, ...segments] = url.pathname.split("/");
        const key = segments.map(decodeURIComponent).join("/");
        const method = (init.method ?? "GET").toUpperCase();
        const headers = new Headers(init.headers);
        const range = headers.get("range");
        this.requests.push({ method, key, range });
        const date = { Date: new Date().toUTCString() };
        const body = bucket === BUCKET ? this.objects.get(key) : undefined;
        if (!body) {
            return new Response(
                method === "HEAD" ? null : "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
                { status: 404, headers: date },
            );
        }
        if (method === "HEAD") {
            return new Response(null, { headers: { ...date, "Content-Length": String(body.byteLength) } });
        }
        if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (!match) {
                return new Response(null, { status: 400, headers: date });
            }
            const start = Number(match[1]);
            if (start >= body.byteLength) {
                return new Response("<Error><Code>InvalidRange</Code><Message>range</Message></Error>", {
                    status: 416,
                    headers: date,
                });
            }
            const end = Math.min(body.byteLength - 1, match[2] ? Number(match[2]) : body.byteLength - 1);
            return new Response(body.slice(start, end + 1), {
                status: 206,
                headers: { ...date, "Content-Range": `bytes ${start}-${end}/${body.byteLength}` },
            });
        }
        return new Response(body.slice(), { headers: date });
    }
}

/**
 * Replaces `fetch`: bucket requests go to `bucket`, everything else to `files` (JSON by path) or `extra` handlers.
 */
export function stubNetwork(
    files: Record<string, unknown>,
    bucket: FakeBucket,
    extra: (url: URL, init?: RequestInit) => Response | undefined = () => undefined,
) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            "https://planet.test",
        );
        if (url.origin === S3_ENDPOINT) {
            return bucket.handle(url, init);
        }
        const handled = extra(url, init);
        if (handled) {
            return handled;
        }
        if (Object.hasOwn(files, url.pathname)) {
            return new Response(JSON.stringify(files[url.pathname]), {
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

let configured = 0;

/**
 * Points Planet at the fake bucket. Each call uses new (fake) credentials, so handlers build a new S3 client and
 * no state carries over between tests.
 */
export async function configureStorage(endpoint = S3_ENDPOINT): Promise<void> {
    configured++;
    await settings.update({
        storage: {
            endpoint,
            bucket: BUCKET,
            prefix: PREFIX,
            region: "us-east-1",
            path_style: true,
            access_key_id: `AKIDTEST${configured}`,
            secret_access_key: "test-secret-not-real",
        },
    });
}
