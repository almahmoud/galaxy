/**
 * Planet build of the Galaxy client: static bundles for planet/dist/static/dist.
 *
 * Derived from vite.config.mjs. Differences: no Galaxy server integration (build
 * metadata, dev proxy), the Planet welcome entry instead of `generic`, Vue's
 * runtime-only build (no template compiler, so no `new Function` under CSP),
 * hashed files in chunks/ and assets/ for immutable caching, and a deterministic
 * build timestamp.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import galaxyConfig from "./vite.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const PLANET_DIST = resolve(repoRoot, "planet/dist");
const PLANET_BUILD_ID = process.env.PLANET_BUILD_ID || "dev";

const OUT_DIR = resolve(PLANET_DIST, "static/dist");
const WELCOME_ENTRY = resolve(__dirname, "src/planet/ui/main.ts");
const DROPPED_PLUGINS = new Set(["vite-plugin-build-metadata", "galaxy-dev-server"]);

const VUE_RUNTIME = "@vue/compat/dist/vue.runtime.esm-bundler.js";
const VUE_RUNTIME_ID = /[\\/]@vue[\\/]compat[\\/]dist[\\/]vue\.runtime\.esm-bundler\.js(\?.*)?$/;
const VUE_FULL_ID = /[\\/]@vue[\\/]compat[\\/]dist[\\/]vue\.esm-bundler\.js(\?.*)?$/;

/** ISO timestamp from SOURCE_DATE_EPOCH, else the HEAD commit date, so rebuilds of one commit are identical. */
function sourceDate() {
    const epoch = Number(process.env.SOURCE_DATE_EPOCH);
    if (Number.isFinite(epoch) && epoch > 0) {
        return new Date(epoch * 1000).toISOString();
    }
    try {
        const committed = execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: repoRoot, encoding: "utf8" });
        return new Date(committed.trim()).toISOString();
    } catch {
        return new Date(0).toISOString();
    }
}

/**
 * Returns [before, after] text pairs for one file of a unified diff. Only
 * replacement hunks (removed lines followed by added lines) are supported.
 */
function parsePatchReplacements(patchText, file) {
    const header = `diff --git a/${file} b/${file}`;
    const start = patchText.indexOf(header);
    if (start === -1) {
        throw new Error(`${file} is not part of the patch`);
    }
    const next = patchText.indexOf("\ndiff --git ", start + header.length);
    const lines = patchText.slice(start, next === -1 ? undefined : next).split("\n");
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
    const replacements = [];
    let removed = [];
    let added = [];
    const flush = () => {
        if (added.length && !removed.length) {
            throw new Error(`Pure insertion hunks in ${file} cannot be applied without context`);
        }
        if (removed.length) {
            replacements.push([removed.join("\n"), added.join("\n")]);
        }
        removed = [];
        added = [];
    };
    for (const line of lines.slice(firstHunk)) {
        if (line.startsWith("-")) {
            if (added.length) {
                flush();
            }
            removed.push(line.slice(1));
        } else if (line.startsWith("+")) {
            added.push(line.slice(1));
        } else {
            flush();
        }
    }
    flush();
    return replacements;
}

function applyReplacements(source, replacements, label) {
    let result = source;
    for (const [before, after] of replacements) {
        const first = result.indexOf(before);
        if (first === -1 || result.indexOf(before, first + before.length) !== -1) {
            throw new Error(`${label}: patch hunk does not match exactly once:\n${before}`);
        }
        result = result.slice(0, first) + after + result.slice(first + before.length);
    }
    return result;
}

/**
 * Resolves `vue` to the runtime-only compat build and applies the repository's
 * @vue/compat patch, which pnpm only applies to the full builds, to it.
 */
function vueRuntimeOnlyPlugin() {
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
    const patches = packageJson.pnpm?.patchedDependencies ?? {};
    const patchKey = Object.keys(patches).find((key) => key.startsWith("@vue/compat@"));
    const replacements = patchKey
        ? parsePatchReplacements(readFileSync(resolve(__dirname, patches[patchKey]), "utf8"), "dist/vue.esm-bundler.js")
        : [];
    let runtimeLoaded = false;
    return {
        name: "planet-vue-runtime-only",
        // Runs after galaxyLegacyPlugin's config hook so these aliases take precedence over its `^vue$`.
        config: {
            order: "post",
            handler: () => ({
                resolve: {
                    alias: [
                        { find: /^vue$/, replacement: VUE_RUNTIME },
                        { find: /^vue\/dist\/vue\.esm\.js$/, replacement: VUE_RUNTIME },
                    ],
                },
            }),
        },
        buildStart() {
            runtimeLoaded = false;
        },
        load: {
            filter: { id: VUE_FULL_ID },
            handler(id) {
                this.error(`${id} includes Vue's template compiler; only the runtime build may be bundled`);
            },
        },
        transform: {
            filter: { id: VUE_RUNTIME_ID },
            handler(code) {
                runtimeLoaded = true;
                return replacements.length
                    ? { code: applyReplacements(code, replacements, patchKey), map: null }
                    : null;
            },
        },
        buildEnd(error) {
            if (!error && !runtimeLoaded) {
                this.error(`${VUE_RUNTIME} was not bundled; check the vue alias`);
            }
        },
    };
}

export default defineConfig(async (env) => {
    const config = await galaxyConfig(env);

    config.plugins = [
        ...config.plugins.flat(Infinity).filter((plugin) => plugin && !DROPPED_PLUGINS.has(plugin.name)),
        vueRuntimeOnlyPlugin(),
    ];

    const aliases = { ...config.resolve.alias };
    delete aliases.vue;
    delete aliases["vue/dist/vue.esm.js"];
    config.resolve.alias = aliases;

    config.define = {
        ...config.define,
        __buildTimestamp__: JSON.stringify(sourceDate()),
        __PLANET_BUILD_ID__: JSON.stringify(PLANET_BUILD_ID),
    };

    delete config.server.proxy;

    const input = {
        libs: resolve(__dirname, "src/entry/libs.js"),
        analysis: resolve(__dirname, "src/entry/analysis/index.ts"),
    };
    if (existsSync(WELCOME_ENTRY)) {
        input["planet-welcome"] = WELCOME_ENTRY;
    } else {
        console.warn(`[planet] ${WELCOME_ENTRY} does not exist; building without planet-welcome.bundled.js`);
    }

    const output = config.build.rolldownOptions.output;
    config.build = {
        ...config.build,
        outDir: OUT_DIR,
        emptyOutDir: true,
        manifest: false,
        copyPublicDir: false,
        reportCompressedSize: false,
        rolldownOptions: {
            ...config.build.rolldownOptions,
            input,
            output: {
                ...output,
                chunkFileNames: "chunks/[name]-[hash].js",
                assetFileNames: (assetInfo) => {
                    const name = assetInfo.names?.[0] ?? assetInfo.name ?? "";
                    return name.endsWith(".css") ? "base.css" : "assets/[name]-[hash][extname]";
                },
            },
        },
    };

    return config;
});
