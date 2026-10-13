/**
 * Loader for the JSON files the build publishes under /static/planet/data/ (configuration, datatypes, genomes,
 * toolbox). Their URLs carry no build id, so after a deploy the network serves the next build's files while this
 * worker keeps running. Files therefore come from this build's static cache, where the Service Worker precaches
 * them at install; a file missing there is fetched and kept only when its SHA-256 matches the one this build's
 * build.json records.
 */

import {
    BUILD_ID,
    BUILD_INFO_PATH,
    BUILD_MANIFEST_KEY,
    type BuildInfo,
    DEV_BUILD_ID,
    parseBuildInfo,
    staticCacheName,
} from "./build";
import { sha256Hex } from "./digest";
import { ApiError, ErrorCodes } from "./errors";

export const STATIC_DATA_ROOT = "/static/planet/data/";

const RELOAD_HINT = "Planet was updated; reload the page to use the new version.";

/** Where a build's data files come from. */
export interface StaticDataSource {
    buildId: string;
    fetch: typeof fetch;
    caches: CacheStorage | undefined;
}

function defaultSource(): StaticDataSource {
    return {
        buildId: BUILD_ID,
        fetch: (input, init) => globalThis.fetch(input, init),
        caches: typeof caches === "undefined" ? undefined : caches,
    };
}

function configError(message: string): ApiError {
    return new ApiError(500, message, ErrorCodes.CONFIG_ERROR);
}

/** The network has another build's files: this worker is older than the deployed site. */
class OtherBuildError extends ApiError {
    constructor(message: string) {
        super(500, message, ErrorCodes.CONFIG_ERROR);
    }
}

/** This build's cache, if it exists; a missing cache is not recreated. */
async function openBuildCache(source: StaticDataSource): Promise<Cache | undefined> {
    const name = staticCacheName(source.buildId);
    try {
        return source.caches && (await source.caches.has(name)) ? await source.caches.open(name) : undefined;
    } catch {
        return undefined;
    }
}

async function fetchOk(url: string, source: StaticDataSource, init: RequestInit): Promise<Response> {
    const response = await source.fetch(url, { credentials: "same-origin", ...init });
    if (!response.ok) {
        throw configError(`Planet data file ${url} is unavailable (HTTP ${response.status})`);
    }
    return response;
}

/** The build description stored with the cache, or this build's build.json while it is still deployed. */
async function buildManifest(cache: Cache | undefined, source: StaticDataSource): Promise<BuildInfo> {
    const stored = await cache?.match(BUILD_MANIFEST_KEY);
    if (stored) {
        try {
            return parseBuildInfo(await stored.json());
        } catch {
            // Replaced from the network below.
        }
    }
    const response = await fetchOk(BUILD_INFO_PATH, source, { cache: "no-store" });
    let info: BuildInfo;
    try {
        info = parseBuildInfo(await response.json());
    } catch {
        throw configError(`${BUILD_INFO_PATH} is not a valid build description`);
    }
    if (info.build_id !== source.buildId) {
        throw new OtherBuildError(RELOAD_HINT);
    }
    await cache
        ?.put(
            BUILD_MANIFEST_KEY,
            new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }),
        )
        .catch(() => undefined);
    return info;
}

function parseJson(bytes: ArrayBuffer, url: string): unknown {
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw configError(`Planet data file ${url} is not valid JSON`);
    }
}

/**
 * Reads the data file at `url` for `source.buildId`. Unbundled code (tests, the dev server) has no build.json and
 * reads the network directly.
 *
 * @throws ApiError 500 (`CONFIG_ERROR`) when the file is missing, not part of the build, from another build, or
 * not JSON
 */
export async function readStaticFile(url: string, source: StaticDataSource = defaultSource()): Promise<unknown> {
    const cache = await openBuildCache(source);
    const cached = await cache?.match(url);
    if (cached) {
        return parseJson(await cached.arrayBuffer(), url);
    }
    if (source.buildId === DEV_BUILD_ID) {
        return parseJson(await (await fetchOk(url, source, { cache: "no-cache" })).arrayBuffer(), url);
    }
    const expected = (await buildManifest(cache, source)).files[url];
    if (!expected) {
        throw configError(`Planet data file ${url} is not part of build ${source.buildId}`);
    }
    const response = await fetchOk(url, source, { cache: "no-cache" });
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) !== expected) {
        throw new OtherBuildError(`Planet data file ${url} belongs to another build. ${RELOAD_HINT}`);
    }
    await cache?.put(url, new Response(bytes, { headers: response.headers })).catch(() => undefined);
    return parseJson(bytes, url);
}

const loaded = new Map<string, Promise<unknown>>();

/**
 * Returns the parsed JSON file at `/static/planet/data/<path>` of this build. Each file is read once per worker
 * lifetime; a failed load is retried on the next call.
 *
 * @throws ApiError 500 (`CONFIG_ERROR`) when the file is missing, from another build, or not JSON
 */
export function loadStaticData<T>(path: string): Promise<T> {
    let pending = loaded.get(path);
    if (!pending) {
        const request = readStaticFile(STATIC_DATA_ROOT + path);
        loaded.set(path, request);
        request.catch(() => {
            if (loaded.get(path) === request) {
                loaded.delete(path);
            }
        });
        pending = request;
    }
    return pending as Promise<T>;
}

/**
 * Like {@link loadStaticData}, for files a deployment may leave out: resolves to `undefined` when it cannot be
 * read, but still fails when the deployed site belongs to another build.
 */
export async function loadOptionalStaticData<T>(path: string): Promise<T | undefined> {
    try {
        return await loadStaticData<T>(path);
    } catch (error) {
        if (error instanceof OtherBuildError) {
            throw error;
        }
        return undefined;
    }
}

/** Forgets loaded files so the next call reads them again. */
export function resetStaticData(): void {
    loaded.clear();
}
