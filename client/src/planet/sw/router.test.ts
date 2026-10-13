// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/planet/util/errors";

import { DOCUMENT_CSP } from "./csp";
import { error, finalize, html, json, noContent, redirect } from "./responses";
import { Router } from "./router";

const ORIGIN = "https://planet.test";

function request(path: string, init: RequestInit = {}): Request {
    return new Request(`${ORIGIN}${path}`, init);
}

/** A request as the worker sees it for a link, frame, typed address or form submission. */
function navigation(path: string, init: RequestInit = {}): Request {
    const navigate = request(path, init);
    Object.defineProperty(navigate, "mode", { value: "navigate" });
    return navigate;
}

/** A request as the worker sees it for an `<img>`, `<script>` or other subresource. */
function subresource(path: string, destination: RequestDestination): Request {
    const fetched = request(path);
    Object.defineProperty(fetched, "destination", { value: destination });
    return fetched;
}

describe("Router matching", () => {
    it("extracts and decodes path parameters", async () => {
        const router = new Router();
        router.untyped("/api/histories/{history_id}/contents/{type}s/{id}", "get", ({ params }) => params);
        const response = await router.handle(request("/api/histories/abc/contents/datasets/x%20y"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ history_id: "abc", type: "dataset", id: "x y" });
    });

    it("matches {name:path} against the rest of the path", async () => {
        const router = new Router();
        router.untyped("/datasets/{dataset_id}/display/{filename:path}", "get", ({ params }) => params);
        const response = await router.handle(request("/datasets/d1/display/sub/dir/file.html"));
        expect(await response.json()).toEqual({ dataset_id: "d1", filename: "sub/dir/file.html" });
    });

    it("prefers literal segments over parameters regardless of registration order", async () => {
        const router = new Router();
        router.untyped("/api/histories/{history_id}", "get", () => "show");
        router.untyped("/api/histories/count", "get", () => "count");
        router.untyped("/api/histories/{history_id}/contents/{id}", "get", () => "legacy");
        router.untyped("/api/histories/{history_id}/contents/{type}s", "get", () => "typed");
        expect(await (await router.handle(request("/api/histories/count"))).json()).toBe("count");
        expect(await (await router.handle(request("/api/histories/h1"))).json()).toBe("show");
        expect(await (await router.handle(request("/api/histories/h1/contents/datasets"))).json()).toBe("typed");
        expect(await (await router.handle(request("/api/histories/h1/contents/abc"))).json()).toBe("legacy");
        expect(router.routes().map((route) => route.pattern)[0]).toBe("/api/histories/count");
    });

    it("ignores a trailing slash and reads repeated query parameters", async () => {
        const router = new Router();
        router.untyped("/api/histories/{history_id}/contents", "get", ({ query }) => ({
            q: query.getAll("q"),
            qv: query.getAll("qv"),
        }));
        const response = await router.handle(
            request("/api/histories/h1/contents/?q=deleted&qv=false&q=visible&qv=true"),
        );
        expect(await response.json()).toEqual({ q: ["deleted", "visible"], qv: ["false", "true"] });
    });

    it("rejects duplicate registrations and malformed patterns", () => {
        const router = new Router();
        router.untyped("/api/a/{x}", "get", () => null);
        expect(() => router.untyped("/api/a/{x}/", "get", () => null)).toThrow(/already registered/);
        expect(() => router.untyped("api/b", "get", () => null)).toThrow();
        expect(() => router.untyped("/api/{p:path}/x", "get", () => null)).toThrow();
        expect(() => router.untyped("/api/{x}/{x}", "get", () => null)).toThrow();
    });
});

