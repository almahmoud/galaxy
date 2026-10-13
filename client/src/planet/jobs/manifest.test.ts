// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, datasets, jobs } from "@/planet/db";

import {
    addDataset,
    addJob,
    addList,
    addOutput,
    addUpload,
    DATAMASH_IMAGE,
    datamashBundle,
    newHistory,
    resetDb,
    schemaErrors,
    teardownDb,
    testDeps,
    withArchive,
} from "./__fixtures__/setup";
import { slotsAndMemory } from "./k8sJob";
import { DEADLINE_MARGIN_SECONDS, toolArchiveKey, toolArchiveStaticPath } from "./keys";
import {
    abortDispatch,
    adoptDispatch,
    DATA_FETCH_TOOL_ID,
    DEFAULT_SLOT_COUNT,
    DEFAULT_START_TIMEOUT_SECONDS,
    DispatchError,
    expandFlatState,
    jobKind,
    jobResources,
    prepareDispatch,
    SET_METADATA_TOOL_ID,
} from "./manifest";
import { EXTRA_OBJECT_POOL, METADATA_FILE_POOL, multipartLayout, readDispatchRecord } from "./objects";
import type { Manifest, ManifestOutput, ToolBundle } from "./schemas";

beforeEach(resetDb);
afterEach(teardownDb);

const GIB = 1024 ** 3;
const REQUEST_EXPIRY = 86400 + DEADLINE_MARGIN_SECONDS + 3600;

/** Writes the manifests to PLANET_MANIFEST_DIR when it is set, to check them with planet_runtime in its image. */
function dump(name: string, manifest: Manifest): void {
    const directory = process.env.PLANET_MANIFEST_DIR;
    if (directory) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${name}.json`), JSON.stringify(manifest, null, 2));
    }
}

function get(key: string, expires = REQUEST_EXPIRY): string {
    return `https://cluster.s3.test/${key}?method=GET&expires=${expires}`;
}

function put(key: string, expires = REQUEST_EXPIRY): string {
    return `https://cluster.s3.test/${key}?method=PUT&expires=${expires}`;
}

async function datamashJob(options: { inputSize?: number; outputExtension?: string } = {}) {
    const historyId = await newHistory();
    const input = await addDataset(
        historyId,
        { name: "scores.tsv", metadata: { columns: 3, column_types: ["str", "int", "float"] }, tags: ["name:scores"] },
        { file_size: options.inputSize ?? 120, total_size: options.inputSize ?? 120 },
    );
    await datasets.update(input.dataset.id, {
        metadata_files: { bam_index: { key: `datasets/${input.dataset.uuid}/meta/0`, file_size: 12 } },
    });
    const output = await addOutput(historyId, {
        name: "Datamash on data 1",
        extension: options.outputExtension ?? "tabular",
    });
    const job = await addJob(historyId, {
        tool_id: datamashBundle().id,
        tool_version: datamashBundle().version,
        params: {
            in_file: { values: [{ src: "hda", id: input.hda.id }] },
            grouping: "1",
            need_sort: true,
            header_in: false,
            header_out: false,
            print_full_line: false,
            ignore_case: false,
            narm: false,
            operations: [{ __index__: 0, op_name: "count", op_column: "2" }],
            dbkey: "hg38",
            chromInfo: "/galaxy/tool-data/shared/ucsc/chrom/hg38.len",
            "in_file|__identifier__": "sample1",
        },
        outputs: [{ name: "out_file", src: "hda", id: output.hda.id }],
    });
    return { historyId, input, output, job };
}

async function toolDeps(overrides: Parameters<typeof testDeps>[1] = {}) {
    const { bundle, tar } = await withArchive(datamashBundle());
    const deps = testDeps([bundle], overrides, { [toolArchiveStaticPath(bundle.source!.repo_tar!.path)]: tar });
    return { deps, bundle, tar };
}

function expectTargets(output: Omit<ManifestOutput, "name">, uuid: string, extraObjects = 0) {
    const prefix = `datasets/${uuid}/`;
    expect(output.uuid).toBe(uuid);
    expect(output.data?.put).toBe(put(`${prefix}data`));
    expect(output.meta).toBe(put(`${prefix}meta.json`));
    expect(output.extra).toBe(put(`${prefix}extra.tar`));
    expect(output.extra_index).toBe(put(`${prefix}extra.json`));
    expect(output.metadata_files).toEqual(
        Array.from({ length: METADATA_FILE_POOL }, (_, index) => put(`${prefix}meta/${index}`)),
    );
    expect(output.extra_objects ?? []).toEqual(
        Array.from({ length: extraObjects }, (_, index) => ({
            key: `${prefix}extra/${index}`,
            request: put(`${prefix}extra/${index}`),
        })),
    );
}

