/** The build this bundle belongs to, and the asset cache the Service Worker keeps for each build. */

/** Build id defined at build time; `"dev"` when the code runs unbundled, as in tests. */
export const BUILD_ID: string = typeof __PLANET_BUILD_ID__ === "string" ? __PLANET_BUILD_ID__ : "dev";

export const STATIC_CACHE_PREFIX = "planet-static-";

/** Name of the asset cache for a build. */
export function staticCacheName(buildId: string): string {
    return `${STATIC_CACHE_PREFIX}${buildId}`;
}
