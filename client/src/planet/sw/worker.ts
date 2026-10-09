/**
 * Service Worker lifecycle and fetch routing.
 *
 * - install: precaches the hashed assets listed in `/static/planet/build.json` (and `/` for offline
 *   navigations) into `planet-static-<build id>`; registers a static route sending `/static/*` to Cache
 *   Storage with network fallback where `InstallEvent.addRoutes` exists. Never calls `skipWaiting` itself.
 * - activate: claims clients and deletes asset caches of older builds that no open page uses.
 * - message: `{type: "planet:build-id", build_id?}` is answered on the transferred port (or the sender)
 *   with `{type: "planet:build-id", build_id}`; pages that send their own `build_id` keep its cache alive.
 *   `{type: "planet:skip-waiting"}` activates a waiting worker.
 * - fetch: same-origin only. `/static/*` is cache-first; Galaxy server paths go to the router (unknown
 *   `/api/**` gets a Galaxy 404); other navigations go to the network, falling back to the cached `/`.
 */

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
}

/** Shape of `/static/planet/build.json`. */
export interface BuildInfo {
    build_id: string;
    assets: string[];
}

export const STATIC_CACHE_PREFIX = "planet-static-";
export const META_CACHE = "planet-meta";
export const SHELL_PATH = "/";

const META_KEY = "/__planet/state.json";
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PRECACHE_CONCURRENCY = 6;

/** Name of the asset cache for a build. */
export function staticCacheName(buildId: string): string {
    return `${STATIC_CACHE_PREFIX}${buildId}`;
}

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

/** Validates a build description. */
export function parseBuildInfo(value: unknown): BuildInfo {
    if (
        !isRecord(value) ||
        typeof value.build_id !== "string" ||
        !Array.isArray(value.assets) ||
        !value.assets.every((asset) => typeof asset === "string")
    ) {
        throw new Error("Invalid build description");
    }
    return { build_id: value.build_id, assets: value.assets as string[] };
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

/** Wires install, activate, message and fetch handlers onto `scope`. */
export function installServiceWorker(scope: ServiceWorkerScopeLike, options: WorkerOptions): void {
    const { buildId, router } = options;
    const buildInfoPath = options.buildInfoPath ?? "/static/planet/build.json";
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

    async function precacheAssets(): Promise<void> {
        const response = await scope.fetch(buildInfoPath, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`Cannot load ${buildInfoPath}: HTTP ${response.status}`);
        }
        const info = parseBuildInfo(await response.json());
        if (info.build_id !== buildId) {
            throw new Error(`${buildInfoPath} describes build ${info.build_id}, this worker is ${buildId}`);
        }
        const cache = await scope.caches.open(cacheName);
        const assets = [...new Set(info.assets.map(sameOriginPath).filter((path): path is string => path !== null))];
        await forEachLimited(assets, PRECACHE_CONCURRENCY, async (path) => {
            if (await cache.match(path)) {
                return;
            }
            const previous = await scope.caches.match(path);
            if (previous) {
                await cache.put(path, previous);
                return;
            }
            const asset = await scope.fetch(path);
            if (!asset.ok) {
                throw new Error(`Cannot precache ${path}: HTTP ${asset.status}`);
            }
            await cache.put(path, asset);
        });
        const shell = await scope.fetch(SHELL_PATH, { cache: "no-cache" });
        if (shell.ok) {
            await cache.put(SHELL_PATH, await copyResponse(shell));
        }
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

    function staticRoutes(event: InstallEventLike): Promise<void> {
        if (typeof event.addRoutes !== "function") {
            return Promise.resolve();
        }
        const URLPatternClass = (globalThis as { URLPattern?: new (init: Record<string, string>) => unknown })
            .URLPattern;
        const urlPattern = URLPatternClass
            ? new URLPatternClass({ pathname: "/static/*", baseURL: origin })
            : "/static/*";
        const rule: RouterRule = { condition: { urlPattern }, source: "cache" };
        try {
            return event.addRoutes(rule).catch((reason) => console.warn("Planet static routes not registered", reason));
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

    async function staticResponse(request: Request): Promise<Response> {
        const cached = await scope.caches.match(request);
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
        event.waitUntil(scope.clients.claim().then(() => pruneCaches()));
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
                event.respondWith(staticResponse(request));
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
