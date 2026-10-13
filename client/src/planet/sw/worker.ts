/**
 * Service Worker lifecycle and fetch routing.
 *
 * - install: precaches what a page of this build needs to start into `planet-static-<build id>`: the files
 *   `/static/planet/build.json` lists with a SHA-256 (entries, base.css, boot script and style, static data), each
 *   fetched past the HTTP cache and checked against its digest, the content-hashed files the entries import, and
 *   `/` for offline navigations. Content-hashed files are copied from older builds' caches when present. A failed
 *   install deletes its cache. Where `InstallEvent.addRoutes` exists, registers static routes that send `/static/*`
 *   to Cache Storage with network fallback, taking the entry files directly under `/static/dist/` (stable names in
 *   every build) from this build's cache. Never calls `skipWaiting` itself.
 * - activate: claims clients and deletes asset caches of older builds that no open page uses, then caches the
 *   build's other content-hashed files in the background (also resumed whenever a page reports its build).
 * - message: `{type: "planet:build-id", build_id?}` is answered on the transferred port (or the sender)
 *   with `{type: "planet:build-id", build_id}`; pages that send their own `build_id` keep its cache alive.
 *   `{type: "planet:skip-waiting"}` activates a waiting worker.
 * - fetch: same-origin only. `/static/*` is cache-first, this build's cache before older ones, then the network;
 *   Galaxy server paths go to the router (unknown `/api/**` gets a Galaxy 404); other navigations go to the
 *   network, falling back to the cached `/`.
 */

import {
    BUILD_INFO_PATH,
    BUILD_MANIFEST_KEY,
    type BuildInfo,
    isContentHashed,
    parseBuildInfo,
    STATIC_CACHE_PREFIX,
    staticCacheName,
} from "@/planet/util/build";
import { sha256Hex } from "@/planet/util/digest";

import type { Router } from "./router";
import type {
    ClientLike,
    ExtendableMessageEventLike,
    FetchEventLike,
    InstallEventLike,
    RouterRule,
    ServiceWorkerScopeLike,
} from "./types";

export interface WorkerOptions {
    /** Build id compiled into this worker. */
    buildId: string;
    router: Router;
    /** Path of the build description. Default `/static/planet/build.json`. */
    buildInfoPath?: string;
    /** Pauses before each retry of a failed install download. Default 0.5 s, then 2 s. */
    retryDelays?: readonly number[];
    /** Clock of the background caching time budget. Default `Date.now`. */
    now?: () => number;
}

export { STATIC_CACHE_PREFIX, staticCacheName };
export const META_CACHE = "planet-meta";
export const SHELL_PATH = "/";

const META_KEY = "/__planet/state.json";
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PRECACHE_CONCURRENCY = 6;
const DEFAULT_RETRY_DELAYS = [500, 2000];
/** Background caching runs two downloads at a time, leaving the connection to the page. */
const WARM_CONCURRENCY = 2;
/**
 * A background caching run starts no download after this long. Browsers stop a worker whose event stays open for
 * about five minutes; the next run continues with the files still missing.
 */
export const WARM_BUDGET_MS = 4 * 60 * 1000;

/** True for paths the router answers: `/context`, `/welcome`, `/api/**` and Galaxy's legacy controllers. */
export function isRoutedPath(pathname: string): boolean {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    return (
        path === "/context" ||
        path === "/welcome" ||
        path === "/api" ||
        path.startsWith("/api/") ||
        path.startsWith("/history/") ||
        path.startsWith("/dataset/") ||
        /^\/datasets\/[^/]+\/display(?:\/|$)/.test(path)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isClient(value: unknown): value is ClientLike {
    return isRecord(value) && typeof value.id === "string" && typeof value.postMessage === "function";
}

/** Worker state shared by every build's worker: which build each page runs and when builds installed. */
interface WorkerMeta {
    clients: Record<string, string>;
    builds: Record<string, number>;
}

function parseMeta(value: unknown): WorkerMeta {
    const meta: WorkerMeta = { clients: {}, builds: {} };
    if (isRecord(value)) {
        if (isRecord(value.clients)) {
            for (const [clientId, build] of Object.entries(value.clients)) {
                if (typeof build === "string") {
                    meta.clients[clientId] = build;
                }
            }
        }
        if (isRecord(value.builds)) {
            for (const [build, time] of Object.entries(value.builds)) {
                if (typeof time === "number") {
                    meta.builds[build] = time;
                }
            }
        }
    }
    return meta;
}

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            await fn(items[next++]!);
        }
    });
    await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(reason: unknown): string {
    return reason instanceof Error ? reason.message || reason.name : String(reason);
}

