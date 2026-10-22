/**
 * The local demo's storyline on the kind cluster of planet/scripts/dev-cluster.sh: a reference and paired reads
 * uploaded through Galaxy's upload activity, fastp, minimap2, Samtools flagstat and stats, and MultiQC over the
 * fastp and Samtools stats outputs, whose report opens in a sandboxed frame. Enabled by PLANET_E2E_CLUSTER=1
 * (planet/scripts/demo.sh rehearse). The inputs are the files planet/scripts/demo-data.mjs writes to
 * PLANET_E2E_DEMO/data; the images of the run's Kubernetes Jobs are added to PLANET_E2E_DEMO/images.txt, which
 * `demo.sh up` pulls into the cluster, and the step and pod timings go to PLANET_E2E_DEMO/timings.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Locator, Page, Request, TestInfo } from "@playwright/test";

import { api, expect, fillSecret, type Health, openGalaxy, ORIGIN, saveScreenshot, test } from "./fixtures";

const ENABLED = process.env.PLANET_E2E_CLUSTER === "1";
const DEMO_DIR = process.env.PLANET_E2E_DEMO ?? resolve(__dirname, "../../../build/demo");
const DATA_DIR = join(DEMO_DIR, "data");
const outDir = process.env.PLANET_E2E_OUT ?? resolve(__dirname, "../../../build/e2e");

const GATEWAY = "http://127.0.0.1:8001";
const NAMESPACE = "planet";
const RUNTIME_IMAGE = "planet-runtime:dev";
/** Two tool pods fit into the local overlay's quota with these requests. */
const JOB_MEMORY = "2Gi";
const JOB_SCRATCH = "8Gi";

const FASTP = "toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.3.7+galaxy0";
const MINIMAP2 = "toolshed.g2.bx.psu.edu/repos/iuc/minimap2/minimap2/2.31+galaxy1";
const FLAGSTAT = "toolshed.g2.bx.psu.edu/repos/devteam/samtools_flagstat/samtools_flagstat/2.0.8";
const SAMTOOLS_STATS = "toolshed.g2.bx.psu.edu/repos/devteam/samtools_stats/samtools_stats/2.0.9";
const MULTIQC = "toolshed.g2.bx.psu.edu/repos/iuc/multiqc/multiqc/1.35+galaxy4";

const READS_COLLECTION = "demo reads";
/** First pulls of the tool images (MultiQC's is the largest) on a busy machine fit within this. */
const JOB_TIMEOUT = 12 * 60_000;

interface ClusterSecrets {
    token: string;
    accessKeyId: string;
    secretAccessKey: string;
}

interface DemoManifest {
    pairs: number;
    reference: { name: string; length: number }[];
}

interface CollectionElement {
    element_identifier: string;
    object: { id: string; state?: string; file_ext?: string; elements?: CollectionElement[] };
}

interface CollectionDetails {
    collection_type: string;
    populated_state: string;
    element_count: number;
    elements: CollectionElement[];
}

interface DatasetDetails {
    extension: string;
    metadata_reference_names?: string[];
    [key: string]: unknown;
}

function readSecrets(): ClusterSecrets {
    const directory = process.env.PLANET_E2E_SECRETS ?? "/secrets";
    const read = (name: string) => readFileSync(join(directory, name), "utf8").trim();
    return { token: read("token"), accessKeyId: read("access-key-id"), secretAccessKey: read("secret-access-key") };
}

function readManifest(): DemoManifest {
    const path = join(DATA_DIR, "manifest.json");
    expect(existsSync(path), `${path} exists (node planet/scripts/demo-data.mjs writes it)`).toBe(true);
    return JSON.parse(readFileSync(path, "utf8")) as DemoManifest;
}

interface Container {
    name: string;
    image?: string;
}

interface ContainerTimes {
    startedAt?: string;
    finishedAt?: string;
}

