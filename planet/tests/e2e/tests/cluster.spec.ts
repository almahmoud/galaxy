/**
 * Runs Planet against a real cluster: the kind cluster of planet/scripts/dev-cluster.sh with Garage, its
 * port-forward reached through cluster-relay.mjs. Enabled by PLANET_E2E_CLUSTER=1 (planet/scripts/e2e.sh), which
 * also passes the planet-client token and the Garage keys as files in PLANET_E2E_SECRETS.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { FrameLocator, Locator, Page, TestInfo } from "@playwright/test";

import {
    api,
    expect,
    expectGalaxy,
    fillSecret,
    type Health,
    openGalaxy,
    ORIGIN,
    saveScreenshot,
    test,
} from "./fixtures";

const ENABLED = process.env.PLANET_E2E_CLUSTER === "1";
const GATEWAY = "http://127.0.0.1:8001";
const NAMESPACE = "planet";
const RUNTIME_IMAGE = "planet-runtime:dev";
/** The Local Garage preset of the storage settings: path-style bucket `planet`, keys under `planet/`. */
const S3_ENDPOINT = "http://127.0.0.1:8002";
const S3_BUCKET = "planet";
const S3_KEY_PREFIX = "planet/";
const S3_REGION = "garage";
const DATAMASH = "toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/datamash_ops/1.9+galaxy0";
const DATAMASH_REVERSE = "toolshed.g2.bx.psu.edu/repos/iuc/datamash_reverse/datamash_reverse/1.9+galaxy0";
const MINIMAP2 = "toolshed.g2.bx.psu.edu/repos/iuc/minimap2/minimap2/2.31+galaxy1";
const QUERY_TABULAR = "toolshed.g2.bx.psu.edu/repos/iuc/query_tabular/query_tabular/3.3.2";
const outDir = process.env.PLANET_E2E_OUT ?? resolve(__dirname, "../../../build/e2e");

const TABLE = "gene\tsample\tcount\ngeneB\ts1\t5\ngeneA\ts1\t10\ngeneA\ts2\t7\ngeneC\ts2\t3\n";
const FASTA = ">seq1 first\nACGTACGTACGTACGTACGT\nACGTAC\n>seq2 second\nTTTTGGGGCCCCAAAA\n";

/** First pull of the runtime and tool images, scheduling and two stage-outs fit well within this. */
const JOB_TIMEOUT = 5 * 60_000;

/** An SQLite query that counts to `n` (about 3 million rows a second), for jobs that keep running a while. */
function countingQuery(n: number): string {
    return `SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT x FROM c)`;
}

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

function kubeHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, Origin: ORIGIN, Accept: "application/json" };
}

/** Lists Planet's Kubernetes objects through the gateway, as the leader tab does. */
async function listPlanetObjects(token: string, resource: "jobs" | "pods"): Promise<string[]> {
    const group = resource === "jobs" ? "apis/batch/v1" : "api/v1";
    const url = `${GATEWAY}/${group}/namespaces/${NAMESPACE}/${resource}?labelSelector=planet.dev%2Finstance`;
    const response = await fetch(url, { headers: kubeHeaders(token) });
    expect(response.status, `list ${resource}`).toBe(200);
    const body = (await response.json()) as { items: { metadata: { name: string } }[] };
    return body.items.map((item) => item.metadata.name);
}

function sha256(data: string): string {
    return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data).digest();
}