/** Wires install, activate, message and fetch handlers onto `scope`. */
export function installServiceWorker(scope: ServiceWorkerScopeLike, options: WorkerOptions): void {
    const { buildId, router } = options;
    const buildInfoPath = options.buildInfoPath ?? BUILD_INFO_PATH;
    const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const now = options.now ?? Date.now;
    const cacheName = staticCacheName(buildId);
    const origin = scope.location.origin;

    function sameOriginPath(url: string): string | null {
        try {
            const parsed = new URL(url, origin);
            return parsed.origin === origin ? parsed.pathname + parsed.search : null;
        } catch {
            return null;
        }
    }

    async function copyResponse(response: Response): Promise<Response> {
        return new Response(await response.blob(), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    /** Fetches an asset, retrying network failures and 5xx answers after each of `delays`. */
    async function fetchAsset(
        path: string,
        init: RequestInit | undefined,
        delays: readonly number[],
    ): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            let failure: string;
            let retryable = true;
            try {
                const response = await scope.fetch(path, init);
                if (response.ok) {
                    return response;
                }
                failure = `HTTP ${response.status}`;
                retryable = response.status >= 500;
            } catch (reason) {
                failure = describe(reason);
            }
            if (!retryable || attempt >= delays.length) {
                throw new Error(`Cannot cache ${path}: ${failure}`);
            }
            await sleep(delays[attempt]!);
        }
    }

    /**
     * Caches a file whose name stays the same across builds. It is always downloaded, past the HTTP cache, and
     * must have the digest build.json records: an edge or HTTP cache can still serve the previous build's copy.
     */
    async function cacheVerified(cache: Cache, path: string, digest: string): Promise<void> {
        if (await cache.match(path)) {
            return;
        }
        const response = await fetchAsset(path, { cache: "no-cache" }, retryDelays);
        const body = await response.arrayBuffer();
        if ((await sha256Hex(body)) !== digest) {
            throw new Error(`${path} is not the file of build ${buildId}; the site may be deploying another build`);
        }
        await cache.put(
            path,
            new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
        );
    }

    /** Caches a content-hashed file, copying it from another build's cache when one holds it. */
    async function cacheHashed(cache: Cache, path: string, delays: readonly number[]): Promise<void> {
        if (!isContentHashed(path) || (await cache.match(path))) {
            return;
        }
        const previous = await scope.caches.match(path);
        if (previous) {
            await cache.put(path, previous);
            return;
        }
        await cache.put(path, await fetchAsset(path, undefined, delays));
    }

    async function readBuildInfo(): Promise<BuildInfo> {
        const response = await scope.fetch(buildInfoPath, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`Cannot load ${buildInfoPath}: HTTP ${response.status}`);
        }
        const info = parseBuildInfo(await response.json());
        if (info.build_id !== buildId) {
            throw new Error(`${buildInfoPath} describes build ${info.build_id}, this worker is ${buildId}`);
        }
        return info;
    }

    /** Caches what a page needs to start, then the build description, which marks the cache complete. */
    async function precacheAssets(): Promise<void> {
        const info = await readBuildInfo();
        const cache = await scope.caches.open(cacheName);
        const tasks: (() => Promise<void>)[] = [];
        for (const [file, digest] of Object.entries(info.files)) {
            const path = sameOriginPath(file);
            if (path) {
                tasks.push(() => cacheVerified(cache, path, digest));
            }
        }
        for (const path of info.boot) {
            tasks.push(() => cacheHashed(cache, path, retryDelays));
        }
        await forEachLimited(tasks, PRECACHE_CONCURRENCY, (task) => task());
        const shell = await scope.fetch(SHELL_PATH, { cache: "no-cache" });
        if (shell.ok) {
            await cache.put(SHELL_PATH, await copyResponse(shell));
        }
        await cache.put(
            BUILD_MANIFEST_KEY,
            new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }),
        );
    }

    /** Precaches this build. A failed install removes its partial cache so a retry starts clean. */
    async function install(): Promise<void> {
        await updateMeta((meta) => {
            meta.builds[buildId] ??= Date.now();
        });
        try {
            await precacheAssets();
        } catch (failure) {
            await scope.caches.delete(cacheName);
            await updateMeta((meta) => {
                delete meta.builds[buildId];
            });
            throw failure;
        }
    }

    /**
     * Caches the build's lazily loaded files, a few at a time. Cached files are skipped and a file that fails is
     * left for the next run, so an interrupted run resumes where it stopped. Until a file is cached, pages load it
     * from the network.
     */
    async function warmLazyAssets(): Promise<void> {
        if (!(await scope.caches.has(cacheName))) {
            return;
        }
        const cache = await scope.caches.open(cacheName);
        const stored = await cache.match(BUILD_MANIFEST_KEY);
        if (!stored) {
            return;
        }
        const { lazy } = parseBuildInfo(await stored.json());
        const started = now();
        let failed = 0;
        await forEachLimited(lazy, WARM_CONCURRENCY, async (path) => {
            // A newer build's worker deletes this cache once no page uses it.
            if (now() - started > WARM_BUDGET_MS || !(await scope.caches.has(cacheName))) {
                return;
            }
            try {
                await cacheHashed(cache, path, []);
            } catch {
                failed += 1;
            }
        });
        if (failed) {
            console.warn(
                `Planet could not cache ${failed} file(s) of build ${buildId}; pages load them from the network`,
            );
        }
    }

    let warming: Promise<void> | undefined;

    /** Starts {@link warmLazyAssets} unless a run is in progress. */
    function warm(): Promise<void> {
        warming ??= warmLazyAssets()
            .catch((reason) => console.warn("Planet background caching failed", reason))
            .finally(() => {
                warming = undefined;
            });
        return warming;
    }

    function staticRoutes(event: InstallEventLike): Promise<void> {
        if (typeof event.addRoutes !== "function") {
            return Promise.resolve();
        }
        const URLPatternClass = (globalThis as { URLPattern?: new (init: Record<string, string>) => unknown })
            .URLPattern;
        const pattern = (pathname: string) =>
            URLPatternClass ? new URLPatternClass({ pathname, baseURL: origin }) : pathname;
        const rules: RouterRule[] = [
            { condition: { urlPattern: pattern("/static/dist/:file") }, source: { cacheName } },
            { condition: { urlPattern: pattern("/static/welcome.html") }, source: { cacheName } },
            { condition: { urlPattern: pattern("/static/*") }, source: "cache" },
        ];
        try {
            return event
                .addRoutes(rules)
                .catch((reason) => console.warn("Planet static routes not registered", reason));
        } catch (reason) {
            console.warn("Planet static routes not registered", reason);
            return Promise.resolve();
        }
    }

    let metaQueue: Promise<unknown> = Promise.resolve();

    /** Reads and rewrites the worker state kept in {@link META_CACHE}, one update at a time. */
    function updateMeta<R>(change: (meta: WorkerMeta) => R | Promise<R>): Promise<R> {
        const run = metaQueue.then(async () => {
            const cache = await scope.caches.open(META_CACHE);
            const meta = parseMeta(await (await cache.match(META_KEY))?.json().catch(() => undefined));
            const result = await change(meta);
            await cache.put(
                META_KEY,
                new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }),
            );
            return result;
        });
        metaQueue = run.catch(() => undefined);
        return run;
    }

    /**
     * Deletes asset caches that no open top-level page uses and that are older than this build. Keeps
     * everything while a page of unknown build is open, and never touches newer (waiting) builds.
     */
    function pruneCaches(record?: { clientId: string; buildId: string }): Promise<void> {
        return updateMeta(async (meta) => {
            const windows = (await scope.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(
                (client) => client.frameType !== "nested",
            );
            const alive = new Set(windows.map((client) => client.id));
            if (record) {
                meta.clients[record.clientId] = record.buildId;
            }
            for (const clientId of Object.keys(meta.clients)) {
                if (!alive.has(clientId)) {
                    delete meta.clients[clientId];
                }
            }
            if (windows.some((client) => !(client.id in meta.clients))) {
                return [];
            }
            const installedAt = meta.builds[buildId] ?? 0;
            const keep = new Set([buildId, ...Object.values(meta.clients)]);
            for (const [build, time] of Object.entries(meta.builds)) {
                if (time > installedAt) {
                    keep.add(build);
                }
            }
            const stale = (await scope.caches.keys()).filter(
                (name) => name.startsWith(STATIC_CACHE_PREFIX) && !keep.has(name.slice(STATIC_CACHE_PREFIX.length)),
            );
            for (const name of stale) {
                delete meta.builds[name.slice(STATIC_CACHE_PREFIX.length)];
            }
            return stale;
        })
            .then((stale) => Promise.all(stale.map((name) => scope.caches.delete(name))))
            .then(
                () => undefined,
                (reason) => console.warn("Planet cache cleanup failed", reason),
            );
    }

    /**
     * This build's copy first: entry files keep their names across builds, and pages add `?v=<build id>`
     * to some of them. Then, for content-hashed files only, any build's copy (older pages' chunks), then the
     * network.
     */
    async function staticResponse(request: Request, pathname: string): Promise<Response> {
        const cached =
            (await scope.caches.match(request, { cacheName, ignoreSearch: true })) ??
            (isContentHashed(pathname) ? await scope.caches.match(request) : undefined);
        return cached ?? scope.fetch(request);
    }

    async function navigationResponse(request: Request): Promise<Response> {
        try {
            return await scope.fetch(request);
        } catch (failure) {
            const shell =
                (await scope.caches.match(SHELL_PATH, { cacheName })) ?? (await scope.caches.match(SHELL_PATH));
            if (shell) {
                return shell;
            }
            throw failure;
        }
    }

    scope.addEventListener("install", (event) => {
        event.waitUntil(Promise.all([install(), staticRoutes(event)]));
    });

    scope.addEventListener("activate", (event) => {
        const activated = scope.clients.claim().then(() => pruneCaches());
        event.waitUntil(activated);
        // Not part of activation, which holds back fetch events until it settles.
        void activated.then(warm, () => undefined);
    });

    scope.addEventListener("message", (event: ExtendableMessageEventLike) => {
        const data = event.data;
        if (!isRecord(data) || typeof data.type !== "string") {
            return;
        }
        if (data.type === "planet:build-id") {
            const reply = { type: "planet:build-id", build_id: buildId };
            const port = event.ports[0];
            if (port) {
                port.postMessage(reply);
            } else if (isClient(event.source)) {
                event.source.postMessage(reply);
            }
            if (isClient(event.source) && typeof data.build_id === "string" && BUILD_ID_PATTERN.test(data.build_id)) {
                event.waitUntil(pruneCaches({ clientId: event.source.id, buildId: data.build_id }));
            }
            // Pages ask on every start, which resumes background caching an earlier run did not finish.
            event.waitUntil(warm());
        } else if (data.type === "planet:skip-waiting") {
            event.waitUntil(scope.skipWaiting());
        }
    });

    scope.addEventListener("fetch", (event: FetchEventLike) => {
        const { request } = event;
        let url: URL;
        try {
            url = new URL(request.url);
        } catch {
            return;
        }
        if (url.origin !== origin) {
            return;
        }
        if (url.pathname.startsWith("/static/")) {
            if (request.method === "GET" && !request.headers.has("Range")) {
                event.respondWith(staticResponse(request, url.pathname));
            }
            return;
        }
        if (isRoutedPath(url.pathname)) {
            event.respondWith(
                router.handle(request, {
                    clientId: event.clientId || event.resultingClientId || "",
                    waitUntil: (promise) => event.waitUntil(promise),
                }),
            );
            return;
        }
        if (request.mode === "navigate" && request.method === "GET") {
            event.respondWith(navigationResponse(request));
        }
    });
}
