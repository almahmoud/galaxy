// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { settings } from "@/planet/db";

import { PLANET_USER_ID } from "../users";
import { fetchJson, makeRouter, request, resetPlanet, teardownPlanet } from "./contents.fixtures";

beforeEach(resetPlanet);
afterEach(teardownPlanet);

describe("GET /context", () => {
    it("returns the configuration, the detailed user and an empty CSRF token", async () => {
        const context = await fetchJson(makeRouter(), "GET", "/context");
        expect(Object.keys(context).sort()).toEqual(["config", "session_csrf_token", "user"]);
        expect(context.session_csrf_token).toBe("");
        expect(context.config).toMatchObject({ brand: "Planet", welcome_url: "/static/welcome.html", themes: {} });
        expect(context.user).toMatchObject({
            id: PLANET_USER_ID,
            email: "planet@localhost",
            username: "planet",
            is_admin: false,
        });
    });

    it("reflects the user configured in Planet settings", async () => {
        await settings.update({ user: { email: "me@example.org", username: "me" } });
        const context = await fetchJson(makeRouter(), "GET", "/context");
        expect(context.user).toMatchObject({ email: "me@example.org", username: "me" });
    });
});

describe("GET /welcome", () => {
    it("redirects to the welcome page", async () => {
        const response = await makeRouter().handle(request("/welcome", { mode: "same-origin" }));
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe("/static/welcome.html");
        expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
    });
});
