// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { histories } from "@/planet/db";
import { Router } from "@/planet/sw/router";

import { registerAll } from "..";
import { makeRouter, request, resetPlanet, teardownPlanet } from "./contents.fixtures";

beforeEach(resetPlanet);
afterEach(teardownPlanet);

function navigation(path: string): Request {
    const navigate = request(path);
    Object.defineProperty(navigate, "mode", { value: "navigate" });
    return navigate;
}

describe("navigable routes", () => {
    it("are exactly the read-only display, download and welcome routes", () => {
        const router = new Router();
        registerAll(router);
        const navigable = router
            .routes()
            .filter((route) => route.navigable)
            .map((route) => `${route.method} ${route.pattern}`);
        expect(navigable.sort()).toEqual(
            [
                "GET /api/datasets/{dataset_id}/extra_files/raw/{filename:path}",
                "GET /api/datasets/{history_content_id}/display",
                "GET /api/datasets/{history_content_id}/download",
                "GET /api/datasets/{history_content_id}/metadata_file",
                "GET /api/histories/{history_id}/contents/{history_content_id}/display",
                "GET /api/histories/{history_id}/contents/{history_content_id}/download",
                "GET /api/histories/{history_id}/contents/{history_content_id}/metadata_file",
                "GET /dataset/display",
                "GET /dataset/get_metadata_file",
                "GET /datasets/{dataset_id}/display",
                "GET /datasets/{dataset_id}/display/{filename:path}",
                "GET /welcome",
            ].sort(),
        );
        const changesState = router
            .routes()
            .filter((route) => route.method === "GET" && route.changesState)
            .map((route) => route.pattern);
        expect(changesState.sort()).toEqual([
            "/history/create_new_current",
            "/history/resume_paused_jobs",
            "/history/set_as_current",
        ]);
    });

    it("keep links and frames from other sites away from the legacy controllers that change state", async () => {
        const router = makeRouter();
        const before = await histories.list();
        for (const path of [
            "/history/create_new_current?name=planted",
            "/history/set_as_current?id=x",
            "/history/resume_paused_jobs?current=True",
            "/api/histories",
            "/context",
        ]) {
            expect((await router.handle(navigation(path))).status, path).toBe(403);
        }
        const image = request("/history/create_new_current?name=planted");
        Object.defineProperty(image, "destination", { value: "image" });
        expect((await router.handle(image)).status).toBe(403);
        expect(await histories.list()).toHaveLength(before.length);
        expect((await router.handle(navigation("/welcome"))).status).toBe(302);
    });
});
