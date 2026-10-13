import type { Page } from "@playwright/test";

import { api, expect, listHistories, openGalaxy, test } from "./fixtures";

const SAVED_GATEWAY = "http://127.0.0.1:8001";
const ATTACKER_GATEWAY = "http://127.0.0.1:9";

/** Submits a text/plain form, the way another site can post JSON-looking bodies cross-origin. */
async function submitForm(page: Page, action: string, json: Record<string, unknown>): Promise<number> {
    const body = JSON.stringify({ ...json, pad: "" });
    // text/plain encodes name=value; the "=" lands inside the pad string.
    const name = body.slice(0, -2);
    const value = '"}';
    const response = page.waitForResponse(
        (candidate) =>
            new URL(candidate.url()).pathname === action &&
            candidate.request().method() === "POST" &&
            candidate.request().isNavigationRequest(),
    );
    await page.evaluate(
        ({ action, name, value }) => {
            const form = document.createElement("form");
            form.method = "POST";
            form.action = action;
            form.enctype = "text/plain";
            const field = document.createElement("input");
            field.name = name;
            field.value = value;
            form.append(field);
            document.body.append(form);
            form.submit();
        },
        { action, name, value },
    );
    const status = (await response).status();
    await page.waitForURL(`**${action}`);
    return status;
}

test.describe("security smoke", () => {
    test("a top-level navigation cannot create a history", async ({ page, health }) => {
        health.allow({
            text: /^Failed to load resource: the server responded with a status of 403/,
            url: /\/history\/create_new_current/,
            reason: "The test navigates to a state-changing endpoint that must answer 403.",
        });
        await openGalaxy(page);
        const before = await listHistories(page);

        const response = await page.goto("/history/create_new_current?name=x");
        expect(response?.status()).toBe(403);

        await openGalaxy(page);
        const after = await listHistories(page);
        expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id));
        expect(after.some(({ name }) => name === "x")).toBe(false);
    });

    test("cross-site form posts cannot change settings or send the saved token elsewhere", async ({
        page,
        context,
        health,
    }) => {
        health.allow({
            text: /^Failed to load resource: the server responded with a status of 4\d\d/,
            url: /\/api\/planet\/settings(\/check)?$/,
            reason: "The test submits forms the Service Worker must refuse.",
        });
        const attackerRequests: string[] = [];
        context.on("request", (request) => {
            if (request.url().startsWith(ATTACKER_GATEWAY)) {
                attackerRequests.push(`${request.method()} ${request.url()}`);
            }
        });
        await openGalaxy(page);
        const saved = await api(page, "/api/planet/settings", {
            method: "PUT",
            body: { cluster: { gateway_url: SAVED_GATEWAY, namespace: "planet", token: "planet-e2e-token" } },
        });
        expect(saved.status).toBe(200);

        const check = await submitForm(page, "/api/planet/settings/check", {
            targets: ["cluster"],
            mode: "full",
            settings: { cluster: { gateway_url: ATTACKER_GATEWAY, namespace: "planet" } },
        });
        expect(check).toBeGreaterThanOrEqual(400);
        expect(check).toBeLessThan(500);

        const update = await submitForm(page, "/api/planet/settings", {
            cluster: { gateway_url: ATTACKER_GATEWAY, namespace: "planet" },
        });
        expect(update).toBeGreaterThanOrEqual(400);
        expect(update).toBeLessThan(500);

        await openGalaxy(page);
        const { body: after } = await api<{ cluster: { gateway_url: string; has_token: boolean } }>(
            page,
            "/api/planet/settings",
        );
        expect(after.cluster).toEqual(expect.objectContaining({ gateway_url: SAVED_GATEWAY, has_token: true }));
        expect(attackerRequests).toEqual([]);
    });

    test("dataset HTML previews carry a sandbox CSP", async () => {
        test.skip(true, "Needs a configured storage bucket: dataset records cannot be created without one.");
    });
});
