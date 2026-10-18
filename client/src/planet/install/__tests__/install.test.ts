// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type JobRecord, jobs, tools } from "@/planet/db";
import { resultsDocument } from "@/planet/jobs/__fixtures__/results";
import {
    datamashBundle,
    markDispatched,
    resetDb,
    schemaErrors,
    teardownDb,
    testDeps,
} from "@/planet/jobs/__fixtures__/setup";
import { ingestResults } from "@/planet/jobs/ingest";
import { buildJobSpec } from "@/planet/jobs/k8sJob";
import { jobKind, prepareDispatch } from "@/planet/jobs/manifest";
import type { Manifest, ToolBundle } from "@/planet/jobs/schemas";
import { readBundle } from "@/planet/tools/bundle";
import { sha256Hex } from "@/planet/util/digest";

import { INSTALL_SLOT_COUNT, installSlotKeys } from "../keys";
import {
    INSTALLED_PANEL_SECTION,
    type InstallSource,
    TOOL_INSTALL_TOOL_ID,
    TOOL_INSTALL_TOOL_VERSION,
} from "../source";
import { installView } from "../views";

const SOURCE: InstallSource = {
    type: "toolshed",
    tool_shed_url: "https://toolshed.g2.bx.psu.edu",
    owner: "iuc",
    name: "datamash_ops",
    changeset_revision: "aaafc0ac4dd2",
};
const REVISION = "aaafc0ac4dd2596ac203f170cce4765e72436c57";
const encoder = new TextEncoder();

type Deps = ReturnType<typeof testDeps>;

function createInstallJob(source: unknown = SOURCE): Promise<JobRecord> {
    return jobs.create({
        tool_id: TOOL_INSTALL_TOOL_ID,
        tool_version: TOOL_INSTALL_TOOL_VERSION,
        state: "queued",
        params: { source } as Record<string, unknown>,
        request: { source },
    });
}

async function dispatched(deps: Deps, source: unknown = SOURCE): Promise<{ job: JobRecord; manifest: Manifest }> {
    const job = await createInstallJob(source);
    const plan = await prepareDispatch(job, deps);
    expect(plan.kind).toBe("tool_install");
    expect(plan.toolImage).toBeNull();
    const manifest = deps.s3.json<Manifest>(plan.manifestKey);
    return { job: await markDispatched(job.id, plan), manifest };
}

interface PodTool {
    slot: number;
    bundle?: ToolBundle;
    archive?: Uint8Array;
    /** Changes the reported entry. */
    entry?: Record<string, unknown>;
}

/** What an install pod writes for `tools`: their slot objects, then results.json. */
async function podInstalls(deps: Deps, job: JobRecord, podTools: PodTool[], extra: Record<string, unknown> = {}) {
    const entries = [];
    for (const tool of podTools) {
        const keys = installSlotKeys(job.id, 1, tool.slot);
        const archive = tool.archive ?? encoder.encode(`archive ${tool.slot}`);
        const base = tool.bundle ?? datamashBundle();
        const bundle: ToolBundle = {
            ...base,
            source: {
                ...base.source,
                repo_tar: { path: keys.repoTar, sha256: await sha256Hex(archive), size: archive.byteLength },
            },
            panel_entry: { ...(base.panel_entry as object), panel_section_id: "planet_installed" },
        };
        const bundleBytes = encoder.encode(JSON.stringify(bundle));
        deps.s3.objects.set(keys.bundle, bundleBytes);
        deps.s3.objects.set(keys.repoTar, archive);
        entries.push({
            path: "datamash-ops.xml",
            id: bundle.id,
            old_id: bundle.old_id,
            version: bundle.version,
            name: bundle.name,
            description: null,
            state: "installed",
            slot: tool.slot,
            bundle: { sha256: await sha256Hex(bundleBytes), size: bundleBytes.byteLength },
            repo_tar: { sha256: await sha256Hex(archive), size: archive.byteLength },
            errors: [],
            warnings: [],
            ...tool.entry,
        });
    }
    const results = {
        ...resultsDocument(job.id, { kind: "tool_install", command_line: null, command_version: null }),
        install: {
            source: SOURCE,
            repository_url: "https://toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops",
            revision: REVISION,
            warnings: [],
        },
        tools: entries,
        ...extra,
    };
    deps.s3.put(`jobs/${job.id}/a1/results.json`, results);
    return results;
}

const rejected = {
    path: "data_manager/fetch.xml",
    id: null,
    old_id: "fetch",
    version: "1.0",
    name: "Fetch",
    description: null,
    state: "rejected",
    slot: null,
    bundle: null,
    repo_tar: null,
    errors: ["Data managers are not supported: they write Galaxy's reference data tables."],
    warnings: [],
};

