// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, hdas, histories, jobs, outbox, settings, uploads } from "@/planet/db";
import { Router } from "@/planet/sw/router";
import { MIN_PART_SIZE, partLayout, type UploadSession } from "@/planet/upload/protocol";

import { DATA_FETCH_TOOL_ID, INITIAL_PART_URLS, PART_URL_SECONDS, register } from "../uploads";
import {
    captureEvents,
    currentHistoryId,
    fetchJson,
    flushEvents,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";
import { configureStorage, FakeS3, PREFIX, sameBytes, sampleBytes, stubUploadNetwork } from "./uploads.fixtures";

const MiB = 1024 * 1024;

let s3: FakeS3;

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

beforeEach(async () => {
    await resetPlanet();
    s3 = new FakeS3();
    stubUploadNetwork(s3);
    await configureStorage();
});
afterEach(teardownPlanet);

function createBody(overrides: Record<string, unknown> = {}) {
    return {
        name: "reads.fastq",
        size: 100,
        content_type: "text/plain",
        history_id: "h1",
        fingerprint: null,
        ...overrides,
    };
}

async function putUrl(url: string, data: Uint8Array): Promise<string> {
    const response = await s3.handle(new URL(url), { method: "PUT", body: data.slice() });
    expect(response.status).toBe(200);
    return response.headers.get("ETag")!;
}

/** Creates a session and stores every part through its presigned URLs. Returns the session and the ETags. */
async function uploadFile(router: Router, data: Uint8Array, overrides: Record<string, unknown> = {}) {
    const session = await fetchJson<UploadSession>(
        router,
        "POST",
        "/api/planet/uploads",
        createBody({ size: data.byteLength, ...overrides }),
    );
    const urls = new Map(session.parts.map((part) => [part.part_number, part.url]));
    const etags = [];
    for (let partNumber = 1; partNumber <= session.part_count; partNumber++) {
        const start = (partNumber - 1) * session.part_size;
        etags.push({
            part_number: partNumber,
            etag: await putUrl(urls.get(partNumber)!, data.subarray(start, start + session.part_size)),
        });
    }
    return { session, etags };
}

async function completedUpload(router: Router, data: Uint8Array, overrides: Record<string, unknown> = {}) {
    const { session, etags } = await uploadFile(router, data, overrides);
    await fetchJson(router, "POST", `/api/planet/uploads/${session.id}/complete`, { parts: etags });
    return session.id;
}

describe("part layout", () => {
    it("uses 8 MiB parts and grows them to stay within 10,000 parts", () => {
        expect(partLayout(0)).toEqual({ partSize: MIN_PART_SIZE, partCount: 1, multipart: false });
        expect(partLayout(MIN_PART_SIZE)).toEqual({ partSize: MIN_PART_SIZE, partCount: 1, multipart: false });
        expect(partLayout(MIN_PART_SIZE + 1)).toEqual({ partSize: MIN_PART_SIZE, partCount: 2, multipart: true });
        const large = partLayout(200 * 1024 * MiB);
        expect(large.partSize % MiB).toBe(0);
        expect(large.partCount).toBeLessThanOrEqual(10_000);
        expect(large.partSize * large.partCount).toBeGreaterThanOrEqual(200 * 1024 * MiB);
    });
});

describe("POST /api/planet/uploads", () => {
    it("signs one PUT of the object for a file that fits in one part", async () => {
        const router = makeRouter();
        const session = await fetchJson<UploadSession>(router, "POST", "/api/planet/uploads", createBody());
        expect(session).toMatchObject({
            mode: "single",
            part_size: MIN_PART_SIZE,
            part_count: 1,
            expires_in: PART_URL_SECONDS,
            uploaded: [],
        });
        expect(session.parts).toHaveLength(1);
        const url = new URL(session.parts[0]!.url);
        expect(url.pathname).toBe(`/bucket/${PREFIX}/uploads/${session.id}`);
        expect(url.searchParams.get("X-Amz-Expires")).toBe(String(PART_URL_SECONDS));
        expect(url.searchParams.has("uploadId")).toBe(false);
        expect(s3.requestsFor("POST")).toHaveLength(0);

        const record = await uploads.get(session.id);
        expect(record).toMatchObject({
            name: "reads.fastq",
            size: 100,
            key: `uploads/${session.id}`,
            upload_id: null,
            state: "pending",
            history_id: "h1",
            content_type: "text/plain",
        });
    });

    it("starts a multipart upload and signs the first parts for a larger file", async () => {
        const router = makeRouter();
        const size = 20 * MiB;
        const session = await fetchJson<UploadSession>(router, "POST", "/api/planet/uploads", createBody({ size }));
        expect(session).toMatchObject({ mode: "multipart", part_size: 8 * MiB, part_count: 3 });
        expect(session.parts.map((part) => part.part_number)).toEqual([1, 2, 3]);
        const record = await uploads.get(session.id);
        expect(record?.upload_id).toBeTruthy();
        for (const part of session.parts) {
            const url = new URL(part.url);
            expect(url.searchParams.get("partNumber")).toBe(String(part.part_number));
            expect(url.searchParams.get("uploadId")).toBe(record!.upload_id);
            expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
        }
        expect(s3.requestsFor("POST", `uploads/${session.id}`)).toHaveLength(1);
    });

    it("signs at most the first parts of a large upload", async () => {
        const router = makeRouter();
        const session = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: 1024 * MiB }),
        );
        expect(session.part_count).toBe(128);
        expect(session.parts).toHaveLength(INITIAL_PART_URLS);
    });

    it("rejects invalid sizes, names and bodies sent without a JSON content type", async () => {
        const router = makeRouter();
        await fetchJson(router, "POST", "/api/planet/uploads", createBody({ size: -1 }), 400);
        await fetchJson(router, "POST", "/api/planet/uploads", createBody({ size: 1.5 }), 400);
        await fetchJson(router, "POST", "/api/planet/uploads", createBody({ size: 6 * 1024 ** 4 }), 400);
        await fetchJson(router, "POST", "/api/planet/uploads", createBody({ name: "" }), 400);
        const response = await send(router, "POST", "/api/planet/uploads", undefined, { "Content-Type": "text/plain" });
        expect(response.status).toBe(400);
    });

    it("explains that storage must be configured first", async () => {
        await settings.update({ storage: { endpoint: "", secret_access_key: null } });
        const error = await fetchJson(makeRouter(), "POST", "/api/planet/uploads", createBody(), 501);
        expect(error.err_msg).toContain("Dataset storage is not configured");
    });

    it("resumes an unfinished upload of the same file with the parts the bucket holds", async () => {
        const router = makeRouter();
        const data = sampleBytes(20 * MiB);
        const fingerprint = "tus-br-reads.fastq-text/plain-20971520-1700000000000-h1";
        const first = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: data.byteLength, fingerprint }),
        );
        const etag = await putUrl(first.parts[0]!.url, data.subarray(0, 8 * MiB));
        // A truncated part 2 (as WebKit's empty-body bug would leave) is sent again.
        await putUrl(first.parts[1]!.url, data.subarray(8 * MiB, 9 * MiB));

        const resumed = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: data.byteLength, fingerprint }),
        );
        expect(resumed.id).toBe(first.id);
        expect(resumed.uploaded).toEqual([{ part_number: 1, etag, size: 8 * MiB }]);
        expect(resumed.parts.map((part) => part.part_number)).toEqual([2, 3]);
        expect((await uploads.get(first.id))?.state).toBe("uploading");

        const other = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: data.byteLength, fingerprint, history_id: "h2" }),
        );
        expect(other.id).not.toBe(first.id);
    });

    it("starts over when the unfinished upload no longer exists in the bucket", async () => {
        const router = makeRouter();
        const fingerprint = "tus-br-a-b-20971520-1-h1";
        const first = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: 20 * MiB, fingerprint }),
        );
        s3.uploads.clear();
        const second = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: 20 * MiB, fingerprint }),
        );
        expect(second.id).not.toBe(first.id);
        expect(second.uploaded).toEqual([]);
        expect((await uploads.get(first.id))?.state).toBe("aborted");
    });

    it("never resumes a finished upload", async () => {
        const router = makeRouter();
        const fingerprint = "tus-br-small";
        const id = await completedUpload(router, sampleBytes(100), { fingerprint });
        const again = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ fingerprint }),
        );
        expect(again.id).not.toBe(id);
    });
});

