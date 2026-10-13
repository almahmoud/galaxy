/** The build this bundle belongs to, the asset cache the Service Worker keeps for each build, and build.json. */

/** Build id of unbundled code. */
export const DEV_BUILD_ID = "dev";

/** Build id defined at build time; {@link DEV_BUILD_ID} when the code runs unbundled, as in tests. */
export const BUILD_ID: string = typeof __PLANET_BUILD_ID__ === "string" ? __PLANET_BUILD_ID__ : DEV_BUILD_ID;

export const STATIC_CACHE_PREFIX = "planet-static-";

/** Where the deployed site describes its build. */
export const BUILD_INFO_PATH = "/static/planet/build.json";

/** Key of the build description inside a build's own static cache. */
export const BUILD_MANIFEST_KEY = "/__planet/build.json";

/** Name of the asset cache for a build. */
export function staticCacheName(buildId: string): string {
    return `${STATIC_CACHE_PREFIX}${buildId}`;
}

/**
 * True for files whose name carries a hash of their content: a copy cached by any build is the same file. Every
 * other file keeps its name across builds.
 */
export function isContentHashed(path: string): boolean {
    return /^\/static\/dist\/(?:chunks|assets)\//.test(path);
}

/** Shape of `/static/planet/build.json`, written by planet/scripts/build-site.mjs. */
export interface BuildInfo {
    build_id: string;
    /** Files with stable names (entries, base.css, boot script and style, welcome page, static data) and their SHA-256. */
    files: Record<string, string>;
    /** Content-hashed files the entries import statically. */
    boot: string[];
    /** The other content-hashed files: lazily loaded chunks, fonts and images. */
    lazy: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((path) => typeof path === "string" && isContentHashed(path));
}

/**
 * Validates a build description.
 *
 * @throws Error when the shape is wrong, a digest is not SHA-256 hex, or a list names a file without a content hash
 */
export function parseBuildInfo(value: unknown): BuildInfo {
    if (
        !isRecord(value) ||
        typeof value.build_id !== "string" ||
        !isRecord(value.files) ||
        !Object.values(value.files).every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) ||
        !isPathList(value.boot) ||
        !isPathList(value.lazy)
    ) {
        throw new Error("Invalid build description");
    }
    return {
        build_id: value.build_id,
        files: { ...(value.files as Record<string, string>) },
        boot: [...value.boot],
        lazy: [...value.lazy],
    };
}
