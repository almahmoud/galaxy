// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUploadApi, isAbortError, UploadTransferError, xhrPut } from "../transport";

const SECRET_URL = "https://bucket.test/uploads/u1?partNumber=1&X-Amz-Signature=secret";

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createUploadApi", () => {
    it("sends JSON to the worker's endpoints", async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
            init?.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse({ ok: true }),
        );
        const api = createUploadApi("/root/api/planet/uploads", fetchMock as typeof fetch);
        await api.create({ name: "a", size: 1, content_type: null, history_id: null, fingerprint: null });
        await api.presign("u 1", [2, 3]);
        await api.complete("u1", { parts: [{ part_number: 1, etag: '"e"' }] });
        await api.abort("u1");

        const calls = fetchMock.mock.calls.map(([input, init]) => [input, init?.method, init?.body]);
        expect(calls).toEqual([
            [
                "/root/api/planet/uploads",
                "POST",
                JSON.stringify({ name: "a", size: 1, content_type: null, history_id: null, fingerprint: null }),
            ],
            ["/root/api/planet/uploads/u%201/parts", "POST", JSON.stringify({ part_numbers: [2, 3] })],
            [
                "/root/api/planet/uploads/u1/complete",
                "POST",
                JSON.stringify({ parts: [{ part_number: 1, etag: '"e"' }] }),
            ],
            ["/root/api/planet/uploads/u1", "DELETE", undefined],
        ]);
        const init = fetchMock.mock.calls[0]![1]!;
        expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
        expect(init.credentials).toBe("same-origin");
    });

    it("turns Galaxy error responses and network failures into transfer errors", async () => {
        const failing = createUploadApi(
            "/api/planet/uploads",
            vi.fn(async () => jsonResponse({ err_msg: "Dataset storage is not configured.", err_code: 501002 }, 501)),
        );
        await expect(failing.presign("u1", [1])).rejects.toMatchObject({
            message: "Dataset storage is not configured.",
            status: 501,
            retryable: false,
        });

        const offline = createUploadApi(
            "/api/planet/uploads",
            vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        );
        const error = await offline.abort("u1").catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(UploadTransferError);
        expect(error).toMatchObject({ status: 0, retryable: true });
    });

    it("reports aborted calls as aborts", async () => {
        const controller = new AbortController();
        const api = createUploadApi(
            "/api/planet/uploads",
            vi.fn(async () => {
                controller.abort();
                throw new DOMException("aborted", "AbortError");
            }),
        );
        const error = await api.complete("u1", { parts: [] }, controller.signal).catch((caught: unknown) => caught);
        expect(isAbortError(error)).toBe(true);
    });
});

/** A scripted XMLHttpRequest. */
class FakeXhr {
    static instances: FakeXhr[] = [];
    static respond: (xhr: FakeXhr) => void = () => undefined;

    method = "";
    url = "";
    status = 0;
    responseText = "";
    sent: unknown;
    aborted = false;
    headers: Record<string, string> = {};
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;

    constructor() {
        FakeXhr.instances.push(this);
    }

    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }

    send(body: unknown) {
        this.sent = body;
        queueMicrotask(() => FakeXhr.respond(this));
    }

    abort() {
        this.aborted = true;
        this.onabort?.();
    }

    getResponseHeader(name: string): string | null {
        return this.headers[name.toLowerCase()] ?? null;
    }

    finish(status: number, headers: Record<string, string> = {}, text = "") {
        this.status = status;
        this.headers = headers;
        this.responseText = text;
        this.onload?.();
    }
}

describe("xhrPut", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        FakeXhr.instances = [];
        FakeXhr.respond = () => undefined;
    });

    function put(body = new Blob(["abcd"]), signal = new AbortController().signal, onProgress = vi.fn()) {
        vi.stubGlobal("XMLHttpRequest", FakeXhr);
        return xhrPut(SECRET_URL, body, { signal, onProgress });
    }

    it("sends the body with PUT, forwards progress and resolves with the ETag", async () => {
        const onProgress = vi.fn();
        FakeXhr.respond = (xhr) => {
            xhr.upload.onprogress?.({ loaded: 2 });
            xhr.finish(200, { etag: '"abc"' });
        };
        const body = new Blob(["abcd"]);
        await expect(put(body, undefined, onProgress)).resolves.toEqual({ etag: '"abc"' });
        expect(FakeXhr.instances[0]).toMatchObject({ method: "PUT", url: SECRET_URL, sent: body });
        expect(onProgress).toHaveBeenCalledWith(2);
    });

    it("explains a missing ETag as a CORS setting", async () => {
        FakeXhr.respond = (xhr) => xhr.finish(200);
        await expect(put()).rejects.toMatchObject({ status: 400, message: expect.stringContaining("ExposeHeaders") });
    });

    it("reports the bucket's error code without the URL", async () => {
        FakeXhr.respond = (xhr) =>
            xhr.finish(503, {}, "<Error><Code>SlowDown</Code><Message>Reduce your rate</Message></Error>");
        const error = (await put().catch((caught: unknown) => caught)) as UploadTransferError;
        expect(error).toMatchObject({ status: 503, retryable: true });
        expect(error.message).toContain("SlowDown");
        expect(error.message).not.toContain("secret");
    });

    it("reports network failures with status 0", async () => {
        FakeXhr.respond = (xhr) => xhr.onerror?.();
        const error = (await put().catch((caught: unknown) => caught)) as UploadTransferError;
        expect(error).toMatchObject({ status: 0, retryable: true });
        expect(error.message).not.toContain("bucket.test");
    });

    it("aborts the request when the signal aborts", async () => {
        const controller = new AbortController();
        const pending = put(undefined, controller.signal);
        controller.abort();
        const error = await pending.catch((caught: unknown) => caught);
        expect(isAbortError(error)).toBe(true);
        expect(FakeXhr.instances[0]!.aborted).toBe(true);
    });
});
