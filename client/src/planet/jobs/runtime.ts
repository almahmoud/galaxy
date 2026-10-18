/**
 * This build's planet-runtime settings as the leader uses them, from `/static/planet/data/runtime.json`
 * (`planet/scripts/build-site.mjs`): `{"image": "<reference>" | null, "tag_pull_policy"?: "Always" | "IfNotPresent"}`.
 * The leader runs no jobs without them: a file that cannot be read or does not have this shape is an error, and only
 * `"image": null` means the build names no image.
 */

import { RUNTIME_DATA_PATH } from "@/planet/ui/lib/runtime";
import { loadStaticData } from "@/planet/util/staticData";

export type PullPolicy = "Always" | "IfNotPresent";

export interface BuildRuntime {
    /** The runtime image the build was made with, or null. */
    image: string | null;
    /**
     * Pull policy of runtime images without a digest. `Always` unless the build allows node-local images
     * (`PLANET_ALLOW_UNPINNED_RUNTIME=1`, local development clusters).
     */
    tagPullPolicy: PullPolicy;
}

const MAX_IMAGE_LENGTH = 512;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/;
const PULL_POLICIES: readonly unknown[] = ["Always", "IfNotPresent"] satisfies PullPolicy[];

/** Raised for a runtime data file that does not have the shape the build writes. */
export class RuntimeDataError extends Error {
    constructor(reason: string) {
        super(`The build's ${RUNTIME_DATA_PATH} ${reason}.`);
        this.name = "RuntimeDataError";
    }
}

/**
 * Validates a runtime data document.
 *
 * @throws RuntimeDataError when it is not an object with an `image` that is null or an image reference, or names an
 *   unknown pull policy
 */
export function parseBuildRuntime(value: unknown): BuildRuntime {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "image")) {
        throw new RuntimeDataError("does not name a runtime image");
    }
    const { image, tag_pull_policy: policy } = value as { image: unknown; tag_pull_policy?: unknown };
    if (
        image !== null &&
        (typeof image !== "string" || image.length > MAX_IMAGE_LENGTH || !IMAGE_PATTERN.test(image))
    ) {
        throw new RuntimeDataError("names an invalid runtime image");
    }
    if (policy !== undefined && !PULL_POLICIES.includes(policy)) {
        throw new RuntimeDataError("names an unknown pull policy");
    }
    return { image, tagPullPolicy: (policy as PullPolicy | undefined) ?? "Always" };
}

/**
 * Reads this build's runtime settings through the static data loader, so a tab of an older build never takes a newer
 * build's image.
 *
 * @throws when the file cannot be read, belongs to another build or is malformed
 */
export async function loadBuildRuntime(): Promise<BuildRuntime> {
    return parseBuildRuntime(await loadStaticData<unknown>(RUNTIME_DATA_PATH));
}
