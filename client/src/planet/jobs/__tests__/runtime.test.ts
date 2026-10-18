import { afterEach, describe, expect, it, vi } from "vitest";

import { RUNTIME_DATA_PATH } from "@/planet/ui/lib/runtime";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import * as staticData from "@/planet/util/staticData";

import { loadBuildRuntime, parseBuildRuntime, RuntimeDataError } from "../runtime";

const PINNED = `ghcr.io/almahmoud/planet-runtime@sha256:${"0123456789abcdef".repeat(4)}`;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("parseBuildRuntime", () => {
    it("reads the image and pulls images without a digest every time unless the build says otherwise", () => {
        expect(parseBuildRuntime({ image: PINNED })).toEqual({ image: PINNED, tagPullPolicy: "Always" });
        expect(parseBuildRuntime({ image: null })).toEqual({ image: null, tagPullPolicy: "Always" });
        expect(parseBuildRuntime({ image: "planet-runtime:dev", tag_pull_policy: "IfNotPresent" })).toEqual({
            image: "planet-runtime:dev",
            tagPullPolicy: "IfNotPresent",
        });
    });

    it("refuses anything but an explicit image or null", () => {
        for (const value of [
            undefined,
            null,
            [],
            "x",
            {},
            { image: undefined },
            { image: "" },
            { image: 3 },
            { image: "a b" },
            { image: `ghcr.io/${"a".repeat(600)}` },
            { image: PINNED, tag_pull_policy: "Never" },
        ]) {
            expect(() => parseBuildRuntime(value)).toThrow(RuntimeDataError);
        }
    });
});

describe("loadBuildRuntime", () => {
    it("reads this build's runtime data", async () => {
        const load = vi.spyOn(staticData, "loadStaticData").mockResolvedValue({ image: PINNED });
        expect(await loadBuildRuntime()).toEqual({ image: PINNED, tagPullPolicy: "Always" });
        expect(load).toHaveBeenCalledWith(RUNTIME_DATA_PATH);
    });

    it("fails when the file cannot be read instead of leaving the image unset", async () => {
        const missing = new ApiError(500, "Planet data file runtime.json could not be read.", ErrorCodes.CONFIG_ERROR);
        vi.spyOn(staticData, "loadStaticData").mockRejectedValue(missing);
        await expect(loadBuildRuntime()).rejects.toBe(missing);
        vi.spyOn(staticData, "loadStaticData").mockResolvedValue(undefined);
        await expect(loadBuildRuntime()).rejects.toThrow(RuntimeDataError);
    });
});
