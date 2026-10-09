// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHUNK_UPLOAD_SIZE, GALAXY_VERSION_MAJOR, GALAXY_VERSION_MINOR, loadStaticData } from "../configuration";
import { PLANET_USER_ID } from "../users";
import { CONFIG, fetchJson, makeRouter, resetPlanet, send, stubStaticData, teardownPlanet } from "./contents.fixtures";

beforeEach(resetPlanet);
afterEach(teardownPlanet);

describe("GET /api/configuration", () => {
    it("serves the generated configuration with Planet's overrides", async () => {
        const config = await fetchJson(makeRouter(), "GET", "/api/configuration");
        expect(config.wiki_url).toBe(CONFIG.wiki_url);
        expect(config).toMatchObject({
            brand: "Planet",
            welcome_url: "/static/welcome.html",
            logo_src: "/static/favicon.svg",
            single_user: true,
            use_remote_user: true,
            enable_account_interface: false,
            enable_celery_tasks: false,
            enable_notification_system: false,
            enable_sse_updates: false,
            interactivetools_enable: false,
            enable_quotas: false,
            enable_webhooks: false,
            object_store_allows_id_selection: false,
            allow_user_dataset_purge: true,
            expose_dataset_path: true,
            is_admin_user: false,
            chunk_upload_size: CHUNK_UPLOAD_SIZE,
            themes: {},
            version_major: GALAXY_VERSION_MAJOR,
            version_minor: GALAXY_VERSION_MINOR,
        });
        expect(config.version_extra).toEqual({ planet_build: "dev" });
        expect(typeof config.server_starttime).toBe("number");
    });

    it("returns only the requested keys", async () => {
        const config = await fetchJson(makeRouter(), "GET", "/api/configuration?keys=brand,wiki_url,unknown_key");
        expect(config).toEqual({ brand: "Planet", wiki_url: CONFIG.wiki_url });
    });

    it("rejects unknown views", async () => {
        const response = await send(makeRouter(), "GET", "/api/configuration?view=admin");
        expect(response.status).toBe(400);
        expect((await response.json()).err_code).toBe(400008);
    });

    it("answers 500 with a Galaxy error when the configuration file is missing", async () => {
        stubStaticData({});
        const response = await send(makeRouter(), "GET", "/api/configuration");
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ err_code: 500003 });
    });
});

describe("loadStaticData", () => {
    it("fetches each file once and retries after a failure", async () => {
        const failing = stubStaticData({});
        await expect(loadStaticData("config.json")).rejects.toThrow(/unavailable/);
        expect(failing).toHaveBeenCalledTimes(1);

        const working = stubStaticData();
        await expect(loadStaticData("config.json")).resolves.toEqual(CONFIG);
        await loadStaticData("config.json");
        expect(working).toHaveBeenCalledTimes(1);
        expect(String(working.mock.calls[0]![0])).toBe("/static/planet/data/config.json");
    });
});

describe("GET /api/version and /api/whoami", () => {
    it("reports the Galaxy version and the Planet build", async () => {
        expect(await fetchJson(makeRouter(), "GET", "/api/version")).toEqual({
            version_major: GALAXY_VERSION_MAJOR,
            version_minor: GALAXY_VERSION_MINOR,
            extra: { planet_build: "dev" },
        });
    });

    it("describes the Planet user", async () => {
        expect(await fetchJson(makeRouter(), "GET", "/api/whoami")).toEqual({
            id: PLANET_USER_ID,
            email: "planet@localhost",
            username: "planet",
            active: true,
            deleted: false,
            last_password_change: null,
            model_class: "User",
        });
    });
});
