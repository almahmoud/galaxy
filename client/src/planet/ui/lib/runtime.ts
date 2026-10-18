/**
 * The planet-runtime image of this build. The site build writes it to `/static/planet/data/runtime.json`
 * (`planet/scripts/build-site.mjs`, from `PLANET_RUNTIME_IMAGE`) as `{"image": "<reference>" | null}`.
 */

import { loadOptionalStaticData } from "@/planet/util/staticData";

/** Path of the runtime data file under `/static/planet/data/`. */
export const RUNTIME_DATA_PATH = "runtime.json";

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const MAX_IMAGE_LENGTH = 512;

/** True when `image` names a sha256 digest, so every node runs the same image. */
export function isPinnedImage(image: string): boolean {
    return DIGEST.test(image.trim());
}

/** The image a runtime data document names, or null when it names none or is malformed. */
export function parseRuntimeData(value: unknown): string | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const image = (value as { image?: unknown }).image;
    if (typeof image !== "string") {
        return null;
    }
    const trimmed = image.trim();
    return trimmed && trimmed.length <= MAX_IMAGE_LENGTH && !/\s/.test(trimmed) ? trimmed : null;
}

/**
 * The runtime image this build was made with, or null when the build names none. Reads the build's data file
 * through the static data loader, so a page or worker of an older build never picks up a newer build's image.
 */
export async function loadBuildRuntimeImage(): Promise<string | null> {
    return parseRuntimeData(await loadOptionalStaticData<unknown>(RUNTIME_DATA_PATH));
}

/** Where the runtime image of job pods comes from. */
export type RuntimeSource = "settings" | "build" | "fallback";

/**
 * The runtime image jobs use: the cluster setting, else the build's image, else `fallback`. `default_image` is the
 * one used while the setting is empty.
 */
export function effectiveRuntimeImage(
    setting: string,
    buildImage: string | null,
    fallback: string,
): { image: string; source: RuntimeSource; default_image: string } {
    const configured = setting.trim();
    const defaultImage = buildImage ?? fallback;
    if (configured) {
        return { image: configured, source: "settings", default_image: defaultImage };
    }
    return { image: defaultImage, source: buildImage ? "build" : "fallback", default_image: defaultImage };
}

/** A warning for a runtime image without a digest, or null when it is pinned. */
export function runtimeImageWarning(image: string, source: RuntimeSource): string | null {
    if (isPinnedImage(image)) {
        return null;
    }
    if (source === "settings") {
        return (
            "This image is a tag without a digest: whoever can push to it changes what your jobs run. " +
            "Pin it as image@sha256:<digest>."
        );
    }
    return (
        `This Planet build does not pin its runtime image, so jobs use the tag ${image}. ` +
        "Enter the image with its digest (image@sha256:<digest>) to pin it."
    );
}
