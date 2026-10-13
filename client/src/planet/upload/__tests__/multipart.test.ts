// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { MAX_ATTEMPTS, type UploaderDependencies, type UploadSource, uploadToBucket, URL_BATCH } from "../multipart";
import type { CompleteUploadRequest, CreateUploadRequest, PartUrl, UploadedPart, UploadSession } from "../protocol";
import { isAbortError, type PutOptions, type UploadApi, UploadTransferError } from "../transport";

const encoder = new TextEncoder();

interface PutCall {
    url: string;
    partNumber: number;
    body: Blob;
    text: string;
}

/** A Service Worker and a bucket that hold sessions in memory and record every call. */
class FakeService implements UploadApi {
    readonly creates: CreateUploadRequest[] = [];
    readonly presigns: number[][] = [];
    readonly completes: CompleteUploadRequest[] = [];
    readonly aborts: string[] = [];
    readonly puts: PutCall[] = [];
    /** Errors to throw from successive calls, by part number. */
    readonly putFailures = new Map<number, Error[]>();
    createFailures: Error[] = [];
    inflight = 0;
    maxInflight = 0;
    /** Resolves pending PUTs; tests that need overlap hold them. */
    gate: Promise<void> = Promise.resolve();
    private version = 0;

    constructor(
        private readonly layout: {
            partSize: number;
            partCount: number;
            initialUrls?: number;
            expiresIn?: number;
            uploaded?: UploadedPart[];
        },
    ) {}

    private urls(numbers: readonly number[]): PartUrl[] {
        return numbers.map((partNumber) => ({
            part_number: partNumber,
            url: `https://bucket.test/uploads/u1?partNumber=${partNumber}&v=${++this.version}`,
        }));
    }

    async create(request: CreateUploadRequest): Promise<UploadSession> {
        this.creates.push(request);
        const failure = this.createFailures.shift();
        if (failure) {
            throw failure;
        }
        const uploaded = this.layout.uploaded ?? [];
        const done = new Set(uploaded.map((part) => part.part_number));
        const missing = Array.from({ length: this.layout.partCount }, (_, index) => index + 1).filter(
            (partNumber) => !done.has(partNumber),
        );
        return {
            id: "u1",
            mode: this.layout.partCount > 1 ? "multipart" : "single",
            part_size: this.layout.partSize,
            part_count: this.layout.partCount,
            parts: this.urls(missing.slice(0, this.layout.initialUrls ?? 16)),
            expires_in: this.layout.expiresIn ?? 3600,
            uploaded,
        };
    }

    async presign(_id: string, partNumbers: number[]) {
        this.presigns.push(partNumbers);
        return { parts: this.urls(partNumbers), expires_in: this.layout.expiresIn ?? 3600 };
    }

    async complete(id: string, request: CompleteUploadRequest) {
        this.completes.push(request);
        return { id, state: "uploaded" as const, size: 0 };
    }

    async abort(id: string) {
        this.aborts.push(id);
    }

    readonly put = async (url: string, body: Blob, { signal, onProgress }: PutOptions) => {
        const partNumber = Number(new URL(url).searchParams.get("partNumber"));
        const call = { url, partNumber, body, text: "" };
        this.puts.push(call);
        call.text = await body.text();
        this.inflight++;
        this.maxInflight = Math.max(this.maxInflight, this.inflight);
        try {
            onProgress(Math.floor(body.size / 2));
            await Promise.race([
                this.gate,
                new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
            ]);
            const failure = this.putFailures.get(partNumber)?.shift();
            if (failure) {
                throw failure;
            }
            onProgress(body.size);
            return { etag: `"etag-${partNumber}"` };
        } finally {
            this.inflight--;
        }
    };

    partsSent(): number[] {
        return this.puts.map((call) => call.partNumber);
    }
}

function dependencies(service: FakeService, overrides: Partial<UploaderDependencies> = {}): UploaderDependencies {
    return {
        api: service,
        put: service.put,
        sleep: vi.fn(async () => undefined),
        waitOnline: vi.fn(async () => undefined),
        random: () => 1,
        ...overrides,
    };
}

function fileOf(text: string): File {
    return new File([text], "data.txt", { type: "text/plain", lastModified: 1 });
}

function blobSource(text: string): UploadSource {
    return { kind: "blob", blob: fileOf(text) };
}

function streamSource(chunks: string[]): UploadSource {
    const queue = chunks.map((chunk) => encoder.encode(chunk));
    return {
        kind: "stream",
        stream: new ReadableStream<Uint8Array>({
            pull(controller) {
                const next = queue.shift();
                if (next) {
                    controller.enqueue(next);
                } else {
                    controller.close();
                }
            },
        }),
    };
}

function options(source: UploadSource, size: number, extra: Record<string, unknown> = {}) {
    return {
        name: "data.txt",
        size,
        contentType: "text/plain",
        historyId: "h1",
        fingerprint: "fp",
        source,
        ...extra,
    };
}

