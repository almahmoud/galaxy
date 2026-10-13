// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { Router } from "./router";
import type {
    ClientLike,
    ExtendableEventLike,
    ExtendableMessageEventLike,
    FetchEventLike,
    InstallEventLike,
    RouterRule,
    ServiceWorkerScopeLike,
} from "./types";
import { installServiceWorker, isRoutedPath, staticCacheName } from "./worker";

const ORIGIN = "https://planet.test";
const BUILD = "b2";

class FakeCache {
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
}

function keyOf(request: RequestInfo | URL, ignoreSearch = false): string {
    const url = new URL(
        typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
        ORIGIN,
    );
    if (ignoreSearch) {
        url.search = "";
    }
    return url.href;
}

class FakeCacheStorage {
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
}

type Listener = (event: never) => void;

function client(id: string, frameType = "top-level"): ClientLike {
    return { id, url: `${ORIGIN}/`, type: "window", frameType, postMessage: vi.fn() };
}

function setup(
    options: {
        files?: Record<string, string>;
        buildInfo?: unknown;
        windows?: ClientLike[];
        offline?: boolean;
        caches?: FakeCacheStorage;
        buildId?: string;
    } = {},
) {
    const buildId = options.buildId ?? BUILD;
    const files: Record<string, string> = {
        "/static/planet/build.json": JSON.stringify(
            options.buildInfo ?? {
                build_id: buildId,
                assets: ["/static/dist/a.1.js", `${ORIGIN}/static/dist/b.2.css`],
            },
        ),
        "/static/dist/a.1.js": "a",
        "/static/dist/b.2.css": "b",
        "/": "<!doctype html><title>Planet</title>",
        ...options.files,
    };
    const listeners = new Map<string, Listener>();
    const caches = options.caches ?? new FakeCacheStorage();
    const windows = options.windows ?? [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (options.offline) {
            throw new TypeError("Failed to fetch");
        }
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
        const body = url.origin === ORIGIN ? files[url.pathname] : undefined;
        return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
    });
    const scope = {
        location: { origin: ORIGIN },
        caches: caches as unknown as CacheStorage,
        clients: {
            claim: vi.fn(async () => undefined),
            get: vi.fn(async () => undefined),
            matchAll: vi.fn(async () => windows),
        },
        fetch,
        skipWaiting: vi.fn(async () => undefined),
        addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    } as unknown as ServiceWorkerScopeLike & { fetch: typeof fetch };
    const router = new Router();
    router.untyped("/context", "get", () => ({ config: {} }));
    installServiceWorker(scope, { buildId, router });

    async function extendable<E extends ExtendableEventLike>(type: string, extra: object = {}): Promise<E> {
        const pending: Promise<unknown>[] = [];
        const event = {
            type,
            waitUntil: (promise: Promise<unknown>) => pending.push(promise),
            ...extra,
        } as unknown as E;
        (listeners.get(type) as (event: E) => void)(event);
        while (pending.length) {
            await pending.shift();
        }
        return event;
    }

    async function fetchEvent(input: string | Request, mode?: RequestMode) {
        const request = typeof input === "string" ? new Request(new URL(input, ORIGIN)) : input;
        if (mode) {
            Object.defineProperty(request, "mode", { value: mode });
        }
        let responded: Promise<Response> | undefined;
        await extendable<FetchEventLike>("fetch", {
            request,
            clientId: "c1",
            resultingClientId: "",
            respondWith: (response: Response | Promise<Response>) => {
                responded = Promise.resolve(response);
            },
        });
        return responded ? await responded : undefined;
    }

    return { scope, caches, fetch, extendable, fetchEvent };
}

