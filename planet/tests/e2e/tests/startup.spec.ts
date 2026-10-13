import { api, expect, openGalaxy, test } from "./fixtures";

test.describe("startup health", () => {
    test("Galaxy starts without console errors, error toasts or malformed API responses", async ({ page, health }) => {
        await openGalaxy(page);
        await expect(
            page.frameLocator("iframe[name=frame]").getByRole("heading", { name: "Welcome to Planet" }),
        ).toBeVisible();
        await page.waitForLoadState("networkidle");
        // Galaxy polls the current history; one more round must also be clean.
        await page.waitForTimeout(4000);
        const paths = new Set(health.apiResponses.map(({ path }) => path));
        for (const path of ["/context", "/api/configuration", "/api/users/current", "/api/tool_panels/default"]) {
            expect(paths, `${path} was requested`).toContain(path);
        }
        expect(health.apiResponses.filter(({ status }) => status >= 500)).toEqual([]);
    });

    test("unknown API paths get a Galaxy JSON 404, never the app shell", async ({ page, health }) => {
        health.allow({
            text: /^Failed to load resource: the server responded with a status of 404/,
            url: /\/planet-e2e-unknown$/,
            reason: "The test requests API paths that do not exist.",
        });
        await openGalaxy(page);
        for (const path of ["/api/planet-e2e-unknown", "/api/histories/0123456789abcdef/planet-e2e-unknown"]) {
            const response = await api<{ err_code: number; err_msg: string }>(page, path);
            expect(response.status, path).toBe(404);
            expect(response.headers["content-type"], path).toContain("application/json");
            expect(response.headers["x-request-id"], path).toMatch(/^[0-9a-f]{32}$/);
            expect(response.body, path).toEqual(
                expect.objectContaining({ err_code: expect.any(Number), err_msg: expect.any(String) }),
            );
        }
    });
});
