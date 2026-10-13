// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { leader, LeaderFenceError, setLeaderFence } from "@/planet/db";

import { datamashBundle, FakeS3, resetDb, teardownDb, testDeps, withArchive } from "./__fixtures__/setup";
import { toolArchiveKey, toolArchiveStaticPath } from "./keys";
import {
    abortMultipartUploads,
    completeMultipartUpload,
    createMultipartUpload,
    ensureToolArchive,
    multipartLayout,
    readAttemptObjects,
    readDispatchRecord,
    readJson,
    SINGLE_PUT_LIMIT,
    writeJson,
} from "./objects";
import { ProtocolError } from "./schemas";

beforeEach(resetDb);
afterEach(async () => {
    setLeaderFence(null);
    await teardownDb();
});

const UUID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const GIB = 1024 ** 3;

describe("readJson", () => {
    it("returns null for missing objects and rejects other content than JSON", async () => {
        const s3 = new FakeS3();
        expect(await readJson(s3, "jobs/a/results.json")).toBeNull();
        s3.put("jobs/a/results.json", "<html>");
        await expect(readJson(s3, "jobs/a/results.json")).rejects.toThrow(ProtocolError);
        s3.put("jobs/a/results.json", { ok: true });
        expect(await readJson(s3, "jobs/a/results.json")).toEqual({ ok: true });
    });

    it("refuses documents over the size limit without reading them whole", async () => {
        const s3 = new FakeS3();
        s3.put("jobs/a/results.json", { text: "x".repeat(2000) });
        await expect(readJson(s3, "jobs/a/results.json", undefined, 1024)).rejects.toThrow(
            "results.json is invalid at the top level: larger than 1024 bytes",
        );
        expect(await readJson(s3, "jobs/a/results.json", undefined, 4096)).toMatchObject({ text: expect.any(String) });
    });
});

describe("bucket writes", () => {
    it("are refused once another tab leads", async () => {
        const s3 = new FakeS3();
        setLeaderFence(await leader.claimEpoch());
        await writeJson(s3, "jobs/a/a1/manifest.json", {});
        const upload = await createMultipartUpload(s3, "out", UUID, 5 * GIB);
        await leader.claimEpoch();

        await expect(writeJson(s3, "jobs/a/a1/manifest.json", { changed: true })).rejects.toThrow(LeaderFenceError);
        await expect(createMultipartUpload(s3, "out", UUID, 5 * GIB)).rejects.toThrow(LeaderFenceError);
        await expect(abortMultipartUploads(s3, [upload])).rejects.toThrow(LeaderFenceError);
        await expect(completeMultipartUpload(s3, upload, [])).rejects.toThrow(LeaderFenceError);
        expect(s3.json("jobs/a/a1/manifest.json")).toEqual({});
        expect(s3.aborted).toEqual([]);
        expect(s3.uploads.size).toBe(1);
    });
});

describe("multipart uploads", () => {
    it("lays out uniform parts with room for outputs larger than the inputs", () => {
        for (const size of [0, 5 * GIB, 100 * GIB, 2000 * GIB]) {
            const { partSize, parts } = multipartLayout(size);
            expect(partSize).toBeGreaterThanOrEqual(5 * 1024 ** 2);
            expect(partSize).toBeLessThanOrEqual(5 * GIB);
            expect(parts).toBeLessThanOrEqual(10_000);
            expect(partSize * parts).toBeGreaterThanOrEqual(Math.min(Math.max(64 * GIB, size * 8), 10_000 * 5 * GIB));
            expect(partSize * parts).toBeGreaterThan(SINGLE_PUT_LIMIT);
        }
    });

    it("completes an upload once and accepts a repeated completion of a stored object", async () => {
        const s3 = new FakeS3();
        const upload = await createMultipartUpload(s3, "out_file", UUID, 5 * GIB);
        expect(upload).toMatchObject({ output: "out_file", uuid: UUID, key: `datasets/${UUID}/data` });
        const etag = s3.uploadPartAsPod(upload.upload_id, 1, "data");
        await completeMultipartUpload(s3, upload, [{ part_number: 1, etag, size: 4 }]);
        await completeMultipartUpload(s3, upload, [{ part_number: 1, etag, size: 4 }]);
        expect(s3.completed).toEqual([upload.upload_id]);

        const lost = { ...upload, key: `datasets/${UUID}/other` };
        await expect(completeMultipartUpload(s3, lost, [{ part_number: 1, etag, size: 4 }])).rejects.toMatchObject({
            code: "NoSuchUpload",
        });
    });
});