describe("jobKind", () => {
    it("tells uploads and metadata jobs from tool jobs", () => {
        expect(jobKind({ tool_id: DATA_FETCH_TOOL_ID })).toBe("upload");
        expect(jobKind({ tool_id: SET_METADATA_TOOL_ID })).toBe("set_metadata");
        expect(jobKind({ tool_id: "toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/datamash_ops/1.9+galaxy0" })).toBe(
            "tool",
        );
    });
});

describe("prepareDispatch for a tool job", () => {
    it("writes a manifest of the generated bundle that matches the protocol schema", async () => {
        const { input, output, job } = await datamashJob();
        const { deps, bundle } = await toolDeps();

        const plan = await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`);
        dump("tool", manifest);

        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(manifest.protocol).toBe(1);
        expect(manifest.kind).toBe("tool");
        expect(manifest.job).toEqual({
            id: job.id,
            attempt: 1,
            history_id: job.history_id,
            walltime_seconds: 86400,
            slots: 1,
            memory_mb: 4096,
        });
        expect(manifest.user).toEqual({ email: "user@example.org", username: "user" });
        expect(manifest.datatypes).toEqual({ source: "builtin" });

        const { archive, ...tool } = manifest.tool!;
        expect(tool).toEqual(bundle);
        expect(archive).toEqual({
            request: get(toolArchiveKey(bundle.id, bundle.version)),
            sha256: bundle.source!.repo_tar!.sha256,
        });

        expect(manifest.params).toEqual({
            in_file: { src: "hda", key: input.hda.id },
            grouping: "1",
            need_sort: true,
            header_in: false,
            header_out: false,
            print_full_line: false,
            ignore_case: false,
            narm: false,
            operations: [{ __index__: 0, op_name: "count", op_column: "2" }],
            dbkey: "hg38",
            "in_file|__identifier__": "sample1",
        });
        const uuid = input.dataset.uuid;
        expect(manifest.inputs).toEqual({
            [input.hda.id]: {
                uuid,
                id: input.hda.id,
                hid: input.hda.hid,
                name: "scores.tsv",
                ext: "tabular",
                dbkey: "hg38",
                info: null,
                tags: ["name:scores"],
                element_identifier: null,
                created_from_basename: null,
                metadata: { columns: 3, column_types: ["str", "int", "float"] },
                metadata_files: { bam_index: get(`datasets/${uuid}/meta/0`) },
                data: get(`datasets/${uuid}/data`),
                size: 120,
            },
        });
        expect(manifest.collections).toEqual({});

        expect(manifest.outputs).toHaveLength(1);
        const [declared] = manifest.outputs;
        expect(declared).toMatchObject({
            name: "out_file",
            id: output.hda.id,
            hid: output.hda.hid,
            ext: "tabular",
            dbkey: "hg38",
            visible: true,
        });
        expectTargets(declared!, output.dataset.uuid);
        expect(declared!.data?.multipart).toBeUndefined();

        expect(manifest.slots).toHaveLength(DEFAULT_SLOT_COUNT);
        const slotUuids = manifest.slots!.map((slot) => slot.uuid);
        expect(new Set(slotUuids).size).toBe(DEFAULT_SLOT_COUNT);
        manifest.slots!.forEach((slot) => expectTargets(slot, slot.uuid));
        expect(manifest.output_collections).toEqual({});
        expect(manifest.job_files).toEqual({
            prepare: put(`jobs/${job.id}/a1/prepare.json`),
            results: put(`jobs/${job.id}/a1/results.json`),
            stdout: put(`jobs/${job.id}/a1/stdout`),
            stderr: put(`jobs/${job.id}/a1/stderr`),
        });
        expect(manifest.limits).toEqual({
            max_discovered_files: DEFAULT_SLOT_COUNT,
            max_metadata_value_size: 5 * 1024 * 1024,
            start_timeout_seconds: DEFAULT_START_TIMEOUT_SECONDS,
        });

        expect(plan).toEqual({
            kind: "tool",
            attempt: 1,
            dispatchId: expect.stringMatching(/^[0-9a-f]{16}$/),
            manifestKey: `jobs/${job.id}/a1/manifest.json`,
            manifestUrl: get(`jobs/${job.id}/a1/manifest.json`, 86400),
            deadlineSeconds: 86400 + DEADLINE_MARGIN_SECONDS,
            walltimeSeconds: 86400,
            toolImage: DATAMASH_IMAGE,
            resources: { cpu: "1", memory: "4Gi", scratch: "20Gi" },
            multipart: [],
        });
        expect(await readDispatchRecord(deps.s3, job.id, 1)).toMatchObject({
            job_id: job.id,
            attempt: 1,
            dispatch_id: plan.dispatchId,
            kind: "tool",
            walltime_seconds: 86400,
            deadline_seconds: 86400 + DEADLINE_MARGIN_SECONDS,
            slots: 1,
            memory_mb: 4096,
            slot_uuids: slotUuids,
            multipart: [],
        });
    });

    it("expands the flat keys of a tool form into Galaxy's nested state", async () => {
        const { input, job } = await datamashJob();
        const flat = await jobs.update(job.id, {
            params: {
                in_file: { batch: false, values: [{ src: "hda", id: input.hda.id }] },
                grouping: "1",
                "operations_0|op_name": "count",
                "operations_0|op_column": "2",
                "operations_3|op_name": "sum",
                "operations_3|op_column": "3",
                need_sort: "true",
                "in_file|__identifier__": "sample1",
            },
        });
        const { deps } = await toolDeps();
        await prepareDispatch(flat, deps);
        const manifest = deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`);
        expect(manifest.params).toEqual({
            in_file: { src: "hda", key: input.hda.id },
            grouping: "1",
            need_sort: "true",
            operations: [
                { __index__: 0, op_name: "count", op_column: "2" },
                { __index__: 1, op_name: "sum", op_column: "3" },
            ],
            "in_file|__identifier__": "sample1",
        });
    });

    it("copies the tool archive into the bucket once, after checking it against the bundle", async () => {
        const { job } = await datamashJob();
        const { deps, bundle, tar } = await toolDeps();
        const key = toolArchiveKey(bundle.id, bundle.version);
        expect(key).toBe(bundle.source!.repo_tar!.path);

        await prepareDispatch(job, deps);
        expect(deps.fetchStatic).toHaveBeenCalledWith(
            "/static/planet/toolrepos/tools/toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/datamash_ops/1.9%2Bgalaxy0/1.9%2Bgalaxy0/repo.tar",
        );
        expect(deps.s3.objects.get(key)).toEqual(tar);

        await prepareDispatch(job, deps);
        expect(deps.fetchStatic).toHaveBeenCalledTimes(1);
        expect(deps.s3.log.filter((entry) => entry === `PUT ${key}`)).toHaveLength(1);
    });

    it("keeps an archive the bucket already has", async () => {
        const { job } = await datamashJob();
        const { deps, bundle, tar } = await toolDeps();
        deps.s3.objects.set(toolArchiveKey(bundle.id, bundle.version), tar);
        await prepareDispatch(job, deps);
        expect(deps.fetchStatic).not.toHaveBeenCalled();
    });

    it("refuses an archive that does not match the bundle", async () => {
        const { job } = await datamashJob();
        const { bundle } = await withArchive(datamashBundle());
        const deps = testDeps(
            [bundle],
            {},
            {
                [toolArchiveStaticPath(bundle.source!.repo_tar!.path)]: new TextEncoder().encode("something else"),
            },
        );
        const error = await prepareDispatch(job, deps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DispatchError);
        expect((error as DispatchError).permanent).toBe(true);
        expect(deps.s3.objects.has(`jobs/${job.id}/a1/manifest.json`)).toBe(false);
    });

    it("gives HTML outputs a pool of extra objects", async () => {
        const { output, job } = await datamashJob({ outputExtension: "html" });
        const { deps } = await toolDeps();
        await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`);
        expectTargets(manifest.outputs[0]!, output.dataset.uuid, EXTRA_OBJECT_POOL);
        expect(schemaErrors(manifest, "manifest")).toEqual([]);
    });

    it("creates multipart uploads for the outputs of jobs with large inputs; a new dispatch of the attempt aborts them", async () => {
        const { output, job } = await datamashJob({ inputSize: 5 * GIB });
        const { deps } = await toolDeps();
        const plan = await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`);
        const key = `datasets/${output.dataset.uuid}/data`;
        const layout = multipartLayout(5 * GIB);
        const multipart = manifest.outputs[0]!.data!.multipart!;
        expect(multipart.part_size).toBe(layout.partSize);
        expect(multipart.parts).toHaveLength(layout.parts);
        expect(multipart.parts[0]).toBe(`${put(key)}&uploadId=upload-1&partNumber=1`);
        expect(layout.partSize * layout.parts).toBeGreaterThanOrEqual(40 * GIB);
        expect(manifest.outputs[0]!.data!.put).toBe(put(key));
        expect(plan.multipart).toEqual([{ key, uploadId: "upload-1" }]);
        expect(schemaErrors(manifest, "manifest")).toEqual([]);

        const again = await prepareDispatch(job, deps);
        expect(deps.s3.aborted).toEqual(["upload-1"]);
        expect(again.attempt).toBe(1);
        expect(again.dispatchId).not.toBe(plan.dispatchId);
        expect(again.multipart).toEqual([{ key, uploadId: "upload-2" }]);

        const next = await prepareDispatch(job, deps, { attempt: 2 });
        expect(deps.s3.aborted).toEqual(["upload-1"]);
        expect(next.manifestKey).toBe(`jobs/${job.id}/a2/manifest.json`);
        expect(deps.s3.json<Manifest>(next.manifestKey).job.attempt).toBe(2);
        expect(deps.s3.json<Manifest>(next.manifestKey).job_files.results).toBe(put(`jobs/${job.id}/a2/results.json`));
        expect(deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`).job.attempt).toBe(1);
    });

    it("adopts an attempt only for the Job of its own dispatch record, and aborts an attempt's uploads", async () => {
        const { job } = await datamashJob({ inputSize: 5 * GIB });
        const { deps } = await toolDeps();
        const plan = await prepareDispatch(job, deps, { attempt: 3 });
        const before = deps.s3.log.length;

        expect(await adoptDispatch(job, deps, { attempt: 3, dispatchId: plan.dispatchId })).toEqual({
            kind: "tool",
            attempt: 3,
            dispatchId: plan.dispatchId,
            multipart: plan.multipart,
        });
        expect(await adoptDispatch(job, deps, { attempt: 3, dispatchId: "f".repeat(16) })).toBeNull();
        expect(await adoptDispatch(job, deps, { attempt: 3, dispatchId: null })).toBeNull();
        expect(await adoptDispatch(job, deps, { attempt: 2, dispatchId: plan.dispatchId })).toBeNull();
        expect(deps.s3.log.slice(before).every((entry) => entry.startsWith("GET "))).toBe(true);

        await abortDispatch(job, deps, { attempt: 2 });
        expect(deps.s3.aborted).toEqual([]);
        await abortDispatch(job, deps, { attempt: 3 });
        expect(deps.s3.aborted).toEqual([plan.multipart[0]!.uploadId]);
    });

    it("aborts the uploads it created when the dispatch fails", async () => {
        const { job } = await datamashJob({ inputSize: 5 * GIB });
        const { deps } = await toolDeps();
        const putObject = deps.s3.putObject.bind(deps.s3);
        deps.s3.putObject = async (key, body) => {
            if (key.endsWith("manifest.json")) {
                throw new Error("bucket unavailable");
            }
            return putObject(key, body);
        };
        await expect(prepareDispatch(job, deps)).rejects.toThrow("bucket unavailable");
        expect(deps.s3.aborted).toEqual(["upload-1"]);
    });

    it("passes input collections and collection elements", async () => {
        const historyId = await newHistory();
        const first = await addDataset(historyId, { name: "a" });
        const second = await addDataset(historyId, { name: "b" });
        const list = await addList(historyId, [first.hda.id, second.hda.id]);
        const elements = await collections.elements(list.collection_id);
        const output = await addOutput(historyId);
        const job = await addJob(historyId, {
            tool_id: datamashBundle().id,
            tool_version: datamashBundle().version,
            params: {
                in_file: { values: [{ src: "dce", id: elements[1]!.id }] },
                queries: { values: [{ src: "hdca", id: list.id }] },
            },
            outputs: [{ name: "out_file", src: "hda", id: output.hda.id }],
        });
        const { deps } = await toolDeps();
        await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`);
        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(manifest.params).toEqual({
            in_file: { src: "hda", key: second.hda.id },
            queries: { src: "hdca", key: list.id },
        });
        expect(manifest.collections).toEqual({
            [list.id]: {
                name: "list",
                id: list.id,
                hid: list.hid,
                collection_type: "list",
                elements: [
                    { element_identifier: "e0", input: first.hda.id },
                    { element_identifier: "e1", input: second.hda.id },
                ],
            },
        });
        expect(Object.keys(manifest.inputs!).sort()).toEqual([first.hda.id, second.hda.id].sort());
        expect(manifest.inputs![second.hda.id]!.element_identifier).toBe("e1");
    });

    it("describes output collections with the outputs of their static elements", async () => {
        const historyId = await newHistory();
        const input = await addDataset(historyId);
        const forward = await addOutput(historyId, { name: "forward", visible: false });
        const reverse = await addOutput(historyId, { name: "reverse", visible: false });
        const pair = await collections.createHdca({
            hdca: { name: "Split on data 1", history_id: historyId },
            collection: {
                collection_type: "paired",
                elements: [
                    { identifier: "forward", hda_id: forward.hda.id },
                    { identifier: "reverse", hda_id: reverse.hda.id },
                ],
            },
        });
        const split = await collections.createHdca({
            hdca: { name: "Parts", history_id: historyId },
            collection: { collection_type: "list", populated_state: "new", elements: [] },
        });
        const bundle: ToolBundle = {
            ...datamashBundle(),
            outputs: [
                {
                    model_class: "ToolOutputCollection",
                    name: "pair",
                    outputs: {
                        forward: { model_class: "ToolOutput", name: "forward" },
                        reverse: { model_class: "ToolOutput", name: "reverse" },
                    },
                },
                { model_class: "ToolOutputCollection", name: "parts" },
            ],
        };
        const { bundle: archived, tar } = await withArchive(bundle);
        const deps = testDeps([archived], {}, { [toolArchiveStaticPath(archived.source!.repo_tar!.path)]: tar });
        const job = await addJob(historyId, {
            tool_id: bundle.id,
            tool_version: bundle.version,
            params: { in_file: { src: "hda", id: input.hda.id } },
            outputs: [
                { name: "pair|__part__|forward", src: "hda", id: forward.hda.id },
                { name: "pair|__part__|reverse", src: "hda", id: reverse.hda.id },
            ],
            output_collections: [
                { name: "pair", src: "hdca", id: pair.hdca.id },
                { name: "parts", src: "hdca", id: split.hdca.id },
            ],
        });
        await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(`jobs/${job.id}/a1/manifest.json`);
        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(manifest.output_collections).toEqual({
            pair: {
                name: "Split on data 1",
                id: pair.hdca.id,
                hid: pair.hdca.hid,
                collection_type: "paired",
                elements: [
                    { element_identifier: "forward", output: "pair|__part__|forward", param_name: "forward" },
                    { element_identifier: "reverse", output: "pair|__part__|reverse", param_name: "reverse" },
                ],
            },
            parts: { name: "Parts", id: split.hdca.id, hid: split.hdca.hid, collection_type: "list", elements: [] },
        });
        expect(manifest.outputs.map((output) => output.visible)).toEqual([false, false]);
    });

    it("waits for inputs that are not ready", async () => {
        const { input, job } = await datamashJob();
        await datasets.update(input.dataset.id, { state: "running" });
        const { deps } = await toolDeps();
        const error = await prepareDispatch(job, deps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DispatchError);
        expect((error as DispatchError).message).toMatch(/is not ready \(running\)/);
        expect((error as DispatchError).permanent).toBe(false);
    });

    it("fails tools without a container image and tools that are not installed", async () => {
        const { job } = await datamashJob();
        const { deps } = await toolDeps({ resolveContainer: async () => null });
        await expect(prepareDispatch(job, deps)).rejects.toMatchObject({ permanent: true });
        await expect(prepareDispatch(job, testDeps([]))).rejects.toThrow(/is not installed/);
    });

    it("uses an explicit docker container and its shell when no resolver is given", async () => {
        const { job } = await datamashJob();
        const { bundle, tar } = await withArchive({
            ...datamashBundle(),
            containers: [{ type: "docker", identifier: "busybox:1.36", shell: "/bin/sh" }],
        });
        const deps = testDeps(
            [bundle],
            { resolveContainer: undefined },
            {
                [toolArchiveStaticPath(bundle.source!.repo_tar!.path)]: tar,
            },
        );
        const plan = await prepareDispatch(job, deps);
        expect(plan.toolImage).toBe("busybox:1.36");
        expect(deps.s3.json<Manifest>(plan.manifestKey).job.shell).toBe("/bin/sh");
    });
});