describe("Router responses", () => {
    it("answers unknown paths with a Galaxy 404 envelope", async () => {
        const router = new Router();
        const response = await router.handle(request("/api/nothing/here"));
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Type")).toBe("application/json");
        expect(await response.json()).toEqual({ err_msg: "No route for /api/nothing/here", err_code: 404001 });
        expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    it("answers a known path with another method with 405", async () => {
        const router = new Router();
        router.untyped("/api/histories", "get", () => []);
        const response = await router.handle(request("/api/histories", { method: "DELETE" }));
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe("GET, HEAD");
        expect((await response.json()).err_msg).toBe("Method Not Allowed");
    });

    it("prefers a full match over a more specific path match", async () => {
        const router = new Router();
        router.untyped("/api/histories/count", "get", () => 1);
        router.untyped("/api/histories/{history_id}", "put", ({ params }) => params.history_id);
        const response = await router.handle(request("/api/histories/count", { method: "PUT", body: "{}" }));
        expect(await response.json()).toBe("count");
    });

    it("gives every response a distinct X-Request-ID and no-store", async () => {
        const router = new Router();
        router.untyped("/context", "get", () => ({}));
        router.untyped("/welcome", "get", () => redirect("/static/welcome.html"));
        router.untyped("/doc", "get", () => html("<p>x</p>"));
        router.untyped("/api/thing", "delete", () => noContent());
        const responses = await Promise.all([
            router.handle(request("/context")),
            router.handle(request("/welcome")),
            router.handle(request("/doc")),
            router.handle(request("/api/thing", { method: "DELETE" })),
            router.handle(request("/api/missing")),
        ]);
        const ids = responses.map((response) => response.headers.get("X-Request-ID"));
        expect(new Set(ids).size).toBe(responses.length);
        for (const response of responses) {
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        }
        expect(responses[1]!.status).toBe(302);
        expect(responses[1]!.headers.get("Location")).toBe("/static/welcome.html");
        expect(responses[2]!.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
        expect(responses[3]!.status).toBe(204);
    });

    it("sends undefined as 204 and null as JSON null", async () => {
        const router = new Router();
        router.untyped("/api/void", "post", () => undefined);
        router.untyped("/history/current_history_json", "get", () => null);
        expect((await router.handle(request("/api/void", { method: "POST" }))).status).toBe(204);
        const unchanged = await router.handle(request("/history/current_history_json?since=x"));
        expect(unchanged.status).toBe(200);
        expect(await unchanged.text()).toBe("null");
    });

    it("supports HEAD on GET routes with the same headers and no body", async () => {
        const router = new Router();
        const handler = vi.fn(({ method }: { method: string }) =>
            json({ method }, { headers: { "x-content-chunked": "True", "x-content-truncated": "False" } }),
        );
        router.untyped("/datasets/{id}/display", "get", handler);
        const get = await router.handle(request("/datasets/d1/display/?preview=True"));
        const head = await router.handle(request("/datasets/d1/display/?preview=True", { method: "HEAD" }));
        expect(head.status).toBe(200);
        expect(head.body).toBeNull();
        expect(head.headers.get("x-content-chunked")).toBe("True");
        expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
        expect(head.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
        expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ method: "HEAD" }));
    });

    it("prefers an explicit HEAD route", async () => {
        const router = new Router();
        router.untyped("/x", "get", () => "get");
        router.untyped("/x", "head", () => json(null, { headers: { "x-from": "head" } }));
        const head = await router.handle(request("/x", { method: "HEAD" }));
        expect(head.headers.get("x-from")).toBe("head");
    });

    it("turns ApiError into its envelope", async () => {
        const router = new Router();
        router.untyped("/api/histories/{history_id}", "get", () => {
            throw ApiError.notFound("History not found");
        });
        const response = await router.handle(request("/api/histories/x"));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ err_msg: "History not found", err_code: 404001 });
    });

    it("hides unexpected errors behind a 500 envelope", async () => {
        const router = new Router();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        router.untyped("/api/boom", "get", () => {
            throw new Error("secret detail at line 3");
        });
        const response = await router.handle(request("/api/boom"));
        const body = await response.text();
        expect(response.status).toBe(500);
        expect(JSON.parse(body)).toEqual({ err_msg: "Internal server error", err_code: 500001 });
        expect(body).not.toContain("secret");
        expect(response.headers.get("X-Request-ID")).toBeTruthy();
        consoleError.mockRestore();
    });

    it("parses JSON bodies and rejects malformed ones with 400003", async () => {
        const router = new Router();
        router.untyped("/api/echo", "put", async (req) => req.json());
        const ok = await router.handle(request("/api/echo", { method: "PUT", body: '{"name":"x"}' }));
        expect(await ok.json()).toEqual({ name: "x" });
        const empty = await router.handle(request("/api/echo", { method: "PUT" }));
        expect(await empty.json()).toEqual({});
        const bad = await router.handle(request("/api/echo", { method: "PUT", body: "{nope" }));
        expect(bad.status).toBe(400);
        expect((await bad.json()).err_code).toBe(400003);
    });

    it("rejects malformed percent-encoding with 400", async () => {
        const router = new Router();
        router.untyped("/api/datasets/{id}", "get", ({ params }) => params.id);
        const response = await router.handle(request("/api/datasets/%E0%A4%A"));
        expect(response.status).toBe(400);
    });

    it("passes the client id and background work through", async () => {
        const router = new Router();
        const waitUntil = vi.fn();
        router.untyped("/api/who", "get", (req) => {
            req.waitUntil(Promise.resolve());
            return req.clientId;
        });
        const response = await router.handle(request("/api/who"), { clientId: "c1", waitUntil });
        expect(await response.json()).toBe("c1");
        expect(waitUntil).toHaveBeenCalledTimes(1);
    });
});