describe("uploadToBucket", () => {
    it("sends blob slices of the session's part size in parallel and completes with every ETag", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        let release!: () => void;
        service.gate = new Promise((resolve) => (release = resolve));
        const pending = uploadToBucket(options(blobSource("abcdefghij"), 10), dependencies(service));
        await vi.waitFor(() => expect(service.puts).toHaveLength(3));
        release();
        await expect(pending).resolves.toEqual({ id: "u1" });

        expect(service.creates).toEqual([
            { name: "data.txt", size: 10, content_type: "text/plain", history_id: "h1", fingerprint: "fp" },
        ]);
        expect(service.maxInflight).toBe(3);
        expect(service.puts.map((call) => [call.partNumber, call.text])).toEqual([
            [1, "abcd"],
            [2, "efgh"],
            [3, "ij"],
        ]);
        for (const call of service.puts) {
            expect(call.body).toBeInstanceOf(Blob);
            expect(call.body).not.toBeInstanceOf(File);
        }
        expect(service.completes).toEqual([
            {
                parts: [
                    { part_number: 1, etag: '"etag-1"' },
                    { part_number: 2, etag: '"etag-2"' },
                    { part_number: 3, etag: '"etag-3"' },
                ],
            },
        ]);
        expect(service.aborts).toEqual([]);
    });

    it("never sends more than three parts at a time", async () => {
        const service = new FakeService({ partSize: 1, partCount: 12 });
        await uploadToBucket(options(blobSource("abcdefghijkl"), 12), dependencies(service));
        expect(service.maxInflight).toBeLessThanOrEqual(3);
        expect(service.partsSent().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it("reports progress that never decreases and ends at the file size", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        service.putFailures.set(2, [new UploadTransferError("reset", 0)]);
        const progress: number[] = [];
        await uploadToBucket(
            options(blobSource("abcdefghij"), 10, { onProgress: (uploaded: number) => progress.push(uploaded) }),
            dependencies(service),
        );
        expect(progress.length).toBeGreaterThan(3);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
        expect(new Set(progress).size).toBe(progress.length);
        expect(progress.at(-1)).toBe(10);
    });

    it("asks for part URLs in batches as it needs them", async () => {
        const service = new FakeService({ partSize: 1, partCount: 40, initialUrls: 2 });
        await uploadToBucket(options(blobSource("x".repeat(40)), 40), dependencies(service));
        expect(service.presigns.length).toBeGreaterThan(0);
        for (const batch of service.presigns) {
            expect(batch.length).toBeLessThanOrEqual(URL_BATCH);
        }
        const signed = new Set(service.presigns.flat());
        for (let partNumber = 3; partNumber <= 40; partNumber++) {
            expect(signed.has(partNumber)).toBe(true);
        }
        expect(signed.has(1)).toBe(false);
        expect(service.completes[0]!.parts).toHaveLength(40);
    });

    it("renews URLs that are about to expire", async () => {
        const service = new FakeService({ partSize: 1, partCount: 4, expiresIn: 600 });
        let time = 0;
        await uploadToBucket(
            options(blobSource("abcd"), 4),
            dependencies(service, {
                now: () => time,
                put: async (url, body, putOptions) => {
                    const result = await service.put(url, body, putOptions);
                    time += 600_000;
                    return result;
                },
            }),
        );
        // Parts 1 to 3 start on the session's URLs; part 4 starts after its URL's renewal time.
        expect(service.presigns).toEqual([[4]]);
    });

    it("retries failed parts with backoff, waiting for the network and using a fresh URL", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        service.putFailures.set(2, [new UploadTransferError("offline", 0), new UploadTransferError("busy", 503)]);
        const deps = dependencies(service);
        await uploadToBucket(options(blobSource("abcdefghij"), 10), deps);

        const urls = service.puts.filter((call) => call.partNumber === 2).map((call) => call.url);
        expect(urls).toHaveLength(3);
        expect(new Set(urls).size).toBe(3);
        expect(deps.sleep).toHaveBeenNthCalledWith(1, 1000, expect.any(AbortSignal));
        expect(deps.sleep).toHaveBeenNthCalledWith(2, 2000, expect.any(AbortSignal));
        expect(deps.waitOnline).toHaveBeenCalledTimes(2);
        expect(service.presigns).toEqual([[2], [2]]);
        expect(service.completes).toHaveLength(1);
    });

    it("fails when a part keeps failing, leaving the session to be resumed", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        service.putFailures.set(
            3,
            Array.from({ length: MAX_ATTEMPTS }, () => new UploadTransferError("The upload to the bucket failed.", 0)),
        );
        await expect(uploadToBucket(options(blobSource("abcdefghij"), 10), dependencies(service))).rejects.toThrow(
            "The upload to the bucket failed.",
        );
        expect(service.puts.filter((call) => call.partNumber === 3)).toHaveLength(MAX_ATTEMPTS);
        expect(service.completes).toEqual([]);
        expect(service.aborts).toEqual([]);
    });

    it("fails at once on errors a retry cannot fix", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        service.putFailures.set(1, [new UploadTransferError("The bucket refused the upload: NoSuchUpload.", 404)]);
        const deps = dependencies(service);
        await expect(uploadToBucket(options(blobSource("abcdefghij"), 10), deps)).rejects.toMatchObject({
            status: 404,
        });
        expect(service.puts.filter((call) => call.partNumber === 1)).toHaveLength(1);
        expect(deps.sleep).not.toHaveBeenCalled();
        expect(service.completes).toEqual([]);
    });

    it("sends only the parts a resumed session lacks", async () => {
        const service = new FakeService({
            partSize: 4,
            partCount: 3,
            uploaded: [{ part_number: 1, etag: '"stored-1"', size: 4 }],
        });
        const progress: number[] = [];
        await uploadToBucket(
            options(blobSource("abcdefghij"), 10, { onProgress: (uploaded: number) => progress.push(uploaded) }),
            dependencies(service),
        );
        expect(service.partsSent().sort()).toEqual([2, 3]);
        expect(progress[0]).toBe(4);
        expect(service.completes[0]!.parts[0]).toEqual({ part_number: 1, etag: '"stored-1"' });
    });

    it("aborts the session when the signal aborts during the upload", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        service.gate = new Promise(() => undefined);
        const controller = new AbortController();
        const pending = uploadToBucket(
            options(blobSource("abcdefghij"), 10, { signal: controller.signal }),
            dependencies(service),
        );
        await vi.waitFor(() => expect(service.puts.length).toBeGreaterThan(0));
        controller.abort();
        const error = await pending.catch((caught: unknown) => caught);
        expect(isAbortError(error)).toBe(true);
        expect(service.aborts).toEqual(["u1"]);
        expect(service.completes).toEqual([]);
    });

    it("does nothing when the signal was aborted before the upload", async () => {
        const service = new FakeService({ partSize: 4, partCount: 3 });
        const controller = new AbortController();
        controller.abort();
        const error = await uploadToBucket(
            options(blobSource("abcdefghij"), 10, { signal: controller.signal }),
            dependencies(service),
        ).catch((caught: unknown) => caught);
        expect(isAbortError(error)).toBe(true);
        expect(service.creates).toEqual([]);
    });

    it("retries the worker's upstream errors but not its refusals", async () => {
        const service = new FakeService({ partSize: 4, partCount: 1 });
        service.createFailures = [new UploadTransferError("Bucket unreachable", 502)];
        await uploadToBucket(options(blobSource("abc"), 3), dependencies(service));
        expect(service.creates).toHaveLength(2);

        const refused = new FakeService({ partSize: 4, partCount: 1 });
        refused.createFailures = [new UploadTransferError("Dataset storage is not configured.", 501)];
        await expect(uploadToBucket(options(blobSource("abc"), 3), dependencies(refused))).rejects.toThrow(
            "Dataset storage is not configured.",
        );
        expect(refused.creates).toHaveLength(1);
    });

    it("uploads an empty file as one empty part", async () => {
        const service = new FakeService({ partSize: 4, partCount: 1 });
        await uploadToBucket(options(blobSource(""), 0), dependencies(service));
        expect(service.puts.map((call) => call.body.size)).toEqual([0]);
        expect(service.completes).toHaveLength(1);
    });

    describe("streams", () => {
        it("reads parts in order across chunk boundaries", async () => {
            const service = new FakeService({ partSize: 4, partCount: 3 });
            await uploadToBucket(options(streamSource(["ab", "cdefg", "", "hij"]), 10), dependencies(service));
            expect(service.puts.map((call) => [call.partNumber, call.text])).toEqual([
                [1, "abcd"],
                [2, "efgh"],
                [3, "ij"],
            ]);
            expect(service.completes[0]!.parts).toHaveLength(3);
        });

        it("skips the bytes of parts a resumed session holds", async () => {
            const service = new FakeService({
                partSize: 4,
                partCount: 3,
                uploaded: [
                    { part_number: 1, etag: '"stored-1"', size: 4 },
                    { part_number: 3, etag: '"stored-3"', size: 2 },
                ],
            });
            await uploadToBucket(options(streamSource(["abcdefghij"]), 10), dependencies(service));
            expect(service.puts.map((call) => [call.partNumber, call.text])).toEqual([[2, "efgh"]]);
        });

        it("fails when the stream is shorter or longer than its size", async () => {
            const short = new FakeService({ partSize: 4, partCount: 3 });
            await expect(uploadToBucket(options(streamSource(["abcdefg"]), 10), dependencies(short))).rejects.toThrow(
                "The file ended before its stated size.",
            );
            expect(short.completes).toEqual([]);

            const long = new FakeService({ partSize: 4, partCount: 3 });
            await expect(
                uploadToBucket(options(streamSource(["abcdefghijk"]), 10), dependencies(long)),
            ).rejects.toThrow("The file is longer than its stated size.");
            expect(long.completes).toEqual([]);
        });

        it("stops reading when a part fails", async () => {
            const service = new FakeService({ partSize: 1, partCount: 8 });
            service.putFailures.set(1, [new UploadTransferError("NoSuchUpload", 404)]);
            await expect(
                uploadToBucket(options(streamSource(["abcdefgh"]), 8), dependencies(service)),
            ).rejects.toMatchObject({ status: 404 });
            expect(service.puts.length).toBeLessThan(8);
            expect(service.completes).toEqual([]);
        });
    });
});