describe("POST /api/planet/uploads/{id}/parts", () => {
    it("signs fresh URLs for the requested parts and marks the session uploading", async () => {
        const router = makeRouter();
        const session = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: 1024 * MiB }),
        );
        const renewed = await fetchJson(router, "POST", `/api/planet/uploads/${session.id}/parts`, {
            part_numbers: [17, 18, 128, 17],
        });
        expect(renewed.expires_in).toBe(PART_URL_SECONDS);
        expect(renewed.parts.map((part: { part_number: number }) => part.part_number)).toEqual([17, 18, 128]);
        expect(new URL(renewed.parts[2].url).searchParams.get("partNumber")).toBe("128");
        expect((await uploads.get(session.id))?.state).toBe("uploading");
    });

    it("rejects part numbers outside the upload and requests for closed sessions", async () => {
        const router = makeRouter();
        const session = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: 20 * MiB }),
        );
        const path = `/api/planet/uploads/${session.id}/parts`;
        await fetchJson(router, "POST", path, { part_numbers: [4] }, 400);
        await fetchJson(router, "POST", path, { part_numbers: [] }, 400);
        await fetchJson(router, "POST", path, { part_numbers: Array.from({ length: 101 }, () => 1) }, 400);
        await fetchJson(router, "POST", "/api/planet/uploads/0123456789abcdef/parts", { part_numbers: [1] }, 404);
        await fetchJson(router, "DELETE", `/api/planet/uploads/${session.id}`, undefined, 204);
        await fetchJson(router, "POST", path, { part_numbers: [1] }, 409);
    });
});

