// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createKubeClient, isExpired, type Job, KubeError, LineDecoder, type WatchEvent } from ".";

const encoder = new TextEncoder();

function line(event: unknown): string {
    return `${JSON.stringify(event)}\n`;
}

function job(name: string, resourceVersion: string, phase?: string): Job {
    return {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, namespace: "planet", resourceVersion, annotations: phase ? { phase } : undefined },
    };
}

/** Splits the payload bytes at the given offsets to exercise chunk boundaries. */
function chunked(payload: string, cuts: number[]): Uint8Array[] {
    const bytes = encoder.encode(payload);
    const chunks: Uint8Array[] = [];
    let start = 0;
    const offsets = [...new Set([...cuts, bytes.length])].sort((a, b) => a - b);
    for (const cut of offsets) {
        chunks.push(bytes.slice(start, cut));
        start = cut;
    }
    return chunks;
}

/** Delivers one chunk per read, then closes or errors. */
function streamOf(chunks: Uint8Array[], options: { error?: unknown } = {}): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            const chunk = chunks[index++];
            if (chunk) {
                controller.enqueue(chunk);
            } else if (options.error) {
                controller.error(options.error);
            } else {
                controller.close();
            }
        },
    });
}

function watchClient(respond: (url: URL, init: RequestInit) => Response) {
    const urls: URL[] = [];
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
        if (init.signal?.aborted) {
            throw init.signal.reason;
        }
        const url = new URL(input);
        urls.push(url);
        return respond(url, init);
    });
    return {
        client: createKubeClient({ gatewayUrl: "https://gw.example.org", namespace: "planet", token: "t" }, { fetch }),
        urls,
    };
}

describe("LineDecoder", () => {
    it("joins lines and multi-byte characters split across chunks", () => {
        const decoder = new LineDecoder();
        const bytes = encoder.encode('{"a":"é"}\n{"b":2}\r\n\n{"c":3}');
        const lines: string[] = [];
        for (let i = 0; i < bytes.length; i++) {
            lines.push(...decoder.push(bytes.slice(i, i + 1)));
        }
        lines.push(...decoder.flush());
        expect(lines.map((value) => JSON.parse(value))).toEqual([{ a: "é" }, { b: 2 }, { c: 3 }]);
    });

    it("bounds the size of a partial line", () => {
        const decoder = new LineDecoder(16);
        expect(() => decoder.push(encoder.encode("x".repeat(17)))).toThrow(KubeError);
    });
});