describe("install", () => {
    it("precaches the build's same-origin assets and the shell, reusing earlier builds' copies", async () => {
        const env = setup({
            buildInfo: {
                build_id: BUILD,
                assets: ["/static/dist/a.1.js", "/static/dist/b.2.css", "https://cdn.example/x.js"],
            },
        });
        (await env.caches.open(staticCacheName("b1"))).entries.set(
            `${ORIGIN}/static/dist/a.1.js`,
            new Response("a from b1"),
        );
        let rules: RouterRule | RouterRule[] | undefined;
        await env.extendable<InstallEventLike>("install", {
            addRoutes: async (value: RouterRule | RouterRule[]) => {
                rules = value;
            },
        });
        const cache = env.caches.caches.get(staticCacheName(BUILD))!;
        expect([...cache.entries.keys()].sort()).toEqual(
            [`${ORIGIN}/`, `${ORIGIN}/static/dist/a.1.js`, `${ORIGIN}/static/dist/b.2.css`].sort(),
        );
        expect(await (await cache.match("/static/dist/a.1.js"))!.text()).toBe("a from b1");
        const fetched = env.fetch.mock.calls.map(([input]) => String(input));
        expect(fetched).not.toContain("/static/dist/a.1.js");
        expect(fetched.some((url) => url.includes("cdn.example"))).toBe(false);
        expect(rules).toMatchObject([
            { condition: { urlPattern: "/static/dist/:file" }, source: { cacheName: staticCacheName(BUILD) } },
            { condition: { urlPattern: "/static/*" }, source: "cache" },
        ]);
    });

    it("fails when build.json describes another build", async () => {
        const env = setup({ buildInfo: { build_id: "other", assets: [] } });
        await expect(env.extendable("install")).rejects.toThrow(/describes build other/);
    });

    it("fails when an asset is missing", async () => {
        const env = setup({ buildInfo: { build_id: BUILD, assets: ["/static/dist/gone.js"] } });
        await expect(env.extendable("install")).rejects.toThrow(/Cannot precache/);
    });
});

