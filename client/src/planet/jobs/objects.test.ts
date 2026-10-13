// @vitest-environment node
import { describe, expect, it } from "vitest";

import { datamashBundle, FakeS3, testDeps, withArchive } from "./__fixtures__/setup";
import { toolArchiveKey, toolArchiveStaticPath } from "./keys";
import {
    completeMultipartUpload,
    createMultipartUpload,
    ensureToolArchive,
    multipartLayout,
    readDispatchRecord,
    readJson,
    SINGLE_PUT_LIMIT,
} from "./objects";
import { ProtocolError } from "./schemas";

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
        const record = {
            protocol: 1,
            job_id: "f2db41a1fa8ec1d3",
            attempt: 2,
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
        s3.put("jobs/f2db41a1fa8ec1d3/dispatch.json", record);
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3")).toEqual(record);
        s3.put("jobs/f2db41a1fa8ec1d3/dispatch.json", { ...record, job_id: "0123456789abcdef" });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3")).toBeNull();
        s3.put("jobs/f2db41a1fa8ec1d3/dispatch.json", {
            ...record,
            multipart: [{ ...record.multipart[0], key: "tools/x/repo.tar" }],
        });
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3")).toBeNull();
        s3.put("jobs/f2db41a1fa8ec1d3/dispatch.json", "{");
        expect(await readDispatchRecord(s3, "f2db41a1fa8ec1d3")).toBeNull();
    });
});