describe("watchJobs", () => {
    it("streams events across chunk boundaries and resumes from the last resourceVersion", async () => {
        const payload =
            line({ type: "ADDED", object: job("j1", "101", "café") }) +
            line({ type: "MODIFIED", object: job("j1", "102") }) +
            line({
                type: "BOOKMARK",
                object: { kind: "Job", apiVersion: "batch/v1", metadata: { resourceVersion: "150" } },
            }) +
            line({ type: "DELETED", object: job("j1", "160") });
        const accentOffset = encoder.encode(payload).indexOf(0xc3) + 1;
        const { client, urls } = watchClient(
            () => new Response(streamOf(chunked(payload, [5, 37, accentOffset, 120, 121, 200]))),
        );
        const events: WatchEvent<Job>[] = [];
        const result = await client.watchJobs("app=planet", "100", (event) => {
            events.push(event);
        });
        expect(events.map((event) => event.type)).toEqual(["ADDED", "MODIFIED", "BOOKMARK", "DELETED"]);
        expect((events[0]?.object as Job).metadata.annotations?.phase).toBe("café");
        expect(result).toEqual({ resourceVersion: "160", end: "closed" });

        const url = urls[0]!;
        expect(url.pathname).toBe("/apis/batch/v1/namespaces/planet/jobs");
        expect(Object.fromEntries(url.searchParams)).toEqual({
            watch: "true",
            allowWatchBookmarks: "true",
            timeoutSeconds: "55",
            labelSelector: "app=planet",
            resourceVersion: "100",
        });
    });

    it("awaits asynchronous handlers in order", async () => {
        const payload = line({ type: "ADDED", object: job("a", "1") }) + line({ type: "ADDED", object: job("b", "2") });
        const { client } = watchClient(() => new Response(streamOf([encoder.encode(payload)])));
        const seen: string[] = [];
        await client.watchJobs("", "", async (event) => {
            const name = event.type === "ADDED" ? (event.object.metadata.name ?? "") : "";
            await new Promise((resolve) => setTimeout(resolve, name === "a" ? 20 : 0));
            seen.push(name);
        });
        expect(seen).toEqual(["a", "b"]);
    });

    it("passes an expired ERROR event to the handler and rejects with 410", async () => {
        const payload =
            line({ type: "ADDED", object: job("j1", "101") }) +
            line({
                type: "ERROR",
                object: {
                    kind: "Status",
                    apiVersion: "v1",
                    status: "Failure",
                    message: "too old resource version: 100 (150)",
                    reason: "Expired",
                    code: 410,
                },
            }) +
            line({ type: "ADDED", object: job("j2", "151") });
        const { client } = watchClient(() => new Response(streamOf([encoder.encode(payload)])));
        const types: string[] = [];
        const error = await client
            .watchJobs("", "100", (event) => {
                types.push(event.type);
            })
            .catch((e: unknown) => e);
        expect(types).toEqual(["ADDED", "ERROR"]);
        expect(error).toBeInstanceOf(KubeError);
        expect(error).toMatchObject({ status: 410, reason: "Expired", message: "too old resource version: 100 (150)" });
        expect(isExpired(error)).toBe(true);
    });

    it("rejects an HTTP 410 response", async () => {
        const { client } = watchClient(() =>
            Response.json(
                { kind: "Status", status: "Failure", reason: "Gone", message: "gone", code: 410 },
                { status: 410 },
            ),
        );
        const error = await client.watchJobs("", "1", () => undefined).catch((e: unknown) => e);
        expect(isExpired(error)).toBe(true);
        expect(error).toMatchObject({ reason: "Gone" });
    });

    it("resolves as aborted when the signal fires mid-stream", async () => {
        const controller = new AbortController();
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const { client } = watchClient((_url, init) => {
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    streamController = c;
                    c.enqueue(encoder.encode(line({ type: "ADDED", object: job("j1", "7") })));
                },
            });
            init.signal?.addEventListener("abort", () => streamController?.error(init.signal?.reason));
            return new Response(body);
        });
        const result = await client.watchJobs(
            "",
            "5",
            () => {
                controller.abort();
            },
            controller.signal,
        );
        expect(result).toEqual({ resourceVersion: "7", end: "aborted" });

        const before = new AbortController();
        before.abort();
        expect(await client.watchJobs("", "5", () => undefined, before.signal)).toEqual({
            resourceVersion: "5",
            end: "aborted",
        });
    });

    it("resolves as interrupted when the connection drops", async () => {
        const { client } = watchClient(
            () =>
                new Response(
                    streamOf([encoder.encode(line({ type: "MODIFIED", object: job("j1", "9") }))], {
                        error: new TypeError("network error"),
                    }),
                ),
        );
        expect(await client.watchJobs("", "8", () => undefined)).toEqual({ resourceVersion: "9", end: "interrupted" });
    });

    it("rejects malformed events", async () => {
        const { client } = watchClient(() => new Response(streamOf([encoder.encode('{"type":"ADDED"\n')])));
        await expect(client.watchJobs("", "1", () => undefined)).rejects.toMatchObject({ reason: "InvalidWatchEvent" });
        const { client: other } = watchClient(
            () => new Response(streamOf([encoder.encode('{"type":"UNKNOWN","object":{}}\n')])),
        );
        await expect(other.watchJobs("", "1", () => undefined)).rejects.toMatchObject({ reason: "InvalidWatchEvent" });
    });

    it("propagates handler errors", async () => {
        const { client } = watchClient(
            () => new Response(streamOf([encoder.encode(line({ type: "ADDED", object: job("j1", "1") }))])),
        );
        await expect(
            client.watchJobs("", "", () => {
                throw new Error("handler failed");
            }),
        ).rejects.toThrow("handler failed");
    });

    it("watches Pods with a custom timeout", async () => {
        const { client, urls } = watchClient(() => new Response(streamOf([])));
        expect(await client.watchPods("job-name=j1", "3", () => undefined, undefined, { timeoutSeconds: 30 })).toEqual({
            resourceVersion: "3",
            end: "closed",
        });
        expect(urls[0]!.pathname).toBe("/api/v1/namespaces/planet/pods");
        expect(urls[0]!.searchParams.get("timeoutSeconds")).toBe("30");
        await expect(client.watchPods("", "", () => undefined, undefined, { timeoutSeconds: 0 })).rejects.toThrow(
            RangeError,
        );
    });
});