describe("jobResources", () => {
    const cluster = testDeps().settings.cluster;

    it("uses the configured defaults", () => {
        expect(jobResources(cluster, null)).toEqual({
            cpu: "1",
            memory: "4Gi",
            scratch: "20Gi",
            slots: 1,
            memoryMb: 4096,
        });
        expect(jobResources({ ...cluster, default_cpu: "1500m" }, null).slots).toBe(2);
    });

    it("raises them to the tool's literal resource requirements", () => {
        const bundle = {
            ...datamashBundle(),
            resource_requirements: [
                { resource_type: "cores_min", value_or_expression: 4 },
                { resource_type: "ram_min", value_or_expression: "16384" },
                { resource_type: "tmpdir_min", value_or_expression: "$(inputs.size * 2)" },
            ],
        };
        expect(jobResources(cluster, bundle)).toEqual({
            cpu: "4",
            memory: "16384Mi",
            scratch: "20Gi",
            slots: 4,
            memoryMb: 16384,
        });
        const smaller = {
            ...bundle,
            resource_requirements: [{ resource_type: "cores_min", value_or_expression: 0.5 }],
        };
        expect(jobResources(cluster, smaller).cpu).toBe("1");
    });

    it("rejects settings that are not Kubernetes quantities", () => {
        expect(() => jobResources({ ...cluster, default_memory: "lots" }, null)).toThrow(DispatchError);
    });

    it("gives the manifest the slots and memory the Job spec sets", () => {
        for (const [defaults, requirements] of [
            [{ default_cpu: "1500m", default_memory: "4G" }, []],
            [
                { default_cpu: "250m", default_memory: "1Gi" },
                [{ resource_type: "cores_min", value_or_expression: 2.5 }],
            ],
            [
                { default_cpu: "3", default_memory: "1500Mi" },
                [{ resource_type: "ram_min", value_or_expression: 2049.5 }],
            ],
        ] as const) {
            const resources = jobResources(
                { ...cluster, ...defaults },
                { ...datamashBundle(), resource_requirements: [...requirements] },
            );
            const spec = slotsAndMemory(resources);
            expect({ slots: resources.slots, memoryMb: resources.memoryMb }).toEqual(spec);
        }
    });
});

