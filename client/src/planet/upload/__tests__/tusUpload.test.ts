// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateUploadRequest, UploadSession } from "../protocol";
import { createUploadApi, isAbortError, type UploadApi, UploadTransferError, xhrPut } from "../transport";
import {
    buildUploadFingerprint,
    createTusUpload,
    type FileStream,
    type NamedBlob,
    type TusUploadOptions,
    uploadsUrl,
} from "../tusUpload";

vi.mock("../transport", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createUploadApi: vi.fn(),
    xhrPut: vi.fn(),
}));

const ENDPOINT = "/api/upload/resumable_upload/";

/** A worker that answers every create with a one-part session per file and records the requests. */
function fakeApi(): UploadApi & { creates: CreateUploadRequest[]; hold: Promise<void> } {
    const creates: CreateUploadRequest[] = [];
    let counter = 0;
    const api = {
        creates,
        hold: Promise.resolve(),
        async create(request: CreateUploadRequest): Promise<UploadSession> {
            creates.push(request);
            await api.hold;
            const id = `session-${++counter}`;
            return {
                id,
                mode: "single",
                part_size: 8 * 1024 * 1024,
                part_count: 1,
                parts: [{ part_number: 1, url: `https://bucket.test/${id}` }],
                expires_in: 3600,
                uploaded: [],
            };
        },
        presign: vi.fn(),
        complete: vi.fn(async (id: string) => ({ id, state: "uploaded" as const, size: 0 })),
        abort: vi.fn(async () => undefined),
    };
    return api;
}

function install(api: UploadApi) {
    vi.mocked(createUploadApi).mockReturnValue(api);
    vi.mocked(xhrPut).mockImplementation(async (_url, body, { onProgress }) => {
        onProgress(body.size / 4);
        onProgress(body.size);
        return { etag: '"e"' };
    });
}

function uploadOptions(file: TusUploadOptions["file"], overrides: Partial<TusUploadOptions> = {}): TusUploadOptions {
    return {
        file,
        endpoint: ENDPOINT,
        historyId: "hist1",
        chunkSize: 10485760,
        onProgress: vi.fn(),
        onError: vi.fn(),
        ...overrides,
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe("buildUploadFingerprint", () => {
    it("matches Galaxy's fingerprints for files, blobs and streams", async () => {
        const file = new File(["content"], "test.txt", { type: "text/plain", lastModified: 1234567890 });
        expect(await buildUploadFingerprint(file, "hist123")()).toBe("tus-br-test.txt-text/plain-7-1234567890-hist123");

        const blob = new Blob(["content"], { type: "text/plain" }) as NamedBlob;
        blob.name = "blob.txt";
        expect(await buildUploadFingerprint(blob, "hist456")()).toBe("tus-br-blob.txt-text/plain-7--hist456");

        const stream: FileStream = {
            name: "stream.txt",
            size: 100,
            type: "text/plain",
            lastModified: 9876543210,
            stream: new ReadableStream(),
            isStream: true,
        };
        expect(await buildUploadFingerprint(stream, "hist789")()).toBe(
            "tus-br-stream.txt-text/plain-100-9876543210-hist789",
        );
    });
});

describe("uploadsUrl", () => {
    it("places Planet's upload endpoints under Galaxy's app root", () => {
        expect(uploadsUrl("/api/upload/resumable_upload/")).toBe("/api/planet/uploads");
        expect(uploadsUrl("/galaxy/api/upload/resumable_upload")).toBe("/galaxy/api/planet/uploads");
        expect(uploadsUrl("https://planet.test/api/upload/resumable_upload/")).toBe(
            "https://planet.test/api/planet/uploads",
        );
        expect(uploadsUrl("/elsewhere/")).toBe("/api/planet/uploads");
    });
});

describe("createTusUpload", () => {
    it("uploads a file and resolves with the session id and file name", async () => {
        const api = fakeApi();
        install(api);
        const file = new File(["x".repeat(400)], "reads.fastq", { type: "text/plain", lastModified: 5 });
        const options = uploadOptions(file);
        await expect(createTusUpload(options)).resolves.toEqual({ sessionId: "session-1", fileName: "reads.fastq" });

        expect(createUploadApi).toHaveBeenCalledWith("/api/planet/uploads");
        expect(api.creates).toEqual([
            {
                name: "reads.fastq",
                size: 400,
                content_type: "text/plain",
                history_id: "hist1",
                fingerprint: "tus-br-reads.fastq-text/plain-400-5-hist1",
            },
        ]);
        const [, body] = vi.mocked(xhrPut).mock.calls[0]!;
        expect(body).not.toBeInstanceOf(File);
        expect(body.size).toBe(400);
        expect(vi.mocked(options.onProgress).mock.calls.map(([percentage]) => percentage)).toEqual([0, 25, 100]);
        expect(options.onError).not.toHaveBeenCalled();
    });

    it("never resumes pasted text", async () => {
        const api = fakeApi();
        install(api);
        const blob = new Blob([">seq\nACGT"]) as NamedBlob;
        blob.name = "New File";
        await createTusUpload(uploadOptions(blob));
        expect(api.creates[0]).toMatchObject({ name: "New File", fingerprint: null, content_type: null });
    });

    it("does not resume a file that is already uploading in this page", async () => {
        const api = fakeApi();
        let release!: () => void;
        api.hold = new Promise((resolve) => (release = resolve));
        install(api);
        const file = new File(["abc"], "a.txt", { lastModified: 1 });
        const first = createTusUpload(uploadOptions(file));
        const second = createTusUpload(uploadOptions(file));
        await vi.waitFor(() => expect(api.creates).toHaveLength(2));
        release();
        await Promise.all([first, second]);
        expect(api.creates.map((request) => request.fingerprint)).toEqual(["tus-br-a.txt--3-1-hist1", null]);

        await createTusUpload(uploadOptions(file));
        expect(api.creates[2]!.fingerprint).toBe("tus-br-a.txt--3-1-hist1");
    });

    it("uploads file streams", async () => {
        const api = fakeApi();
        install(api);
        const stream: FileStream = {
            name: "entry.txt",
            size: 5,
            lastModified: 7,
            stream: new Blob(["hello"]).stream(),
            isStream: true,
        };
        await expect(createTusUpload(uploadOptions(stream))).resolves.toEqual({
            sessionId: "session-1",
            fileName: "entry.txt",
        });
        const [, body] = vi.mocked(xhrPut).mock.calls[0]!;
        expect(await body.text()).toBe("hello");
        expect(api.creates[0]!.fingerprint).toBe("tus-br-entry.txt--5-7-hist1");
    });

    it("reports an abort before the upload starts", async () => {
        const api = fakeApi();
        install(api);
        const controller = new AbortController();
        controller.abort();
        const options = uploadOptions(new File(["a"], "a.txt"), { signal: controller.signal });
        const error = await createTusUpload(options).catch((caught: unknown) => caught);
        expect(isAbortError(error)).toBe(true);
        expect(options.onError).toHaveBeenCalledWith(error);
        expect(api.creates).toEqual([]);
    });

    it("reports failures through onError and rejects", async () => {
        const api = fakeApi();
        install(api);
        vi.mocked(xhrPut).mockRejectedValue(
            new UploadTransferError("The bucket refused the upload: AccessDenied.", 401),
        );
        const options = uploadOptions(new File(["a"], "a.txt"));
        await expect(createTusUpload(options)).rejects.toThrow("AccessDenied");
        expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    });
});
