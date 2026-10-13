// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { BUILD_MANIFEST_KEY, type BuildInfo } from "@/planet/util/build";
import { FakeCacheStorage } from "@/planet/util/caches.fixtures";
import { sha256Hex } from "@/planet/util/digest";

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
import { installServiceWorker, isRoutedPath, staticCacheName, WARM_BUDGET_MS } from "./worker";

const ORIGIN = "https://planet.test";
const BUILD = "b2";

const ENTRY = "/static/dist/analysis.bundled.js";
const STYLE = "/static/dist/base.css";
const BOOT_CHUNK = "/static/dist/chunks/app-1.js";
const LAZY = ["/static/dist/chunks/lazy-1.js", "/static/dist/assets/font-1.woff2"];

/** Site files of the build under test. */
const SITE: Record<string, string> = {
    [ENTRY]: "analysis b2",
    [STYLE]: "css b2",
    [BOOT_CHUNK]: "app",
    [LAZY[0]!]: "lazy",
    [LAZY[1]!]: "font",
    "/": "<!doctype html><title>Planet</title>",
};

/** build.json for `files`: digests of the stable-named ones, the boot chunk and the lazy files. */
async function describeBuild(buildId: string, files: Record<string, string> = SITE): Promise<BuildInfo> {
    const stable = [ENTRY, STYLE].filter((path) => path in files);
    return {
        build_id: buildId,
        files: Object.fromEntries(await Promise.all(stable.map(async (path) => [path, await sha256Hex(files[path]!)]))),
        boot: [BOOT_CHUNK],
        lazy: LAZY,
    };
}

type Listener = (event: never) => void;

function client(id: string, frameType = "top-level"): ClientLike {
    return { id, url: `${ORIGIN}/`, type: "window", frameType, postMessage: vi.fn() };
}

async function setup(
    options: {
        files?: Record<string, string>;
        buildInfo?: unknown;
        windows?: ClientLike[];
        offline?: boolean;
        caches?: FakeCacheStorage;
        buildId?: string;
        /** Answers a request before `files` do. */
        respond?: (path: string) => Response | undefined | Promise<Response | undefined>;
        now?: () => number;
    } = {},
) {
    const buildId = options.buildId ?? BUILD;
    const files: Record<string, string> = { ...SITE, ...options.files };
    files["/static/planet/build.json"] = JSON.stringify(options.buildInfo ?? (await describeBuild(buildId, files)));
    const listeners = new Map<string, Listener>();
    const caches = options.caches ?? new FakeCacheStorage();
    const windows = options.windows ?? [];
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (options.offline) {
            throw new TypeError("Failed to fetch");
        }
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
        const answer = url.origin === ORIGIN ? await options.respond?.(url.pathname) : undefined;
        if (answer) {
            return answer;
        }
        const body = url.origin === ORIGIN ? files[url.pathname] : undefined;
        return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
    });
    const scope = {
        location: { origin: ORIGIN },
        caches: caches.asCacheStorage(),
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
    installServiceWorker(scope, { buildId, router, retryDelays: [0, 0], now: options.now });

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

    /** A page reporting its build, which also resumes background caching. */
    function report(id = "w1", build = buildId) {
        return extendable<ExtendableMessageEventLike>("message", {
            data: { type: "planet:build-id", build_id: build },
            source: client(id),
            ports: [{ postMessage: vi.fn() }],
        });
    }

    const fetched = () => fetch.mock.calls.map(([input]) => String(input));
    const cache = () => caches.caches.get(staticCacheName(buildId));

    return { scope, caches, fetch, fetched, cache, extendable, fetchEvent, report };
}

