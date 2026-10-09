// Run with: node --test planet/site/worker.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import worker, { isBackendPath } from "./worker.js";

const assets = {
    requests: [],
    async fetch(request) {
        this.requests.push(request);
        return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    },
};

function call(path, init) {
    return worker.fetch(new Request(`https://planet.example${path}`, init), { ASSETS: assets });
}

describe("worker", () => {
    for (const path of [
        "/context",
        "/api/histories",
        "/api",
        "/history/current_history_json",
        "/dataset/display",
        "/datasets/abc/display",
    ]) {
        it(`answers ${path} with 503 while the service worker is inactive`, async () => {
            const response = await call(path);
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("Content-Type"), "application/json");
            assert.equal(response.headers.get("Cache-Control"), "no-store");
            assert.match(response.headers.get("X-Request-ID"), /^[0-9a-f]{32}$/);
            assert.deepEqual(await response.json(), {
                err_msg: "Planet's service worker is not active; reload the page",
                err_code: 503001,
            });
        });
    }

    it("answers other unmatched paths with 404", async () => {
        const response = await call("/static/dist/chunks/removed-ABC.js");
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { err_msg: "No such file", err_code: 404001 });
    });

    it("sends no body for HEAD", async () => {
        const response = await call("/api/version", { method: "HEAD" });
        assert.equal(response.status, 503);
        assert.equal(await response.text(), "");
    });

    it("serves index.html for a non-navigation request to /", async () => {
        const response = await call("/");
        assert.equal(response.status, 200);
        assert.equal(new URL(assets.requests.at(-1).url).pathname, "/index.html");
    });

    it("does not treat lookalike prefixes as backend paths", () => {
        assert.equal(isBackendPath("/apis"), false);
        assert.equal(isBackendPath("/datasets-list"), false);
        assert.equal(isBackendPath("/contexts"), false);
    });
});
