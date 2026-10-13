/**
 * The job runner card on the welcome page and the runtime image of the build, without a cluster. The settings
 * point at a closed port; where a test needs a state a real leader only reaches with a cluster, it writes the
 * leader's records (client/src/planet/db/leader.ts) straight into IndexedDB.
 */
import { createHash } from "node:crypto";

import type { FrameLocator, Locator, Page } from "@playwright/test";

import { api, expect, openGalaxy, saveScreenshot, test } from "./fixtures";

/** Nothing listens here, in the container or in cluster mode (the relay uses 8001 and 8002). */
const CLOSED = "http://127.0.0.1:8019";
const JOB_ID = "0123456789abcdef";
/** Higher than any epoch a test's own tabs claim, so their resignation cannot remove the record. */
const TEST_EPOCH = 1000;

interface Status {
    configured: { cluster: boolean; storage: boolean };
    leader: { active: boolean; epoch: number | null; heartbeat_age_seconds: number | null; state: string | null };
    jobs: { queued: number; running: number };
    runtime: { image: string; source: string; default_image: string; build_image: string | null; pinned: boolean };
}

function statusCard(scope: Page | FrameLocator, title: string): Locator {
    return scope.locator("article.pw-status", { has: scope.getByRole("heading", { name: title, exact: true }) });
}

async function status(page: Page): Promise<Status> {
    const response = await api<Status>(page, "/api/planet/status");
    expect(response.status).toBe(200);
    return response.body;
}

/** Saves complete settings that point at a closed port, with placeholder credentials. */
async function configure(page: Page): Promise<void> {
    const response = await api(page, "/api/planet/settings", {
        method: "PUT",
        body: {
            cluster: { gateway_url: CLOSED, namespace: "planet", token: "e2e-placeholder-token" },
            storage: {
                endpoint: CLOSED,
                bucket: "planet",
                region: "garage",
                access_key_id: "GKe2eplaceholder",
                secret_access_key: "e2e-placeholder-secret",
            },
        },
    });
    expect(response.status).toBe(200);
}

/**
 * Writes the leader's heartbeat (`kv` key `leader`) and its report (`leader_status`, with `report`), both `ageMs`
 * old.
 */
async function writeLeaderRecords(page: Page, ageMs: number, report: Record<string, unknown>): Promise<void> {
    await page.evaluate(
        async ({ ageMs, epoch, report }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open("planet");
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                await new Promise<void>((resolve, reject) => {
                    const heartbeat = Date.now() - ageMs;
                    const tx = db.transaction("kv", "readwrite");
                    const kv = tx.objectStore("kv");
                    kv.put({ epoch, tab_id: "e2e", heartbeat, visible: true }, "leader");
                    kv.put(
                        {
                            epoch,
                            tab_id: "e2e",
                            heartbeat,
                            state: "active",
                            blocked_reason: null,
                            last_error: null,
                            counts: { queued: 0, running: 0 },
                            ...report,
                        },
                        "leader_status",
                    );
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                });
            } finally {
                db.close();
            }
        },
        { ageMs, epoch: TEST_EPOCH, report },
    );
}

