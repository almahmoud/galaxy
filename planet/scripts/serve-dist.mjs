#!/usr/bin/env node
/**
 * Serves planet/dist on 127.0.0.1 the way Workers Static Assets serves it with
 * planet/site/wrangler.jsonc: exact file matches (html_handling "none"), _headers
 * rules, index.html for unmatched navigations, and worker.js's JSON errors for
 * other unmatched requests.
 *
 *   node planet/scripts/serve-dist.mjs [port] [--dir <site root>]
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isBackendPath, NOT_ACTIVE, NOT_FOUND } from "../site/worker.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".eot": "application/vnd.ms-fontobject",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".tar": "application/x-tar",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
};
const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";
/** Files the platform reads as configuration and never serves. */
const UNSERVED = new Set(["/_headers", "/_redirects", "/.assetsignore"]);

/** Parses a _headers file into ordered rules of {pattern, set: [[name, value]], detach: [name]}. */
export function parseHeaders(text) {
    const rules = [];
    let rule = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }
        if (!/^\s/.test(rawLine)) {
            rule = { pattern: compilePattern(line), set: [], detach: [] };
            rules.push(rule);
        } else if (!rule) {
            throw new Error(`_headers: header line without a URL pattern: ${line}`);
        } else if (line.startsWith("!")) {
            rule.detach.push(line.slice(1).trim().toLowerCase());
        } else {
            const colon = line.indexOf(":");
            if (colon <= 0) {
                throw new Error(`_headers: malformed header line: ${line}`);
            }
            rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
        }
    }
    return rules;
}

function compilePattern(pattern) {
    const absolute = /^https:\/\//.test(pattern);
    let source = "";
    let splat = false;
    for (const token of pattern.match(/\*|:[A-Za-z]\w*|[^*:]+|:/g) ?? []) {
        if (token === "*") {
            if (splat) {
                throw new Error(`_headers: more than one splat in ${pattern}`);
            }
            splat = true;
            source += "(?<splat>.*)";
        } else if (/^:[A-Za-z]/.test(token)) {
            source += `(?<${token.slice(1)}>[^/${absolute ? "." : ""}]+)`;
        } else {
            source += token.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        }
    }
    return { absolute, regex: new RegExp(`^${source}$`) };
}

/** Applies matching rules to default headers; repeated headers are joined with ", " as on Cloudflare. */
export function applyHeaderRules(rules, host, pathname, defaults) {
    const headers = new Map(Object.entries(defaults).map(([name, value]) => [name.toLowerCase(), [name, value]]));
    const setByRule = new Set();
    for (const { pattern, set, detach } of rules) {
        const match = pattern.regex.exec(pattern.absolute ? `https://${host}${pathname}` : pathname);
        if (!match) {
            continue;
        }
        for (const name of detach) {
            headers.delete(name);
            setByRule.delete(name);
        }
        for (const [name, template] of set) {
            const value = template.replace(/:([A-Za-z]\w*)/g, (token, key) => match.groups?.[key] ?? token);
            const key = name.toLowerCase();
            if (setByRule.has(key)) {
                headers.set(key, [name, `${headers.get(key)[1]}, ${value}`]);
            } else {
                headers.set(key, [name, value]);
                setByRule.add(key);
            }
        }
    }
    return Object.fromEntries(headers.values());
}

/** A navigation as the browser marks it, or an HTML request from a client without Fetch Metadata. */
export function isNavigation(headers) {
    const mode = headers["sec-fetch-mode"];
    if (mode) {
        return mode === "navigate";
    }
    return (headers.accept ?? "").includes("text/html");
}

function errorHeaders() {
    return {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Request-ID": randomUUID().replaceAll("-", ""),
    };
}

