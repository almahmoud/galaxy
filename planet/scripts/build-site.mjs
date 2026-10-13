#!/usr/bin/env node
/**
 * Builds the deployable Planet site into planet/dist.
 *
 *   PLANET_RUNTIME_IMAGE=ghcr.io/<owner>/planet-runtime@sha256:<digest> \
 *       node planet/scripts/build-site.mjs [--verbose]
 *
 * The build id is the short git SHA plus a hash of the built files. Files are
 * hashed while they still carry a placeholder id, so the id depends only on
 * the sources, and the files that embed it are rebuilt with the final value.
 *
 * PLANET_RUNTIME_IMAGE names the planet-runtime image built from the same
 * commit. It is written to static/planet/data/runtime.json, the default image
 * of job pods; pin it by digest. Without it, jobs default to a movable tag.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clientDir = join(root, "client");
const siteDir = join(root, "planet/site");
const distDir = join(root, "planet/dist");
const buildDir = join(root, "planet/build");
const logDir = join(buildDir, "logs");
const generatedStaticDir = join(buildDir, "generated/static");
const generatedToolReposDir = join(buildDir, "generated/toolrepos");
const dataDir = join(generatedStaticDir, "planet/data");
/** Site directory of the tool archives that bundles reference with source.repo_tar.path. */
const TOOL_REPOS_PATH = "static/planet/toolrepos";

/** Value compiled in place of __PLANET_BUILD_ID__ until the real id is known. */
const PLACEHOLDER_ID = "planet-build-id-placeholder";
/** Token in the HTML shells replaced by the build id. */
const HTML_TOKEN = "__PLANET_BUILD_ID__";

