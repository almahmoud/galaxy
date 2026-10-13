import { afterEach, describe, expect, it, vi } from "vitest";

import * as staticData from "@/planet/util/staticData";

import {
    effectiveRuntimeImage,
    isPinnedImage,
    loadBuildRuntimeImage,
    parseRuntimeData,
    RUNTIME_DATA_PATH,
    runtimeImageWarning,
} from "./runtime";

const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const PINNED = `ghcr.io/almahmoud/planet-runtime@${DIGEST}`;
const TAG = "ghcr.io/almahmoud/planet-runtime:latest";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("isPinnedImage", () => {
    it("accepts a full sha256 digest, with or without a tag", () => {
        expect(isPinnedImage(PINNED)).toBe(true);
        expect(isPinnedImage(`ghcr.io/almahmoud/planet-runtime:v1@${DIGEST}`)).toBe(true);
        expect(isPinnedImage(` ${PINNED} `)).toBe(true);
    });

    it("rejects tags and partial digests", () => {
        expect(isPinnedImage(TAG)).toBe(false);
        expect(isPinnedImage("planet-runtime")).toBe(false);
        expect(isPinnedImage("ghcr.io/almahmoud/planet-runtime@sha256:0000")).toBe(false);
        expect(isPinnedImage(`${PINNED}:latest`)).toBe(false);
    });
});

describe("parseRuntimeData", () => {
    it("returns the image the build names", () => {
        expect(parseRuntimeData({ image: PINNED })).toBe(PINNED);
        expect(parseRuntimeData({ image: ` ${TAG}\n` })).toBe(TAG);
    });

    it("returns null when the build names none or the file is malformed", () => {
        for (const value of [
            undefined,
            null,
            [],
            "x",
            { image: null },
            { image: 3 },
            { image: " " },
            { image: "a b" },
        ]) {
            expect(parseRuntimeData(value)).toBeNull();
        }
        expect(parseRuntimeData({ image: `ghcr.io/${"a".repeat(600)}` })).toBeNull();
    });
});

describe("loadBuildRuntimeImage", () => {
    it("reads the build's data file through the static data loader", async () => {
        const load = vi.spyOn(staticData, "loadOptionalStaticData").mockResolvedValue({ image: PINNED });
        expect(await loadBuildRuntimeImage()).toBe(PINNED);
        expect(load).toHaveBeenCalledWith(RUNTIME_DATA_PATH);
    });

    it("returns null when the deployment has no data file", async () => {
        vi.spyOn(staticData, "loadOptionalStaticData").mockResolvedValue(undefined);
        expect(await loadBuildRuntimeImage()).toBeNull();
    });
});

describe("effectiveRuntimeImage", () => {
    it("prefers the setting, then the build's image, then the fallback", () => {
        expect(effectiveRuntimeImage(" custom:1 ", PINNED, TAG)).toEqual({
            image: "custom:1",
            source: "settings",
            default_image: PINNED,
        });
        expect(effectiveRuntimeImage("", PINNED, TAG)).toEqual({
            image: PINNED,
            source: "build",
            default_image: PINNED,
        });
        expect(effectiveRuntimeImage("  ", null, TAG)).toEqual({ image: TAG, source: "fallback", default_image: TAG });
    });
});

describe("runtimeImageWarning", () => {
    it("is silent for pinned images", () => {
        expect(runtimeImageWarning(PINNED, "settings")).toBeNull();
        expect(runtimeImageWarning(PINNED, "build")).toBeNull();
    });

    it("explains the risk of a tag and how to pin it", () => {
        expect(runtimeImageWarning("ghcr.io/me/runtime:main", "settings")).toMatch(/tag without a digest.*@sha256/);
        expect(runtimeImageWarning(TAG, "fallback")).toContain(
            `does not pin its runtime image, so jobs use the tag ${TAG}`,
        );
    });
});