describe("install", () => {
    it("precaches the stable-named files, the boot chunks and the shell, but not the lazy files", async () => {
        const env = await setup();
        let rules: RouterRule | RouterRule[] | undefined;
        await env.extendable<InstallEventLike>("install", {
            addRoutes: async (value: RouterRule | RouterRule[]) => {
                rules = value;
            },
        });
        const cache = env.cache()!;
        expect([...cache.entries.keys()].sort()).toEqual(
            [
                `${ORIGIN}/`,
                `${ORIGIN}${ENTRY}`,
                `${ORIGIN}${STYLE}`,
                `${ORIGIN}${BOOT_CHUNK}`,
                `${ORIGIN}${BUILD_MANIFEST_KEY}`,
            ].sort(),
        );
        expect(await cache.text(ENTRY)).toBe("analysis b2");
        expect(JSON.parse((await cache.text(BUILD_MANIFEST_KEY))!)).toEqual(await describeBuild(BUILD));
        expect(env.fetched().filter((url) => LAZY.includes(url))).toEqual([]);
        expect(rules).toMatchObject([
            { condition: { urlPattern: "/static/dist/:file" }, source: { cacheName: staticCacheName(BUILD) } },
            { condition: { urlPattern: "/static/welcome.html" }, source: { cacheName: staticCacheName(BUILD) } },
            { condition: { urlPattern: "/static/*" }, source: "cache" },
        ]);
    });

    it("downloads stable-named files past the HTTP cache instead of copying an older build's", async () => {
        const env = await setup();
        const old = await env.caches.open(staticCacheName("b1"));
        await old.put(ENTRY, new Response("analysis b1"));
        await old.put(BOOT_CHUNK, new Response("app from b1"));
        await env.extendable("install");
        expect(await env.cache()!.text(ENTRY)).toBe("analysis b2");
        expect(env.fetch).toHaveBeenCalledWith(ENTRY, { cache: "no-cache" });
        expect(await env.cache()!.text(BOOT_CHUNK)).toBe("app from b1");
        expect(env.fetched()).not.toContain(BOOT_CHUNK);
    });

    it("fails without a cache when a stable-named file is another build's", async () => {
        const env = await setup({ respond: (path) => (path === ENTRY ? new Response("analysis b1") : undefined) });
        await expect(env.extendable("install")).rejects.toThrow(/is not the file of build b2/);
        expect(env.cache()).toBeUndefined();
    });

    it("fails when build.json describes another build", async () => {
        const env = await setup({ buildInfo: { build_id: "other", files: {}, boot: [], lazy: [] } });
        await expect(env.extendable("install")).rejects.toThrow(/describes build other/);
    });

    it("rejects build descriptions of the old shape", async () => {
        const env = await setup({ buildInfo: { build_id: BUILD, assets: [ENTRY] } });
        await expect(env.extendable("install")).rejects.toThrow(/Invalid build description/);
    });

    it("fails when a file is missing, without retrying", async () => {
        const env = await setup({
            buildInfo: { build_id: BUILD, files: {}, boot: ["/static/dist/chunks/gone-1.js"], lazy: [] },
        });
        await expect(env.extendable("install")).rejects.toThrow(
            /Cannot cache \/static\/dist\/chunks\/gone-1\.js: HTTP 404/,
        );
        expect(env.fetched().filter((url) => url.includes("gone"))).toHaveLength(1);
    });

    it("retries network failures and server errors", async () => {
        let attempts = 0;
        const env = await setup({
            respond: (path) => {
                if (path !== BOOT_CHUNK) {
                    return undefined;
                }
                attempts += 1;
                if (attempts === 1) {
                    throw new TypeError("Failed to fetch");
                }
                return attempts === 2 ? new Response("busy", { status: 503 }) : undefined;
            },
        });
        await env.extendable("install");
        expect(attempts).toBe(3);
        expect(await env.cache()!.text(BOOT_CHUNK)).toBe("app");
    });
});

describe("background caching", () => {
    it("caches the lazy files after activation without holding it up", async () => {
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const env = await setup({ respond: async (path) => (path === LAZY[0] ? (await held, undefined) : undefined) });
        await env.extendable("install");
        await env.extendable("activate");
        expect(await env.cache()!.text(LAZY[0]!)).toBeUndefined();
        release();
        await env.report();
        expect(await env.cache()!.text(LAZY[0]!)).toBe("lazy");
        expect(await env.cache()!.text(LAZY[1]!)).toBe("font");
    });

    it("skips files that fail and caches them on a later run", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        let available = false;
        const env = await setup({
            respond: (path) => (path === LAZY[0] && !available ? new Response("busy", { status: 503 }) : undefined),
        });
        await env.extendable("install");
        await env.report();
        expect(await env.cache()!.text(LAZY[0]!)).toBeUndefined();
        expect(await env.cache()!.text(LAZY[1]!)).toBe("font");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not cache 1 file(s) of build b2"));
        available = true;
        env.fetch.mockClear();
        await env.report();
        expect(await env.cache()!.text(LAZY[0]!)).toBe("lazy");
        expect(env.fetched()).toEqual([LAZY[0]]);
        warn.mockRestore();
    });

    it("stops starting downloads when its time budget is spent", async () => {
        const later = "/static/dist/chunks/later-1.js";
        let clock = 0;
        const env = await setup({
            now: () => clock,
            files: { [later]: "later" },
            buildInfo: { ...(await describeBuild(BUILD)), lazy: [...LAZY, later] },
            respond: (path) => {
                if (path === LAZY[0]) {
                    clock += WARM_BUDGET_MS + 1;
                }
                return undefined;
            },
        });
        await env.extendable("install");
        await env.report();
        expect(await env.cache()!.text(LAZY[0]!)).toBe("lazy");
        expect(await env.cache()!.text(later)).toBeUndefined();
        expect(env.fetched()).not.toContain(later);
    });

    it("does nothing for a build without a complete cache", async () => {
        const env = await setup();
        await env.report();
        expect(env.cache()).toBeUndefined();
        expect(env.fetch).not.toHaveBeenCalled();
    });
});

