/** Loader for the JSON files the build publishes under /static/planet/data/ (configuration, datatypes, genomes, toolbox). */

import { BUILD_ID, staticCacheName } from "./build";
import { ApiError, ErrorCodes } from "./errors";

export const STATIC_DATA_ROOT = "/static/planet/data/";

const loaded = new Map<string, Promise<unknown>>();

async function openCache(): Promise<Cache | undefined> {
    if (typeof caches === "undefined") {
        return undefined;
    }
    try {
        return await caches.open(staticCacheName(BUILD_ID));
    } catch {
        return undefined;
    }
}

async function fetchStaticJson(url: string): Promise<unknown> {
    const cache = await openCache();
    let response = cache ? await cache.match(url) : undefined;
    if (!response) {
        const fetched = await fetch(url, { cache: "no-cache", credentials: "same-origin" });
        if (!fetched.ok) {
            throw new ApiError(
                500,
                `Planet data file ${url} is unavailable (HTTP ${fetched.status})`,
                ErrorCodes.CONFIG_ERROR,
            );
        }
        if (cache) {
            await cache.put(url, fetched.clone()).catch(() => undefined);
        }
        response = fetched;
    }
    try {
        return await response.json();
    } catch {
        throw new ApiError(500, `Planet data file ${url} is not valid JSON`, ErrorCodes.CONFIG_ERROR);
    }
}

/**
 * Returns the parsed JSON file at `/static/planet/data/<path>`. Each file is fetched once per worker lifetime and
 * kept in this build's static cache; a failed load is retried on the next call.
 *
 * @throws ApiError 500 (`CONFIG_ERROR`) when the file is missing or not JSON
 */
export function loadStaticData<T>(path: string): Promise<T> {
    let pending = loaded.get(path);
    if (!pending) {
        const request = fetchStaticJson(STATIC_DATA_ROOT + path);
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

/** Like {@link loadStaticData}, for files a deployment may leave out: resolves to `undefined` when it cannot be read. */
export async function loadOptionalStaticData<T>(path: string): Promise<T | undefined> {
    try {
        return await loadStaticData<T>(path);
    } catch {
        return undefined;
    }
}

/** Forgets loaded files so the next call fetches them again. */
export function resetStaticData(): void {
    loaded.clear();
}