describe("expandFlatState", () => {
    it("follows conditionals, sections and repeats of the bundle", () => {
        const inputs = [
            {
                name: "mode",
                model_class: "Conditional",
                test_param: { name: "kind", type: "select" },
                cases: [
                    { value: "fast", inputs: [{ name: "level", type: "integer" }] },
                    { value: "slow", inputs: [{ name: "passes", type: "integer" }] },
                ],
            },
            { name: "advanced", model_class: "Section", inputs: [{ name: "seed", type: "integer" }] },
            { name: "flag", model_class: "BooleanToolParameter", type: "boolean" },
        ];
        expect(
            expandFlatState(inputs, {
                "mode|kind": "slow",
                "mode|passes": 3,
                "mode|level": 9,
                "advanced|seed": 7,
                flag: false,
                __input_ext: "tabular",
            }),
        ).toEqual({
            mode: { kind: "slow", __current_case__: 1, passes: 3 },
            advanced: { seed: 7 },
            flag: false,
            __input_ext: "tabular",
        });
    });
});

describe("prepareDispatch for an upload job", () => {
    async function uploadJob(targets: unknown[], files: Record<string, unknown>, outputs: number) {
        const historyId = await newHistory();
        const created = [];
        for (let index = 0; index < outputs; index++) {
            created.push(
                await addOutput(
                    historyId,
                    { name: `upload ${index}`, extension: "auto", dbkey: "?" },
                    { state: "queued" },
                ),
            );
        }
        const job = await addJob(historyId, {
            tool_id: DATA_FETCH_TOOL_ID,
            tool_version: "0.1.0",
            request: { history_id: historyId, targets, auto_decompress: true, ...files },
            outputs: created.map((output, index) => ({ name: `output${index}`, src: "hda", id: output.hda.id })),
        });
        return { historyId, job, outputs: created };
    }

    it("rewrites the fetch request for two uploaded files and pasted text", async () => {
        const reads = await addUpload({ name: "reads.fastq.gz", size: 2048 });
        const table = await addUpload({ name: "table.txt", size: 64 });
        const { job, outputs } = await uploadJob(
            [
                {
                    destination: { type: "hdas" },
                    items: [
                        { src: "files", ext: "auto", dbkey: "?", MD5: "0123456789abcdef0123456789abcdef" },
                        { src: "files", name: "table", ext: "txt", dbkey: "hg19", space_to_tab: true },
                        { src: "pasted", paste_content: "x\ty\n1\t2\n", name: "pasted", ext: "auto" },
                    ],
                },
            ],
            {
                "files_1|file_data": { session_id: table.id, name: "table.txt" },
                "files_0|file_data": { session_id: reads.id, name: "reads.fastq.gz" },
            },
            3,
        );
        const deps = testDeps();
        const plan = await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(plan.manifestKey);
        dump("upload", manifest);

        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(plan).toMatchObject({ kind: "upload", toolImage: null, multipart: [] });
        expect(manifest.kind).toBe("upload");
        expect(manifest.tool).toBeUndefined();
        expect(manifest.upload).toEqual({
            request: {
                targets: [
                    {
                        destination: { type: "hdas" },
                        elements: [
                            {
                                src: "planet",
                                file: reads.id,
                                name: "reads.fastq.gz",
                                ext: "auto",
                                dbkey: "?",
                                hashes: [{ hash_function: "MD5", hash_value: "0123456789abcdef0123456789abcdef" }],
                                in_place: false,
                                purge_source: true,
                                object_id: outputs[0]!.hda.id,
                            },
                            {
                                src: "planet",
                                file: table.id,
                                name: "table",
                                ext: "txt",
                                dbkey: "hg19",
                                space_to_tab: true,
                                hashes: [],
                                in_place: false,
                                purge_source: true,
                                object_id: outputs[1]!.hda.id,
                            },
                            {
                                src: "pasted",
                                paste_content: "x\ty\n1\t2\n",
                                name: "pasted",
                                ext: "auto",
                                hashes: [],
                                purge_source: false,
                                object_id: outputs[2]!.hda.id,
                            },
                        ],
                    },
                ],
                auto_decompress: true,
                check_content: true,
            },
            files: {
                [reads.id]: { request: get(`uploads/${reads.id}`), size: 2048 },
                [table.id]: { request: get(`uploads/${table.id}`), size: 64 },
            },
        });
        expect(manifest.outputs.map((output) => [output.name, output.object_id, output.ext])).toEqual([
            ["output0", outputs[0]!.hda.id, "auto"],
            ["output1", outputs[1]!.hda.id, "auto"],
            ["output2", outputs[2]!.hda.id, "auto"],
        ]);
        expectTargets(manifest.outputs[0]!, outputs[0]!.dataset.uuid);
        expect(manifest.slots).toEqual([]);
        expect(manifest.job_files).toEqual({ results: put(`jobs/${job.id}/a1/results.json`) });
        expect(manifest.job).toMatchObject({ id: job.id, attempt: 1, walltime_seconds: 86400 });
    });

    it("keeps the object ids of precreated datasets and gives collection targets slots", async () => {
        const historyId = await newHistory();
        const first = await addOutput(historyId, { extension: "auto" });
        const job = await addJob(historyId, {
            tool_id: DATA_FETCH_TOOL_ID,
            request: {
                targets: [
                    {
                        destination: { type: "hdas" },
                        elements: [{ src: "url", url: "https://example.org/a.bed", object_id: first.hda.id }],
                    },
                    {
                        destination: { type: "hdca", object_id: "precreated" },
                        name: "pair",
                        collection_type: "list",
                        elements: [
                            { src: "pasted", paste_content: "a\n", name: "first" },
                            { src: "pasted", paste_content: "b\n", name: "second" },
                        ],
                    },
                    {
                        destination: { type: "hdas" },
                        elements_from: "archive",
                        src: "url",
                        url: "https://example.org/x.zip",
                    },
                ],
            },
            outputs: [{ name: "output0", src: "hda", id: first.hda.id }],
        });
        const deps = testDeps();
        const plan = await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(plan.manifestKey);
        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        const targets = manifest.upload!.request.targets as Record<string, unknown>[];
        expect(targets[0]!.elements).toEqual([
            {
                src: "url",
                url: "https://example.org/a.bed",
                object_id: first.hda.id,
                hashes: [],
                in_place: false,
                purge_source: false,
            },
        ]);
        expect(targets[1]!.destination).toEqual({ type: "hdca" });
        expect(manifest.slots).toHaveLength(2 + DEFAULT_SLOT_COUNT);
        expect(manifest.limits?.max_discovered_files).toBe(2 + DEFAULT_SLOT_COUNT);
    });

    it("decides on a multipart upload for each output from its own upload's size", async () => {
        const large = await addUpload({ name: "reads.bam", size: 5 * GIB });
        const small = await addUpload({ name: "notes.txt", size: 64 });
        const { job, outputs } = await uploadJob(
            [
                {
                    destination: { type: "hdas" },
                    elements: [
                        { src: "planet", file: large.id },
                        { src: "planet", file: small.id },
                        { src: "url", url: "https://example.org/a.bed" },
                    ],
                },
            ],
            {},
            3,
        );
        const deps = testDeps();
        const plan = await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(plan.manifestKey);
        expect(plan.multipart).toEqual([{ key: `datasets/${outputs[0]!.dataset.uuid}/data`, uploadId: "upload-1" }]);
        expect(manifest.outputs.map((output) => output.data?.multipart?.parts.length ?? 0)).toEqual([
            multipartLayout(5 * GIB).parts,
            0,
            0,
        ]);
        expect(manifest.limits?.start_timeout_seconds).toBeNull();
    });

    it("accepts requests the upload API already pointed at upload sessions", async () => {
        const reads = await addUpload({ name: "reads.fastq", size: 10 });
        const { job, outputs } = await uploadJob([{ destination: { type: "hdas" }, elements: [] }], {}, 1);
        const request = {
            targets: [
                {
                    destination: { type: "hdas" },
                    elements: [
                        {
                            src: "planet",
                            file: reads.id,
                            name: "reads.fastq",
                            ext: "fastqsanger",
                            in_place: false,
                            purge_source: true,
                            hashes: [],
                            object_id: outputs[0]!.hda.id,
                        },
                    ],
                },
            ],
            check_content: true,
        };
        const stored = await jobs.update(job.id, { request });
        const deps = testDeps();
        const manifest = deps.s3.json<Manifest>((await prepareDispatch(stored, deps)).manifestKey);
        expect(manifest.upload).toEqual({
            request,
            files: { [reads.id]: { request: get(`uploads/${reads.id}`), size: 10 } },
        });
    });

    it("waits for uploads in progress and refuses server-side sources", async () => {
        const pending = await addUpload({ name: "big.bam", size: 10, state: "uploading" });
        const { job } = await uploadJob(
            [{ destination: { type: "hdas" }, elements: [{ src: "files" }] }],
            { "files_0|file_data": { session_id: pending.id } },
            1,
        );
        await expect(prepareDispatch(job, testDeps())).rejects.toMatchObject({ permanent: false });

        const { job: local } = await uploadJob(
            [{ destination: { type: "hdas" }, elements: [{ src: "path", path: "/etc/passwd" }] }],
            {},
            1,
        );
        await expect(prepareDispatch(local, testDeps())).rejects.toMatchObject({ permanent: true });
    });
});

