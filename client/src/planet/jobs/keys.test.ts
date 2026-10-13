import { describe, expect, it } from "vitest";

import { MAX_PRESIGN_EXPIRES_SECONDS } from "@/planet/s3";

import {
    datasetObjectKeys,
    DEADLINE_MARGIN_SECONDS,
    extraObjectKey,
    jobObjectKeys,
    jobTimeLimits,
    legacyJobObjectKeys,
    MAX_DEADLINE_SECONDS,
    metadataFileKey,
    toolArchiveKey,
    toolArchiveStaticPath,
} from "./keys";

const UUID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

describe("bucket keys", () => {
    it("lays out the objects of each attempt of a job", () => {
        expect(jobObjectKeys("f2db41a1fa8ec1d3", 2)).toEqual({
            manifest: "jobs/f2db41a1fa8ec1d3/a2/manifest.json",
            prepare: "jobs/f2db41a1fa8ec1d3/a2/prepare.json",
            results: "jobs/f2db41a1fa8ec1d3/a2/results.json",
            stdout: "jobs/f2db41a1fa8ec1d3/a2/stdout",
            stderr: "jobs/f2db41a1fa8ec1d3/a2/stderr",
            dispatch: "jobs/f2db41a1fa8ec1d3/a2/dispatch.json",
        });
        expect(legacyJobObjectKeys("f2db41a1fa8ec1d3")).toMatchObject({
            results: "jobs/f2db41a1fa8ec1d3/results.json",
            dispatch: "jobs/f2db41a1fa8ec1d3/dispatch.json",
        });
        expect(() => jobObjectKeys("../other", 1)).toThrow(RangeError);
        expect(() => jobObjectKeys("f2db41a1fa8ec1d3", 0)).toThrow(RangeError);
        expect(() => jobObjectKeys("f2db41a1fa8ec1d3", 1.5)).toThrow(RangeError);
    });

    it("lays out a dataset's objects", () => {
        expect(datasetObjectKeys(UUID)).toEqual({
            data: `datasets/${UUID}/data`,
            meta: `datasets/${UUID}/meta.json`,
            extra: `datasets/${UUID}/extra.tar`,
            extraIndex: `datasets/${UUID}/extra.json`,
            prefix: `datasets/${UUID}/`,
        });
        expect(metadataFileKey(UUID, 3)).toBe(`datasets/${UUID}/meta/3`);
        expect(extraObjectKey(UUID, 0)).toBe(`datasets/${UUID}/extra/0`);
        expect(() => datasetObjectKeys("not-a-uuid")).toThrow(RangeError);
    });

    it("places tool archives where the bundle generator does", () => {
        const id = "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.3.7+galaxy0";
        expect(toolArchiveKey(id, "1.3.7+galaxy0")).toBe(
            "tools/toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.3.7+galaxy0/1.3.7+galaxy0/repo.tar",
        );
        expect(toolArchiveKey("cat1", "1.0.0")).toBe("tools/cat1/1.0.0/repo.tar");
        expect(() => toolArchiveKey("../../datasets", "1")).toThrow(RangeError);
        expect(() => toolArchiveKey("cat1", "1 0")).toThrow(RangeError);
    });

    it("encodes every segment of a tool archive's site path", () => {
        expect(toolArchiveStaticPath("tools/a/fastp/1.3.7+galaxy0/1.3.7+galaxy0/repo.tar")).toBe(
            "/static/planet/toolrepos/tools/a/fastp/1.3.7%2Bgalaxy0/1.3.7%2Bgalaxy0/repo.tar",
        );
        expect(() => toolArchiveStaticPath("tools/../../index.html")).toThrow(RangeError);
    });
});

describe("jobTimeLimits", () => {
    it("adds the staging margin to the walltime and an hour to the requests", () => {
        expect(jobTimeLimits(86400)).toEqual({
            walltimeSeconds: 86400,
            deadlineSeconds: 86400 + DEADLINE_MARGIN_SECONDS,
            requestExpirySeconds: 86400 + DEADLINE_MARGIN_SECONDS + 3600,
            manifestExpirySeconds: 86400,
        });
    });

    it("never lets the manifest GET outlive the deadline", () => {
        const limits = jobTimeLimits(600);
        expect(limits.deadlineSeconds).toBe(600 + DEADLINE_MARGIN_SECONDS);
        expect(limits.manifestExpirySeconds).toBe(limits.deadlineSeconds);
        expect(jobTimeLimits(86400, 3600).manifestExpirySeconds).toBe(3600);
    });

    it("keeps requests within the SigV4 maximum by shortening the walltime", () => {
        const limits = jobTimeLimits(30 * 86400);
        expect(limits.deadlineSeconds).toBe(MAX_DEADLINE_SECONDS);
        expect(limits.walltimeSeconds).toBe(MAX_DEADLINE_SECONDS - DEADLINE_MARGIN_SECONDS);
        expect(limits.requestExpirySeconds).toBe(MAX_PRESIGN_EXPIRES_SECONDS);
        expect(MAX_DEADLINE_SECONDS).toBe(7 * 86400 - 3600);
    });

    it("uses at least a minute of walltime", () => {
        expect(jobTimeLimits(0).walltimeSeconds).toBe(60);
        expect(jobTimeLimits(Number.NaN).walltimeSeconds).toBe(60);
    });
});