describe("Router request guards", () => {
    function guardedRouter() {
        const router = new Router();
        const calls: string[] = [];
        router.untyped(
            "/datasets/{id}/display",
            "get",
            () => {
                calls.push("display");
                return "display";
            },
            { navigable: true },
        );
        router.untyped("/api/histories", ["get", "post", "delete"], ({ method }) => {
            calls.push(method);
            return method;
        });
        router.untyped(
            "/history/create_new_current",
            ["get", "post"],
            () => {
                calls.push("create");
                return "created";
            },
            { changesState: true },
        );
        return { router, calls };
    }

    it("lets navigations reach only navigable routes", async () => {
        const { router, calls } = guardedRouter();
        expect((await router.handle(navigation("/datasets/d1/display?preview=True"))).status).toBe(200);
        for (const path of ["/api/histories", "/history/create_new_current", "/history/create_new_current/"]) {
            const refused = await router.handle(navigation(path));
            expect(refused.status, path).toBe(403);
            expect(await refused.json()).toEqual({
                err_msg: "This Planet address cannot be opened as a page, link or frame.",
                err_code: 403002,
            });
            expect(refused.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
        }
        expect((await router.handle(navigation("/api/unknown"))).status).toBe(404);
        expect(calls).toEqual(["display"]);
    });

    it("refuses every navigation that is not GET, such as a cross-site form post", async () => {
        const { router, calls } = guardedRouter();
        for (const path of ["/api/histories", "/datasets/d1/display", "/history/create_new_current", "/api/unknown"]) {
            const form = navigation(path, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "name=x",
            });
            const refused = await router.handle(form);
            expect(refused.status, path).toBe(403);
            expect((await refused.json()).err_msg).toBe("Planet does not accept form submissions.");
        }
        expect(calls).toEqual([]);
    });

    it("refuses state-changing requests that carry another origin", async () => {
        const { router, calls } = guardedRouter();
        const foreign: Record<string, string>[] = [
            { Origin: "https://attacker.example" },
            { Origin: "null" },
            { "Sec-Fetch-Site": "cross-site" },
            { "Sec-Fetch-Site": "same-site" },
        ];
        for (const headers of foreign) {
            for (const method of ["POST", "DELETE"]) {
                const refused = await router.handle(request("/api/histories", { method, headers, body: "{}" }));
                expect(refused.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
                expect((await refused.json()).err_msg).toBe("Requests from other sites cannot change Planet data.");
            }
        }
        expect(calls).toEqual([]);
        const own = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
        expect((await router.handle(request("/api/histories", { method: "POST", headers: own }))).status).toBe(200);
        expect((await router.handle(request("/api/histories", { method: "POST" }))).status).toBe(200);
        const read = request("/api/histories", { headers: { Origin: "https://attacker.example" } });
        expect((await router.handle(read)).status).toBe(200);
        expect(calls).toEqual(["POST", "POST", "GET"]);
    });

    it("answers state-changing GET routes only to same-origin script requests", async () => {
        const { router, calls } = guardedRouter();
        for (const destination of ["image", "script", "style", "iframe"] as const) {
            const refused = await router.handle(subresource("/history/create_new_current", destination));
            expect(refused.status, destination).toBe(403);
        }
        const foreign = request("/history/create_new_current", { headers: { "Sec-Fetch-Site": "cross-site" } });
        expect((await router.handle(foreign)).status).toBe(403);
        expect(calls).toEqual([]);
        expect(await (await router.handle(request("/history/create_new_current"))).json()).toBe("created");
        expect((await router.handle(subresource("/datasets/d1/display", "image"))).status).toBe(200);
    });

    it("accepts navigable only on read-only GET routes and reports the options", () => {
        const router = new Router();
        expect(() => router.untyped("/a", "post", () => null, { navigable: true })).toThrow(/read-only GET/);
        expect(() => router.untyped("/b", ["get", "post"], () => null, { navigable: true })).toThrow(/read-only GET/);
        expect(() => router.untyped("/c", "get", () => null, { navigable: true, changesState: true })).toThrow(
            /read-only GET/,
        );
        router.untyped("/d", "get", () => null, { navigable: true });
        router.untyped("/e", ["get", "post"], () => null, { changesState: true });
        expect(router.routes()).toEqual(
            expect.arrayContaining([
                { method: "GET", pattern: "/d", navigable: true, changesState: false },
                { method: "GET", pattern: "/e", navigable: false, changesState: true },
                { method: "POST", pattern: "/e", navigable: false, changesState: true },
            ]),
        );
    });
});

describe("document CSP", () => {
    it("allows plain http only to the loopback sources browsers accept", () => {
        expect(DOCUMENT_CSP).toContain("connect-src 'self' https: http://localhost:* http://127.0.0.1:*;");
        expect(DOCUMENT_CSP).toContain("font-src 'self' data:");
        expect(DOCUMENT_CSP).not.toContain("[");
    });
});

describe("finalize", () => {
    it("copies responses with immutable headers", async () => {
        const immutable = Response.redirect(`${ORIGIN}/static/welcome.html`, 302);
        const response = finalize(immutable);
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe(`${ORIGIN}/static/welcome.html`);
        expect(response.headers.get("X-Request-ID")).toBeTruthy();
    });

    it("builds error envelopes with default codes", async () => {
        expect(await error(403, "no").json()).toEqual({ err_msg: "no", err_code: 403002 });
    });
});

describe("typed routes", () => {
    it("types parameters, bodies and results from the schema", async () => {
        const router = new Router();
        router.route("/api/histories/count", "get", () => 3);
        router.route("/api/histories/{history_id}", "put", async ({ params, json: body }) => {
            const payload = await body();
            const name: string | null | undefined = payload.name;
            return json({ id: params.history_id, name } as never);
        });
        router.route<"/api/histories/{history_id}", "delete">("/api/histories/{history_id}", "delete", () =>
            error(404, "missing"),
        );
        // @ts-expect-error the count endpoint returns a number
        router.route("/api/genomes", "get", () => 3);
        // @ts-expect-error /api/histories/count has no PUT
        router.route("/api/histories/count", "put", () => 3);
        // @ts-expect-error not a schema path
        router.route("/history/current_history_json", "get", () => null);
        router.route("/api/histories/{history_id}/contents/{type}s/{id}", "get", ({ params }) => {
            const keys: ("history_id" | "type" | "id")[] = Object.keys(params) as never;
            // @ts-expect-error not a parameter of this path
            void params.dataset_id;
            return json(keys as never);
        });
        const response = await router.handle(request("/api/histories/count"));
        expect(await response.json()).toBe(3);
    });
});