describe("POST /api/planet/uploads/{id}/complete", () => {
    it("completes a multipart upload and records its parts", async () => {
        const router = makeRouter();
        const data = sampleBytes(20 * MiB, 7);
        const { session, etags } = await uploadFile(router, data);
        const done = await fetchJson(router, "POST", `/api/planet/uploads/${session.id}/complete`, {
            parts: [...etags].reverse(),
        });
        expect(done).toEqual({ id: session.id, state: "uploaded", size: data.byteLength });
        expect(sameBytes(s3.objects.get(`uploads/${session.id}`), data)).toBe(true);
        const record = await uploads.get(session.id);
        expect(record?.state).toBe("uploaded");
        expect(record?.parts.map((part) => [part.part_number, part.size])).toEqual([
            [1, 8 * MiB],
            [2, 8 * MiB],
            [3, 4 * MiB],
        ]);
        // A repeated completion (its first response lost) succeeds again.
        const again = await fetchJson(router, "POST", `/api/planet/uploads/${session.id}/complete`, { parts: etags });
        expect(again.state).toBe("uploaded");
    });

    it("checks the size of a file sent with one PUT", async () => {
        const router = makeRouter();
        const data = sampleBytes(100);
        const { session, etags } = await uploadFile(router, data);
        await fetchJson(router, "POST", `/api/planet/uploads/${session.id}/complete`, { parts: etags });
        expect((await uploads.get(session.id))?.state).toBe("uploaded");
        expect(s3.requestsFor("HEAD", `uploads/${session.id}`).length).toBeGreaterThan(0);
    });

    it("fails an upload whose object has the wrong size and removes the object", async () => {
        const router = makeRouter();
        const session = await fetchJson<UploadSession>(
            router,
            "POST",
            "/api/planet/uploads",
            createBody({ size: 100 }),
        );
        const etag = await putUrl(session.parts[0]!.url, new Uint8Array(0));
        const error = await fetchJson(
            router,
            "POST",
            `/api/planet/uploads/${session.id}/complete`,
            { parts: [{ part_number: 1, etag }] },
            400,
        );
        expect(error.err_msg).toContain("holds 0 bytes");
        expect((await uploads.get(session.id))?.state).toBe("failed");
        expect(s3.objects.has(`uploads/${session.id}`)).toBe(false);
    });

    it("rejects incomplete part lists and parts the bucket refuses", async () => {
        const router = makeRouter();
        const { session, etags } = await uploadFile(router, sampleBytes(20 * MiB));
        const path = `/api/planet/uploads/${session.id}/complete`;
        await fetchJson(router, "POST", path, { parts: etags.slice(0, 2) }, 400);
        await fetchJson(router, "POST", path, { parts: [etags[0], etags[0], etags[2]] }, 400);
        await fetchJson(router, "POST", path, { parts: [etags[0], etags[1], { part_number: 3, etag: "" }] }, 400);
        expect((await uploads.get(session.id))?.state).toBe("pending");
        const error = await fetchJson(
            router,
            "POST",
            path,
            { parts: [etags[0], etags[1], { part_number: 3, etag: '"wrong"' }] },
            400,
        );
        expect(error.err_msg).toContain("InvalidPart");
        expect((await uploads.get(session.id))?.state).toBe("failed");
        expect(s3.uploads.size).toBe(0);
    });
});