export function createSiteServer({ dir, log = console.log }) {
    const siteRoot = resolve(dir);
    const etags = new Map();

    const loadRules = () => {
        try {
            return parseHeaders(readFileSync(join(siteRoot, "_headers"), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            throw error;
        }
    };

    const fileFor = (pathname) => {
        if (UNSERVED.has(pathname) || pathname.includes("\0")) {
            return null;
        }
        const file = resolve(siteRoot, `.${pathname}`);
        if (file !== siteRoot && !file.startsWith(siteRoot + sep)) {
            return null;
        }
        try {
            const stats = statSync(file);
            return stats.isFile() ? { file, stats } : null;
        } catch {
            return null;
        }
    };

    const etagFor = ({ file, stats }) => {
        const cached = etags.get(file);
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
            return cached.etag;
        }
        const etag = `"${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32)}"`;
        etags.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, etag });
        return etag;
    };

    const sendFile = (request, response, pathname, asset) => {
        const etag = etagFor(asset);
        const defaults = {
            "Content-Type": MIME_TYPES[extname(asset.file).toLowerCase()] ?? "application/octet-stream",
            ETag: etag,
        };
        if (!request.headers.authorization && !request.headers.range) {
            defaults["Cache-Control"] = DEFAULT_CACHE_CONTROL;
        }
        const headers = applyHeaderRules(loadRules(), request.headers.host ?? "", pathname, defaults);
        if (request.headers["if-none-match"] === etag) {
            response.writeHead(304, headers).end();
            return 0;
        }
        const body = readFileSync(asset.file);
        response.writeHead(200, { ...headers, "Content-Length": body.length });
        if (request.method === "HEAD") {
            response.end();
            return 0;
        }
        response.end(body);
        return body.length;
    };

    const sendError = (request, response, { status, err_msg, err_code }) => {
        const body = Buffer.from(JSON.stringify({ err_msg, err_code }));
        response.writeHead(status, { ...errorHeaders(), "Content-Length": body.length });
        if (request.method === "HEAD") {
            response.end();
            return 0;
        }
        response.end(body);
        return body.length;
    };

    return createServer((request, response) => {
        const started = performance.now();
        let pathname;
        let outcome;
        let bytes = 0;
        try {
            pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
        } catch {
            pathname = null;
        }
        const readable = request.method === "GET" || request.method === "HEAD";
        const asset = pathname !== null && readable ? fileFor(pathname) : null;
        if (pathname === null) {
            outcome = "worker";
            bytes = sendError(request, response, NOT_FOUND);
        } else if (asset) {
            outcome = "asset";
            bytes = sendFile(request, response, pathname, asset);
        } else if (readable && (isNavigation(request.headers) || pathname === "/")) {
            outcome = pathname === "/" ? "index" : "spa";
            const index = fileFor("/index.html");
            bytes = index ? sendFile(request, response, pathname, index) : sendError(request, response, NOT_FOUND);
        } else {
            outcome = "worker";
            bytes = sendError(request, response, isBackendPath(pathname) ? NOT_ACTIVE : NOT_FOUND);
        }
        const elapsed = (performance.now() - started).toFixed(1);
        // Query strings are not logged.
        log(
            `${request.method} ${pathname ?? "(invalid path)"} ${response.statusCode} ${outcome} ${bytes}B ${elapsed}ms`,
        );
    });
}

function parseArguments(argv) {
    let port = 8787;
    let dir = join(root, "planet/dist");
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--dir") {
            dir = resolve(argv[++index] ?? "");
        } else if (/^\d+$/.test(argument)) {
            port = Number(argument);
        } else {
            throw new Error(`Unknown argument ${argument}. Usage: serve-dist.mjs [port] [--dir <site root>]`);
        }
    }
    return { port, dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { port, dir } = parseArguments(process.argv.slice(2));
    const server = createSiteServer({ dir });
    server.listen(port, "127.0.0.1", () => {
        console.log(`Serving ${dir} at http://127.0.0.1:${port}/ (Ctrl+C to stop)`);
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
            server.close(() => process.exit(0));
            server.closeAllConnections();
        });
    }
}