/** Lists the keys under `prefix` (below the settings' key prefix) with a SigV4-signed ListObjectsV2 request. */
async function listBucket(secrets: ClusterSecrets, prefix: string): Promise<string[]> {
    const amzDate = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const query = `list-type=2&prefix=${encodeURIComponent(S3_KEY_PREFIX + prefix)}`;
    const payloadHash = sha256("");
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonical = [
        "GET",
        `/${S3_BUCKET}`,
        query,
        `host:${new URL(S3_ENDPOINT).host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
        signedHeaders,
        payloadHash,
    ].join("\n");
    const scope = `${day}/${S3_REGION}/s3/aws4_request`;
    const signingKey = ["s3", "aws4_request"].reduce(
        (key, part) => hmac(key, part),
        hmac(hmac(`AWS4${secrets.secretAccessKey}`, day), S3_REGION),
    );
    const signature = createHmac("sha256", signingKey)
        .update(["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n"))
        .digest("hex");
    const response = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}?${query}`, {
        headers: {
            Origin: ORIGIN,
            "x-amz-date": amzDate,
            "x-amz-content-sha256": payloadHash,
            Authorization: `AWS4-HMAC-SHA256 Credential=${secrets.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
    });
    const body = await response.text();
    expect(response.status, `list ${prefix}: ${body.slice(0, 200)}`).toBe(200);
    return [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]!.slice(S3_KEY_PREFIX.length));
}

interface ContainerTimes {
    startedAt?: string;
    finishedAt?: string;
}

interface WatchedPod {
    metadata: { name: string; creationTimestamp?: string; labels?: Record<string, string> };
    spec?: { initContainers?: { name: string; image?: string }[]; containers?: { name: string; image?: string }[] };
    status?: {
        initContainerStatuses?: { name: string; state?: Record<string, ContainerTimes> }[];
        containerStatuses?: { name: string; state?: Record<string, ContainerTimes> }[];
    };
}

export interface PodTimings {
    pod: string;
    kind: string;
    created: string | null;
    finished: string | null;
    /** The image of the stagers (stage-in, stage-out or the single stager). */
    runtime_image: string | null;
    tool_image: string | null;
    /** Pod creation to the first container start (scheduling, volume setup). */
    start_s: number | null;
    stage_in_s: number | null;
    /** Stage-in end to tool start: mostly the tool image pull. */
    tool_pull_s: number | null;
    tool_s: number | null;
    /** Tool end to stage-out end: Galaxy's finishing and the uploads. */
    stage_out_s: number | null;
    /** The single container of upload and set-metadata pods. */
    stager_s: number | null;
    total_s: number | null;
}

/**
 * Records the container start and end times of Planet's pods from a watch through the gateway. The DELETED event
 * carries a pod's last status, so pods the leader removes right after ingest are still measured.
 */
class PodTimeline {
    private readonly pods = new Map<string, WatchedPod>();
    private readonly controller = new AbortController();
    private loop: Promise<void> | null = null;

    constructor(private readonly token: string) {}

    start(): void {
        this.loop = this.run();
    }

    async stop(): Promise<PodTimings[]> {
        this.controller.abort();
        await this.loop;
        return [...this.pods.values()].map(podTimings);
    }

    private async run(): Promise<void> {
        const url =
            `${GATEWAY}/api/v1/namespaces/${NAMESPACE}/pods?labelSelector=planet.dev%2Finstance` +
            "&watch=1&timeoutSeconds=50";
        while (!this.controller.signal.aborted) {
            try {
                const response = await fetch(url, {
                    headers: kubeHeaders(this.token),
                    signal: this.controller.signal,
                });
                if (!response.ok || !response.body) {
                    throw new Error(`watch answered ${response.status}`);
                }
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                    buffer += decoder.decode(chunk.value, { stream: true });
                    let end: number;
                    while ((end = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, end).trim();
                        buffer = buffer.slice(end + 1);
                        if (line) {
                            const event = JSON.parse(line) as { type: string; object: WatchedPod };
                            if (event.object?.metadata?.name) {
                                this.pods.set(event.object.metadata.name, event.object);
                            }
                        }
                    }
                }
            } catch {
                if (this.controller.signal.aborted) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    }
}

function containerTimes(pod: WatchedPod, name: string): ContainerTimes {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const state = statuses.find((status) => status.name === name)?.state ?? {};
    return state.terminated ?? state.running ?? {};
}

function seconds(from: string | undefined, to: string | undefined): number | null {
    return from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null;
}

function podTimings(pod: WatchedPod): PodTimings {
    const stageIn = containerTimes(pod, "stage-in");
    const tool = containerTimes(pod, "tool");
    const stageOut = containerTimes(pod, "stage-out");
    const stager = containerTimes(pod, "stager");
    const first = stageIn.startedAt ?? stager.startedAt;
    const last = stageOut.finishedAt ?? stager.finishedAt;
    return {
        pod: pod.metadata.name,
        kind: pod.metadata.labels?.["planet.dev/kind"] ?? "unknown",
        created: pod.metadata.creationTimestamp ?? null,
        finished: last ?? null,
        runtime_image:
            [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].find(
                (container) => container.name === "stage-in" || container.name === "stager",
            )?.image ?? null,
        tool_image: pod.spec?.containers?.find((container) => container.name === "tool")?.image ?? null,
        start_s: seconds(pod.metadata.creationTimestamp, first),
        stage_in_s: seconds(stageIn.startedAt, stageIn.finishedAt),
        tool_pull_s: seconds(stageIn.finishedAt, tool.startedAt),
        tool_s: seconds(tool.startedAt, tool.finishedAt),
        stage_out_s: seconds(tool.finishedAt, stageOut.finishedAt),
        stager_s: seconds(stager.startedAt, stager.finishedAt),
        total_s: seconds(pod.metadata.creationTimestamp, last),
    };
}

function historyItem(page: Page, hid: number): Locator {
    return page.locator(`#current-history-panel [data-hid="${hid}"]`).first();
}

/** The hid of the newest history item whose name matches. */
async function hidOf(page: Page, name: RegExp): Promise<number> {
    const item = page
        .locator("#current-history-panel [data-hid]", { has: page.locator(".content-title", { hasText: name }) })
        .first();
    await expect(item, `a history item named ${name}`).toBeVisible({ timeout: 60_000 });
    return Number(await item.getAttribute("data-hid"));
}

/** The encoded HDA id of a history item (its element id is `dataset-<id>`). */
async function hdaId(page: Page, hid: number): Promise<string> {
    const id = (await historyItem(page, hid).getAttribute("id")) ?? "";
    expect(id).toMatch(/^dataset-/);
    return id.slice("dataset-".length);
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

/** Picks the option of a single form select (a multiselect) whose label starts with `label`. */
async function selectOption(page: Page, parameter: string, label: string): Promise<void> {
    const field = page.locator(`[id="form-element-${parameter}"] .multiselect`).first();
    await field.click();
    await field.locator(".multiselect__option", { hasText: label }).first().click();
    await expect(field).not.toHaveClass(/multiselect--active/);
}

/** Selects the options with these labels in a multiple form select, which then holds exactly those. */
async function selectMany(page: Page, parameter: string, labels: string[]): Promise<void> {
    const field = page.locator(`[id="form-element-${parameter}"] .multiselect`).first();
    await field.click();
    for (const label of labels) {
        // The list moves selected options; unselected ones show an empty square.
        const option = field.locator(".multiselect__option", { hasText: label }).first();
        const unselected = option.locator('svg[data-icon="square"]');
        if (await unselected.count()) {
            await option.click();
        }
        await expect(unselected).toHaveCount(0);
    }
    await expect(field.locator(".multiselect__tag")).toHaveCount(labels.length);
    await field.locator("input").press("Escape");
}

async function submitTool(page: Page, jobs = 1): Promise<void> {
    await page.locator("button#execute").first().click();
    await expect(page.getByText(new RegExp(`successfully added ${jobs} jobs?`, "i"))).toBeVisible();
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

interface DatasetDetails {
    id: string;
    uuid: string;
    state: string;
    deleted: boolean;
    purged: boolean;
    extension: string;
    creating_job: string;
    meta_files?: { file_type: string; download_url: string }[];
    [key: string]: unknown;
}

async function datasetDetails(page: Page, id: string): Promise<DatasetDetails> {
    const response = await api<DatasetDetails>(page, `/api/datasets/${id}?view=detailed`);
    expect(response.status).toBe(200);
    return response.body;
}

function statusCard(scope: Page | FrameLocator, title: string): Locator {
    return scope.locator("article.pw-status", { has: scope.getByRole("heading", { name: title, exact: true }) });
}

const timings: Record<string, number> = {};
/** When each timed step started, to line the steps up with the pods. */
const starts: Record<string, string> = {};

async function timed<T>(name: string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    starts[name] = new Date(started).toISOString();
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
        const path = resolve(outDir, `cluster-console-${testInfo.workerIndex}-${testInfo.title.slice(0, 20)}.log`);
        writeFileSync(path, `${lines.join("\n")}\n`);
    };
}

const recordedPods: PodTimings[] = [];

/** Writes the UI and pod timings of the tests so far to cluster-timings.json and the report. */
async function saveTimings(testInfo: TestInfo, pods: PodTimings[]): Promise<void> {
    expect
        .soft(
            pods.map((pod) => pod.runtime_image),
            "every pod's stagers run the runtime image",
        )
        .toEqual(pods.map(() => RUNTIME_IMAGE));
    recordedPods.push(...pods);
    const body = JSON.stringify({ ui: timings, ui_started: starts, pods: recordedPods }, null, 2);
    writeFileSync(resolve(outDir, "cluster-timings.json"), `${body}\n`);
    await testInfo.attach("timings", { body, contentType: "application/json" });
    console.log(`cluster timings (s): ${JSON.stringify(timings)}`);
    for (const pod of pods) {
        console.log(`pod ${JSON.stringify(pod)}`);
    }
}

/** Console errors every cluster run produces, each with its reason. */
function allowClusterErrors(health: Health): void {
    health.allow({
        text: /^Failed to load resource: the server responded with a status of 403/,
        url: /^http:\/\/127\.0\.0\.1:8002\/$/,
        reason: "The storage test checks that the endpoint answers with an unsigned request, which S3 refuses.",
    });
    health.allow({
        text: /^Failed to load resource: the server responded with a status of 404/,
        url: /^http:\/\/127\.0\.0\.1:8002\/planet\/planet\/jobs\/[0-9a-f]+\/a\d+\/dispatch\.json$/,
        reason: "The leader reads an attempt's dispatch record before its first dispatch, when it does not exist yet.",
    });
    health.allow({
        text: /^Failed to load resource: the server responded with a status of 404/,
        url: /^http:\/\/127\.0\.0\.1:8001\/apis\/batch\/v1\/namespaces\/planet\/jobs\/planet-[0-9a-z]+-[0-9a-f]+-a\d+$/,
        reason: "Each dispatch first looks its Kubernetes Job up, which does not exist before the first dispatch.",
    });
    health.allow({
        text: /^Failed to load resource: the server responded with a status of 404/,
        url: /^http:\/\/127\.0\.0\.1:8002\/planet\/planet\/tools\/.+\/repo\.tar$/,
        reason: "The first dispatch of a tool checks whether its archive is in the bucket before uploading it.",
    });
}

/** Saves the cluster and Local Garage settings on the welcome page and runs both connection tests. */
async function connect(page: Page, secrets: ClusterSecrets): Promise<void> {
    // Galaxy silences the console in production builds; the leader's warnings help diagnose failures.
    await page.addInitScript(() => window.localStorage.setItem("console-debugging-enabled", "true"));
    await openGalaxy(page);
    await page.goto("/welcome");

    const cluster = page.getByRole("form", { name: "Cluster settings" });
    await cluster.getByLabel("Gateway URL").fill(GATEWAY);
    await cluster.getByRole("textbox", { name: "Namespace", exact: true }).fill(NAMESPACE);
    await fillSecret(cluster.getByLabel("Token"), secrets.token);
    await cluster.getByRole("button", { name: "Job defaults and runtime" }).click();
    // A site built with PLANET_RUNTIME_IMAGE=planet-runtime:dev uses it by default; other builds need the setting.
    const { body: build } = await api<{ image: string | null }>(page, "/static/planet/data/runtime.json");
    if (build.image !== RUNTIME_IMAGE) {
        await cluster.getByLabel("Runtime image").fill(RUNTIME_IMAGE);
    }
    await cluster.getByRole("button", { name: "Save" }).click();
    await expect(cluster.getByRole("status")).toHaveText("Saved.");
    await cluster.getByRole("button", { name: "Test connection" }).click();
    const clusterReport = page.getByRole("region", { name: "Cluster connection test" });
    await expect(clusterReport).toContainText("The connection works", { timeout: 60_000 });

    const storage = page.getByRole("form", { name: "Storage settings" });
    await storage.getByText("Local Garage", { exact: true }).click();
    await storage.getByLabel("Access key ID").fill(secrets.accessKeyId);
    await fillSecret(storage.getByLabel("Secret access key"), secrets.secretAccessKey);
    await storage.getByRole("button", { name: "Save" }).click();
    await expect(storage.getByRole("status")).toHaveText("Saved.");
    await storage.getByRole("button", { name: "Test connection" }).click();
    const storageReport = page.getByRole("region", { name: "Storage connection test" });
    await expect(storageReport).toContainText("The connection works", { timeout: 60_000 });
}

/** Fills the SQL query of the Query Tabular form and runs it; returns the hid of its result. */
async function runQuery(page: Page, sql: string): Promise<number> {
    await openToolForm(page, QUERY_TABULAR);
    await page.locator("#form-element-sqlquery").locator("textarea, input").first().fill(sql);
    await submitTool(page);
    return hidOf(page, /^query results on/);
}

interface RunnerStatus {
    leader: { active: boolean; epoch: number | null; state: string | null };
    jobs: { queued: number; running: number };
}

async function planetStatus(page: Page): Promise<RunnerStatus> {
    const response = await api<RunnerStatus>(page, "/api/planet/status");
    expect(response.status).toBe(200);
    return response.body;
}

test.describe("cluster", () => {
    test.skip(!ENABLED, "set PLANET_E2E_CLUSTER=1 and run planet/scripts/dev-cluster.sh port-forward");
    test.describe.configure({ mode: "serial" });
    test.use({ actionTimeout: 30_000 });

    test("uploads data, runs tools, purges a dataset and reports a failing job on a real cluster", async ({
        page,
        health,
    }, testInfo) => {
        test.setTimeout(30 * 60_000);
        allowClusterErrors(health);
        const secrets = readSecrets();
        const writeConsole = saveConsoleLog(page, testInfo);
        const pods = new PodTimeline(secrets.token);
        pods.start();
        try {
            await connect(page, secrets);
            await saveScreenshot(page, testInfo, "cluster-01-settings");

            // The Galaxy tab leads and the overview reports it.
            await openGalaxy(page);
            const runner = statusCard(page.frameLocator("iframe[name=frame]"), "Job runner");
            await expect(runner).toContainText("Active in this browser", { timeout: 60_000 });
            await expect(runner).toContainText("No jobs are waiting or running.");
            await saveScreenshot(page, testInfo, "cluster-02-runner-active");

            // Upload a tabular and a FASTA file through Galaxy's upload activity.
            const table = testInfo.outputPath("counts.tsv");
            const fasta = testInfo.outputPath("sequences.fasta");
            writeFileSync(table, TABLE);
            writeFileSync(fasta, FASTA);
            await page.locator("#activity-upload").click();
            await page.locator('[data-method-id="local-file"]').click();
            await page.locator("#local-file-input").setInputFiles([table, fasta]);
            await saveScreenshot(page, testInfo, "cluster-03-upload-staged");
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
            await saveScreenshot(page, testInfo, "cluster-04-uploaded");

            // Datamash: count rows per gene of the tabular dataset.
            await openToolForm(page, DATAMASH);
            await expect(page.locator("#form-element-in_file")).toContainText("counts.tsv");
            await page.locator("#form-element-grouping input").fill("1");
            await setSwitch(page, "need_sort", true);
            await setSwitch(page, "header_in", true);
            await saveScreenshot(page, testInfo, "cluster-05-tool-form");
            await timed("tool run", async () => {
                await submitTool(page);
                await waitForState(page, 3, "ok");
            });
            await saveScreenshot(page, testInfo, "cluster-06-tool-ok");

            const output = await expandItem(page, 3);
            await expect(output.locator(".dataset-peek")).toContainText("geneA");
            await output.locator(".display-btn").click();
            const center = page.locator("#center");
            await expect(center).toContainText("geneA");
            const text = (await center.innerText()).replace(/\s+/g, " ");
            expect(text).toMatch(/geneA 2 geneB 1 geneC 1/);
            await saveScreenshot(page, testInfo, "cluster-07-output");

            const job = await openJobInformation(page, 3);
            await expect(job.locator("#command-line")).toContainText("datamash");
            await expect(job.locator("#command-line")).toContainText("--group '1'");
            await expect(job.locator("#stdout")).toBeVisible();
            await expect(job.locator("#exit-code")).toHaveText("0");
            await saveScreenshot(page, testInfo, "cluster-08-job-information");

            // The form now selects the newest tabular dataset, the two-column output; datamash exits 1 when asked to
            // group by a field the input does not have.
            await openToolForm(page, DATAMASH);
            await expect(page.locator("#form-element-in_file")).toContainText("Datamash on dataset 1");
            await page.locator("#form-element-grouping input").fill("9");
            await setSwitch(page, "header_in", true);
            await timed("failing tool run", async () => {
                await submitTool(page);
                await waitForState(page, 4, "error");
            });
            const failed = await expandItem(page, 4);
            await expect(failed).toContainText("An error occurred with this dataset");
            await expect(failed.locator(".info .value")).toContainText("field 9 requested");
            await saveScreenshot(page, testInfo, "cluster-09-tool-error");
            const failedJob = await openJobInformation(page, 4);
            await expect(failedJob.locator("#stderr")).toContainText("invalid input: field 9 requested");
            await expect(failedJob.locator("#exit-code")).toHaveText("1");
            await saveScreenshot(page, testInfo, "cluster-10-error-job-information");

            // Batch mode: one Reverse run over two datasets makes two jobs.
            await openToolForm(page, DATAMASH_REVERSE);
            await page.locator('#form-element-in_file button[title="Multiple datasets"]').click();
            await expect(page.locator("#form-element-in_file")).toContainText("This is a batch mode input field.");
            await selectMany(page, "in_file", ["1: counts.tsv", "3: Datamash on dataset 1"]);
            await saveScreenshot(page, testInfo, "cluster-11-batch-form");
            await timed("batch run", async () => {
                await submitTool(page, 2);
                await waitForState(page, 5, "ok");
                await waitForState(page, 6, "ok");
            });
            const reversed = new Map<string, { hid: number; id: string }>();
            for (const hid of [5, 6]) {
                const item = await expandItem(page, hid);
                await expect(item.locator(".dataset-peek")).toContainText(/count\s*sample\s*gene|2\s*geneA/);
                const name = (await item.locator(".content-title").innerText()).trim();
                reversed.set(name, { hid, id: await hdaId(page, hid) });
            }
            expect([...reversed.keys()].sort()).toEqual(["Reverse on dataset 1", "Reverse on dataset 3"]);
            const batchJobs = await Promise.all(
                [...reversed.values()].map(async ({ id }) => (await datasetDetails(page, id)).creating_job),
            );
            expect(new Set(batchJobs).size).toBe(2);
            await saveScreenshot(page, testInfo, "cluster-12-batch-ok");

            // minimap2 maps the FASTA file against itself; the BAM output gets its metadata and index in the pod.
            await openToolForm(page, MINIMAP2);
            await selectOption(page, "reference_source|reference_source_selector", "Use a genome from history");
            await expect(page.locator('[id="form-element-reference_source|ref_file"]')).toContainText(
                "sequences.fasta",
            );
            await expect(page.locator('[id="form-element-fastq_input|fastq_input1"]')).toContainText("sequences.fasta");
            await saveScreenshot(page, testInfo, "cluster-13-minimap2-form");
            const mapped = await timed("minimap2 run", async () => {
                await submitTool(page);
                const hid = await hidOf(page, /^Map with minimap2 on/);
                await waitForState(page, hid, "ok");
                return hid;
            });
            const bamItem = await expandItem(page, mapped);
            await expect(bamItem.locator(".datatype .value")).toHaveText("bam");
            const bam = await datasetDetails(page, await hdaId(page, mapped));
            expect(bam.extension).toBe("bam");
            expect(bam.metadata_reference_names).toEqual(["seq1", "seq2"]);
            expect(bam.metadata_sort_order).toBe("coordinate");
            const index = bam.meta_files?.find((file) => file.file_type === "bam_index");
            expect(index, "the BAM index is a metadata file").toBeTruthy();
            const indexBytes = await page.evaluate(async (url) => {
                const response = await fetch(url);
                return { status: response.status, size: (await response.arrayBuffer()).byteLength };
            }, index!.download_url);
            expect(indexBytes.status).toBe(200);
            expect(indexBytes.size).toBeGreaterThan(0);
            await saveScreenshot(page, testInfo, "cluster-14-minimap2-bam");

            // Purging a dataset deletes its objects from the bucket.
            const target = reversed.get("Reverse on dataset 3")!;
            const purged = await datasetDetails(page, target.id);
            expect(await listBucket(secrets, `datasets/${purged.uuid}/`)).toContain(`datasets/${purged.uuid}/data`);
            await page.locator(".show-history-content-selectors-btn").click();
            await historyItem(page, target.hid).locator(".selector").click();
            await page.locator('[data-description="selected content menu"] button').first().click();
            await page.locator('[data-description="purge option"]').click();
            await page.getByRole("dialog").getByRole("button", { name: "Purge" }).click();
            await expect.poll(async () => (await datasetDetails(page, target.id)).purged).toBe(true);
            await timed("purge", () =>
                expect
                    .poll(() => listBucket(secrets, `datasets/${purged.uuid}/`), {
                        message: "the purged dataset's objects are deleted",
                        timeout: 120_000,
                    })
                    .toEqual([]),
            );
            await saveScreenshot(page, testInfo, "cluster-15-purged");

            // Finished jobs are removed from the cluster.
            await expect.poll(() => listPlanetObjects(secrets.token, "jobs"), { timeout: 120_000 }).toEqual([]);
            await expect.poll(() => listPlanetObjects(secrets.token, "pods"), { timeout: 120_000 }).toEqual([]);
        } finally {
            writeConsole();
            await saveTimings(testInfo, await pods.stop());
        }
    });

    test("stops a running job and finishes a job across a page reload", async ({ page, health }, testInfo) => {
        test.setTimeout(20 * 60_000);
        allowClusterErrors(health);
        const secrets = readSecrets();
        const writeConsole = saveConsoleLog(page, testInfo);
        const pods = new PodTimeline(secrets.token);
        pods.start();
        try {
            await connect(page, secrets);
            await openGalaxy(page);

            // A query that would run for minutes is stopped by deleting its output.
            const slow = await runQuery(page, countingQuery(3_000_000_000));
            const slowId = await hdaId(page, slow);
            await waitForState(page, slow, "running");
            const { creating_job: slowJob } = await datasetDetails(page, slowId);
            await expect
                .poll(() => listPlanetObjects(secrets.token, "pods"))
                .toContainEqual(expect.stringContaining(slowJob));
            await saveScreenshot(page, testInfo, "cluster-16-running");
            await timed("stop running job", async () => {
                await historyItem(page, slow).locator(".delete-btn").click();
                await expect(historyItem(page, slow)).toHaveCount(0);
                await expect
                    .poll(async () => (await api<{ state: string }>(page, `/api/jobs/${slowJob}`)).body.state)
                    .toBe("deleted");
                await expect
                    .poll(() => listPlanetObjects(secrets.token, "jobs"), { timeout: 120_000 })
                    .not.toContainEqual(expect.stringContaining(slowJob));
                await expect
                    .poll(() => listPlanetObjects(secrets.token, "pods"), { timeout: 120_000 })
                    .not.toContainEqual(expect.stringContaining(slowJob));
            });
            const stopped = await datasetDetails(page, slowId);
            expect(stopped).toMatchObject({ state: "discarded", deleted: true });
            await saveScreenshot(page, testInfo, "cluster-17-stopped");

            // A job keeps running while its page reloads; the reloaded tab leads again and ingests it.
            const epochBefore = (await planetStatus(page)).leader.epoch;
            const counted = await runQuery(page, countingQuery(60_000_000));
            await waitForState(page, counted, "running");
            await timed("job across reload", async () => {
                await page.reload();
                await expectGalaxy(page);
                await waitForState(page, counted, "ok");
            });
            const status = await planetStatus(page);
            expect(status.leader.active).toBe(true);
            expect(status.leader.epoch).toBeGreaterThan(epochBefore ?? 0);
            expect(status.jobs).toEqual({ queued: 0, running: 0 });
            // The leader's report follows at its next heartbeat (20 seconds).
            await expect.poll(async () => (await planetStatus(page)).leader.state, { timeout: 45_000 }).toBe("idle");
            // The overview reads the status every 10 seconds.
            await expect(statusCard(page.frameLocator("iframe[name=frame]"), "Job runner")).toContainText(
                "No jobs are waiting or running.",
                { timeout: 30_000 },
            );
            const result = await expandItem(page, counted);
            await expect(result.locator(".dataset-peek")).toContainText("60000000");
            await saveScreenshot(page, testInfo, "cluster-18-after-reload");

            await expect.poll(() => listPlanetObjects(secrets.token, "jobs"), { timeout: 120_000 }).toEqual([]);
            await expect.poll(() => listPlanetObjects(secrets.token, "pods"), { timeout: 120_000 }).toEqual([]);
        } finally {
            writeConsole();
            await saveTimings(testInfo, await pods.stop());
        }
    });
});
