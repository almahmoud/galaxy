// @vitest-environment node
import { describe, expect, it } from "vitest";

import { Router } from "@/planet/sw/router";

import { register } from "../stubs";
import { fetchJson, send } from "./contents.fixtures";

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

const EMPTY_LISTS = [
    "/api/webhooks",
    "/api/entry_points",
    "/api/object_stores",
    "/api/object_stores?selectable=true",
    "/api/object_store_instances",
    "/api/object_store_templates",
    "/api/file_source_instances",
    "/api/file_source_templates",
    "/api/remote_files/plugins",
    "/api/remote_files?target=gxftp://",
    "/api/plugins?embeddable=true",
    "/api/tours",
    "/api/exports?limit=50&days=30",
    "/api/libraries",
    "/api/licenses",
    "/api/quotas",
    "/api/tool_shed_repositories",
    "/api/notifications",
    "/api/notifications/broadcast",
];

const PAGINATED = ["/api/invocations", "/api/workflows", "/api/pages", "/api/visualizations"];

describe("stubs", () => {
    it.each(EMPTY_LISTS)("answers %s with an empty list", async (path: string) => {
        expect(await fetchJson(makeRouter(), "GET", path)).toEqual([]);
    });

    it.each(PAGINATED)("answers %s with an empty page and total_matches 0", async (path: string) => {
        const response = await send(makeRouter(), "GET", `${path}?limit=24&offset=0`);
        expect(response.status).toBe(200);
        expect(response.headers.get("total_matches")).toBe("0");
        expect(await response.json()).toEqual([]);
    });

    it("answers the fixed objects with their schema shapes", async () => {
        const router = makeRouter();
        expect(await fetchJson(router, "GET", "/api/workflows/menu")).toEqual({ ids_in_menu: [], workflows: [] });
        expect(await fetchJson(router, "GET", "/api/workflows/curated")).toMatchObject({
            source: "unavailable",
            total_matches: 0,
            workflows: [],
            collections: [],
        });
        expect(await fetchJson(router, "GET", "/api/notifications/status?since=2026-01-01")).toEqual({
            total_unread_count: 0,
            notifications: [],
            broadcasts: [],
        });
        expect(await fetchJson(router, "GET", "/api/notifications/preferences")).toEqual({ preferences: {} });
        expect(await fetchJson(router, "GET", "/api/help/forum/search?query=fastqc")).toEqual({
            topics: [],
            posts: [],
            users: [],
            categories: [],
            tags: [],
            groups: [],
            grouped_search_result: null,
        });
    });

    it("answers 403 for user-defined tools so the client hides them without an error toast", async () => {
        const error = await fetchJson(makeRouter(), "GET", "/api/unprivileged_tools", undefined, 403);
        expect(error.err_code).toBe(403005);
    });

    it("leaves single items to the router's 404", async () => {
        const response = await send(makeRouter(), "GET", "/api/workflows/abc");
        expect(response.status).toBe(404);
    });
});