describe("DELETE /api/planet/uploads/{id}", () => {
    it("aborts a multipart upload", async () => {
        const router = makeRouter();
        const { session } = await uploadFile(router, sampleBytes(20 * MiB));
        expect(s3.uploads.size).toBe(1);
        await fetchJson(router, "DELETE", `/api/planet/uploads/${session.id}`, undefined, 204);
        expect(s3.uploads.size).toBe(0);
        expect((await uploads.get(session.id))?.state).toBe("aborted");
        await fetchJson(router, "DELETE", `/api/planet/uploads/${session.id}`, undefined, 204);
    });

    it("deletes the object of a finished upload", async () => {
        const router = makeRouter();
        const id = await completedUpload(router, sampleBytes(100));
        await fetchJson(router, "DELETE", `/api/planet/uploads/${id}`, undefined, 204);
        expect(s3.objects.has(`uploads/${id}`)).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------------------

/** A fetch request for one target. */
function fetchBody(historyId: string, target: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { history_id: historyId, targets: [target], auto_decompress: true, ...extra };
}

function fileElement(overrides: Record<string, unknown> = {}) {
    return {
        src: "files",
        dbkey: "?",
        ext: "auto",
        name: "reads.fastq",
        space_to_tab: false,
        to_posix_lines: true,
        auto_decompress: true,
        deferred: false,
        ...overrides,
    };
}

describe("POST /api/tools/fetch", () => {
    it("creates an upload job, queued datasets and a dispatch entry for uploaded files", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const id = await completedUpload(router, sampleBytes(100));
        const captured = captureEvents();

        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                { destination: { type: "hdas" }, elements: [fileElement()], auto_decompress: true },
                { "files_0|file_data": { session_id: id, name: "reads.fastq" } },
            ),
        );
        await flushEvents();
        captured.stop();

        expect(response.jobs).toHaveLength(1);
        const jobId = response.jobs[0].id;
        expect(response.jobs[0]).toMatchObject({
            model_class: "Job",
            state: "new",
            tool_id: DATA_FETCH_TOOL_ID,
            tool_version: "0.1.0",
            history_id: historyId,
            exit_code: null,
        });
        expect(response.output_collections).toEqual([]);
        expect(response.implicit_collections).toEqual([]);
        expect(response.outputs).toHaveLength(1);
        const output = response.outputs[0];
        expect(output).toMatchObject({
            model_class: "HistoryDatasetAssociation",
            output_name: "output0",
            hid: 1,
            name: "reads.fastq",
            state: "queued",
            file_ext: "auto",
            genome_build: "?",
            history_id: historyId,
            history_content_type: "dataset",
            hda_ldda: "hda",
        });

        const job = await jobs.get(jobId);
        expect(job?.outputs).toEqual([{ name: "output0", src: "hda", id: output.id }]);
        expect(job?.request).toEqual({
            targets: [
                {
                    destination: { type: "hdas" },
                    auto_decompress: true,
                    elements: [
                        {
                            src: "planet",
                            file: id,
                            dbkey: "?",
                            ext: "auto",
                            name: "reads.fastq",
                            space_to_tab: false,
                            to_posix_lines: true,
                            auto_decompress: true,
                            deferred: false,
                            hashes: [],
                            in_place: false,
                            purge_source: true,
                            object_id: output.id,
                        },
                    ],
                },
            ],
            auto_decompress: true,
            check_content: true,
        });
        expect(job?.params).toEqual({
            request_version: "1",
            request_json: JSON.stringify(job?.request),
            file_count: "1",
        });
        const hda = await hdas.getWithDataset(output.id);
        expect(hda?.hda.creating_job_id).toBe(jobId);
        expect(hda?.dataset).toMatchObject({ state: "queued", job_id: jobId });
        expect(await outbox.listForJob(jobId)).toMatchObject([{ kind: "dispatch", job_id: jobId }]);
        expect(captured.events).toEqual(
            expect.arrayContaining([
                { type: "job-created", jobId },
                { type: "outbox-changed" },
                { type: "history-changed", historyId },
            ]),
        );
    });

    it("names unnamed files after the uploaded file", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const id = await completedUpload(router, sampleBytes(100), { name: "local.bed" });
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                { destination: { type: "hdas" }, elements: [fileElement({ name: null })] },
                { "files_0|file_data": { session_id: id } },
            ),
        );
        expect(response.outputs[0].name).toBe("local.bed");
        const job = await jobs.get(response.jobs[0].id);
        expect((job?.request as { targets: { elements: { name: string }[] }[] }).targets[0]!.elements[0]!.name).toBe(
            "local.bed",
        );
    });

    it("reads pasted text from its upload when Galaxy's client sent it through the upload path", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const id = await completedUpload(router, new TextEncoder().encode(">seq\nACGT\n"), { name: "New File" });
        const pasted = { src: "pasted", paste_content: ">seq\nACGT\n", name: null, ext: "fasta", dbkey: "hg38" };
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                { destination: { type: "hdas" }, elements: [pasted] },
                { "files_0|file_data": { session_id: id, name: "New File" } },
            ),
        );
        const job = await jobs.get(response.jobs[0].id);
        const element = (job?.request as { targets: { elements: Record<string, unknown>[] }[] }).targets[0]!
            .elements[0]!;
        expect(element).toMatchObject({ src: "planet", file: id, name: "Pasted Entry", ext: "fasta", dbkey: "hg38" });
        expect(element.paste_content).toBeUndefined();
        expect(response.outputs[0]).toMatchObject({ name: "Pasted Entry", file_ext: "fasta", genome_build: "hg38" });
        expect((await histories.get(historyId))?.genome_build).toBe("hg38");
    });

    it("keeps pasted text inline next to uploaded files", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const id = await completedUpload(router, sampleBytes(100));
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                {
                    destination: { type: "hdas" },
                    elements: [{ src: "pasted", paste_content: "a b\n", name: "notes" }, fileElement()],
                },
                { "files_0|file_data": { session_id: id, name: "reads.fastq" } },
            ),
        );
        const job = await jobs.get(response.jobs[0].id);
        const elements = (job?.request as { targets: { elements: Record<string, unknown>[] }[] }).targets[0]!.elements;
        expect(elements[0]).toMatchObject({ src: "pasted", paste_content: "a b\n", purge_source: false });
        expect(elements[1]).toMatchObject({ src: "planet", file: id });
        expect(response.outputs.map((output: { name: string; hid: number }) => [output.name, output.hid])).toEqual([
            ["notes", 1],
            ["reads.fastq", 2],
        ]);
    });

    it("passes URLs through for the upload pod and names datasets after them", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const url = "https://example.org/data/sample.bed?x=1";
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(historyId, {
                destination: { type: "hdas" },
                elements: [
                    { src: "url", url: "https://example.org/data/peaks.bed", ext: "bed", dbkey: "mm10" },
                    { src: "url", url, name: "named" },
                ],
            }),
        );
        const job = await jobs.get(response.jobs[0].id);
        const elements = (job?.request as { targets: { elements: Record<string, unknown>[] }[] }).targets[0]!.elements;
        expect(elements[0]).toMatchObject({
            src: "url",
            url: "https://example.org/data/peaks.bed",
            in_place: false,
            purge_source: false,
        });
        expect(
            response.outputs.map((output: Record<string, unknown>) => [
                output.name,
                output.file_ext,
                output.genome_build,
            ]),
        ).toEqual([
            ["peaks.bed", "bed", "mm10"],
            ["named", "auto", "?"],
        ]);
        expect(job?.params.file_count).toBe("0");
    });

    it("passes the conversion options through to data_fetch", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const id = await completedUpload(router, sampleBytes(100));
        const element = fileElement({ space_to_tab: true, to_posix_lines: false, auto_decompress: false });
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                { destination: { type: "hdas" }, elements: [element], auto_decompress: false },
                { "files_0|file_data": { session_id: id, name: "reads.fastq" }, to_posix_lines: true },
            ),
        );
        const request = (await jobs.get(response.jobs[0].id))?.request as Record<string, unknown> & {
            targets: Record<string, unknown>[];
        };
        expect(request).toMatchObject({ auto_decompress: true, to_posix_lines: true });
        expect(request.targets[0]).toMatchObject({ auto_decompress: false });
        expect((request.targets[0]!.elements as Record<string, unknown>[])[0]).toMatchObject({
            space_to_tab: true,
            to_posix_lines: false,
            auto_decompress: false,
        });
    });

    it("creates a list collection that the upload pod populates", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const first = await completedUpload(router, sampleBytes(100, 1), { name: "b.txt" });
        const second = await completedUpload(router, sampleBytes(100, 2), { name: "a.txt" });
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                {
                    destination: { type: "hdca" },
                    collection_type: "list",
                    name: "My list",
                    auto_decompress: false,
                    elements: [fileElement({ name: "b.txt" }), fileElement({ name: "a.txt" })],
                    tags: ["#sample"],
                },
                {
                    "files_0|file_data": { session_id: first, name: "b.txt" },
                    "files_1|file_data": { session_id: second, name: "a.txt" },
                },
            ),
        );
        expect(response.outputs).toEqual([]);
        expect(response.output_collections).toHaveLength(1);
        const output = response.output_collections[0];
        expect(output).toMatchObject({
            model_class: "HistoryDatasetCollectionAssociation",
            output_name: "output0",
            name: "My list",
            collection_type: "list",
            populated_state: "new",
            hid: 1,
            tags: ["name:sample"],
        });
        const job = await jobs.get(response.jobs[0].id);
        expect(job?.output_collections).toEqual([{ name: "output0", src: "hdca", id: output.id }]);
        expect(job?.outputs).toEqual([]);
        const hdca = await collections.getHdcaWithCollection(output.id);
        expect(hdca?.hdca).toMatchObject({ job_source_id: job?.id, job_source_type: "Job" });
        expect(hdca?.collection).toMatchObject({ populated_state: "new", element_count: null });
        const target = (job?.request as { targets: Record<string, unknown>[] }).targets[0]!;
        expect(target.destination).toEqual({ type: "hdca" });
        expect((target.elements as Record<string, unknown>[]).map((element) => element.file)).toEqual([first, second]);
        expect(await hdas.listForJob(job!.id)).toEqual([]);
    });

    it("assigns uploads to paired elements depth first", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const ids = [];
        for (const name of ["s1_1.fq", "s1_2.fq", "s2_1.fq", "s2_2.fq"]) {
            ids.push(await completedUpload(router, sampleBytes(100), { name }));
        }
        const pair = (name: string) => ({
            name,
            elements: [fileElement({ name: "forward", ext: "fasta" }), fileElement({ name: "reverse" })],
            auto_decompress: false,
            dbkey: "?",
            ext: "auto",
        });
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                {
                    destination: { type: "hdca" },
                    collection_type: "list:paired",
                    name: "pairs",
                    elements: [pair("s1"), pair("s2")],
                },
                Object.fromEntries(ids.map((id, index) => [`files_${index}|file_data`, { session_id: id }])),
            ),
        );
        expect(response.output_collections[0]).toMatchObject({ collection_type: "list:paired", name: "pairs" });
        const job = await jobs.get(response.jobs[0].id);
        const pairs = (job?.request as { targets: { elements: { elements: Record<string, unknown>[] }[] }[] })
            .targets[0]!.elements;
        expect(pairs.flatMap((nested) => nested.elements.map((element) => [element.name, element.file]))).toEqual([
            ["forward", ids[0]],
            ["reverse", ids[1]],
            ["forward", ids[2]],
            ["reverse", ids[3]],
        ]);
    });

    it("reads the files of a composite dataset from their uploads", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const id = await completedUpload(router, sampleBytes(100), { name: "sequences.txt" });
        const composite = {
            src: "composite",
            dbkey: "?",
            ext: "txt",
            auto_decompress: false,
            composite: {
                elements: [
                    fileElement({ name: "sequences.txt" }),
                    { src: "pasted", paste_content: "settings\n", name: null },
                ],
            },
        };
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(
                historyId,
                { destination: { type: "hdas" }, elements: [composite] },
                { "files_0|file_data": { session_id: id, name: "sequences.txt" } },
            ),
        );
        expect(response.outputs.map((output: Record<string, unknown>) => [output.name, output.file_ext])).toEqual([
            ["Composite Dataset", "txt"],
        ]);
        const job = await jobs.get(response.jobs[0].id);
        const element = (job?.request as { targets: { elements: Record<string, unknown>[] }[] }).targets[0]!
            .elements[0]!;
        expect(element).toMatchObject({ src: "composite", object_id: response.outputs[0].id, purge_source: false });
        expect((element.composite as { elements: Record<string, unknown>[] }).elements).toMatchObject([
            { src: "planet", file: id, name: "sequences.txt" },
            { src: "pasted", paste_content: "settings\n" },
        ]);
    });

    it("applies Galaxy's request shorthands", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const response = await fetchJson(router, "POST", "/api/tools/fetch", {
            history_id: historyId,
            targets: [
                {
                    destination: { type: "hdas" },
                    items: [
                        { src: "url", url: "https://example.org/a.txt", MD5: "abc", "sha-1": "def", "SHA-256": null },
                    ],
                },
            ],
        });
        const job = await jobs.get(response.jobs[0].id);
        const target = (job?.request as { targets: Record<string, unknown>[] }).targets[0]!;
        expect(target.items).toBeUndefined();
        expect((target.elements as Record<string, unknown>[])[0]).toMatchObject({
            hashes: [
                { hash_function: "MD5", hash_value: "abc" },
                { hash_function: "SHA-1", hash_value: "def" },
            ],
            "SHA-256": null,
        });
    });

    it("pre-creates no datasets for elements derived from an archive", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const response = await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(historyId, {
                destination: { type: "hdas" },
                elements_from: "archive",
                src: "url",
                url: "https://example.org/files.zip",
            }),
        );
        expect(response.outputs).toEqual([]);
        expect(response.jobs).toHaveLength(1);
    });

    it("rejects requests Planet cannot run", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const url = (overrides: Record<string, unknown>) =>
            fetchBody(historyId, {
                destination: { type: "hdas" },
                elements: [{ src: "url", url: "https://example.org/a.txt", ...overrides }],
            });
        const cases: [unknown, number, string][] = [
            [url({ deferred: true }), 400, "cannot defer"],
            [{ ...url({}), deferred: true }, 400, "cannot defer"],
            [url({ url: "file:///etc/passwd" }), 403, "filesystem paths"],
            [url({ url: "gopher://example.org/a" }), 400, "Invalid URL"],
            [url({ ext: "nonsense" }), 400, "Requested extension 'nonsense' unknown"],
            [url({ paste_content: "x" }), 400, "paste_content"],
            [url({ src: "path", path: "/data/a.txt", url: undefined }), 403, "filesystem paths"],
            [url({ src: "ftp_import", ftp_path: "a.txt", url: undefined }), 403, "FTP"],
            [url({ src: "pasted", url: undefined }), 400, "requires paste_content"],
            [fetchBody(historyId, { destination: { type: "library", name: "lib" }, elements: [] }), 403, "libraries"],
            [
                fetchBody(historyId, { destination: { type: "hdca" }, collection_type: "lists", elements: [] }),
                400,
                "Invalid collection type",
            ],
            [fetchBody(historyId, { destination: { type: "hdca" }, elements: [] }), 400, "collection_type"],
            [fetchBody(historyId, { destination: { type: "hdas" }, elements: [{ name: "x" }] }), 400, "needs a src"],
            [{ targets: [] }, 400, "history_id"],
            [{ ...url({}), "files_0|file_data": "abc" }, 400, "session_id"],
            [{ history_id: historyId, targets: [] }, 400, "targets"],
            [
                fetchBody(historyId, { destination: { type: "hdas" }, elements: [fileElement()] }),
                400,
                "Failed to find uploaded file",
            ],
        ];
        for (const [body, status, message] of cases) {
            const error = await fetchJson(router, "POST", "/api/tools/fetch", body, status);
            expect(error.err_msg).toContain(message);
        }
        expect(await jobs.listForHistory(historyId)).toEqual([]);
        expect((await histories.get(historyId))?.hid_counter).toBe(1);
    });

    it("rejects unknown and unfinished upload sessions without creating anything", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const pending = await fetchJson<UploadSession>(router, "POST", "/api/planet/uploads", createBody());
        const body = (sessionId: string) =>
            fetchBody(
                historyId,
                { destination: { type: "hdas" }, elements: [fileElement()] },
                { "files_0|file_data": { session_id: sessionId } },
            );
        const missing = await fetchJson(router, "POST", "/api/tools/fetch", body("0123456789abcdef"), 400);
        expect(missing.err_msg).toContain("was not found");
        const unfinished = await fetchJson(router, "POST", "/api/tools/fetch", body(pending.id), 400);
        expect(unfinished.err_msg).toContain("is pending");
        expect(await jobs.listForHistory(historyId)).toEqual([]);
        expect((await histories.get(historyId))?.hid_counter).toBe(1);
    });

    it("refuses archived histories", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        await histories.update(historyId, { archived: true });
        await fetchJson(
            router,
            "POST",
            "/api/tools/fetch",
            fetchBody(historyId, { destination: { type: "hdas" }, elements: [{ src: "url", url: "https://a.org/b" }] }),
            403,
        );
        expect(await jobs.listForHistory(historyId)).toEqual([]);
    });
});
