import type { FrameLocator, Locator, Page } from "@playwright/test";

import { api, expect, openGalaxy, saveScreenshot, test } from "./fixtures";

const UNREACHABLE_GATEWAY = "http://127.0.0.1:8001";

function statusCard(scope: Page | FrameLocator, title: string): Locator {
    return scope.locator("article.pw-status", { has: scope.getByRole("heading", { name: title, exact: true }) });
}

async function openWelcome(page: Page): Promise<void> {
    await openGalaxy(page);
    await page.goto("/welcome");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to Planet" })).toBeVisible();
}

test.describe("welcome page", () => {
    test("Galaxy's center panel shows the Planet overview", async ({ page }, testInfo) => {
        await openGalaxy(page);
        const welcome = page.frameLocator("iframe[name=frame]");
        await expect(welcome.getByRole("heading", { level: 1, name: "Welcome to Planet" })).toBeVisible();
        for (const title of ["Kubernetes cluster", "Storage bucket"]) {
            await expect(statusCard(welcome, title)).toContainText("Not configured");
        }
        await saveScreenshot(page, testInfo, "galaxy-home");
    });

    test("full page at desktop and mobile widths", async ({ page }, testInfo) => {
        await openWelcome(page);
        for (const title of ["Kubernetes cluster", "Storage bucket"]) {
            await expect(statusCard(page, title)).toContainText("Not configured");
        }
        await saveScreenshot(page, testInfo, "welcome-desktop-1440x900");

        await page.setViewportSize({ width: 390, height: 844 });
        await expect(statusCard(page, "Storage bucket")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, "no horizontal scrolling at 390 px").toBeLessThanOrEqual(0);
        await saveScreenshot(page, testInfo, "welcome-mobile-390x844");
    });

    test("cluster settings reject a non-local http gateway", async ({ page, health }) => {
        health.allow({
            text: /^Failed to load resource: the server responded with a status of 400/,
            url: /\/api\/planet\/settings$/,
            reason: "The test sends invalid settings to the API, which must answer 400.",
        });
        await openWelcome(page);
        const form = page.getByRole("form", { name: "Cluster settings" });
        const gateway = form.getByLabel("Gateway URL");
        await gateway.fill("http://gateway.example.org:8001");
        await form.getByRole("button", { name: "Save" }).click();
        await expect(gateway).toHaveAttribute("aria-invalid", "true");
        await expect(gateway).toHaveAccessibleDescription(/must use https:\/\//);

        const response = await api<{ err_code: number; err_data: Record<string, unknown> }>(
            page,
            "/api/planet/settings",
            { method: "PUT", body: { cluster: { gateway_url: "http://gateway.example.org:8001" } } },
        );
        expect(response.status).toBe(400);
        expect(response.body.err_code).toBe(400004);
        expect(JSON.stringify(response.body.err_data)).toMatch(/must use https:\/\//);
        const { body: settings } = await api<{ cluster: { gateway_url: string } }>(page, "/api/planet/settings");
        expect(settings.cluster.gateway_url).not.toContain("example.org");
    });

    test("cluster settings save without a reachable gateway and the test reports what to fix", async ({
        page,
        health,
    }) => {
        test.skip(process.env.PLANET_E2E_CLUSTER === "1", "the cluster relay listens on the gateway port");
        health.allow({
            text: /^Failed to load resource: net::ERR_CONNECTION_REFUSED/,
            url: /^http:\/\/127\.0\.0\.1:8001\//,
            reason: "Test connection is pointed at a gateway that is deliberately not running.",
        });
        await openWelcome(page);
        const form = page.getByRole("form", { name: "Cluster settings" });
        await form.getByLabel("Gateway URL").fill(UNREACHABLE_GATEWAY);
        await form.getByRole("textbox", { name: "Namespace", exact: true }).fill("planet");
        await form.getByRole("button", { name: "Save" }).click();
        await expect(form.getByRole("status")).toHaveText("Saved.");

        const { body: settings } = await api<{ cluster: { gateway_url: string; namespace: string } }>(
            page,
            "/api/planet/settings",
        );
        expect(settings.cluster).toEqual(
            expect.objectContaining({ gateway_url: UNREACHABLE_GATEWAY, namespace: "planet" }),
        );
        await expect(statusCard(page, "Kubernetes cluster")).toContainText("Not configured");

        await form.getByRole("button", { name: "Test connection" }).click();
        const report = page.getByRole("region", { name: "Cluster connection test" });
        await expect(report).toContainText(`Could not reach the gateway at ${UNREACHABLE_GATEWAY}`);
        await expect(report).toContainText("port-forward");

        await page.reload();
        await expect(page.getByRole("form", { name: "Cluster settings" }).getByLabel("Gateway URL")).toHaveValue(
            UNREACHABLE_GATEWAY,
        );
    });
});