const CLIENT_ENTRIES = ["libs.bundled.js", "analysis.bundled.js", "base.css"];
/** Planet's own page entries; neither may load Galaxy's analysis entry, which mounts the Galaxy app. */
const PLANET_ENTRIES = {
    "planet-welcome.bundled.js": "client/src/planet/ui/main.ts",
    "planet-leader.bundled.js": "client/src/planet/leader/main.ts",
};
const SCRIPT_ENTRIES = {
    sw: "client/src/planet/sw/index.ts",
    boot: "client/src/planet/boot/boot.ts",
};
const REPO_STATIC = ["style/jquery-ui", "favicon.svg", "favicon.ico", "robots.txt"];
/** Stable-named files a page loads before Galaxy's entries, precached with them. */
const BOOT_FILES = ["static/planet/boot.js", "static/planet/boot.css", "static/welcome.html"];
/** Site path of the runtime image data (client/src/planet/ui/lib/runtime.ts). */
const RUNTIME_DATA = "static/planet/data/runtime.json";
/** [registry[:port]/]repository[:tag][@sha256:digest], as the setup page validates it. */
const IMAGE_REFERENCE =
    /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?\/)?[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(\/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*(:\w[\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/;
const GENERATED_DATA = {
    datatypes: "datatypes/index.json",
    toolbox: "toolbox/panel.json",
    genomes: "genomes.json",
};
// Workers Static Assets limits (Free plan): files per version and bytes per file.
const MAX_FILES = 20000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|txt|map)$/;

const verbose = process.argv.includes("--verbose");
const timings = [];
const warnings = [];

function warn(message) {
    warnings.push(message);
    console.warn(`warning: ${message}`);
}

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

function step(name, action) {
    const started = performance.now();
    const note = action();
    const seconds = (performance.now() - started) / 1000;
    timings.push({ name, seconds, note });
    console.log(`  ${name.padEnd(22)} ${seconds.toFixed(1).padStart(6)} s${note ? `  (${note})` : ""}`);
}

function run(name, command, args, { cwd = root, env = {} } = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: verbose ? "inherit" : "pipe",
        maxBuffer: 256 * 1024 * 1024,
    });
    if (!verbose) {
        mkdirSync(logDir, { recursive: true });
        writeFileSync(join(logDir, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    if (result.status !== 0) {
        if (!verbose) {
            const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd().split("\n");
            console.error(output.slice(-40).join("\n"));
            console.error(`(full log: ${relative(root, join(logDir, `${name}.log`))})`);
        }
        fail(`${name} failed${result.error ? `: ${result.error.message}` : ""}`);
    }
}

function walk(dir) {
    if (!existsSync(dir)) {
        return [];
    }
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walk(path));
        } else {
            files.push(path);
        }
    }
    return files;
}

/** Site-relative path with forward slashes. */
function sitePath(file) {
    return relative(distDir, file).split(sep).join("/");
}

function gitShortSha() {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "nogit";
}

function newestMtime(dir, exclude) {
    return Math.max(
        0,
        ...walk(dir)
            .filter((file) => !exclude.test(file))
            .map((file) => statSync(file).mtimeMs),
    );
}

function viteBuild(name, config, buildId, env = {}) {
    run(name, process.execPath, [join(clientDir, "node_modules/vite/bin/vite.js"), "build", "--config", config], {
        cwd: clientDir,
        env: { NODE_ENV: "production", PLANET_BUILD_ID: buildId, ...env },
    });
}

function buildClient(buildId) {
    viteBuild("client", "vite.config.planet.mjs", buildId);
    for (const entry of CLIENT_ENTRIES) {
        if (!existsSync(join(distDir, "static/dist", entry))) {
            fail(`client build did not produce static/dist/${entry}`);
        }
    }
    for (const [entry, source] of Object.entries(PLANET_ENTRIES)) {
        const file = join(distDir, "static/dist", entry);
        if (!existsSync(file)) {
            if (existsSync(join(root, source))) {
                fail(`client build did not produce static/dist/${entry}`);
            }
            warn(`${source} is missing; built without ${entry}`);
        } else if (staticImportGraph(file).has(join(distDir, "static/dist/analysis.bundled.js"))) {
            // The analysis entry mounts Galaxy on window load: in the welcome page it would replace the welcome
            // app, and loaded again by the leader it would mount a second Galaxy.
            fail(`${entry} statically imports analysis.bundled.js`);
        }
    }
}

function buildScript(target, buildId) {
    if (!existsSync(join(root, SCRIPT_ENTRIES[target]))) {
        warn(`${SCRIPT_ENTRIES[target]} is missing; skipped the ${target} build`);
        return false;
    }
    viteBuild(target === "sw" ? "service-worker" : "boot", "vite.config.planet-sw.mjs", buildId, {
        PLANET_SCRIPT: target,
    });
    return true;
}

function copyInto(source, target) {
    cpSync(source, target, { recursive: true, dereference: true, errorOnExist: false, force: true });
}

function contentHash(files) {
    const hash = createHash("sha256");
    for (const file of [...files].sort((a, b) => (sitePath(a) < sitePath(b) ? -1 : 1))) {
        hash.update(sitePath(file));
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
    }
    return hash.digest("hex");
}

const STATIC_IMPORT = /(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+)["']/g;

/** Files reached from `entry` through static imports and re-exports (dynamic imports excluded). */
function staticImportGraph(entry) {
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file) || !existsSync(file)) {
            continue;
        }
        seen.add(file);
        for (const [, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
            if (specifier.startsWith(".")) {
                queue.push(resolve(dirname(file), specifier));
            }
        }
    }
    return seen;
}

/** True for files whose name carries a content hash (the client build's chunk and asset names). */
function isContentHashed(path) {
    return /^\/static\/dist\/(?:chunks|assets)\//.test(path);
}

