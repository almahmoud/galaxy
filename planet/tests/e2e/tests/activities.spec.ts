import { expect, openGalaxy, saveScreenshot, test } from "./fixtures";

/** Sections of the starter toolbox, planet/toolbox/toolbox.yml. */
const STARTER_SECTIONS = [
    "Get Data",
    "Text Manipulation",
    "Datamash",
    "FASTQ Quality Control",
    "Mapping",
    "SAM/BAM",
    "Reports",
];

test.describe("activity bar", () => {
    test("every default activity opens without errors", async ({ page, health }, testInfo) => {
        await openGalaxy(page);
        const items = page.locator('.activity-bar a[id^="activity-"]');
        await expect(items.first()).toBeVisible();
        const ids = await items.evaluateAll((links) => links.map((link) => link.id));
        expect(ids).toEqual(expect.arrayContaining(["activity-tools", "activity-workflows", "activity-histories"]));

        const panel = page.locator(".activity-panel[data-description]").first();
        const visibleHeading = async () =>
            (await panel.isVisible()) ? await panel.getAttribute("data-description") : null;

        for (const id of ids) {
            await test.step(id, async () => {
                const toastsBefore = health.errorToasts.length;
                const errorsBefore = health.consoleErrors.length + health.pageErrors.length;
                const urlBefore = page.url();
                const headingBefore = await visibleHeading();

                await page.locator(`#${id}`).click();
                await page.waitForLoadState("networkidle");
                await page.waitForTimeout(750);

                const heading = await visibleHeading();
                const dialogs = await page.getByRole("dialog").count();
                const path = new URL(page.url()).pathname;
                const outcome = page.url() !== urlBefore ? `page ${path}` : `panel ${heading ?? "closed"}`;
                testInfo.annotations.push({ type: id, description: outcome });
                expect
                    .soft(
                        heading !== headingBefore || page.url() !== urlBefore || dialogs > 0,
                        `${id} opened something`,
                    )
                    .toBe(true);
                expect.soft(health.errorToasts.slice(toastsBefore), `error toasts after ${id}`).toEqual([]);
                expect
                    .soft(health.consoleErrors.length + health.pageErrors.length - errorsBefore, `errors after ${id}`)
                    .toBe(0);

                await page.keyboard.press("Escape");
                if (!(await page.locator("#masthead").isVisible())) {
                    await openGalaxy(page);
                }
            });
        }
    });

    test("the tool panel lists the starter toolbox sections", async ({ page }, testInfo) => {
        await openGalaxy(page);
        const toolbox = page.locator("#toolbox-panel");
        // Galaxy opens the tool panel by default; the activity button toggles it.
        if (
            !(await toolbox.waitFor({ timeout: 5000 }).then(
                () => true,
                () => false,
            ))
        ) {
            await page.locator("#activity-tools").click();
        }
        await expect(toolbox).toBeVisible();
        const titles = toolbox.locator(".tool-panel-section .toolSectionTitle .name");
        await expect(titles.first()).toBeVisible();
        const names = (await titles.allInnerTexts()).map((name) => name.trim());
        expect(names).toEqual(expect.arrayContaining(STARTER_SECTIONS));

        await toolbox.locator(".toolSectionTitle", { hasText: "Text Manipulation" }).click();
        await expect(toolbox.locator(".toolTitle a").first()).toBeVisible();
        await saveScreenshot(page, testInfo, "tool-panel");
    });
});
