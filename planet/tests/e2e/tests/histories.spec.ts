import type { Page } from "@playwright/test";

import { api, currentHistoryId, expect, listHistories, openGalaxy, saveScreenshot, test } from "./fixtures";

const RENAMED = "E2E renamed history";

function historyCards(page: Page) {
    return page.locator("#history-list .history-card-list .g-card");
}

function cardTitle(page: Page, historyId: string) {
    return page.locator(`#history-list #g-card-title-history-${historyId}`);
}

test.describe("histories", () => {
    test("create, rename, switch back and persist across reloads", async ({ page }, testInfo) => {
        await openGalaxy(page);
        const panel = page.locator("#current-history-panel");
        const nameDisplay = panel.locator('[data-description="name display"]');

        const initial = await listHistories(page);
        expect(initial, "the default history").toHaveLength(1);
        const original = initial[0]!;
        expect(original.name).toBe("Unnamed history");
        expect(await currentHistoryId(page)).toBe(original.id);
        await expect(nameDisplay).toHaveText("Unnamed history");

        await panel.locator('[data-description="create new history"]').click();
        await expect.poll(() => currentHistoryId(page)).not.toBe(original.id);
        const createdId = await currentHistoryId(page);

        await panel.locator('[data-description="editor toggle"]').click();
        const nameInput = panel.locator('[data-description="name input"]');
        await nameInput.fill(RENAMED);
        await nameInput.press("Enter");
        await expect(nameDisplay).toHaveText(RENAMED);
        await expect
            .poll(async () => (await listHistories(page)).find(({ id }) => id === createdId)?.name)
            .toBe(RENAMED);

        await page.goto("/histories/list");
        await expect(historyCards(page)).toHaveCount(2);
        await page.locator(`#history-list #g-card-title-link-history-${original.id}`).click();
        await expect.poll(() => currentHistoryId(page)).toBe(original.id);
        await expect(nameDisplay).toHaveText("Unnamed history");

        await expectListed(page, original.id, createdId);
        await saveScreenshot(page, testInfo, "histories-list");

        await page.reload();
        await expect(page.locator("#masthead")).toBeVisible();
        await expectListed(page, original.id, createdId);
        expect(await currentHistoryId(page)).toBe(original.id);
    });
});

async function expectListed(page: Page, originalId: string, createdId: string): Promise<void> {
    await expect(historyCards(page)).toHaveCount(2);
    await expect(cardTitle(page, originalId)).toContainText("Unnamed history");
    await expect(cardTitle(page, createdId)).toContainText(RENAMED);

    const histories = await listHistories(page);
    expect(
        histories.map(({ id, name, count }) => ({ id, name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
        { id: createdId, name: RENAMED, count: 0 },
        { id: originalId, name: "Unnamed history", count: 0 },
    ]);
    const { body: total } = await api<number>(page, "/api/histories/count");
    expect(total).toBe(2);
}
