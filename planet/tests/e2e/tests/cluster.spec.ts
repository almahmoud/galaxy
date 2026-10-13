/**
 * Runs Planet against a real cluster: the kind cluster of planet/scripts/dev-cluster.sh with Garage, its
 * port-forward reached through cluster-relay.mjs. Enabled by PLANET_E2E_CLUSTER=1 (planet/scripts/e2e.sh), which
 * also passes the planet-client token and the Garage keys as files in PLANET_E2E_SECRETS.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect, openGalaxy, saveScreenshot, test } from "./fixtures";

const ENABLED = process.env.PLANET_E2E_CLUSTER === "1";
const GATEWAY = "http://127.0.0.1:8001";
const NAMESPACE = "planet";
const RUNTIME_IMAGE = "planet-runtime:dev";
const DATAMASH = "toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/datamash_ops/1.9+galaxy0";
const outDir = process.env.PLANET_E2E_OUT ?? resolve(__dirname, "../../../build/e2e");

const TABLE = "gene\tsample\tcount\ngeneB\ts1\t5\ngeneA\ts1\t10\ngeneA\ts2\t7\ngeneC\ts2\t3\n";
const FASTA = ">seq1 first\nACGTACGTACGTACGTACGT\nACGTAC\n>seq2 second\nTTTTGGGGCCCCAAAA\n";

/** First pull of the runtime and tool images, scheduling and two stage-outs fit well within this. */
const JOB_TIMEOUT = 5 * 60_000;

interface ClusterSecrets {
    token: string;
    accessKeyId: string;
    secretAccessKey: string;
}

function readSecrets(): ClusterSecrets {
    const directory = process.env.PLANET_E2E_SECRETS ?? "/secrets";
    const read = (name: string) => readFileSync(join(directory, name), "utf8").trim();
    return { token: read("token"), accessKeyId: read("access-key-id"), secretAccessKey: read("secret-access-key") };
}

/** Lists Planet's Kubernetes objects through the gateway, as the leader tab does. */
async function listPlanetObjects(token: string, resource: "jobs" | "pods"): Promise<string[]> {
    const group = resource === "jobs" ? "apis/batch/v1" : "api/v1";
    const url = `${GATEWAY}/${group}/namespaces/${NAMESPACE}/${resource}?labelSelector=planet.dev%2Finstance`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Origin: "http://127.0.0.1:8787", Accept: "application/json" },
    });
    expect(response.status, `list ${resource}`).toBe(200);
    const body = (await response.json()) as { items: { metadata: { name: string } }[] };
    return body.items.map((item) => item.metadata.name);
}

function historyItem(page: Page, hid: number): Locator {
    return page.locator(`#current-history-panel [data-hid="${hid}"]`).first();
}

/** Waits until a history item settles and expects `state`; a different final state fails at once. */
async function waitForState(page: Page, hid: number, state: string, timeout = JOB_TIMEOUT): Promise<void> {
    const item = historyItem(page, hid);
    const settled = new RegExp(`^(ok|error|paused|failed_metadata|deferred|discarded|${state})$`);
    await expect
        .poll(async () => ((await item.count()) ? ((await item.getAttribute("data-state")) ?? "") : ""), {
            message: `history item ${hid} settles`,
            timeout,
            intervals: [1000],
        })
        .toMatch(settled);
    await expect(item, `history item ${hid} is ${state}`).toHaveAttribute("data-state", state, { timeout: 1000 });
}

async function expandItem(page: Page, hid: number): Promise<Locator> {
    const item = historyItem(page, hid);
    if (!(await item.locator(".details").isVisible())) {
        await item.locator(".content-title").click();
    }
    await expect(item.locator(".details")).toBeVisible();
    return item;
}

async function openToolForm(page: Page, toolId: string): Promise<void> {
    await page.goto(`/?tool_id=${encodeURIComponent(toolId)}`);
    await expect(page.locator("button#execute").first()).toBeVisible();
}

async function setSwitch(page: Page, parameter: string, value: boolean): Promise<void> {
    const input = page.locator(`#form-element-${parameter} input[type="checkbox"]`);
    if ((await input.isChecked()) !== value) {
        await page.locator(`#form-element-${parameter} .custom-control-label`).click();
    }
    await expect(input).toBeChecked({ checked: value });
}

