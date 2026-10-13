// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    currentHistoryId,
    fetchJson,
    ORIGIN,
    resetPlanet,
    teardownPlanet,
} from "@/planet/api/__tests__/contents.fixtures";
import {
    configureStorage,
    FakeS3,
    sameBytes,
    sampleBytes,
    stubUploadNetwork,
} from "@/planet/api/__tests__/uploads.fixtures";
import { register } from "@/planet/api/uploads";
import { jobs, uploads } from "@/planet/db";
import { Router } from "@/planet/sw/router";

import { type UploaderDependencies, uploadToBucket } from "../multipart";
import { MIN_PART_SIZE } from "../protocol";
import { createUploadApi, type PutFunction, UploadTransferError } from "../transport";

const MiB = 1024 * 1024;

let s3: FakeS3;
let router: Router;

beforeEach(async () => {
    await resetPlanet();
    s3 = new FakeS3();
    stubUploadNetwork(s3);
    await configureStorage();
    router = new Router();
    register(router);
});
afterEach(teardownPlanet);

/** The page side: worker calls go to the router, part PUTs to the bucket. */
function pageDependencies(failPut?: (url: URL) => UploadTransferError | undefined): UploaderDependencies {
    const put: PutFunction = async (url, body, { onProgress }) => {
        const target = new URL(url);
        const failure = failPut?.(target);
        if (failure) {
            throw failure;
        }
        const response = await s3.handle(target, { method: "PUT", body });
        if (!response.ok) {
            throw new UploadTransferError(`HTTP ${response.status}`, response.status);
        }
        onProgress(body.size);
        return { etag: response.headers.get("ETag")! };
    };
    return {
        api: createUploadApi("/api/planet/uploads", (input, init) =>
            router.handle(new Request(new URL(String(input), ORIGIN), init)),
        ),
        put,
        sleep: async () => undefined,
        waitOnline: async () => undefined,
    };
}

function fileOptions(data: Uint8Array, fingerprint: string | null = "tus-br-big.bin--x-1-h") {
    return {
        name: "big.bin",
        size: data.byteLength,
        contentType: null,
        historyId: "h",
        fingerprint,
        source: { kind: "blob" as const, blob: new Blob([data.slice()]) },
    };
}

describe("page to bucket uploads", () => {
    it("uploads a multipart file through the worker and imports it with /api/tools/fetch", async () => {
        const data = sampleBytes(2 * MIN_PART_SIZE + 3 * MiB, 3);
        const { id } = await uploadToBucket(fileOptions(data), pageDependencies());

        expect(sameBytes(s3.objects.get(`uploads/${id}`), data)).toBe(true);
        const partPuts = s3.requestsFor("PUT").filter((request) => request.query.has("partNumber"));
        expect(partPuts.map((request) => request.presigned)).toEqual([true, true, true]);
        expect((await uploads.get(id))?.state).toBe("uploaded");

        const historyId = await currentHistoryId();
        const response = await fetchJson(router, "POST", "/api/tools/fetch", {
            history_id: historyId,
            targets: [{ destination: { type: "hdas" }, elements: [{ src: "files", name: "big.bin", ext: "auto" }] }],
            "files_0|file_data": { session_id: id, name: "big.bin" },
        });
        const job = await jobs.get(response.jobs[0].id);
        expect(job?.request).toMatchObject({ targets: [{ elements: [{ src: "planet", file: id }] }] });
    });

    it("sends a small file with one presigned PUT", async () => {
        const data = sampleBytes(1000);
        const { id } = await uploadToBucket(fileOptions(data, null), pageDependencies());
        expect(sameBytes(s3.objects.get(`uploads/${id}`), data)).toBe(true);
        expect(s3.requestsFor("POST")).toEqual([]);
    });

    it("resumes a failed upload with the parts the bucket already holds", async () => {
        const data = sampleBytes(2 * MIN_PART_SIZE + MiB, 9);
        const refuseLastPart = (url: URL) =>
            url.searchParams.get("partNumber") === "3" ? new UploadTransferError("NoSuchKey", 404) : undefined;
        await expect(uploadToBucket(fileOptions(data), pageDependencies(refuseLastPart))).rejects.toMatchObject({
            status: 404,
        });
        const firstRun = s3.requests.length;

        const { id } = await uploadToBucket(fileOptions(data), pageDependencies());
        const resumedPuts = s3.requests
            .slice(firstRun)
            .filter((request) => request.method === "PUT" && request.query.has("partNumber"));
        expect(resumedPuts.map((request) => request.query.get("partNumber"))).toEqual(["3"]);
        expect(sameBytes(s3.objects.get(`uploads/${id}`), data)).toBe(true);
    });

    it("aborts the multipart upload in the bucket when the page aborts", async () => {
        const data = sampleBytes(2 * MIN_PART_SIZE, 1);
        const controller = new AbortController();
        const dependencies = pageDependencies((url) => {
            if (url.searchParams.get("partNumber") === "2") {
                controller.abort();
            }
            return undefined;
        });
        await expect(
            uploadToBucket({ ...fileOptions(data), signal: controller.signal }, dependencies),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(s3.uploads.size).toBe(0);
        const [record] = await uploads.listByState("aborted");
        expect(record?.name).toBe("big.bin");
    });
});