/** The runtime image data from PLANET_RUNTIME_IMAGE: `{image}`, null when unset. */
function runtimeData() {
    const image = (process.env.PLANET_RUNTIME_IMAGE ?? "").trim();
    if (!image) {
        warn("PLANET_RUNTIME_IMAGE is not set; jobs default to the movable planet-runtime tag");
        return { image: null };
    }
    if (image.length > 512 || !IMAGE_REFERENCE.test(image)) {
        fail(`PLANET_RUNTIME_IMAGE is not an image reference: ${JSON.stringify(image)}`);
    }
    if (!IMAGE_DIGEST.test(image)) {
        warn(`PLANET_RUNTIME_IMAGE ${image} has no digest; pin it as image@sha256:<digest>`);
    }
    return { image };
}

function sha256(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The build description the service worker installs from (client/src/planet/util/build.ts, BuildInfo):
 * - files: stable-named files a page or the worker needs, with their SHA-256. The worker fetches them past the
 *   HTTP cache and rejects copies of another build.
 * - boot: content-hashed files the entries import statically, precached with the files.
 * - lazy: the other content-hashed files, cached in the background after activation.
 */
function buildDescription(buildId) {
    const site = (file) => `/${sitePath(file)}`;
    const dist = walk(join(distDir, "static/dist")).filter((file) => !file.endsWith(".map"));
    const stable = [
        ...dist.filter((file) => !isContentHashed(site(file))),
        ...BOOT_FILES.map((path) => join(distDir, path)).filter((file) => existsSync(file)),
        ...walk(join(distDir, "static/style")),
        ...walk(join(distDir, "static/planet/data")),
    ];
    const entries = [...CLIENT_ENTRIES, ...Object.keys(PLANET_ENTRIES)]
        .filter((entry) => entry.endsWith(".js"))
        .map((entry) => join(distDir, "static/dist", entry))
        .filter((file) => existsSync(file));
    const imported = new Set(
        entries.flatMap((entry) => [...staticImportGraph(entry)]).filter((file) => isContentHashed(site(file))),
    );
    const files = Object.fromEntries(
        stable.map((file) => [site(file), sha256(file)]).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    const hashed = dist.filter((file) => isContentHashed(site(file))).sort();
    return {
        build_id: buildId,
        files,
        boot: hashed.filter((file) => imported.has(file)).map(site),
        lazy: hashed.filter((file) => !imported.has(file)).map(site),
    };
}

function filesContaining(files, needle) {
    const bytes = Buffer.from(needle);
    return files.filter((file) => readFileSync(file).includes(bytes));
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

function sizeGroup(path) {
    if (/^static\/dist\/[^/]+$/.test(path)) {
        return "static/dist (entries)";
    }
    for (const prefix of [
        "static/dist/chunks",
        "static/dist/assets",
        "static/planet/data",
        TOOL_REPOS_PATH,
        "static/style",
    ]) {
        if (path.startsWith(`${prefix}/`)) {
            return prefix;
        }
    }
    return "shell and other";
}

/**
 * Checks that every tool bundle's `source.repo_tar` is in the site with the size and SHA-256 the bundle
 * records; the browser copies the archive into the user's bucket and verifies it against the bundle.
 */
function checkToolArchives() {
    const bundles = walk(join(distDir, "static/planet/data/toolbox/bundles")).filter((file) => file.endsWith(".json"));
    const reposDir = join(distDir, TOOL_REPOS_PATH);
    const problems = [];
    let archives = 0;
    for (const file of bundles) {
        let repoTar;
        try {
            repoTar = JSON.parse(readFileSync(file, "utf8")).source?.repo_tar;
        } catch (error) {
            problems.push(`${sitePath(file)}: ${error.message}`);
            continue;
        }
        if (!repoTar) {
            continue;
        }
        const archive = resolve(reposDir, String(repoTar.path ?? ""));
        if (!repoTar.path || !archive.startsWith(`${reposDir}${sep}`)) {
            problems.push(`${sitePath(file)}: invalid source.repo_tar.path ${JSON.stringify(repoTar.path)}`);
        } else if (!existsSync(archive)) {
            problems.push(`${sitePath(file)}: ${TOOL_REPOS_PATH}/${repoTar.path} is missing`);
        } else {
            const data = readFileSync(archive);
            const sha256 = createHash("sha256").update(data).digest("hex");
            if (data.length !== repoTar.size || sha256 !== repoTar.sha256) {
                problems.push(
                    `${sitePath(file)}: ${TOOL_REPOS_PATH}/${repoTar.path} does not match its size or sha256`,
                );
            } else {
                archives += 1;
            }
        }
    }
    if (problems.length) {
        console.error(problems.map((problem) => `  ${problem}`).join("\n"));
        fail(`${problems.length} tool archive problem(s); regenerate with planet/scripts/generate-data.sh`);
    }
    return `bundles: ${bundles.length}, archives: ${archives}`;
}

function printSummary(files, buildId, description, totalSeconds) {
    const groups = new Map();
    let largest = { path: "", bytes: 0 };
    for (const file of files) {
        const path = sitePath(file);
        const data = readFileSync(file);
        const gzip = COMPRESSIBLE.test(path) ? gzipSync(data, { level: 6 }).length : data.length;
        const group = groups.get(sizeGroup(path)) ?? { files: 0, bytes: 0, gzip: 0 };
        group.files += 1;
        group.bytes += data.length;
        group.gzip += gzip;
        groups.set(sizeGroup(path), group);
        if (data.length > largest.bytes) {
            largest = { path, bytes: data.length };
        }
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    const total = rows.reduce(
        (sum, [, group]) => ({
            files: sum.files + group.files,
            bytes: sum.bytes + group.bytes,
            gzip: sum.gzip + group.gzip,
        }),
        { files: 0, bytes: 0, gzip: 0 },
    );
    const line = (label, group) =>
        `  ${label.padEnd(24)}${String(group.files).padStart(6)}${formatBytes(group.bytes).padStart(12)}${formatBytes(group.gzip).padStart(12)}`;

    console.log(`\nPlanet site: ${relative(process.cwd(), distDir) || "."}  build ${buildId}`);
    console.log(`  ${"".padEnd(24)}${"files".padStart(6)}${"size".padStart(12)}${"gzip".padStart(12)}`);
    for (const [label, group] of rows) {
        console.log(line(label, group));
    }
    console.log(line("total", total));
    console.log(`  largest file: ${largest.path} (${formatBytes(largest.bytes)})`);
    const bytesOf = (paths) => paths.reduce((sum, path) => sum + statSync(join(distDir, path)).size, 0);
    const install = [...Object.keys(description.files), ...description.boot];
    console.log(
        `  service worker: ${install.length} files (${formatBytes(bytesOf(install))}) at install, ` +
            `${description.lazy.length} (${formatBytes(bytesOf(description.lazy))}) in the background`,
    );
    console.log(`  built in ${totalSeconds.toFixed(1)} s`);
    if (warnings.length) {
        console.log(`\n${warnings.length} warning(s):`);
        for (const message of warnings) {
            console.log(`  - ${message}`);
        }
    }
}

function main() {
    const started = performance.now();
    console.log(`Building Planet site into ${relative(process.cwd(), distDir) || "."}`);
    const runtime = runtimeData();
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });

    step("configuration", () => {
        run("gen-config", process.execPath, [
            join(root, "planet/scripts/gen-config.mjs"),
            join(dataDir, "config.json"),
        ]);
    });

    step("icons", () => {
        const icons = join(clientDir, "src/assets/icons.json");
        // all-icons.md is written by the icon build itself.
        if (existsSync(icons) && statSync(icons).mtimeMs >= newestMtime(join(clientDir, "icons"), /all-icons\.md$/)) {
            return "up to date";
        }
        run("icons", process.execPath, [join(clientDir, "scripts/build.mjs"), "icons"], {
            cwd: clientDir,
            env: { SKIP_VIZ: "1" },
        });
    });

    for (const [name, file] of Object.entries(GENERATED_DATA)) {
        if (!existsSync(join(dataDir, file))) {
            warn(`generated ${name} data is missing (${relative(root, join(dataDir, file))})`);
        }
    }
    if (!existsSync(generatedToolReposDir)) {
        warn(`generated tool archives are missing (${relative(root, generatedToolReposDir)})`);
    }

    step("client bundles", () => buildClient(PLACEHOLDER_ID));
    const scripts = Object.keys(SCRIPT_ENTRIES).filter((target) => existsSync(join(root, SCRIPT_ENTRIES[target])));
    step("service worker, boot", () => {
        for (const target of Object.keys(SCRIPT_ENTRIES)) {
            buildScript(target, PLACEHOLDER_ID);
        }
    });

    step("static files", () => {
        for (const item of REPO_STATIC) {
            const source = join(root, "static", item);
            if (existsSync(source)) {
                copyInto(source, join(distDir, "static", item));
            } else {
                warn(`static/${item} does not exist`);
            }
        }
        copyInto(generatedStaticDir, join(distDir, "static"));
        if (existsSync(generatedToolReposDir)) {
            copyInto(generatedToolReposDir, join(distDir, TOOL_REPOS_PATH));
        }
        copyInto(join(siteDir, "index.html"), join(distDir, "index.html"));
        copyInto(join(siteDir, "welcome.html"), join(distDir, "static/welcome.html"));
        copyInto(join(siteDir, "_headers"), join(distDir, "_headers"));
        mkdirSync(dirname(join(distDir, RUNTIME_DATA)), { recursive: true });
        writeFileSync(join(distDir, RUNTIME_DATA), `${JSON.stringify(runtime, null, 2)}\n`);
        return `runtime image: ${runtime.image ?? "not set"}`;
    });

    step("tool archives", checkToolArchives);

    let buildId = "";
    let description;
    step("build id", () => {
        buildId = `${gitShortSha()}-${contentHash(walk(distDir)).slice(0, 10)}`;
        return buildId;
    });

    step("embed build id", () => {
        const rebuilt = [];
        if (filesContaining(walk(join(distDir, "static/dist")), PLACEHOLDER_ID).length) {
            buildClient(buildId);
            rebuilt.push("client");
        }
        for (const target of scripts) {
            buildScript(target, buildId);
            rebuilt.push(target);
        }
        for (const shell of ["index.html", "static/welcome.html"]) {
            const file = join(distDir, shell);
            writeFileSync(file, readFileSync(file, "utf8").replaceAll(HTML_TOKEN, buildId));
        }
        description = buildDescription(buildId);
        mkdirSync(join(distDir, "static/planet"), { recursive: true });
        writeFileSync(join(distDir, "static/planet/build.json"), `${JSON.stringify(description, null, 2)}\n`);
        return rebuilt.length ? `rebuilt ${rebuilt.join(", ")}` : undefined;
    });

    const files = walk(distDir);
    const leftovers = [
        ...filesContaining(files, PLACEHOLDER_ID),
        ...filesContaining(
            files.filter((file) => file.endsWith(".html")),
            HTML_TOKEN,
        ),
    ];
    if (leftovers.length) {
        fail(`placeholder build id left in ${leftovers.map(sitePath).join(", ")}`);
    }
    if (existsSync(join(distDir, "404.html"))) {
        fail("planet/dist/404.html would disable single-page-application fallback");
    }
    if (files.length > MAX_FILES) {
        fail(`${files.length} files exceed the Workers Static Assets limit of ${MAX_FILES}`);
    }
    for (const file of files) {
        if (statSync(file).size > MAX_FILE_BYTES) {
            fail(`${sitePath(file)} exceeds the Workers Static Assets limit of 25 MiB per file`);
        }
    }

    printSummary(files, buildId, description, (performance.now() - started) / 1000);
}

main();