/** Opens a dataset's details page from the history panel and returns its job information table. */
async function openJobInformation(page: Page, hid: number): Promise<Locator> {
    const item = await expandItem(page, hid);
    await item.locator(".info-btn").click();
    const table = page.locator("table#job-information");
    await expect(table).toBeVisible();
    await table.scrollIntoViewIfNeeded();
    return table;
}

const timings: Record<string, number> = {};

async function timed<T>(name: string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
        return await action();
    } finally {
        timings[name] = (Date.now() - started) / 1000;
    }
}

function saveConsoleLog(page: Page, testInfo: TestInfo): () => void {
    const lines: string[] = [];
    page.on("console", (message) => lines.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => lines.push(`[pageerror] ${error.message}`));
    return () => {
        const path = resolve(outDir, `cluster-console-${testInfo.workerIndex}.log`);
        writeFileSync(path, `${lines.join("\n")}\n`);
    };
}

test.describe("cluster", () => {
    test.skip(!ENABLED, "set PLANET_E2E_CLUSTER=1 and run planet/scripts/dev-cluster.sh port-forward");
    test.describe.configure({ mode: "serial" });
    test.use({ actionTimeout: 30_000 });

    test("uploads data, runs a tool and reports a failing job on a real cluster", async ({
        page,
        health,
    }, testInfo) => {
        test.setTimeout(20 * 60_000);
        health.allow({
            text: /^Failed to load resource: the server responded with a status of 403/,
            url: /^http:\/\/127\.0\.0\.1:8002\/$/,
            reason: "The storage test checks that the endpoint answers with an unsigned request, which S3 refuses.",
        });
        health.allow({
            text: /^Failed to load resource: the server responded with a status of 404/,
            url: /^http:\/\/127\.0\.0\.1:8002\/planet\/planet\/jobs\/[0-9a-f]+\/dispatch\.json$/,
            reason: "The leader reads a job's dispatch record before its first dispatch, when it does not exist yet.",
        });
        // Galaxy silences the console in production builds; the leader's warnings help diagnose failures.
        await page.addInitScript(() => window.localStorage.setItem("console-debugging-enabled", "true"));
        const secrets = readSecrets();
        const writeConsole = saveConsoleLog(page, testInfo);
        try {
            await openGalaxy(page);
            await page.goto("/welcome");

            // Cluster settings.
            const cluster = page.getByRole("form", { name: "Cluster settings" });
            await cluster.getByLabel("Gateway URL").fill(GATEWAY);
            await cluster.getByRole("textbox", { name: "Namespace", exact: true }).fill(NAMESPACE);
            await cluster.getByLabel("Token").fill(secrets.token);
            await cluster.getByRole("button", { name: "Job defaults and runtime" }).click();
            await cluster.getByLabel("Runtime image").fill(RUNTIME_IMAGE);
            await cluster.getByRole("button", { name: "Save" }).click();
            await expect(cluster.getByRole("status")).toHaveText("Saved.");
            await cluster.getByRole("button", { name: "Test connection" }).click();
            const clusterReport = page.getByRole("region", { name: "Cluster connection test" });
            await expect(clusterReport).toContainText("The connection works", { timeout: 60_000 });

            // Storage settings.
            const storage = page.getByRole("form", { name: "Storage settings" });
            await storage.getByText("Local Garage", { exact: true }).click();
            await storage.getByLabel("Access key ID").fill(secrets.accessKeyId);
            await storage.getByLabel("Secret access key").fill(secrets.secretAccessKey);
            await storage.getByRole("button", { name: "Save" }).click();
            await expect(storage.getByRole("status")).toHaveText("Saved.");
            await storage.getByRole("button", { name: "Test connection" }).click();
            const storageReport = page.getByRole("region", { name: "Storage connection test" });
            await expect(storageReport).toContainText("The connection works", { timeout: 60_000 });
            await saveScreenshot(page, testInfo, "cluster-01-settings");

            // Upload a tabular and a FASTA file through Galaxy's upload activity.
            const table = testInfo.outputPath("counts.tsv");
            const fasta = testInfo.outputPath("sequences.fasta");
            writeFileSync(table, TABLE);
            writeFileSync(fasta, FASTA);
            await openGalaxy(page);
            await page.locator("#activity-upload").click();
            await page.locator('[data-method-id="local-file"]').click();
            await page.locator("#local-file-input").setInputFiles([table, fasta]);
            await saveScreenshot(page, testInfo, "cluster-02-upload-staged");
            await timed("upload", async () => {
                await page.locator('[data-test-id="start-upload"]').click();
                await waitForState(page, 1, "ok");
                await waitForState(page, 2, "ok");
            });

            const tabular = await expandItem(page, 1);
            await expect(tabular.locator(".name")).toContainText("counts.tsv");
            await expect(tabular.locator(".datatype .value")).toHaveText("tabular");
            await expect(tabular.locator(".blurb .value")).toContainText("5 lines");
            await expect(tabular.locator(".dataset-peek")).toContainText("geneA");
            const sequences = await expandItem(page, 2);
            await expect(sequences.locator(".datatype .value")).toHaveText("fasta");
            await expect(sequences.locator(".blurb .value")).toContainText("2 sequences");
            await expect(sequences.locator(".dataset-peek")).toContainText("seq1");
            await saveScreenshot(page, testInfo, "cluster-03-uploaded");

            // Datamash: count rows per gene of the tabular dataset.
            await openToolForm(page, DATAMASH);
            await expect(page.locator("#form-element-in_file")).toContainText("counts.tsv");
            await page.locator("#form-element-grouping input").fill("1");
            await setSwitch(page, "need_sort", true);
            await setSwitch(page, "header_in", true);
            await saveScreenshot(page, testInfo, "cluster-04-tool-form");
            await timed("tool run", async () => {
                await page.locator("button#execute").first().click();
                await expect(page.getByText(/successfully added 1 job/i)).toBeVisible();
                await waitForState(page, 3, "ok");
            });
            await saveScreenshot(page, testInfo, "cluster-05-tool-ok");

            const output = await expandItem(page, 3);
            await expect(output.locator(".dataset-peek")).toContainText("geneA");
            await output.locator(".display-btn").click();
            const center = page.locator("#center");
            await expect(center).toContainText("geneA");
            const text = (await center.innerText()).replace(/\s+/g, " ");
            expect(text).toMatch(/geneA 2 geneB 1 geneC 1/);
            await saveScreenshot(page, testInfo, "cluster-06-output");

            const job = await openJobInformation(page, 3);
            await expect(job.locator("#command-line")).toContainText("datamash");
            await expect(job.locator("#command-line")).toContainText("--group '1'");
            await expect(job.locator("#stdout")).toBeVisible();
            await expect(job.locator("#exit-code")).toHaveText("0");
            await saveScreenshot(page, testInfo, "cluster-07-job-information");

            // The form now selects the newest tabular dataset, the two-column output; datamash exits 1 when asked to
            // group by a field the input does not have.
            await openToolForm(page, DATAMASH);
            await expect(page.locator("#form-element-in_file")).toContainText("Datamash on dataset 1");
            await page.locator("#form-element-grouping input").fill("9");
            await setSwitch(page, "header_in", true);
            await timed("failing tool run", async () => {
                await page.locator("button#execute").first().click();
                await expect(page.getByText(/successfully added 1 job/i)).toBeVisible();
                await waitForState(page, 4, "error");
            });
            const failed = await expandItem(page, 4);
            await expect(failed).toContainText("An error occurred with this dataset");
            await expect(failed.locator(".info .value")).toContainText("field 9 requested");
            await saveScreenshot(page, testInfo, "cluster-08-tool-error");
            const failedJob = await openJobInformation(page, 4);
            await expect(failedJob.locator("#stderr")).toContainText("invalid input: field 9 requested");
            await expect(failedJob.locator("#exit-code")).toHaveText("1");
            await saveScreenshot(page, testInfo, "cluster-09-error-job-information");

            // Finished jobs are removed from the cluster.
            await expect.poll(() => listPlanetObjects(secrets.token, "jobs"), { timeout: 120_000 }).toEqual([]);
            await expect.poll(() => listPlanetObjects(secrets.token, "pods"), { timeout: 120_000 }).toEqual([]);
        } finally {
            writeConsole();
            await testInfo.attach("timings", {
                body: JSON.stringify(timings, null, 2),
                contentType: "application/json",
            });
            console.log(`cluster timings (s): ${JSON.stringify(timings)}`);
        }
    });
});