describe("prepareDispatch for a set-metadata job", () => {
    it("asks for the dataset's metadata to be detected and written back to its own keys", async () => {
        const historyId = await newHistory();
        const target = await addDataset(historyId, { name: "reads.bam", extension: "bam", _state: "setting_metadata" });
        const job = await addJob(historyId, {
            tool_id: SET_METADATA_TOOL_ID,
            tool_version: "1.0.1",
            params: { detect: true, __ORIGINAL_DATASET_STATE__: "ok" },
            inputs: [{ name: "input1", src: "hda", id: target.hda.id }],
        });
        const deps = testDeps();
        const plan = await prepareDispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(plan.manifestKey);
        dump("set_metadata", manifest);

        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(plan).toMatchObject({ kind: "set_metadata", toolImage: null });
        const uuid = target.dataset.uuid;
        expect(manifest.inputs![target.hda.id]).toMatchObject({ uuid, ext: "bam", data: get(`datasets/${uuid}/data`) });
        expect(manifest.outputs).toHaveLength(1);
        const [output] = manifest.outputs;
        expect(output).toMatchObject({ name: "input1", uuid, id: target.hda.id });
        expect(output!.data).toBeUndefined();
        expect(output!.extra).toBeUndefined();
        expect(output!.meta).toBe(put(`datasets/${uuid}/meta.json`));
        expect(output!.metadata_files).toHaveLength(METADATA_FILE_POOL);
        expect(manifest.set_metadata).toEqual({
            datasets: [{ input: target.hda.id, output: "input1", ext: null, detect: true, overwrite: false }],
        });
        expect(manifest.slots).toBeUndefined();
        expect(manifest.job_files).toEqual({ results: put(`jobs/${job.id}/a1/results.json`) });
    });

    it("rewrites the extra files of composite datasets", async () => {
        const historyId = await newHistory();
        const target = await addDataset(historyId, { extension: "velvet" });
        await datasets.update(target.dataset.id, {
            extra_files: {
                key: `datasets/${target.dataset.uuid}/extra.tar`,
                index_key: `datasets/${target.dataset.uuid}/extra.json`,
            },
        });
        const job = await addJob(historyId, {
            tool_id: SET_METADATA_TOOL_ID,
            params: { ext: "velvet", overwrite: true },
            inputs: [{ name: "input1", src: "hda", id: target.hda.id }],
        });
        const deps = testDeps();
        const manifest = deps.s3.json<Manifest>((await prepareDispatch(job, deps)).manifestKey);
        expect(schemaErrors(manifest, "manifest")).toEqual([]);
        expect(manifest.inputs![target.hda.id]!.extra).toBe(get(`datasets/${target.dataset.uuid}/extra.tar`));
        expectTargets(
            { ...manifest.outputs[0]!, data: { put: put(`datasets/${target.dataset.uuid}/data`) } },
            target.dataset.uuid,
            EXTRA_OBJECT_POOL,
        );
        expect(manifest.set_metadata!.datasets[0]).toMatchObject({ ext: "velvet", detect: false, overwrite: true });
    });
});
