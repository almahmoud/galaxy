// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILD_INFO_PATH, BUILD_MANIFEST_KEY, type BuildInfo, staticCacheName } from "./build";
import { FAKE_ORIGIN, FakeCacheStorage } from "./caches.fixtures";
import { sha256Hex } from "./digest";
import { readStaticFile, type StaticDataSource } from "./staticData";

const BUILD = "b2";
const CONFIG = "/static/planet/data/config.json";
const TOOLS = "/static/planet/data/toolbox/tools.json";

async function describeBuild(files: Record<string, string>, buildId = BUILD): Promise<BuildInfo> {
    const digests = await Promise.all(Object.entries(files).map(async ([path, body]) => [path, await sha256Hex(body)]));
    return { build_id: buildId, files: Object.fromEntries(digests), boot: [], lazy: [] };
}

/** A site serving `network` and a worker cache for BUILD holding `cached` and, unless `manifest` is null, its build description. */
async function setup(options: {
    network: Record<string, string>;
    cached?: Record<string, string>;
    manifest?: BuildInfo | null;
    buildId?: string;
}) {
    const caches = new FakeCacheStorage();
    const cache = await caches.open(staticCacheName(BUILD));
    for (const [path, body] of Object.entries(options.cached ?? {})) {
        await cache.put(path, new Response(body));
    }
    if (options.manifest !== null) {
        const manifest = options.manifest ?? (await describeBuild({ [CONFIG]: '{"brand":"b2"}' }));
        await cache.put(BUILD_MANIFEST_KEY, new Response(JSON.stringify(manifest)));
    }
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), FAKE_ORIGIN).pathname;
        const body = options.network[path];
        return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
    });
    const source: StaticDataSource = {
        buildId: options.buildId ?? BUILD,
        fetch: fetch as unknown as typeof globalThis.fetch,
        caches: caches.asCacheStorage(),
    };
    return { caches, cache, fetch, source };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("readStaticFile", () => {
    it("reads the build's own cache without the network", async () => {
        const env = await setup({ network: { [CONFIG]: '{"brand":"b3"}' }, cached: { [CONFIG]: '{"brand":"b2"}' } });
        expect(await readStaticFile(CONFIG, env.source)).toEqual({ brand: "b2" });
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("never reads another build's cache", async () => {
        const env = await setup({ network: { [CONFIG]: '{"brand":"b2"}' } });
        await (await env.caches.open(staticCacheName("b1"))).put(CONFIG, new Response('{"brand":"b1"}'));
        expect(await readStaticFile(CONFIG, env.source)).toEqual({ brand: "b2" });
    });

    it("keeps a fetched file that matches the build's digest", async () => {
        const env = await setup({ network: { [CONFIG]: '{"brand":"b2"}' } });
        expect(await readStaticFile(CONFIG, env.source)).toEqual({ brand: "b2" });
        expect(env.fetch).toHaveBeenCalledWith(CONFIG, { credentials: "same-origin", cache: "no-cache" });
        expect(await env.cache.text(CONFIG)).toBe('{"brand":"b2"}');
    });

    it("refuses and does not keep a file from another deploy", async () => {
        const env = await setup({ network: { [CONFIG]: '{"brand":"b3"}' } });
        await expect(readStaticFile(CONFIG, env.source)).rejects.toThrow(/belongs to another build.*reload the page/);
        expect(await env.cache.text(CONFIG)).toBeUndefined();
    });

    it("refuses files the build does not list", async () => {
        const env = await setup({ network: { [TOOLS]: "[]" } });
        await expect(readStaticFile(TOOLS, env.source)).rejects.toThrow(/is not part of build b2/);
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("falls back to the deployed build.json only while it describes this build", async () => {
        const deployed = await setup({
            network: {
                [CONFIG]: '{"brand":"b2"}',
                [BUILD_INFO_PATH]: JSON.stringify(await describeBuild({ [CONFIG]: '{"brand":"b2"}' })),
            },
            manifest: null,
        });
        expect(await readStaticFile(CONFIG, deployed.source)).toEqual({ brand: "b2" });
        expect(await deployed.cache.match(BUILD_MANIFEST_KEY)).toBeDefined();

        const replaced = await setup({
            network: {
                [CONFIG]: '{"brand":"b3"}',
                [BUILD_INFO_PATH]: JSON.stringify(await describeBuild({ [CONFIG]: '{"brand":"b3"}' }, "b3")),
            },
            manifest: null,
        });
        await expect(readStaticFile(CONFIG, replaced.source)).rejects.toThrow(/Planet was updated; reload the page/);
    });

    it("looks up percent-encoded paths under the file names build.json records", async () => {
        const bundle = "/static/planet/data/toolbox/bundles/repos/iuc/datamash_ops/1.9+galaxy0.json";
        const encoded = "/static/planet/data/toolbox/bundles/repos/iuc/datamash_ops/1.9%2Bgalaxy0.json";
        const fetched = await setup({
            network: { [bundle]: '{"id":"datamash_ops"}' },
            manifest: await describeBuild({ [bundle]: '{"id":"datamash_ops"}' }),
        });
        expect(await readStaticFile(encoded, fetched.source)).toEqual({ id: "datamash_ops" });
        expect(fetched.fetch).toHaveBeenCalledWith(bundle, { credentials: "same-origin", cache: "no-cache" });

        const cached = await setup({ network: {}, cached: { [bundle]: '{"id":"cached"}' } });
        expect(await readStaticFile(encoded, cached.source)).toEqual({ id: "cached" });
        expect(cached.fetch).not.toHaveBeenCalled();
    });

    it("rejects malformed and segment-joining escapes", async () => {
        const env = await setup({ network: {} });
        await expect(readStaticFile("/static/planet/data/%E0%A4%A.json", env.source)).rejects.toThrow(
            /is not a valid path/,
        );
        await expect(readStaticFile("/static/planet/data/a%2F..%2Fconfig.json", env.source)).rejects.toThrow(
            /is not a valid path/,
        );
        expect(env.fetch).not.toHaveBeenCalled();
    });

    it("reads the network directly in unbundled code", async () => {
        const env = await setup({ network: { [CONFIG]: '{"brand":"dev"}' }, manifest: null, buildId: "dev" });
        expect(await readStaticFile(CONFIG, env.source)).toEqual({ brand: "dev" });
    });

    it("reports files that are not JSON", async () => {
        const env = await setup({ network: {}, cached: { [CONFIG]: "not json" } });
        await expect(readStaticFile(CONFIG, env.source)).rejects.toThrow(/is not valid JSON/);
    });
});

describe("loadOptionalStaticData", () => {
    it("treats files of another deploy as errors, not as missing files", async () => {
        const env = await setup({
            network: { [TOOLS]: '["b3 tool"]' },
            manifest: await describeBuild({ [TOOLS]: '["b2 tool"]' }),
        });
        vi.stubGlobal("__PLANET_BUILD_ID__", BUILD);
        vi.stubGlobal("caches", env.caches.asCacheStorage());
        vi.stubGlobal("fetch", env.fetch);
        const { loadOptionalStaticData } = await import("./staticData");
        await expect(loadOptionalStaticData("toolbox/tools.json")).rejects.toThrow(/belongs to another build/);
        expect(await loadOptionalStaticData("toolbox/panel.json")).toBeUndefined();
    });
});