interface KubeObject {
    metadata: { name: string; creationTimestamp?: string; labels?: Record<string, string> };
    spec?: {
        initContainers?: Container[];
        containers?: Container[];
        template?: { spec?: { initContainers?: Container[]; containers?: Container[] } };
    };
    status?: {
        initContainerStatuses?: { name: string; state?: Record<string, ContainerTimes> }[];
        containerStatuses?: { name: string; state?: Record<string, ContainerTimes> }[];
    };
}

/**
 * Keeps the last state of the instance's Jobs or pods from a watch through the gateway, as the leader sees them.
 * DELETED events carry the final object, so Jobs and pods the leader removes right after ingest are kept.
 */
class Watch {
    readonly objects = new Map<string, KubeObject>();
    private readonly controller = new AbortController();
    private loop: Promise<void> | null = null;

    constructor(
        private readonly token: string,
        private readonly path: string,
        private readonly instance: string,
    ) {}

    start(): void {
        this.loop = this.run();
    }

    async stop(): Promise<KubeObject[]> {
        this.controller.abort();
        await this.loop;
        return [...this.objects.values()];
    }

    private async run(): Promise<void> {
        const selector = encodeURIComponent(`planet.dev/instance=${this.instance}`);
        const url = `${GATEWAY}/${this.path}?labelSelector=${selector}&watch=1&timeoutSeconds=50`;
        const headers = { Authorization: `Bearer ${this.token}`, Origin: ORIGIN, Accept: "application/json" };
        while (!this.controller.signal.aborted) {
            try {
                const response = await fetch(url, { headers, signal: this.controller.signal });
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
                            const event = JSON.parse(line) as { object?: KubeObject };
                            if (event.object?.metadata?.name) {
                                this.objects.set(event.object.metadata.name, event.object);
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

/** Every container image of the Jobs except the runtime image, which demo.sh loads on its own. */
function jobImages(jobs: KubeObject[]): string[] {
    const images = new Set<string>();
    for (const job of jobs) {
        const spec = job.spec?.template?.spec;
        for (const container of [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])]) {
            if (container.image && container.image !== RUNTIME_IMAGE) {
                images.add(container.image);
            }
        }
    }
    return [...images];
}

/** Adds `images` to images.txt, keeping the images recorded by earlier runs. */
function recordImages(images: string[]): string[] {
    const path = join(DEMO_DIR, "images.txt");
    const known = existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line && !line.startsWith("#"))
        : [];
    const all = [...new Set([...known, ...images])].sort();
    if (all.length) {
        writeFileSync(path, `${all.join("\n")}\n`);
    }
    return all;
}

function seconds(from: string | undefined, to: string | undefined): number | null {
    return from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null;
}

function podTimings(pod: KubeObject) {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const times = (name: string): ContainerTimes => {
        const state = statuses.find((status) => status.name === name)?.state ?? {};
        return state.terminated ?? state.running ?? {};
    };
    const stageIn = times("stage-in");
    const tool = times("tool");
    const stageOut = times("stage-out");
    const stager = times("stager");
    return {
        pod: pod.metadata.name,
        kind: pod.metadata.labels?.["planet.dev/kind"] ?? "unknown",
        tool_image: pod.spec?.containers?.find((container) => container.name === "tool")?.image ?? null,
        /** Stage-in end to tool start: mostly the tool image pull. */
        tool_pull_s: seconds(stageIn.finishedAt, tool.startedAt),
        tool_s: seconds(tool.startedAt, tool.finishedAt),
        total_s: seconds(pod.metadata.creationTimestamp, stageOut.finishedAt ?? stager.finishedAt),
    };
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

/** A request's method and URL without the query, which may hold presigned signatures. */
function requestLabel(request: Request): string {
    const url = new URL(request.url());
    return `${request.method()} ${url.origin}${url.pathname}`;
}

/** Records the page's console and failed requests; the returned function writes them to demo-console.log. */
function recordConsole(page: Page): () => void {
    const started = Date.now();
    const stamp = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    const lines: string[] = [];
    page.on("console", (message) => lines.push(`${stamp()} [${message.type()}] ${message.text()}`));
    // The stack's first frames show which document's script threw; queries are dropped, as presigned URLs have them.
    page.on("pageerror", (error) => {
        const stack = (error.stack ?? error.message).split("\n").slice(0, 3).join(" | ");
        lines.push(`${stamp()} [pageerror] ${stack.replace(/\?[^\s)]*/g, "")}`);
    });
    page.on("requestfailed", (request) =>
        lines.push(`${stamp()} [requestfailed] ${requestLabel(request)}: ${request.failure()?.errorText ?? ""}`),
    );
    return () => writeFileSync(resolve(outDir, "demo-console.log"), `${lines.join("\n")}\n`);
}

/** Console errors of a cluster run, each with its reason (as in cluster.spec.ts). */
function allowClusterErrors(health: Health): void {
    health.allow({
        text: /^Failed to load resource: the server responded with a status of 403/,
        url: /^http:\/\/127\.0\.0\.1:8002\/$/,
        reason: "The storage test checks that the endpoint answers with an unsigned request, which S3 refuses.",
    });
    health.allow({
        text: /^Failed to load resource: the server responded with a status of 404/,
        url: /^http:\/\/127\.0\.0\.1:8002\/planet\/planet\/state\/[^/]+\/lease\.json$/,
        reason: "The leader reads its instance's lease.json before it writes the first one.",
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
    health.allow({
        text: /^Failed to load resource: net::ERR_EMPTY_RESPONSE$/,
        url: /^http:\/\/127\.0\.0\.1:800[12]\//,
        reason:
            "kubectl port-forward can stop opening streams for new connections and closes them; dev-cluster.sh " +
            "restarts it, and the leader repeats the request at its next reconcile.",
    });
    health.allow({
        text: /Content Security Policy/,
        url: /\/datasets\/[^/]+\/display\//,
        reason: "The MultiQC report runs under the dataset document policy, which blocks its requests to other origins.",
    });
}

/** Saves the cluster and Local Garage settings on the welcome page and runs both connection tests. */
async function connect(page: Page, secrets: ClusterSecrets): Promise<void> {
    // Galaxy silences the console in production builds; the leader's warnings help diagnose failures. Init scripts
    // also run in sandboxed dataset documents, whose storage throws.
    await page.addInitScript(() => {
        try {
            window.localStorage.setItem("console-debugging-enabled", "true");
        } catch {
            // A sandboxed frame.
        }
    });
    await openGalaxy(page, "/", 60_000);
    await page.goto("/welcome");

    const cluster = page.getByRole("form", { name: "Cluster settings" });
    await cluster.getByLabel("Gateway URL").fill(GATEWAY);
    await cluster.getByRole("textbox", { name: "Namespace", exact: true }).fill(NAMESPACE);
    await fillSecret(cluster.getByLabel("Token"), secrets.token);
    await cluster.getByRole("button", { name: "Job defaults and runtime" }).click();
    await cluster.getByRole("textbox", { name: "Memory", exact: true }).fill(JOB_MEMORY);
    await cluster.getByRole("textbox", { name: "Scratch space", exact: true }).fill(JOB_SCRATCH);
    const { body: build } = await api<{ image: string | null }>(page, "/static/planet/data/runtime.json");
    if (build.image !== RUNTIME_IMAGE) {
        await cluster.getByLabel("Runtime image").fill(RUNTIME_IMAGE);
    }
    await cluster.getByRole("button", { name: "Save" }).click();
    await expect(cluster.getByRole("status")).toHaveText("Saved.");
    await testConnection(page, cluster, "Cluster connection test");

    const storage = page.getByRole("form", { name: "Storage settings" });
    await storage.getByText("Local Garage", { exact: true }).click();
    await storage.getByLabel("Access key ID").fill(secrets.accessKeyId);
    await fillSecret(storage.getByLabel("Secret access key"), secrets.secretAccessKey);
    await storage.getByRole("button", { name: "Save" }).click();
    await expect(storage.getByRole("status")).toHaveText("Saved.");
    await testConnection(page, storage, "Storage connection test");
}

/**
 * Runs a form's connection test, and runs it again when it fails, as a presenter would: kubectl port-forward can drop
 * requests until dev-cluster.sh restarts it (see allowClusterErrors). A wrong setting fails all three attempts.
 */
async function testConnection(page: Page, form: Locator, report: string): Promise<void> {
    const button = form.getByRole("button", { name: "Test connection" });
    const region = page.getByRole("region", { name: report });
    for (let attempt = 1; attempt <= 3; attempt++) {
        await button.click();
        // The button is disabled while the test runs; a quick test may finish before this sees it.
        await expect(button)
            .toBeDisabled({ timeout: 2000 })
            .catch(() => undefined);
        await expect(button).toBeEnabled({ timeout: 60_000 });
        if ((await region.textContent())?.includes("The connection works")) {
            return;
        }
    }
    await expect(region).toContainText("The connection works", { timeout: 1000 });
}

async function instanceOf(page: Page): Promise<string> {
    const response = await api<{ instance_id: string }>(page, "/api/planet/status");
    expect(response.status).toBe(200);
    return response.body.instance_id;
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

async function itemId(page: Page, hid: number, kind: "dataset" | "dataset_collection"): Promise<string> {
    const id = (await historyItem(page, hid).getAttribute("id")) ?? "";
    expect(id).toMatch(new RegExp(`^${kind}-`));
    return id.slice(kind.length + 1);
}

/** Waits until a history item settles and expects `state`; a different final state fails at once. */
async function waitForState(page: Page, hid: number, state: string, timeout = JOB_TIMEOUT): Promise<void> {
    const item = historyItem(page, hid);
    const settled = new RegExp(`^(ok|error|paused|failed_metadata|deferred|discarded|${state})$`);
    const read = () => item.getAttribute("data-state", { timeout: 5000 }).catch(() => null);
    await expect
        .poll(async () => ((await item.count()) ? ((await read()) ?? "") : ""), {
            message: `history item ${hid} settles`,
            timeout,
            intervals: [2000],
        })
        .toMatch(settled);
    const final = await item.getAttribute("data-state");
    if (final !== state) {
        throw new Error(`history item ${hid} is ${final}, not ${state}: ${await failureDetails(page, hid)}`);
    }
}

/** The info of a failed history item's dataset (the first failed element of a collection) and its job's messages. */
async function failureDetails(page: Page, hid: number): Promise<string> {
    const domId = (await historyItem(page, hid).getAttribute("id")) ?? "";
    let datasetId = domId.startsWith("dataset-") ? domId.slice("dataset-".length) : null;
    if (domId.startsWith("dataset_collection-")) {
        const pending = [...(await collection(page, hid)).elements];
        while (pending.length && !datasetId) {
            const element = pending.shift()!;
            if (element.object.elements) {
                pending.push(...element.object.elements);
            } else if (element.object.state !== "ok") {
                datasetId = element.object.id;
            }
        }
    }
    if (!datasetId) {
        return "no failed dataset found";
    }
    const dataset = await datasetDetails(page, datasetId);
    const details = [`dataset ${datasetId}: ${String(dataset.misc_info ?? "")}`];
    if (typeof dataset.creating_job === "string") {
        const { body: job } = await api<Record<string, unknown>>(page, `/api/jobs/${dataset.creating_job}?full=true`);
        details.push(`job ${dataset.creating_job} ${String(job.state)}: ${JSON.stringify(job.job_messages ?? [])}`);
        details.push(`stderr: ${String(job.stderr ?? job.tool_stderr ?? "").slice(-2000)}`);
    }
    return details.join("\n");
}

async function expandItem(page: Page, hid: number): Promise<Locator> {
    const item = historyItem(page, hid);
    if (!(await item.locator(".details").isVisible())) {
        await item.locator(".content-title").click();
    }
    await expect(item.locator(".details")).toBeVisible();
    return item;
}

async function collection(page: Page, hid: number): Promise<CollectionDetails> {
    const id = await itemId(page, hid, "dataset_collection");
    const response = await api<CollectionDetails>(page, `/api/dataset_collections/${id}?instance_type=history`);
    expect(response.status).toBe(200);
    return response.body;
}

/** The dataset id of the only element of a list collection. */
async function onlyElement(page: Page, hid: number): Promise<string> {
    const { elements } = await collection(page, hid);
    expect(elements, `collection ${hid} has one element`).toHaveLength(1);
    return elements[0]!.object.id;
}

async function datasetDetails(page: Page, id: string): Promise<DatasetDetails> {
    const response = await api<DatasetDetails>(page, `/api/datasets/${id}?view=detailed`);
    expect(response.status).toBe(200);
    return response.body;
}

/** A dataset's content, read as the client's download does (a redirect to the bucket). */
async function datasetText(page: Page, id: string): Promise<string> {
    const result = await page.evaluate(async (url) => {
        const response = await fetch(url);
        return { status: response.status, text: await response.text() };
    }, `/api/datasets/${id}/display`);
    expect(result.status, `content of dataset ${id}`).toBe(200);
    return result.text;
}

async function openToolForm(page: Page, toolId: string): Promise<void> {
    await page.goto(`/?tool_id=${encodeURIComponent(toolId)}`);
    await expect(page.locator("button#execute").first()).toBeVisible({ timeout: 60_000 });
}

function formElement(page: Page, parameter: string): Locator {
    return page.locator(`[id="form-element-${parameter}"]`);
}

/** Picks the option of a single form select whose label matches. */
async function selectOption(page: Page, parameter: string, label: string | RegExp): Promise<void> {
    const field = formElement(page, parameter).locator(".multiselect").first();
    await field.click();
    // The option's own text includes the template's whitespace; its label span holds the label alone.
    const option = field.locator(".multiselect__option", { has: page.locator("span", { hasText: label }) });
    await option.first().click();
    await expect(field).not.toHaveClass(/multiselect--active/);
}

/** Selects the options with these labels in a multiple form select, which then holds exactly those. */
async function selectMany(page: Page, parameter: string, labels: (string | RegExp)[]): Promise<void> {
    const field = formElement(page, parameter).locator(".multiselect").first();
    await field.click();
    for (const label of labels) {
        // The list moves selected options; unselected ones show an empty square.
        const option = field.locator(".multiselect__option", { has: page.locator("span", { hasText: label }) }).first();
        const unselected = option.locator('svg[data-icon="square"]');
        if (await unselected.count()) {
            await option.click();
        }
        await expect(unselected).toHaveCount(0);
    }
    await expect(field.locator(".multiselect__tag")).toHaveCount(labels.length);
    await field.locator("input").press("Escape");
}

async function useCollection(page: Page, parameter: string): Promise<void> {
    await formElement(page, parameter).locator('button[title="Dataset collection"]').click();
}

async function submitTool(page: Page, jobs = 1): Promise<void> {
    await page.locator("button#execute").first().click();
    await expect(page.getByText(new RegExp(`successfully added ${jobs} jobs?`, "i"))).toBeVisible();
}

/** Opens the upload activity's local file method; the activity button toggles the panel. */
async function openLocalUpload(page: Page): Promise<void> {
    const method = page.locator('[data-method-id="local-file"]');
    const shown = () =>
        method
            .waitFor({ state: "visible", timeout: 5000 })
            .then(() => true)
            .catch(() => false);
    if (!(await shown())) {
        await page.locator("#activity-upload").click();
        if (!(await shown())) {
            await page.locator("#activity-upload").click();
        }
    }
    await method.click();
}

async function setUploadExtension(page: Page, row: number, extension: string): Promise<void> {
    const selector = page.locator(`[data-test-id="upload-row-${row}-extension"] .single-item-selector`);
    // The selector is disabled until the upload configuration has loaded.
    await expect(selector).not.toHaveClass(/multiselect--disabled/);
    await selector.click();
    await selector.locator("input.multiselect__input").fill(extension);
    await selector.locator(`[data-test-id="single-item-selector-option"][data-id="${extension}"]`).click();
    await expect(selector).toContainText(extension);
}

test.describe("demo", () => {
    test.skip(!ENABLED, "set PLANET_E2E_CLUSTER=1 and run planet/scripts/demo.sh up");
    test.use({ actionTimeout: 30_000 });

    test("reads QC to mapping: fastp, minimap2, Samtools and MultiQC", async ({ page, health }, testInfo: TestInfo) => {
        test.setTimeout(60 * 60_000);
        allowClusterErrors(health);
        const manifest = readManifest();
        const secrets = readSecrets();
        const writeConsole = recordConsole(page);
        let jobs: Watch | null = null;
        let pods: Watch | null = null;
        try {
            await timed("settings", () => connect(page, secrets));
            await saveScreenshot(page, testInfo, "demo-01-settings");
            const instance = await instanceOf(page);
            jobs = new Watch(secrets.token, `apis/batch/v1/namespaces/${NAMESPACE}/jobs`, instance);
            pods = new Watch(secrets.token, `api/v1/namespaces/${NAMESPACE}/pods`, instance);
            jobs.start();
            pods.start();

            await openGalaxy(page);
            const overview = page.frameLocator("iframe[name=frame]");
            const runner = overview.locator("article.pw-status", {
                has: overview.getByRole("heading", { name: "Job runner", exact: true }),
            });
            await expect(runner).toContainText("Active in this browser", { timeout: 60_000 });
            await saveScreenshot(page, testInfo, "demo-02-galaxy");

            // The reference on its own, then both read files into a list of pairs.
            const reference = await timed("upload reference", async () => {
                await openLocalUpload(page);
                await page.locator("#local-file-input").setInputFiles(join(DATA_DIR, "reference.fasta"));
                await page.locator('[data-test-id="start-upload"]').click();
                const hid = await hidOf(page, /^reference\.fasta$/);
                await waitForState(page, hid, "ok");
                return hid;
            });
            const referenceItem = await expandItem(page, reference);
            await expect(referenceItem.locator(".datatype .value")).toHaveText("fasta");
            await expect(referenceItem.locator(".blurb .value")).toContainText("2 sequences");

            await openGalaxy(page);
            await openLocalUpload(page);
            await page
                .locator("#local-file-input")
                .setInputFiles([join(DATA_DIR, "demo_R1.fastq.gz"), join(DATA_DIR, "demo_R2.fastq.gz")]);
            await setUploadExtension(page, 1, "fastqsanger.gz");
            await setUploadExtension(page, 2, "fastqsanger.gz");
            await page.locator('[data-test-id="collection-toggle"] label').click();
            await page.locator("#collection-name-input").fill(READS_COLLECTION);
            await page.locator("#collection-type-select").selectOption("list:paired");
            await expect(page.locator(".pairing-preview")).toContainText(
                /Forward\s*demo_R1\.fastq\.gz\s*\+\s*Reverse\s*demo_R2\.fastq\.gz/,
            );
            await saveScreenshot(page, testInfo, "demo-03-reads-staged");
            const reads = await timed("upload reads", async () => {
                await page.locator('[data-test-id="start-upload"]').click();
                const hid = await hidOf(page, new RegExp(`^${READS_COLLECTION}$`));
                await waitForState(page, hid, "ok");
                return hid;
            });
            const readsCollection = await collection(page, reads);
            expect(readsCollection.collection_type).toBe("list:paired");
            expect(readsCollection.elements.map((element) => element.element_identifier)).toEqual(["demo"]);
            const pair = readsCollection.elements[0]!.object.elements ?? [];
            expect(pair.map((element) => element.element_identifier)).toEqual(["forward", "reverse"]);
            for (const element of pair) {
                expect((await datasetDetails(page, element.object.id)).extension).toBe("fastqsanger.gz");
            }
            await saveScreenshot(page, testInfo, "demo-04-uploaded");

            // fastp over the pair: trimmed reads, an HTML and a JSON report.
            await openToolForm(page, FASTP);
            await selectOption(page, "single_paired|single_paired_selector", "Paired Collection");
            await expect(formElement(page, "single_paired|paired_input")).toContainText(READS_COLLECTION);
            await saveScreenshot(page, testInfo, "demo-05-fastp-form");
            const [fastpReads, fastpJson] = await timed("fastp", async () => {
                await submitTool(page);
                const trimmed = await hidOf(page, /^fastp on .*: Paired-end output$/);
                const json = await hidOf(page, /^fastp on .*: JSON report$/);
                await waitForState(page, json, "ok");
                await waitForState(page, trimmed, "ok");
                return [trimmed, json];
            });
            const fastp = JSON.parse(await datasetText(page, await onlyElement(page, fastpJson))) as {
                summary: { before_filtering: { total_reads: number } };
                filtering_result: { passed_filter_reads: number; low_quality_reads: number };
                adapter_cutting?: { adapter_trimmed_reads: number };
            };
            expect(fastp.summary.before_filtering.total_reads).toBe(2 * manifest.pairs);
            expect(fastp.filtering_result.passed_filter_reads).toBeGreaterThan(1.8 * manifest.pairs);
            expect(fastp.filtering_result.low_quality_reads).toBeGreaterThan(0);
            expect(fastp.adapter_cutting?.adapter_trimmed_reads ?? 0).toBeGreaterThan(0);
            await saveScreenshot(page, testInfo, "demo-06-fastp-ok");

            // minimap2 maps the trimmed pair against the uploaded reference.
            await openToolForm(page, MINIMAP2);
            await selectOption(page, "reference_source|reference_source_selector", "Use a genome from history");
            await selectOption(page, "reference_source|ref_file", `${reference}: reference.fasta`);
            await selectOption(page, "fastq_input|fastq_input_selector", "Paired Collection");
            await selectOption(page, "fastq_input|fastq_input1", `${fastpReads}: fastp on`);
            await saveScreenshot(page, testInfo, "demo-07-minimap2-form");
            const mapped = await timed("minimap2", async () => {
                await submitTool(page);
                const hid = await hidOf(page, /^Map with minimap2 on/);
                await waitForState(page, hid, "ok");
                return hid;
            });
            const bam = await datasetDetails(page, await onlyElement(page, mapped));
            expect(bam.extension).toBe("bam");
            expect(bam.metadata_reference_names).toEqual(manifest.reference.map((contig) => contig.name));
            await saveScreenshot(page, testInfo, "demo-08-minimap2-ok");

            // Samtools flagstat and stats on the BAM; both jobs run at the same time.
            await openToolForm(page, FLAGSTAT);
            await useCollection(page, "input1");
            await selectOption(page, "input1", `${mapped}: Map with minimap2`);
            await submitTool(page);
            await openToolForm(page, SAMTOOLS_STATS);
            await useCollection(page, "input");
            await selectOption(page, "input", `${mapped}: Map with minimap2`);
            const [flagstat, stats] = await timed("samtools", async () => {
                await submitTool(page);
                const flagstatHid = await hidOf(page, /^Samtools flagstat on/);
                const statsHid = await hidOf(page, /^Samtools stats on/);
                await waitForState(page, flagstatHid, "ok");
                await waitForState(page, statsHid, "ok");
                return [flagstatHid, statsHid];
            });
            const flagstatText = await datasetText(page, await onlyElement(page, flagstat));
            const mappedPercent = Number(/\d+ \+ \d+ mapped \((\d+\.\d+)%/.exec(flagstatText)?.[1]);
            expect(mappedPercent, `mapped reads in:\n${flagstatText}`).toBeGreaterThan(90);
            expect(flagstatText).toMatch(/\d+ \+ \d+ properly paired/);
            const statsText = await datasetText(page, await onlyElement(page, stats));
            expect(statsText).toMatch(/^SN\treads mapped:\t\d+/m);
            expect(statsText).toMatch(/^SN\tinsert size average:\t\d+/m);
            await saveScreenshot(page, testInfo, "demo-09-samtools-ok");

            // MultiQC over the fastp JSON report and the Samtools stats output.
            await openToolForm(page, MULTIQC);
            await selectOption(page, "results_0|software_cond|software", /^fastp$/);
            await useCollection(page, "results_0|software_cond|input");
            await selectMany(page, "results_0|software_cond|input", [`${fastpJson}: fastp on`]);
            await page.locator('[data-description="repeat insert"][data-repeat-name="results"]').click();
            await selectOption(page, "results_1|software_cond|software", /^Samtools$/);
            // Galaxy's form adds no repeat instance when a conditional case is chosen, whatever the repeat's minimum.
            await page.locator('[data-description="repeat insert"][data-repeat-name="output"]').click();
            await selectOption(page, "results_1|software_cond|output_0|type|type", /^stats$/);
            await useCollection(page, "results_1|software_cond|output_0|type|input");
            await selectMany(page, "results_1|software_cond|output_0|type|input", [`${stats}: Samtools stats on`]);
            await saveScreenshot(page, testInfo, "demo-10-multiqc-form");
            const [report, multiqcStats] = await timed("multiqc", async () => {
                await submitTool(page);
                const reportHid = await hidOf(page, /^MultiQC on .*: Webpage$/);
                const statsHid = await hidOf(page, /^MultiQC on .*: Stats$/);
                await waitForState(page, reportHid, "ok");
                await waitForState(page, statsHid, "ok");
                return [reportHid, statsHid];
            });
            // MultiQC's general statistics: a header and a row for the sample.
            const generalStats = (await datasetText(page, await itemId(page, multiqcStats, "dataset"))).trim();
            expect(generalStats).toMatch(/^Sample\t/);
            expect(generalStats.split("\n").length).toBeGreaterThan(1);

            // The report opens in the center panel, sandboxed: scripts run, but in an opaque origin.
            const reportId = await itemId(page, report, "dataset");
            const reportDocument = page.waitForResponse(
                (response) =>
                    response.url().includes(`/datasets/${reportId}/display/`) &&
                    response.request().isNavigationRequest(),
                { timeout: 60_000 },
            );
            await timed("report", async () => {
                await (await expandItem(page, report)).locator(".display-btn").click();
                const frame = page.frameLocator('#center iframe.center-frame[src*="/display/"]');
                await expect(frame.locator("body")).toContainText("MultiQC", { timeout: 60_000 });
                await expect(frame.locator("body")).toContainText(/fastp/i);
                await expect(frame.locator("body")).toContainText(/Samtools/i);
            });
            const policy = (await reportDocument).headers()["content-security-policy"] ?? "";
            expect(policy).toMatch(/(^|;\s*)sandbox allow-scripts allow-popups allow-forms\s*(;|$)/);
            expect(policy).not.toContain("allow-same-origin");
            const reportFrame = page.frames().find((frame) => frame.url().includes(`/datasets/${reportId}/display/`));
            expect(reportFrame, "the report frame").toBeTruthy();
            expect(await reportFrame!.evaluate(() => window.origin)).toBe("null");
            await saveScreenshot(page, testInfo, "demo-11-multiqc-report");
        } finally {
            writeConsole();
            const jobObjects = (await jobs?.stop()) ?? [];
            const podObjects = (await pods?.stop()) ?? [];
            const images = recordImages(jobImages(jobObjects));
            const body = JSON.stringify({ steps_s: timings, images, pods: podObjects.map(podTimings) }, null, 2);
            writeFileSync(resolve(outDir, "demo-timings.json"), `${body}\n`);
            writeFileSync(join(DEMO_DIR, "timings.json"), `${body}\n`);
            await testInfo.attach("timings", { body, contentType: "application/json" });
            console.log(`demo timings (s): ${JSON.stringify(timings)}`);
            console.log(`tool images: ${images.join(" ")}`);
        }
    });
});
