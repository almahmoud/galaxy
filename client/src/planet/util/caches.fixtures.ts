/** In-memory Cache Storage for Service Worker and static data tests. */

export const FAKE_ORIGIN = "https://planet.test";

function keyOf(request: RequestInfo | URL, ignoreSearch = false): string {
    const url = new URL(
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
        FAKE_ORIGIN,
    );
    if (ignoreSearch) {
        url.search = "";
    }
    return url.href;
}

export class FakeCache {
    readonly entries = new Map<string, Response>();

    async match(request: RequestInfo | URL, options: CacheQueryOptions = {}): Promise<Response | undefined> {
        const key = keyOf(request, options.ignoreSearch);
        for (const [stored, response] of this.entries) {
            if (keyOf(stored, options.ignoreSearch) === key) {
                return response.clone();
            }
        }
        return undefined;
    }

    async put(request: RequestInfo | URL, response: Response): Promise<void> {
        this.entries.set(keyOf(request), response);
    }

    /** The stored body for `path`, or undefined. */
    async text(path: string): Promise<string | undefined> {
        return (await this.match(path))?.text();
    }
}

export class FakeCacheStorage {
    readonly caches = new Map<string, FakeCache>();

    async open(name: string): Promise<FakeCache> {
        if (!this.caches.has(name)) {
            this.caches.set(name, new FakeCache());
        }
        return this.caches.get(name)!;
    }

    async keys(): Promise<string[]> {
        return [...this.caches.keys()];
    }

    async delete(name: string): Promise<boolean> {
        return this.caches.delete(name);
    }

    async has(name: string): Promise<boolean> {
        return this.caches.has(name);
    }

    async match(request: RequestInfo | URL, options: MultiCacheQueryOptions = {}): Promise<Response | undefined> {
        if (options.cacheName) {
            return this.caches.get(options.cacheName)?.match(request, options);
        }
        for (const cache of this.caches.values()) {
            const found = await cache.match(request, options);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /** This storage typed as the browser's. */
    asCacheStorage(): CacheStorage {
        return this as unknown as CacheStorage;
    }
}