describe("activate and messages", () => {
    it("answers build-id on the message port and never skips waiting on its own", async () => {
        const env = setup();
        const port = { postMessage: vi.fn() };
        await env.extendable<ExtendableMessageEventLike>("message", {
            data: { type: "planet:build-id" },
            source: client("w1"),
            ports: [port],
        });
        expect(port.postMessage).toHaveBeenCalledWith({ type: "planet:build-id", build_id: BUILD });
        await env.extendable("install");
        await env.extendable("activate");
        expect(env.scope.skipWaiting).not.toHaveBeenCalled();
        expect(env.scope.clients.claim).toHaveBeenCalled();
        await env.extendable<ExtendableMessageEventLike>("message", {
            data: { type: "planet:skip-waiting" },
            source: client("w1"),
            ports: [],
        });
        expect(env.scope.skipWaiting).toHaveBeenCalledTimes(1);
    });

    it("deletes caches of builds no open page uses", async () => {
        const windows = [client("w-old"), client("w-new"), client("frame", "nested")];
        const env = setup({ windows });
        for (const build of ["b0", "b1", BUILD]) {
            await env.caches.open(staticCacheName(build));
        }
        await env.caches.open("unrelated");
        for (const [id, build] of [
            ["w-old", "b1"],
            ["w-new", BUILD],
        ]) {
            await env.extendable<ExtendableMessageEventLike>("message", {
                data: { type: "planet:build-id", build_id: build },
                source: client(id!),
                ports: [{ postMessage: vi.fn() }],
            });
        }
        await env.extendable("activate");
        expect((await env.caches.keys()).sort()).toEqual(
            [staticCacheName("b1"), staticCacheName(BUILD), "planet-meta", "unrelated"].sort(),
        );
    });

    it("never deletes the cache of a newer build waiting to activate", async () => {
        const caches = new FakeCacheStorage();
        const windows = [client("w1")];
        const active = setup({ caches, windows, buildId: "b1" });
        await active.extendable("install");
        await active.extendable("activate");
        const waiting = setup({ caches, windows, buildId: "b9" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await waiting.extendable("install");
        await active.extendable<ExtendableMessageEventLike>("message", {
            data: { type: "planet:build-id", build_id: "b1" },
            source: client("w1"),
            ports: [{ postMessage: vi.fn() }],
        });
        expect(await caches.has(staticCacheName("b9"))).toBe(true);
        await waiting.extendable("activate");
        expect(await caches.has(staticCacheName("b1"))).toBe(true);
        await waiting.extendable<ExtendableMessageEventLike>("message", {
            data: { type: "planet:build-id", build_id: "b9" },
            source: client("w1"),
            ports: [{ postMessage: vi.fn() }],
        });
        expect(await caches.has(staticCacheName("b1"))).toBe(false);
        expect(await caches.has(staticCacheName("b9"))).toBe(true);
    });

    it("removes its partial cache when the install fails", async () => {
        const env = setup({ buildInfo: { build_id: BUILD, assets: ["/static/dist/a.1.js", "/static/dist/gone.js"] } });
        await expect(env.extendable("install")).rejects.toThrow();
        expect(await env.caches.has(staticCacheName(BUILD))).toBe(false);
    });

    it("keeps every build cache while a page of unknown build is open", async () => {
        const env = setup({ windows: [client("unknown")] });
        await env.caches.open(staticCacheName("b0"));
        await env.extendable("activate");
        expect(await env.caches.has(staticCacheName("b0"))).toBe(true);
    });
});

describe("fetch routing", () => {
    it("ignores cross-origin requests", async () => {
        const env = setup();
        expect(await env.fetchEvent("https://bucket.example/datasets/x/data")).toBeUndefined();
    });

    it("serves /static from cache first, then the network", async () => {
        const env = setup({ files: { "/static/welcome.html": "welcome" } });
        await env.extendable("install");
        env.fetch.mockClear();
        expect(await (await env.fetchEvent("/static/dist/a.1.js"))!.text()).toBe("a");
        expect(env.fetch).not.toHaveBeenCalled();
        expect(await (await env.fetchEvent("/static/welcome.html"))!.text()).toBe("welcome");
        expect(env.fetch).toHaveBeenCalledTimes(1);
        expect(await env.fetchEvent(new Request(`${ORIGIN}/static/x`, { method: "POST" }))).toBeUndefined();
    });

    it("serves entry files from this build's cache, ignoring the build query, and older chunks from any cache", async () => {
        const env = setup();
        const old = await env.caches.open(staticCacheName("b1"));
        await old.put("/static/dist/base.css", new Response("old css"));
        await old.put("/static/dist/chunks/old.1.js", new Response("old chunk"));
        await (await env.caches.open(staticCacheName(BUILD))).put("/static/dist/base.css", new Response("new css"));
        env.fetch.mockClear();
        expect(await (await env.fetchEvent(`/static/dist/base.css?v=${BUILD}`))!.text()).toBe("new css");
        expect(await (await env.fetchEvent("/static/dist/chunks/old.1.js"))!.text()).toBe("old chunk");
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("routes Galaxy paths and answers unknown API paths with a Galaxy 404", async () => {
        const env = setup();
        const context = await env.fetchEvent("/context");
        expect(await context!.json()).toEqual({ config: {} });
        const missing = await env.fetchEvent("/api/does/not/exist");
        expect(missing!.status).toBe(404);
        expect((await missing!.json()).err_code).toBe(404001);
        expect(missing!.headers.get("X-Request-ID")).toBeTruthy();
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("sends other navigations to the network and falls back to the cached shell offline", async () => {
        const online = setup({ files: { "/histories/list": "spa" } });
        expect(await (await online.fetchEvent("/histories/list", "navigate"))!.text()).toBe("spa");
        expect(await online.fetchEvent("/favicon.ico")).toBeUndefined();

        const env = setup();
        await env.extendable("install");
        const offline = setup({ offline: true });
        for (const [name, cache] of env.caches.caches) {
            offline.caches.caches.set(name, cache);
        }
        const shell = await offline.fetchEvent("/datasets/abc/details", "navigate");
        expect(await shell!.text()).toContain("<title>Planet</title>");
    });

    it("classifies routed paths", () => {
        for (const path of [
            "/context",
            "/welcome",
            "/welcome/",
            "/api",
            "/api/histories",
            "/history/current_history_json",
            "/dataset/display",
            "/datasets/abc/display",
            "/datasets/abc/display/",
            "/datasets/abc/display/sub/file.png",
        ]) {
            expect(isRoutedPath(path), path).toBe(true);
        }
        for (const path of ["/", "/datasets/abc/details", "/datasets/list", "/histories/list", "/static/x", "/apis"]) {
            expect(isRoutedPath(path), path).toBe(false);
        }
    });
});