test.describe("job runner", () => {
    test("the Galaxy tab runs jobs and the overview shows its card", async ({ page }, testInfo) => {
        await openGalaxy(page);
        await expect.poll(async () => (await status(page)).leader.active, { message: "a tab leads" }).toBe(true);
        const current = await status(page);
        expect(current.leader.epoch).toBeGreaterThanOrEqual(1);
        expect(current.leader.heartbeat_age_seconds).toBeLessThan(90);
        expect(current.jobs).toEqual({ queued: 0, running: 0 });

        const card = statusCard(page.frameLocator("iframe[name=frame]"), "Job runner");
        await expect(card).toContainText("Not configured");
        await expect(card).toContainText("Jobs start once the cluster and the storage bucket are connected.");
        await expect(card.getByRole("button", { name: /Set up/ })).toHaveAttribute("aria-controls", "pw-setup-cluster");
        await saveScreenshot(page, testInfo, "runner-galaxy-home");
    });

    test("the card follows the leader's record: waiting, blocked, failing", async ({ page, health }, testInfo) => {
        health.allow({
            text: /^Failed to load resource: net::ERR_CONNECTION_REFUSED/,
            url: /^http:\/\/127\.0\.0\.1:8019\//,
            reason: "The settings point at a closed port, so the welcome page's connection checks fail.",
        });
        await openGalaxy(page);
        await page.goto("/welcome");
        await configure(page);
        const card = statusCard(page, "Job runner");

        await writeLeaderRecords(page, 5 * 60_000, {});
        await page.reload();
        await expect(card).toContainText("Waiting for a Planet tab");
        await expect(card).toContainText("Jobs run only while Planet is open in a tab of this browser.");
        await expect(card.getByRole("link", { name: "Open Planet" })).toHaveAttribute("href", "/");
        await saveScreenshot(page, testInfo, "runner-waiting");

        // No reload from here on: the page reads the status every 10 seconds.
        await writeLeaderRecords(page, 0, { state: "blocked", blocked_reason: "The gateway refused the token." });
        await expect(card).toContainText("Blocked");
        await expect(card).toContainText("The gateway refused the token.");
        await card.getByRole("button", { name: /Review settings/ }).click();
        await expect(page.locator("#pw-setup-cluster .pw-section__toggle")).toHaveAttribute("aria-expanded", "true");

        await writeLeaderRecords(page, 0, {
            last_error: { message: "Kubernetes refused the Job: quota exceeded.", job_id: JOB_ID, time: Date.now() },
        });
        await expect(card).toContainText("Active, with errors");
        await expect(card).toContainText("Last error (just now): Kubernetes refused the Job: quota exceeded.");
        await expect(card.getByRole("link", { name: "View job" })).toHaveAttribute("href", `/jobs/${JOB_ID}/view`);
        await card.scrollIntoViewIfNeeded();
        await saveScreenshot(page, testInfo, "runner-failing");

        expect((await status(page)).leader).toMatchObject({ active: true, epoch: TEST_EPOCH, state: "active" });
    });
});

test.describe("runtime image", () => {
    test("the build publishes its runtime image in the data the Service Worker verifies", async ({ page }) => {
        await openGalaxy(page);
        const file = await page.evaluate(async () => {
            const response = await fetch("/static/planet/data/runtime.json", { cache: "no-store" });
            return { status: response.status, text: await response.text() };
        });
        expect(file.status).toBe(200);
        const { image } = JSON.parse(file.text) as { image: string | null };
        const { body: build } = await api<{ files: Record<string, string> }>(page, "/static/planet/build.json");
        expect(build.files["/static/planet/data/runtime.json"]).toBe(
            createHash("sha256").update(file.text).digest("hex"),
        );

        const { runtime } = await status(page);
        expect(runtime.build_image).toBe(image);
        expect(runtime.source).toBe(image ? "build" : "fallback");
        expect(runtime.image).toBe(runtime.default_image);
        expect(runtime.pinned).toBe(Boolean(image && /@sha256:[0-9a-f]{64}$/.test(image)));
    });

    test("the cluster settings warn about a runtime image without a digest", async ({ page }) => {
        await openGalaxy(page);
        await page.goto("/welcome");
        const { runtime } = await status(page);
        const form = page.getByRole("form", { name: "Cluster settings" });
        const disclosure = form.getByRole("button", { name: /Job defaults and runtime/ });
        await expect(disclosure.getByText("runtime image not pinned")).toHaveCount(runtime.pinned ? 0 : 1);

        await disclosure.click();
        const field = form.getByLabel("Runtime image");
        await expect(field).toHaveAttribute("placeholder", runtime.default_image);
        await field.fill("ghcr.io/example/planet-runtime:main");
        await expect(field).toHaveAccessibleDescription(/tag without a digest/);
        await field.fill(`ghcr.io/example/planet-runtime@sha256:${"0".repeat(64)}`);
        await expect(field).not.toHaveAccessibleDescription(/without a digest|does not pin/);
    });
});