beforeEach(resetDb);
afterEach(teardownDb);

describe("tool_install dispatch", () => {
    it("writes a manifest with the source and a slot pool, without tool or datasets", async () => {
        const deps = testDeps();
        const { job, manifest } = await dispatched(deps);
        expect(jobKind(job)).toBe("tool_install");
        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(manifest.kind).toBe("tool_install");
        expect(manifest.tool).toBeUndefined();
        expect(manifest.install!.source).toEqual(SOURCE);
        expect(manifest.install!.panel_section).toEqual(INSTALLED_PANEL_SECTION);
        expect(manifest.install!.slots).toHaveLength(INSTALL_SLOT_COUNT);
        expect(manifest.install!.slots[3]!.repo_tar.key).toBe(`tools/installs/${job.id}-a1/3/repo.tar`);
        expect(manifest.install!.slots[3]!.bundle.key).toBe(`tools/installs/${job.id}-a1/3/bundle.json`);
        expect(Object.keys(manifest.job_files)).toEqual(["results"]);
    });

    it("runs the install stager in a single container", async () => {
        const deps = testDeps();
        const job = await createInstallJob();
        const plan = await prepareDispatch(job, deps);
        const spec = await buildJobSpec({
            instanceId: deps.settings.instance_id,
            jobId: job.id,
            attempt: 1,
            cluster: deps.settings.cluster,
            plan,
        });
        const pod = spec.spec!.template.spec!;
        expect(pod.initContainers).toBeUndefined();
        expect(pod.containers.map((container) => container.command)).toEqual([["planet-stager", "install"]]);
        expect(pod.containers[0]!.env!.find((item) => item.name === "PLANET_MANIFEST_URL")?.value).toBe(
            plan.manifestUrl,
        );
    });

    it("fails a job whose source is not valid, permanently", async () => {
        const deps = testDeps();
        const job = await createInstallJob({ ...SOURCE, tool_shed_url: "https://evil.example" });
        await expect(prepareDispatch(job, deps)).rejects.toMatchObject({ permanent: true });
    });
});

