// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { components } from "@/api/schema";

import { normalizeFavorites, PLANET_USER_ID } from "../users";
import {
    addDataset,
    currentHistoryId,
    fetchJson,
    keysOf,
    makeRouter,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";

type DetailedUserModel = components["schemas"]["DetailedUserModel"];

/** Every key of the API model; `satisfies` makes tsc fail when the model gains or loses one. */
const DETAILED_USER_KEYS = {
    deleted: true,
    display_name: true,
    email: true,
    id: true,
    is_admin: true,
    nice_total_disk_usage: true,
    preferences: true,
    preferred_object_store_id: true,
    purged: true,
    quota: true,
    quota_bytes: true,
    quota_percent: true,
    total_disk_usage: true,
    username: true,
} satisfies Record<keyof DetailedUserModel, true>;

beforeEach(resetPlanet);
afterEach(teardownPlanet);

describe("GET /api/users/{user_id}", () => {
    it("returns the DetailedUserModel for current and for the user's id", async () => {
        const router = makeRouter();
        const user = await fetchJson<DetailedUserModel>(router, "GET", "/api/users/current");
        expect(keysOf(user)).toEqual(Object.keys(DETAILED_USER_KEYS).sort());
        expect(user).toMatchObject({
            id: PLANET_USER_ID,
            email: "planet@localhost",
            username: "planet",
            is_admin: false,
            deleted: false,
            purged: false,
            quota: "unlimited",
            quota_percent: null,
            total_disk_usage: 0,
            nice_total_disk_usage: "0 bytes",
            preferences: {},
        });
        expect(await fetchJson(router, "GET", `/api/users/${PLANET_USER_ID}`)).toEqual(user);
    });

    it("rejects other user ids", async () => {
        const response = await send(makeRouter(), "GET", "/api/users/0123456789abcdef");
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ err_msg: "Invalid user id specified", err_code: 400008 });
    });

    it("counts each non-purged dataset once in the disk usage", async () => {
        const historyId = await currentHistoryId();
        const { hda } = await addDataset(historyId, {}, { file_size: 1500, total_size: 2500 });
        await fetchJson(makeRouter(), "POST", "/api/histories", { history_id: historyId });
        await addDataset(historyId, { purged: true, deleted: true }, { file_size: 7000, total_size: 7000 });
        await addDataset(historyId, {}, { file_size: 10, total_size: null, purged: true });
        const user = await fetchJson(makeRouter(), "GET", "/api/users/current");
        expect(hda.hid).toBe(1);
        expect(user.total_disk_usage).toBe(2500);
        expect(user.nice_total_disk_usage).toBe("2.5 KB");
        expect(await fetchJson(makeRouter(), "GET", "/api/users/current/usage")).toEqual([
            {
                quota_source_label: null,
                total_disk_usage: 2500,
                quota: "unlimited",
                quota_bytes: null,
                quota_percent: null,
            },
        ]);
        expect(await fetchJson(makeRouter(), "GET", "/api/users/current/usage/__null__")).toMatchObject({
            total_disk_usage: 2500,
        });
    });
});

describe("favorites and theme", () => {
    it("adds, orders and removes favorites and exposes them in preferences", async () => {
        const router = makeRouter();
        await fetchJson(router, "PUT", "/api/users/current/favorites/tools", { object_id: "cat1" });
        await fetchJson(router, "PUT", "/api/users/current/favorites/tags", { object_id: " genomics " });
        const added = await fetchJson(router, "PUT", "/api/users/current/favorites/tools", {
            object_id: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.0",
        });
        expect(added.tools).toEqual(["cat1", "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.0"]);
        expect(added.tags).toEqual(["genomics"]);
        expect(added.order).toEqual([
            { object_type: "tools", object_id: "cat1" },
            { object_type: "tags", object_id: "genomics" },
            { object_type: "tools", object_id: "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.0" },
        ]);

        const reordered = await fetchJson(router, "PUT", "/api/users/current/favorites/order", {
            order: [...added.order].reverse(),
        });
        expect(reordered.tools).toEqual(["toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.0", "cat1"]);

        const removed = await fetchJson(
            router,
            "DELETE",
            "/api/users/current/favorites/tools/toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.0",
        );
        expect(removed.tools).toEqual(["cat1"]);

        const user = await fetchJson(router, "GET", "/api/users/current");
        expect(JSON.parse(user.preferences.favorites)).toEqual(removed);
    });

    it("rejects incomplete orders, unknown types and missing favorites", async () => {
        const router = makeRouter();
        await fetchJson(router, "PUT", "/api/users/current/favorites/tools", { object_id: "cat1" });
        expect((await send(router, "PUT", "/api/users/current/favorites/order", { order: [] })).status).toBe(400);
        expect((await send(router, "PUT", "/api/users/current/favorites/widgets", { object_id: "x" })).status).toBe(
            400,
        );
        expect((await send(router, "DELETE", "/api/users/current/favorites/tools/sort1")).status).toBe(404);
    });

    it("stores the theme preference", async () => {
        const router = makeRouter();
        expect(await fetchJson(router, "PUT", "/api/users/current/theme/dark")).toBe("dark");
        expect((await fetchJson(router, "GET", "/api/users/current")).preferences.theme).toBe("dark");
    });

    it("normalizes stored favorites like Galaxy", () => {
        expect(
            normalizeFavorites({
                tools: ["a", "a", "", 3, "b"],
                order: [{ object_type: "tools", object_id: "b" }, { object_type: "tools", object_id: "missing" }, "x"],
            }),
        ).toEqual({
            tools: ["a", "b"],
            tags: [],
            edam_operations: [],
            edam_topics: [],
            order: [
                { object_type: "tools", object_id: "b" },
                { object_type: "tools", object_id: "a" },
            ],
        });
    });
});

describe("disk usage maintenance", () => {
    it("answers recalculation with 204", async () => {
        const response = await send(makeRouter(), "PUT", "/api/users/current/recalculate_disk_usage");
        expect(response.status).toBe(204);
        expect(await fetchJson(makeRouter(), "GET", "/api/users/current/objectstore_usage")).toEqual([]);
    });
});