describe("activate and messages", () => {
    it("answers build-id on the message port and never skips waiting on its own", async () => {
        const env = await setup();
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
        const env = await setup({ windows });
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
        const active = await setup({ caches, windows, buildId: "b1" });
        await active.extendable("install");
        await active.extendable("activate");
        const waiting = await setup({ caches, windows, buildId: "b9" });
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
        const env = await setup({
            buildInfo: { ...(await describeBuild(BUILD)), boot: [BOOT_CHUNK, "/static/dist/chunks/gone-1.js"] },
        });
        await expect(env.extendable("install")).rejects.toThrow();
        expect(await env.caches.has(staticCacheName(BUILD))).toBe(false);
    });

    it("keeps every build cache while a page of unknown build is open", async () => {
        const env = await setup({ windows: [client("unknown")] });
        await env.caches.open(staticCacheName("b0"));
        await env.extendable("activate");
        expect(await env.caches.has(staticCacheName("b0"))).toBe(true);
    });
});

describe("fetch routing", () => {
    it("ignores cross-origin requests", async () => {
        const env = await setup();
        expect(await env.fetchEvent("https://bucket.example/datasets/x/data")).toBeUndefined();
    });

    it("serves /static from cache first, then the network", async () => {
        const env = await setup({ files: { "/static/welcome.html": "welcome" } });
        await env.extendable("install");
        env.fetch.mockClear();
        expect(await (await env.fetchEvent(BOOT_CHUNK))!.text()).toBe("app");
        expect(env.fetch).not.toHaveBeenCalled();
        expect(await (await env.fetchEvent("/static/welcome.html"))!.text()).toBe("welcome");
        expect(env.fetch).toHaveBeenCalledTimes(1);
        expect(await env.fetchEvent(new Request(`${ORIGIN}/static/x`, { method: "POST" }))).toBeUndefined();
    });

    it("serves entry files from this build's cache, ignoring the build query, and older chunks from any cache", async () => {
        const env = await setup();
        const old = await env.caches.open(staticCacheName("b1"));
        await old.put("/static/dist/base.css", new Response("old css"));
        await old.put("/static/dist/chunks/old.1.js", new Response("old chunk"));
        await (await env.caches.open(staticCacheName(BUILD))).put("/static/dist/base.css", new Response("new css"));
        env.fetch.mockClear();
        expect(await (await env.fetchEvent(`/static/dist/base.css?v=${BUILD}`))!.text()).toBe("new css");
        expect(await (await env.fetchEvent("/static/dist/chunks/old.1.js"))!.text()).toBe("old chunk");
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("never serves another build's copy of a stable-named file", async () => {
        const env = await setup({ files: { "/static/welcome.html": "welcome b2" } });
        await (await env.caches.open(staticCacheName("b1"))).put("/static/welcome.html", new Response("welcome b1"));
        expect(await (await env.fetchEvent("/static/welcome.html"))!.text()).toBe("welcome b2");
    });

    it("routes Galaxy paths and answers unknown API paths with a Galaxy 404", async () => {
        const env = await setup();
        const context = await env.fetchEvent("/context");
        expect(await context!.json()).toEqual({ config: {} });
        const missing = await env.fetchEvent("/api/does/not/exist");
        expect(missing!.status).toBe(404);
        expect((await missing!.json()).err_code).toBe(404001);
        expect(missing!.headers.get("X-Request-ID")).toBeTruthy();
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("sends other navigations to the network and falls back to the cached shell offline", async () => {
        const online = await setup({ files: { "/histories/list": "spa" } });
        expect(await (await online.fetchEvent("/histories/list", "navigate"))!.text()).toBe("spa");
        expect(await online.fetchEvent("/favicon.ico")).toBeUndefined();

        const env = await setup();
        await env.extendable("install");
        const offline = await setup({ offline: true });
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