describe("ensureToolArchive", () => {
    it("replaces an archive of another size in the bucket", async () => {
        const { bundle, tar } = await withArchive(datamashBundle());
        const deps = testDeps([bundle], {}, { [toolArchiveStaticPath(bundle.source!.repo_tar!.path)]: tar });
        const key = toolArchiveKey(bundle.id, bundle.version);
        deps.s3.objects.set(key, new Uint8Array(3));
        expect(await ensureToolArchive(deps, bundle)).toEqual({ key, sha256: bundle.source!.repo_tar!.sha256 });
        expect(deps.s3.objects.get(key)).toEqual(tar);
    });

    it("skips tools without an archive and reports archives the site lacks", async () => {
        const deps = testDeps();
        expect(await ensureToolArchive(deps, { ...datamashBundle(), source: null })).toBeNull();
        await expect(ensureToolArchive(deps, datamashBundle())).rejects.toMatchObject({ permanent: true });
    });
});

describe("readDispatchRecord", () => {
    it("ignores records that are not the job's or not well formed", async () => {
        const s3 = new FakeS3();
        const key = "jobs/f2db41a1fa8ec1d3/a2/dispatch.json";
        const record = {
            protocol: 1,
            job_id: "f2db41a1fa8ec1d3",
            attempt: 2,
            dispatch_id: "0123456789abcdef",
            kind: "tool",
            create_time: "2026-10-13T10:00:00.000000",
            walltime_seconds: 60,
            deadline_seconds: 7260,
            slots: 1,
            memory_mb: 4096,
            slot_uuids: [UUID],
            multipart: [
                { output: "o", uuid: UUID, key: `datasets/${UUID}/data`, upload_id: "u", part_size: 1, parts: 1 },
            ],
        };
        s3.put(key, record);
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toEqual(record);
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 1)).toBeNull();
        s3.put(key, { ...record, attempt: 3 });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
        s3.put(key, { ...record, job_id: "0123456789abcdef" });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
        s3.put(key, { ...record, multipart: [{ ...record.multipart[0], key: "tools/x/repo.tar" }] });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
        s3.put(key, { ...record, multipart: [{ ...record.multipart[0], uuid: "../../tools" }] });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
        s3.put(key, { ...record, slot_uuids: ["not-a-uuid"] });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
        s3.put(key, "{");
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
    });
});

describe("readAttemptObjects", () => {
    const record = (attempt: number, dispatchId?: string) => ({
        protocol: 1,
        job_id: "f2db41a1fa8ec1d3",
        attempt,
        ...(dispatchId ? { dispatch_id: dispatchId } : {}),
        kind: "tool",
        create_time: "2026-10-13T10:00:00.000000",
        walltime_seconds: 60,
        deadline_seconds: 7260,
        slots: 1,
        memory_mb: 4096,
        slot_uuids: [UUID],
        multipart: [],
    });

    it("finds an attempt's own objects", async () => {
        const s3 = new FakeS3();
        s3.put("jobs/f2db41a1fa8ec1d3/a2/dispatch.json", record(2, "0123456789abcdef"));
        const objects = await readAttemptObjects(s3, "f2db41a1fa8ec1d3", 2);
        expect(objects?.keys.results).toBe("jobs/f2db41a1fa8ec1d3/a2/results.json");
        expect(objects?.dispatch.dispatch_id).toBe("0123456789abcdef");
        expect(await readAttemptObjects(s3, "f2db41a1fa8ec1d3", 1)).toBeNull();
    });

    it("reads jobs dispatched before attempts had their own keys from the legacy layout", async () => {
        const s3 = new FakeS3();
        s3.put("jobs/f2db41a1fa8ec1d3/dispatch.json", record(1));
        const objects = await readAttemptObjects(s3, "f2db41a1fa8ec1d3", 1);
        expect(objects?.keys).toMatchObject({
            results: "jobs/f2db41a1fa8ec1d3/results.json",
            prepare: "jobs/f2db41a1fa8ec1d3/prepare.json",
        });
        expect(await readAttemptObjects(s3, "f2db41a1fa8ec1d3", 2)).toBeNull();
        // A legacy-layout record that claims a dispatch id was not written by the legacy code.
        s3.put("jobs/f2db41a1fa8ec1d3/dispatch.json", record(1, "0123456789abcdef"));
        expect(await readAttemptObjects(s3, "f2db41a1fa8ec1d3", 1)).toBeNull();
    });
});
