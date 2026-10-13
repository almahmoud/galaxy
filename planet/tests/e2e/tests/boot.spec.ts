import type { CDPSession, Page } from "@playwright/test";

import { expect, expectGalaxy, isControlled, openGalaxy, ORIGIN, test } from "./fixtures";

/** Document loads of the main frame (same-document history changes are not counted). */
function countDocumentLoads(page: Page): () => number {
    let loads = 0;
    page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            loads += 1;
        }
    });
    return () => loads;
}

/** Reloads bypassing the HTTP cache and the Service Worker, like Shift+Reload. */
async function hardReload(cdp: CDPSession): Promise<void> {
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.reload", { ignoreCache: true });
}

test.describe("boot gate", () => {
    test("first visit registers the Service Worker and starts Galaxy", async ({ page }) => {
        const loads = countDocumentLoads(page);
        await openGalaxy(page);
        expect(loads()).toBe(1);
        const registration = await page.evaluate(async () => {
            const current = await navigator.serviceWorker.getRegistration("/");
            return { scope: current?.scope, script: current?.active?.scriptURL };
        });
        expect(registration).toEqual({ scope: `${ORIGIN}/`, script: `${ORIGIN}/sw.js` });
        await expect(page).toHaveTitle(/Planet/);
    });

    test("a hard reload ends Service Worker controlled after one automatic reload", async ({ page, context }) => {
        await openGalaxy(page);
        const loads = countDocumentLoads(page);
        await hardReload(await context.newCDPSession(page));
        await expectGalaxy(page);
        expect(loads(), "the forced load plus one automatic reload").toBe(2);
    });

    test("a hard reload after a recent automatic reload shows the failure page instead of looping", async ({
        page,
        context,
    }) => {
        await openGalaxy(page);
        // The boot gate's sessionStorage guard, as left by an automatic reload a moment ago.
        await page.evaluate(() => sessionStorage.setItem("planet:boot-reload", String(Date.now())));
        const cdp = await context.newCDPSession(page);
        const loads = countDocumentLoads(page);
        await hardReload(cdp);
        const message = page.locator(".planet-boot-message");
        await expect(message).toHaveAttribute("data-reason", "not-controlled");
        await expect(message.getByRole("heading", { name: "Service workers are required" })).toBeVisible();
        expect(await isControlled(page)).toBe(false);
        expect(loads()).toBe(1);

        await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
        await message.getByRole("button", { name: "Reload" }).click();
        await expectGalaxy(page);
    });

    test("blocked Service Workers show the 'Service workers are required' page", async ({ browser }) => {
        const context = await browser.newContext({ serviceWorkers: "block" });
        try {
            const page = await context.newPage();
            const bundleRequests: string[] = [];
            page.on("request", (request) => {
                if (/\/static\/dist\/(libs|analysis)\.bundled\.js/.test(request.url())) {
                    bundleRequests.push(request.url());
                }
            });
            await page.goto("/");
            const message = page.locator(".planet-boot-message");
            await expect(message.getByRole("heading", { name: "Service workers are required" })).toBeVisible();
            await expect(page.locator("#masthead")).toHaveCount(0);
            expect(bundleRequests, "Galaxy bundles load only under Service Worker control").toEqual([]);
        } finally {
            await context.close();
        }
    });

    const unavailable = [
        {
            name: "without the Service Worker API",
            reason: "unsupported",
            script: "Object.defineProperty(Navigator.prototype, 'serviceWorker', { get: () => undefined });",
        },
        {
            name: "when registration is refused",
            reason: "registration-failed",
            script:
                "ServiceWorkerContainer.prototype.register = () => " +
                "Promise.reject(new DOMException('The operation is insecure.', 'SecurityError'));",
        },
    ];
    for (const { name, reason, script } of unavailable) {
        test(`the failure page explains the problem ${name}`, async ({ browser }) => {
            const context = await browser.newContext();
            try {
                await context.addInitScript(script);
                const page = await context.newPage();
                await page.goto("/");
                const message = page.locator(".planet-boot-message");
                await expect(message).toHaveAttribute("data-reason", reason);
                await expect(message.getByRole("heading", { name: "Service workers are required" })).toBeVisible();
                await expect(page.locator("#masthead")).toHaveCount(0);
            } finally {
                await context.close();
            }
        });
    }
});