describe("tool_install ingest", () => {
    it("stores the verified tools and the outcome of every tool file", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        const results = await podInstalls(deps, job, [{ slot: 0 }]);
        deps.s3.put(`jobs/${job.id}/a1/results.json`, { ...results, tools: [...results.tools, rejected] });

        const outcome = await ingestResults(job, deps);
        expect(outcome?.state).toBe("ok");

        const bundle = datamashBundle();
        const record = await tools.get(bundle.id, bundle.version);
        expect(record).toMatchObject({
            source: "installed",
            status: "ready",
            bundle_url: null,
            panel_section_id: "planet_installed",
            panel_section_name: "Installed tools",
            hidden: false,
        });
        const stored = record!.bundle as ToolBundle;
        expect(stored.source!.repo_tar!.path).toBe(`tools/installs/${job.id}-a1/0/repo.tar`);
        expect((stored.panel_entry as Record<string, unknown>).panel_section_name).toBe("Installed tools");
        expect(await readBundle(bundle.id, bundle.version)).toEqual(stored);

        const updated = (await jobs.get(job.id))!;
        expect(updated.state).toBe("ok");
        const view = installView(updated);
        expect(view).toMatchObject({ phase: "partial", label: "iuc/datamash_ops", revision: REVISION });
        expect(view.tools.map((tool) => [tool.path, tool.state])).toEqual([
            ["datamash-ops.xml", "installed"],
            ["data_manager/fetch.xml", "rejected"],
        ]);
        expect(view.tools[1]!.errors[0]).toMatch(/Data managers/);
    });

    it("runs installed tools from the archive their install pod stored", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 0 }]);
        await ingestResults(job, deps);
        const bundle = (await readBundle(datamashBundle().id, datamashBundle().version)) as unknown as ToolBundle;

        const toolDeps = testDeps([bundle]);
        toolDeps.s3.objects.set(bundle.source!.repo_tar!.path, deps.s3.objects.get(bundle.source!.repo_tar!.path)!);
        const toolJob = await jobs.create({
            tool_id: bundle.id,
            tool_version: bundle.version,
            state: "queued",
            params: {},
        });
        const plan = await prepareDispatch(toolJob, toolDeps);
        const manifest = toolDeps.s3.json<Manifest>(plan.manifestKey);
        expect(manifest.tool!.archive!.sha256).toBe(bundle.source!.repo_tar!.sha256);
        expect(String(manifest.tool!.archive!.request)).toContain(`tools/installs/${job.id}-a1/0/repo.tar`);
        expect(toolDeps.fetchStatic).not.toHaveBeenCalled();

        toolDeps.s3.objects.delete(bundle.source!.repo_tar!.path);
        const again = await jobs.create({
            tool_id: bundle.id,
            tool_version: bundle.version,
            state: "queued",
            params: {},
        });
        await expect(prepareDispatch(again, toolDeps)).rejects.toThrow(
            /missing from the bucket; install the tool again/,
        );
    });

    it.each([
        [
            "a bundle that differs from its digest",
            { entry: { bundle: { sha256: "0".repeat(64), size: 10 } } },
            /does not match its digest/,
        ],
        [
            "an id outside the repository's ids",
            { bundle: { ...datamashBundle(), id: "cat1" }, entry: { id: "cat1" } },
            /its id is not toolshed\.g2\.bx\.psu\.edu\/repos\/iuc\/datamash_ops\//,
        ],
        [
            "another repository's tool",
            {
                bundle: { ...datamashBundle(), id: "toolshed.g2.bx.psu.edu/repos/devteam/x/datamash_ops/1.9+galaxy0" },
                entry: { id: "toolshed.g2.bx.psu.edu/repos/devteam/x/datamash_ops/1.9+galaxy0" },
            },
            /its id is not/,
        ],
        [
            "a data manager",
            { bundle: { ...datamashBundle(), tool_type: "manage_data" } },
            /cannot run tools of its kind/,
        ],
        ["a slot outside the pool", { entry: { slot: INSTALL_SLOT_COUNT } }, /no slot of its own/],
    ])("refuses %s", async (_, change: Omit<PodTool, "slot">, reason) => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 1, ...change }]);
        await ingestResults(job, deps);
        const updated = (await jobs.get(job.id))!;
        const view = installView(updated);
        expect(view.tools[0]!.state).toBe("failed");
        expect(view.tools[0]!.errors.at(-1)).toMatch(reason);
        expect(updated.job_messages.map((message) => (message as { desc: string }).desc).join("\n")).toMatch(reason);
        expect(updated.state).toBe("error");
        expect(view.phase).toBe("failed");
        expect(await tools.list()).toEqual([]);
    });

    it("refuses a second tool reported in the same slot", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 0 }, { slot: 0 }]);
        await ingestResults(job, deps);
        const updated = (await jobs.get(job.id))!;
        expect(installView(updated).tools.map((tool) => tool.state)).toEqual(["installed", "failed"]);
        expect(installView(updated).tools[1]!.errors.at(-1)).toMatch(/no slot of its own/);
        expect(updated.state).toBe("ok");
        expect(await tools.list()).toHaveLength(1);
    });

    it("refuses an archive whose size differs from the report", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 0 }]);
        deps.s3.objects.set(installSlotKeys(job.id, 1, 0).repoTar, encoder.encode("longer archive than reported"));
        await ingestResults(job, deps);
        expect((await jobs.get(job.id))!.state).toBe("error");
        expect(await tools.list()).toEqual([]);
    });

    it("fails on results whose tools do not follow the protocol", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 0, entry: { state: "maybe" } }]);
        await expect(ingestResults(job, deps)).rejects.toThrow(/tools\/0\/state/);
    });

    it("stores nothing for a job cancelled before its results arrived", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 0 }]);
        await jobs.update(job.id, { state: "deleting" });
        await ingestResults(job, deps);
        expect(await tools.list()).toEqual([]);
        expect((await jobs.get(job.id))!.params.tools).toBeUndefined();
    });

    it("does not replace a built-in tool record of the same version", async () => {
        const deps = testDeps();
        const bundle = datamashBundle();
        await tools.put({
            tool_id: bundle.id,
            tool_version: bundle.version,
            source: "curated",
            status: "ready",
            message: null,
            bundle,
            bundle_url: null,
            panel_section_id: null,
            panel_section_name: null,
            hidden: false,
        });
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [{ slot: 0 }]);
        await ingestResults(job, deps);
        expect((await tools.get(bundle.id, bundle.version))!.source).toBe("curated");
        expect(installView((await jobs.get(job.id))!).tools[0]!.errors).toEqual([
            "A built-in tool has the same id and version.",
        ]);
    });

    it("keeps the pod's failure when it installed nothing", async () => {
        const deps = testDeps();
        const { job } = await dispatched(deps);
        await podInstalls(deps, job, [], {
            state: "error",
            errors: ["Cloning https://toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops at aaafc0ac4dd2 failed."],
            job_messages: [{ type: "internal", desc: "Cloning failed.", code_desc: null, error_level: 3 }],
        });
        await ingestResults(job, deps);
        const updated = (await jobs.get(job.id))!;
        expect(updated.state).toBe("error");
        expect(installView(updated)).toMatchObject({ phase: "failed", message: "Cloning failed.", tools: [] });
    });
});
