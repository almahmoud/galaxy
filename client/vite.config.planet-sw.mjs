/**
 * Planet classic scripts, each bundled into one self-contained IIFE file:
 *
 *   PLANET_SCRIPT=sw   (default)  src/planet/sw/index.ts   -> planet/dist/sw.js
 *   PLANET_SCRIPT=boot            src/planet/boot/boot.ts  -> planet/dist/static/planet/boot.js (+ boot.css)
 *
 * The service worker is registered as a classic script, so it cannot use ES
 * module imports at runtime; the boot script runs before any module is loaded.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const TARGETS = {
    sw: {
        entry: "src/planet/sw/index.ts",
        outDir: "planet/dist",
        fileName: "sw.js",
    },
    boot: {
        entry: "src/planet/boot/boot.ts",
        outDir: "planet/dist/static/planet",
        fileName: "boot.js",
        cssFileName: "boot",
    },
};

export default defineConfig(() => {
    const targetName = process.env.PLANET_SCRIPT || "sw";
    const target = TARGETS[targetName];
    if (!target) {
        throw new Error(`Unknown PLANET_SCRIPT "${targetName}"; expected one of ${Object.keys(TARGETS).join(", ")}`);
    }
    const entry = resolve(__dirname, target.entry);
    if (!existsSync(entry)) {
        throw new Error(`${target.entry} does not exist`);
    }

    return {
        root: __dirname,
        publicDir: false,
        resolve: {
            alias: [{ find: /^@\//, replacement: `${resolve(__dirname, "src")}/` }],
        },
        define: {
            __PLANET_BUILD_ID__: JSON.stringify(process.env.PLANET_BUILD_ID || "dev"),
            // Library mode leaves process.env in place for consumers; these files have none.
            "process.env.NODE_ENV": JSON.stringify("production"),
        },
        build: {
            outDir: resolve(repoRoot, target.outDir),
            emptyOutDir: false,
            copyPublicDir: false,
            target: "es2022",
            minify: true,
            sourcemap: !!process.env.GXY_BUILD_SOURCEMAPS,
            reportCompressedSize: false,
            lib: {
                entry,
                formats: ["iife"],
                name: targetName === "sw" ? "PlanetServiceWorker" : "PlanetBoot",
                fileName: () => target.fileName,
                cssFileName: target.cssFileName,
            },
        },
    };
});
