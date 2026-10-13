// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, datasets, hdas, histories, type JobRecord, jobs } from "@/planet/db";

import { datasetResult, discoveredResult, prepareDocument, resultsDocument } from "./__fixtures__/results";
import {
    addDataset,
    addJob,
    addOutput,
    addPendingCollection,
    datamashBundle,
    markDispatched,
    newHistory,
    resetDb,
    schemaErrors,
    teardownDb,
    testDeps,
    withArchive,
} from "./__fixtures__/setup";
import {
    COMMAND_LINE_LIMIT,
    coreMetrics,
    FAILURE_MESSAGES,
    ingestFailure,
    ingestResults,
    JOB_MESSAGE_LIMIT,
    MAX_JOB_MESSAGES,
    PEEK_LIMIT,
    readPrepare,
    SHORT_TEXT_LIMIT,
    shrinkStream,
    STREAM_LIMIT,
} from "./ingest";
import { toolArchiveStaticPath } from "./keys";
import { DATA_FETCH_TOOL_ID, MAX_METADATA_VALUE_SIZE, prepareDispatch, SET_METADATA_TOOL_ID } from "./manifest";
import type { Manifest, ResultsDocument } from "./schemas";
import { ProtocolError } from "./schemas";

beforeEach(resetDb);
afterEach(teardownDb);

const GIB = 1024 ** 3;

/** A datamash job dispatched through `prepareDispatch`, with its manifest. */
async function dispatchedJob(options: { inputSize?: number; outputs?: string[]; collection?: boolean } = {}) {
    const historyId = await newHistory();
    const size = options.inputSize ?? 100;
    const input = await addDataset(historyId, { name: "scores.tsv" }, { file_size: size, total_size: size });
    const outputs = [];
    for (const name of options.outputs ?? ["out_file"]) {
        outputs.push({ name, ...(await addOutput(historyId, { name: `datamash ${name}`, extension: "auto" })) });
    }
    const split = options.collection ? await addPendingCollection(historyId, "Parts") : null;
    const bundle = datamashBundle();
    const job = await addJob(historyId, {
        tool_id: bundle.id,
        tool_version: bundle.version,
        params: { in_file: { src: "hda", id: input.hda.id } },
        outputs: outputs.map((output) => ({ name: output.name, src: "hda", id: output.hda.id })),
        output_collections: split ? [{ name: "parts", src: "hdca", id: split.id }] : [],
    });
    for (const output of outputs) {
        await hdas.update(output.hda.id, { creating_job_id: job.id });
        await datasets.update(output.dataset.id, { job_id: job.id });
    }
    const { bundle: archived, tar } = await withArchive(bundle);
    const deps = testDeps([archived], {}, { [toolArchiveStaticPath(archived.source!.repo_tar!.path)]: tar });
    const plan = await prepareDispatch(await jobs.getOrThrow(job.id), deps);
    const manifest = deps.s3.json<Manifest>(plan.manifestKey);
    return { historyId, input, outputs, split, job: await markDispatched(job.id, plan), deps, plan, manifest };
}

/** Dispatches a job through `prepareDispatch` and records the dispatch; returns the job. */
async function dispatch(job: JobRecord, deps: ReturnType<typeof testDeps>) {
    const plan = await prepareDispatch(job, deps);
    return { plan, job: await markDispatched(job.id, plan) };
}

function writeResults(deps: ReturnType<typeof testDeps>, results: ResultsDocument): void {
    const document = JSON.parse(JSON.stringify(results));
    expect(schemaErrors(document, "results")).toEqual([]);
    deps.s3.put(`jobs/${results.job_id}/a${results.attempt}/results.json`, document);
}

describe("readPrepare", () => {
    it("returns null until stage-in wrote prepare.json", async () => {
        const { job, deps } = await dispatchedJob();
        expect(await readPrepare(job, deps)).toBeNull();
    });

    it("applies labels, formats and the command line once", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        const prepare = prepareDocument(job.id);
        expect(schemaErrors(prepare, "prepare")).toEqual([]);
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, prepare);

        expect(await readPrepare(job, deps)).toEqual(prepare);
        const hda = await hdas.getOrThrow(outputs[0]!.hda.id);
        expect(hda).toMatchObject({ name: "Datamash on data 1", extension: "tsv" });
        expect((await jobs.getOrThrow(job.id)).command_line).toBe("datamash --sort -g 1 count 2");

        await hdas.update(hda.id, { name: "renamed by the user" });
        await readPrepare(await jobs.getOrThrow(job.id), deps);
        expect((await hdas.getOrThrow(hda.id)).name).toBe("renamed by the user");
    });

    it("removes filtered outputs as Galaxy never creates them", async () => {
        const { job, deps, outputs } = await dispatchedJob({ outputs: ["out_file", "log"] });
        deps.s3.put(
            `jobs/${job.id}/a1/prepare.json`,
            prepareDocument(job.id, {
                outputs: {
                    out_file: { filtered: false, format: "tabular", label: "Datamash on data 1" },
                    log: { filtered: true, format: "txt", label: "log" },
                },
            }),
        );
        await readPrepare(job, deps);
        const log = await hdas.getWithDatasetOrThrow(outputs[1]!.hda.id);
        expect(log.hda).toMatchObject({ deleted: true, purged: true, visible: false });
        expect(log.dataset).toMatchObject({ state: "discarded", purged: true });
        expect((await jobs.getOrThrow(job.id)).outputs.map((output) => output.name)).toEqual(["out_file"]);
    });

    it("returns a failed stage-in's document without applying it", async () => {
        const { job, deps } = await dispatchedJob();
        deps.s3.put(
            `jobs/${job.id}/a1/prepare.json`,
            prepareDocument(job.id, {
                state: "error",
                command_line: undefined,
                outputs: undefined,
                errors: [{ phase: "templating", message: "NameMapper.NotFound: cannot find 'x'" }],
            }),
        );
        expect(await readPrepare(job, deps)).toMatchObject({ state: "error" });
        expect((await jobs.getOrThrow(job.id)).command_line).toBeNull();
    });

    it("ignores documents of other attempts and rejects malformed ones", async () => {
        const { job, deps } = await dispatchedJob();
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, prepareDocument(job.id, { attempt: 7 }));
        expect(await readPrepare(job, deps)).toBeNull();
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, { ...prepareDocument(job.id), errors: "none" });
        await expect(readPrepare(job, deps)).rejects.toThrow(ProtocolError);
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, "{not json");
        await expect(readPrepare(job, deps)).rejects.toThrow(ProtocolError);
    });
});

describe("ingestResults", () => {
    it("returns null until the pod committed results", async () => {
        const { job, deps } = await dispatchedJob();
        expect(await ingestResults(job, deps)).toBeNull();
    });

    it("records outputs, discovered datasets, the output collection and the job", async () => {
        const { job, deps, outputs, manifest, split, historyId } = await dispatchedJob({ collection: true });
        const output = outputs[0]!;
        const copyHistory = await newHistory();
        const copy = await hdas.copy(output.hda.id, copyHistory);
        const [slot0, slot1, slot2] = manifest.slots!.map((slot) => slot.uuid);
        const counterBefore = (await histories.getOrThrow(historyId)).hid_counter;
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, prepareDocument(job.id));
        writeResults(
            deps,
            resultsDocument(job.id, {
                tool_stdout: { text: "sorted\n", size: 7 },
                tool_stderr: { text: "warning: header\n", size: 16 },
                job_messages: [{ type: "regex", desc: "Warning: header", code_desc: null, error_level: 2 }],
                outputs: {
                    out_file: datasetResult(output.dataset.uuid, {
                        ext: "tabular",
                        metadata_files: { bam_index: { index: 2, size: 96 } },
                        extra_files: { size: 10, entries: [{ path: "a.txt", type: "file", offset: 512, size: 10 }] },
                        total_size: 18,
                        created_from_basename: "scores.tsv",
                        info: "sorted",
                    }),
                },
                discovered: [
                    discoveredResult(slot1!, 1, {
                        name: "b",
                        visible: false,
                        collection: "parts",
                        element_identifiers: ["b"],
                    }),
                    discoveredResult(slot0!, 0, {
                        name: "a",
                        visible: false,
                        collection: "parts",
                        element_identifiers: ["a"],
                    }),
                    discoveredResult(slot2!, 2, {
                        name: "report",
                        ext: "html",
                        output: "out_file",
                        designation: "report",
                        state: "failed_metadata",
                    }),
                ],
                output_collections: {
                    parts: {
                        name: "Parts",
                        collection_type: "list",
                        populated_state: "ok",
                        elements: [
                            { element_identifier: "a", slot: 0 },
                            { element_identifier: "b", slot: 1 },
                        ],
                    },
                },
            }),
        );

        const outcome = await ingestResults(job, deps);

        const finished = await jobs.getOrThrow(job.id);
        expect(finished).toMatchObject({
            state: "ok",
            exit_code: 0,
            command_line: resultsDocument(job.id).command_line,
            command_version: "datamash (GNU datamash) 1.9",
            tool_stdout: "sorted\n",
            tool_stderr: "warning: header\n",
            job_stdout: "",
            job_stderr: "",
            job_messages: [{ type: "regex", desc: "Warning: header", code_desc: null, error_level: 2 }],
        });
        expect(finished.metrics.map((metric) => [metric.name, metric.raw_value])).toEqual([
            ["galaxy_slots", "1"],
            ["galaxy_memory_mb", "4096"],
            ["start_epoch", String(Date.UTC(2026, 9, 13, 10) / 1000)],
            ["end_epoch", String(Date.UTC(2026, 9, 13, 10, 2, 5) / 1000)],
            ["runtime_seconds", "125"],
        ]);

        const declared = await hdas.getWithDatasetOrThrow(output.hda.id);
        const uuid = output.dataset.uuid;
        expect(declared.dataset).toMatchObject({
            state: "ok",
            file_size: 8,
            total_size: 18,
            metadata_files: { bam_index: { key: `datasets/${uuid}/meta/2`, file_size: 96 } },
            extra_files: { key: `datasets/${uuid}/extra.tar`, index_key: `datasets/${uuid}/extra.json` },
            created_from_basename: "scores.tsv",
        });
        expect(declared.hda).toMatchObject({
            name: "Datamash on data 1",
            extension: "tabular",
            info: "sorted",
            blurb: "2 lines",
            peek: "a\t2\nb\t5\n",
            metadata: { columns: 2, column_types: ["str", "int"], data_lines: 2 },
            _state: null,
            visible: true,
        });
        expect(await hdas.getOrThrow(copy.id)).toMatchObject({
            extension: "tabular",
            peek: "a\t2\nb\t5\n",
            name: copy.name,
        });

        const created = finished.outputs.slice(1);
        expect(created.map((item) => item.name)).toEqual([
            "__new_primary_file_parts|a__",
            "__new_primary_file_parts|b__",
            "__new_primary_file_out_file|report__",
        ]);
        const report = await hdas.getWithDatasetOrThrow(created[2]!.id);
        expect(report.hda).toMatchObject({
            name: "report",
            extension: "html",
            hid: counterBefore + 2,
            creating_job_id: job.id,
            _state: "failed_metadata",
        });
        expect(report.dataset).toMatchObject({ uuid: slot2, state: "ok", job_id: job.id });

        const collection = await collections.getHdcaWithCollection(split!.id);
        expect(collection!.collection).toMatchObject({ populated_state: "ok", element_count: 2 });
        const elements = await collections.elements(collection!.collection.id);
        expect(elements.map((element) => element.element_identifier)).toEqual(["a", "b"]);
        const a = await hdas.getWithDatasetOrThrow(elements[0]!.hda_id!);
        expect(a.hda).toMatchObject({ name: "a", visible: false, hid: counterBefore });
        expect(a.dataset.uuid).toBe(slot0);
        expect((await hdas.getOrThrow(elements[1]!.hda_id!)).hid).toBe(counterBefore + 1);

        expect(outcome).toEqual({
            state: "ok",
            datasetIds: [output.dataset.id, a.dataset.id, expect.any(String), report.dataset.id],
            hdaIds: [output.hda.id, a.hda.id, elements[1]!.hda_id, report.hda.id],
        });
    });

    it("is idempotent", async () => {
        const { job, deps, outputs, manifest, historyId } = await dispatchedJob();
        writeResults(
            deps,
            resultsDocument(job.id, {
                outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) },
                discovered: [discoveredResult(manifest.slots![0]!.uuid, 0, { output: "out_file", designation: "x" })],
            }),
        );
        const first = await ingestResults(job, deps);
        const counter = (await histories.getOrThrow(historyId)).hid_counter;
        const second = await ingestResults(await jobs.getOrThrow(job.id), deps);
        expect(second).toEqual(first);
        expect((await histories.getOrThrow(historyId)).hid_counter).toBe(counter);
        expect((await jobs.getOrThrow(job.id)).outputs).toHaveLength(2);
    });

    it("only accepts discovered datasets in the slots it gave the pod", async () => {
        const { job, deps, outputs, historyId } = await dispatchedJob();
        const other = await addDataset(historyId, { name: "someone else's" });
        const counter = (await histories.getOrThrow(historyId)).hid_counter;
        writeResults(
            deps,
            resultsDocument(job.id, {
                outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) },
                discovered: [
                    discoveredResult(other.dataset.uuid, 0, { output: "out_file", designation: "x", ext: "html" }),
                    discoveredResult("6f1c5a9e-2b7d-4c3a-9e1f-0a2b3c4d5e6f", 40, {
                        output: "out_file",
                        designation: "y",
                    }),
                ],
            }),
        );
        const outcome = await ingestResults(job, deps);
        expect(outcome!.datasetIds).toEqual([outputs[0]!.dataset.id]);
        expect((await hdas.getOrThrow(other.hda.id)).extension).toBe("tabular");
        expect((await histories.getOrThrow(historyId)).hid_counter).toBe(counter);
    });

    it("fails an output whose record names another dataset", async () => {
        const { job, deps, outputs, manifest } = await dispatchedJob();
        writeResults(deps, resultsDocument(job.id, { outputs: { out_file: datasetResult(manifest.slots![0]!.uuid) } }));
        expect((await ingestResults(job, deps))!.state).toBe("error");
        expect(await hdas.getOrThrow(outputs[0]!.hda.id)).toMatchObject({
            blurb: "tool error",
            info: "The job's pod reported another dataset for this output.",
        });
    });

    it("keeps datasets whose metadata failed and empty datasets usable", async () => {
        const { job, deps, outputs } = await dispatchedJob({ outputs: ["out_file", "log"] });
        writeResults(
            deps,
            resultsDocument(job.id, {
                outputs: {
                    out_file: datasetResult(outputs[0]!.dataset.uuid, { state: "failed_metadata" }),
                    log: datasetResult(outputs[1]!.dataset.uuid, {
                        state: "empty",
                        size: 0,
                        total_size: 0,
                        blurb: "empty",
                    }),
                },
            }),
        );
        expect((await ingestResults(job, deps))!.state).toBe("ok");
        const failed = await hdas.getWithDatasetOrThrow(outputs[0]!.hda.id);
        expect(failed.dataset.state).toBe("ok");
        expect(failed.state).toBe("failed_metadata");
        const empty = await hdas.getWithDatasetOrThrow(outputs[1]!.hda.id);
        expect(empty.state).toBe("ok");
        expect(empty.dataset.file_size).toBe(0);
    });

    it("records a tool error like Galaxy's job finishing", async () => {
        const { job, deps, outputs } = await dispatchedJob({ outputs: ["out_file", "missing"] });
        await hdas.update(outputs[0]!.hda.id, { visible: false });
        writeResults(
            deps,
            resultsDocument(job.id, {
                state: "error",
                exit_code: 1,
                tool_stderr: { text: "datamash: invalid field\n", size: 24 },
                job_messages: [
                    { type: "exit_code", desc: "Fatal error: Exit code 1 ()", code_desc: "", error_level: 3 },
                ],
                outputs: {
                    out_file: datasetResult(outputs[0]!.dataset.uuid, {
                        state: "error",
                        ext: "auto",
                        blurb: "error",
                        info: "datamash: invalid field",
                        peek: null,
                    }),
                },
            }),
        );
        const outcome = await ingestResults(job, deps);
        expect(outcome!.state).toBe("error");
        const failed = await hdas.getWithDatasetOrThrow(outputs[0]!.hda.id);
        expect(failed.dataset.state).toBe("error");
        expect(failed.hda).toMatchObject({
            extension: "data",
            blurb: "error",
            visible: true,
            info: "datamash: invalid field",
        });
        const missing = await hdas.getWithDatasetOrThrow(outputs[1]!.hda.id);
        expect(missing.dataset.state).toBe("error");
        expect(missing.hda).toMatchObject({
            blurb: "tool error",
            info: "Fatal error: Exit code 1 ()",
            extension: "data",
        });
        expect(await jobs.getOrThrow(job.id)).toMatchObject({
            state: "error",
            exit_code: 1,
            tool_stderr: "datamash: invalid field\n",
        });
    });

    it("completes multipart uploads from the reported ETags and aborts unused ones", async () => {
        const { job, deps, outputs, plan } = await dispatchedJob({ inputSize: 5 * GIB, outputs: ["out_file", "log"] });
        expect(plan.multipart).toHaveLength(2);
        const [big, small] = outputs;
        const first = deps.s3.uploadPartAsPod("upload-1", 1, "part one ");
        deps.s3.uploadPartAsPod("upload-1", 2, "part two");
        writeResults(
            deps,
            resultsDocument(job.id, {
                outputs: {
                    out_file: datasetResult(big!.dataset.uuid, {
                        size: 17,
                        total_size: 17,
                        data: {
                            mode: "multipart",
                            size: 17,
                            part_size: 9,
                            parts: [
                                { part_number: 2, etag: null, size: 8 },
                                { part_number: 1, etag: first, size: 9 },
                            ],
                        },
                    }),
                    log: datasetResult(small!.dataset.uuid),
                },
            }),
        );
        expect((await ingestResults(job, deps))!.state).toBe("ok");
        expect(new TextDecoder().decode(deps.s3.objects.get(`datasets/${big!.dataset.uuid}/data`))).toBe(
            "part one part two",
        );
        expect(deps.s3.completed).toEqual(["upload-1"]);
        expect(deps.s3.aborted).toEqual(["upload-2"]);
    });

    it("fails an output whose multipart upload cannot be completed", async () => {
        const { job, deps, outputs } = await dispatchedJob({ inputSize: 5 * GIB });
        writeResults(
            deps,
            resultsDocument(job.id, {
                outputs: {
                    out_file: datasetResult(outputs[0]!.dataset.uuid, {
                        data: { mode: "multipart", size: 9, parts: [{ part_number: 1, etag: '"wrong"', size: 9 }] },
                    }),
                },
            }),
        );
        expect((await ingestResults(job, deps))!.state).toBe("error");
        const failed = await hdas.getWithDatasetOrThrow(outputs[0]!.hda.id);
        expect(failed.dataset.state).toBe("error");
        expect(failed.hda.info).toMatch(/^The dataset's data could not be stored/);
    });

    it("ignores results of another attempt and of another job", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        writeResults(
            deps,
            resultsDocument(job.id, { attempt: 3, outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) } }),
        );
        expect(await ingestResults(job, deps)).toBeNull();
        deps.s3.put(`jobs/${job.id}/a1/results.json`, resultsDocument("0123456789abcdef"));
        await expect(ingestResults(job, deps)).rejects.toThrow(/belongs to job/);
        deps.s3.put(`jobs/${job.id}/a1/results.json`, { ...resultsDocument(job.id), state: "finished" });
        await expect(ingestResults(job, deps)).rejects.toThrow(ProtocolError);
    });

    it("leaves settled jobs alone", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        await jobs.update(job.id, { state: "deleting" });
        writeResults(deps, resultsDocument(job.id, { outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) } }));
        expect(await ingestResults(job, deps)).toEqual({
            state: "error",
            datasetIds: [outputs[0]!.dataset.id],
            hdaIds: [outputs[0]!.hda.id],
        });
        expect((await datasets.get(outputs[0]!.dataset.id))!.state).toBe("new");
    });

    it("records the metadata of a set-metadata job", async () => {
        const historyId = await newHistory();
        const target = await addDataset(historyId, { extension: "data", _state: "setting_metadata", info: "uploaded" });
        const job = await addJob(historyId, {
            tool_id: SET_METADATA_TOOL_ID,
            params: { detect: true },
            inputs: [{ name: "input1", src: "hda", id: target.hda.id }],
        });
        const deps = testDeps();
        const { job: dispatched } = await dispatch(job, deps);
        writeResults(
            deps,
            resultsDocument(job.id, {
                kind: "set_metadata",
                exit_code: null,
                outputs: {
                    input1: datasetResult(target.dataset.uuid, {
                        ext: "bam",
                        metadata: { reference_names: ["chr1"] },
                        metadata_files: { bam_index: { index: 0, size: 96 } },
                        peek: "Binary bam alignments file",
                        blurb: "binary bam alignments file",
                        data: undefined,
                    }),
                },
            }),
        );
        expect(await ingestResults(dispatched, deps)).toEqual({
            state: "ok",
            datasetIds: [target.dataset.id],
            hdaIds: [target.hda.id],
        });
        const updated = await hdas.getWithDatasetOrThrow(target.hda.id);
        expect(updated.hda).toMatchObject({
            extension: "bam",
            metadata: { reference_names: ["chr1"] },
            peek: "Binary bam alignments file",
            _state: null,
            info: "uploaded",
        });
        expect(updated.dataset.metadata_files).toEqual({
            bam_index: { key: `datasets/${target.dataset.uuid}/meta/0`, file_size: 96 },
        });
    });

    it("marks datasets whose metadata could not be set", async () => {
        const historyId = await newHistory();
        const target = await addDataset(historyId, { _state: "setting_metadata" });
        const job = await addJob(historyId, {
            tool_id: SET_METADATA_TOOL_ID,
            inputs: [{ name: "input1", src: "hda", id: target.hda.id }],
        });
        const deps = testDeps();
        const { job: dispatched } = await dispatch(job, deps);
        writeResults(
            deps,
            resultsDocument(job.id, {
                kind: "set_metadata",
                outputs: { input1: datasetResult(target.dataset.uuid, { state: "failed_metadata" }) },
            }),
        );
        await ingestResults(dispatched, deps);
        expect((await hdas.getWithDatasetOrThrow(target.hda.id)).state).toBe("failed_metadata");
    });

    it("fills upload outputs and collection targets", async () => {
        const historyId = await newHistory();
        const upload = await addOutput(historyId, { name: "a.bed", extension: "auto" }, { state: "queued" });
        const pair = await addPendingCollection(historyId, "pair");
        const job = await addJob(historyId, {
            tool_id: DATA_FETCH_TOOL_ID,
            request: {
                targets: [
                    { destination: { type: "hdas" }, elements: [{ src: "pasted", paste_content: "chr1\t1\t2\n" }] },
                    {
                        destination: { type: "hdca" },
                        name: "pair",
                        collection_type: "list",
                        elements: [
                            { src: "pasted", paste_content: "a\n", name: "first" },
                            { src: "pasted", paste_content: "b\n", name: "second" },
                        ],
                    },
                ],
            },
            outputs: [{ name: "output0", src: "hda", id: upload.hda.id }],
            output_collections: [{ name: "output1", src: "hdca", id: pair.id }],
        });
        const deps = testDeps();
        const { plan, job: dispatched } = await dispatch(job, deps);
        const manifest = deps.s3.json<Manifest>(plan.manifestKey);
        const [first, second] = manifest.slots!.map((slot) => slot.uuid);
        writeResults(
            deps,
            resultsDocument(job.id, {
                kind: "upload",
                exit_code: null,
                command_line: null,
                command_version: null,
                outputs: {
                    output0: datasetResult(upload.dataset.uuid, {
                        name: "a.bed",
                        ext: "bed",
                        info: "uploaded bed file",
                    }),
                },
                discovered: [
                    discoveredResult(first!, 0, { name: "first", ext: "txt", visible: false }),
                    discoveredResult(second!, 1, { name: "second", ext: "txt", visible: false }),
                ],
                output_collections: {
                    pair: {
                        name: "pair",
                        collection_type: "list",
                        populated_state: "ok",
                        elements: [
                            { element_identifier: "first", slot: 0 },
                            { element_identifier: "second", slot: 1 },
                        ],
                    },
                },
            }),
        );
        await ingestResults(dispatched, deps);
        const bed = await hdas.getWithDatasetOrThrow(upload.hda.id);
        expect(bed.hda).toMatchObject({ name: "a.bed", extension: "bed", info: "uploaded bed file" });
        expect(bed.dataset.state).toBe("ok");
        const collection = await collections.getHdcaWithCollection(pair.id);
        const elements = await collections.elements(collection!.collection.id);
        expect(elements.map((element) => element.element_identifier)).toEqual(["first", "second"]);
        expect(collection!.collection.populated_state).toBe("ok");
    });
});

describe("ingestResults across attempts and layouts", () => {
    it("refuses results of an attempt whose dispatch record is missing", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        deps.s3.objects.delete(`jobs/${job.id}/a1/dispatch.json`);
        expect(await ingestResults(job, deps)).toBeNull();
        writeResults(deps, resultsDocument(job.id, { outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) } }));
        await expect(ingestResults(job, deps)).rejects.toThrow("dispatch.json is invalid");
        expect((await jobs.getOrThrow(job.id)).state).toBe("queued");
    });

    it("ignores jobs that were never dispatched", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        writeResults(deps, resultsDocument(job.id, { outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) } }));
        expect(await ingestResults({ ...job, k8s: null }, deps)).toBeNull();
    });

    it("reads the objects of jobs dispatched before attempts had their own keys", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        const record = deps.s3.json<Record<string, unknown>>(`jobs/${job.id}/a1/dispatch.json`);
        delete record.dispatch_id;
        deps.s3.objects.delete(`jobs/${job.id}/a1/dispatch.json`);
        deps.s3.put(`jobs/${job.id}/dispatch.json`, record);
        deps.s3.put(`jobs/${job.id}/prepare.json`, prepareDocument(job.id));
        deps.s3.put(
            `jobs/${job.id}/results.json`,
            resultsDocument(job.id, { outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) } }),
        );
        expect((await ingestResults(job, deps))!.state).toBe("ok");
        expect(await hdas.getOrThrow(outputs[0]!.hda.id)).toMatchObject({
            name: "Datamash on data 1",
            extension: "tabular",
        });
    });

    it("rejects dataset UUIDs that are not UUIDs before building keys from them", async () => {
        const { job, deps } = await dispatchedJob();
        deps.s3.put(
            `jobs/${job.id}/a1/results.json`,
            resultsDocument(job.id, { outputs: { out_file: datasetResult("../../tools/x") } }),
        );
        await expect(ingestResults(job, deps)).rejects.toThrow("results.json is invalid at /outputs/out_file/uuid");
    });
});

describe("ingestResults of OOM-killed tools", () => {
    it("fails the job with Galaxy's memory message when the tool container was OOM-killed", async () => {
        const { job, deps, outputs, plan, manifest } = await dispatchedJob();
        const killed = await markDispatched(job.id, plan, { reason: "OOMKilled", exit_code: 137, message: null });
        writeResults(
            deps,
            resultsDocument(job.id, {
                state: "error",
                exit_code: null,
                termination: "signal",
                tool_stderr: { text: "Killed\n", size: 7 },
                job_messages: [{ type: "internal", desc: "The tool was killed.", code_desc: null, error_level: 3 }],
                outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) },
                discovered: [discoveredResult(manifest.slots![0]!.uuid, 0, { output: "out_file", designation: "x" })],
            }),
        );
        expect(await ingestResults(killed, deps)).toEqual({
            state: "error",
            datasetIds: [outputs[0]!.dataset.id],
            hdaIds: [outputs[0]!.hda.id],
        });
        const stored = await jobs.getOrThrow(job.id);
        expect(stored).toMatchObject({ state: "error", info: FAILURE_MESSAGES.oom, tool_stderr: "Killed\n" });
        expect(stored.outputs).toHaveLength(1);
        expect(stored.job_messages.at(-1)).toEqual({
            type: "internal",
            desc: FAILURE_MESSAGES.oom,
            code_desc: null,
            error_level: 4,
        });
        const output = await hdas.getWithDatasetOrThrow(outputs[0]!.hda.id);
        expect(output.dataset.state).toBe("error");
        expect(output.hda).toMatchObject({ blurb: "tool error", info: FAILURE_MESSAGES.oom, extension: "data" });
    });

    it("keeps a signal without an OOM kill as the pod reported it", async () => {
        const { job, deps, outputs, plan } = await dispatchedJob();
        const killed = await markDispatched(job.id, plan, { reason: "Error", exit_code: 137, message: null });
        writeResults(
            deps,
            resultsDocument(job.id, {
                state: "error",
                termination: "signal",
                job_messages: [{ type: "internal", desc: "The tool was killed.", code_desc: null, error_level: 3 }],
            }),
        );
        await ingestResults(killed, deps);
        expect((await hdas.getOrThrow(outputs[0]!.hda.id)).info).toBe("The tool was killed.");
    });
});

describe("filtered output collections", () => {
    it("deletes and hides a collection prepare.json filtered, with the outputs of its elements", async () => {
        const { job, deps, outputs, split } = await dispatchedJob({
            outputs: ["out_file", "parts|__part__|a"],
            collection: true,
        });
        deps.s3.put(
            `jobs/${job.id}/a1/prepare.json`,
            prepareDocument(job.id, {
                outputs: {
                    out_file: { filtered: false, format: "tabular", label: "Datamash on data 1" },
                    parts: { filtered: true, format: null, label: "parts" },
                },
            }),
        );
        await readPrepare(job, deps);
        expect(await collections.getHdca(split!.id)).toMatchObject({ deleted: true, visible: false });
        expect(await hdas.getOrThrow(outputs[1]!.hda.id)).toMatchObject({
            deleted: true,
            purged: true,
            visible: false,
        });
        const prepared = await jobs.getOrThrow(job.id);
        expect(prepared.outputs.map((output) => output.name)).toEqual(["out_file"]);
        expect(prepared.output_collections).toEqual([]);

        writeResults(deps, resultsDocument(job.id, { outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) } }));
        expect((await ingestResults(prepared, deps))!.state).toBe("ok");
    });

    it("applies collections the pod filtered after the tool ran", async () => {
        const { job, deps, outputs, split } = await dispatchedJob({
            outputs: ["out_file", "parts|__part__|a"],
            collection: true,
        });
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, prepareDocument(job.id));
        writeResults(
            deps,
            resultsDocument(job.id, {
                filtered_outputs: ["parts"],
                outputs: { out_file: datasetResult(outputs[0]!.dataset.uuid) },
            }),
        );
        expect((await ingestResults(job, deps))!.state).toBe("ok");
        expect(await collections.getHdca(split!.id)).toMatchObject({ deleted: true, visible: false });
        expect((await hdas.getWithDatasetOrThrow(outputs[1]!.hda.id)).dataset.state).toBe("discarded");
        expect((await jobs.getOrThrow(job.id)).output_collections).toEqual([]);
    });
});

describe("limits on what pods write", () => {
    const SIGNED =
        "https://acct.r2.cloudflarestorage.com/bucket/planet/datasets/x/data?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAEXAMPLE%2F20261013%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=" +
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    it("caps peeks, metadata values, names, messages and command lines and removes signed URLs", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        writeResults(
            deps,
            resultsDocument(job.id, {
                command_line: `curl '${SIGNED}' ${"x".repeat(COMMAND_LINE_LIMIT)}`,
                tool_stdout: { text: `downloading ${SIGNED}\n`, size: 300 },
                job_messages: Array.from({ length: MAX_JOB_MESSAGES + 20 }, () => ({
                    type: "regex",
                    desc: "d".repeat(JOB_MESSAGE_LIMIT * 2),
                    code_desc: null,
                    error_level: 2,
                })),
                outputs: {
                    out_file: datasetResult(outputs[0]!.dataset.uuid, {
                        peek: "p".repeat(PEEK_LIMIT + 10),
                        info: `fetched ${SIGNED} ${"i".repeat(400)}`,
                        blurb: "b".repeat(400),
                        metadata: { columns: 2, huge: "m".repeat(MAX_METADATA_VALUE_SIZE + 1) },
                    }),
                },
            }),
        );
        await ingestResults(job, deps);
        const stored = await jobs.getOrThrow(job.id);
        expect(stored.command_line!.length).toBeLessThanOrEqual(COMMAND_LINE_LIMIT);
        expect(stored.command_line).toContain("datasets/x/data?[redacted]'");
        expect(stored.command_line).not.toContain("AKIAEXAMPLE");
        expect(stored.tool_stdout).toBe(
            "downloading https://acct.r2.cloudflarestorage.com/bucket/planet/datasets/x/data?[redacted]\n",
        );
        expect(stored.job_messages).toHaveLength(MAX_JOB_MESSAGES);
        expect((stored.job_messages[0] as { desc: string }).desc).toHaveLength(JOB_MESSAGE_LIMIT);
        const hda = await hdas.getOrThrow(outputs[0]!.hda.id);
        expect(hda.peek).toHaveLength(PEEK_LIMIT);
        expect(hda.info).toHaveLength(SHORT_TEXT_LIMIT);
        expect(hda.info).not.toContain("0123456789abcdef");
        expect(hda.blurb).toHaveLength(SHORT_TEXT_LIMIT);
        expect(hda.metadata).toEqual({ columns: 2 });
    });

    it("removes signed URLs from the logs and messages of failed pods", async () => {
        const { job, deps } = await dispatchedJob();
        await ingestFailure(
            job,
            {
                reason: "stage_in",
                message: `Preparing the job failed: GET ${SIGNED} returned 403`,
                toolStdout: `fetching ${SIGNED}\n`,
                detail: `stage-in: Error: ${SIGNED}`,
            },
            deps,
        );
        const stored = await jobs.getOrThrow(job.id);
        expect(JSON.stringify(stored)).not.toContain("0123456789abcdef0123456789abcdef");
        expect(stored.info).toContain("[redacted]");
        expect(stored.tool_stdout).toContain("[redacted]");
    });
});

describe("ingestFailure", () => {
    it("fails the job and its outputs as Galaxy's JobWrapper.fail does", async () => {
        const { job, deps, outputs, plan } = await dispatchedJob({ inputSize: 5 * GIB });
        expect(plan.multipart).toHaveLength(1);
        const log = "x".repeat(STREAM_LIMIT + 100);
        await ingestFailure(
            job,
            {
                reason: "oom",
                message: FAILURE_MESSAGES.oom,
                toolStdout: log,
                detail: "tool: OOMKilled (exit code 137)",
            },
            deps,
        );
        const failed = await jobs.getOrThrow(job.id);
        expect(failed).toMatchObject({
            state: "error",
            info: "Tool failed due to insufficient memory. Try with more memory.",
            tool_stderr: "",
            job_stderr:
                "Tool failed due to insufficient memory. Try with more memory.\ntool: OOMKilled (exit code 137)",
            job_messages: [
                {
                    type: "internal",
                    desc: "Tool failed due to insufficient memory. Try with more memory.",
                    code_desc: null,
                    error_level: 4,
                },
            ],
        });
        expect(failed.tool_stdout).toHaveLength(STREAM_LIMIT);
        const output = await hdas.getWithDatasetOrThrow(outputs[0]!.hda.id);
        expect(output.dataset.state).toBe("error");
        expect(output.hda).toMatchObject({
            blurb: "tool error",
            info: "Tool failed due to insufficient memory. Try with more memory.",
            visible: true,
            extension: "data",
        });
        expect(deps.s3.aborted).toEqual(["upload-1"]);
    });

    it("uses the reason's message when none is given and keeps stage-in errors", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        deps.s3.put(
            `jobs/${job.id}/a1/prepare.json`,
            prepareDocument(job.id, {
                state: "error",
                command_line: undefined,
                outputs: undefined,
                errors: [{ phase: "templating", message: "NameMapper.NotFound: cannot find 'x'" }],
            }),
        );
        await ingestFailure(job, { reason: "stage_in", message: "" }, deps);
        const failed = await jobs.getOrThrow(job.id);
        expect(failed.info).toBe(FAILURE_MESSAGES.stage_in);
        expect(failed.job_stderr).toBe(
            `${FAILURE_MESSAGES.stage_in}\ntemplating: NameMapper.NotFound: cannot find 'x'`,
        );
        expect((await hdas.getOrThrow(outputs[0]!.hda.id)).info).toBe(FAILURE_MESSAGES.stage_in);
    });

    it("applies the decisions of prepare.json before failing the outputs", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        deps.s3.put(`jobs/${job.id}/a1/prepare.json`, prepareDocument(job.id));
        await ingestFailure(job, { reason: "walltime", message: FAILURE_MESSAGES.walltime }, deps);
        expect(await hdas.getOrThrow(outputs[0]!.hda.id)).toMatchObject({
            name: "Datamash on data 1",
            blurb: "tool error",
        });
        expect((await jobs.getOrThrow(job.id)).command_line).toBe("datamash --sort -g 1 count 2");
    });

    it("fails jobs that never reached the cluster", async () => {
        const historyId = await newHistory();
        const output = await addOutput(historyId);
        const job = await addJob(historyId, {
            tool_id: "cat1",
            state: "new",
            outputs: [{ name: "out_file1", src: "hda", id: output.hda.id }],
        });
        await ingestFailure(
            job,
            { reason: "rejected", message: "The job could not be submitted to the cluster." },
            testDeps(),
        );
        expect((await jobs.getOrThrow(job.id)).state).toBe("error");
        expect((await hdas.getWithDatasetOrThrow(output.hda.id)).state).toBe("error");
    });

    it("marks the datasets of a failed set-metadata job", async () => {
        const historyId = await newHistory();
        const target = await addDataset(historyId, { _state: "setting_metadata" });
        const job = await addJob(historyId, {
            tool_id: SET_METADATA_TOOL_ID,
            inputs: [{ name: "input1", src: "hda", id: target.hda.id }],
        });
        await ingestFailure(job, { reason: "evicted", message: "" }, testDeps());
        const failed = await hdas.getWithDatasetOrThrow(target.hda.id);
        expect(failed.state).toBe("failed_metadata");
        expect(failed.dataset.state).toBe("ok");
        expect((await jobs.getOrThrow(job.id)).info).toBe(FAILURE_MESSAGES.evicted);
    });

    it("leaves settled and cancelled jobs alone", async () => {
        const { job, deps, outputs } = await dispatchedJob();
        await jobs.update(job.id, { state: "ok" });
        await ingestFailure(job, { reason: "unknown", message: "late" }, deps);
        expect((await jobs.getOrThrow(job.id)).info).toBeNull();
        await jobs.update(job.id, { state: "deleting" });
        await ingestFailure(job, { reason: "deleted", message: "" }, deps);
        expect((await hdas.getWithDatasetOrThrow(outputs[0]!.hda.id)).state).toBe("new");
    });
});

describe("shrinkStream", () => {
    it("keeps short streams and shortens long ones in the middle like Galaxy", () => {
        expect(shrinkStream(null)).toBe("");
        expect(shrinkStream("ok\n")).toBe("ok\n");
        const text = `${"a".repeat(30)}${"b".repeat(30)}`;
        const shrunk = shrinkStream(text, 21);
        expect(shrunk).toBe(`${"a".repeat(9)}\n..\n${"b".repeat(8)}`);
        expect(shrunk).toHaveLength(21);
        expect(shrinkStream(text, 20)).toBe(`${"a".repeat(8)}\n..\n${"b".repeat(8)}`);
    });
});

describe("coreMetrics", () => {
    it("formats Galaxy's core metrics", () => {
        const metrics = coreMetrics(
            resultsDocument("0123456789abcdef", {
                timings: { tool_start: "2026-10-13T10:00:00.000000", tool_end: "2026-10-13T11:05:00.000000" },
            }),
            null,
        );
        expect(metrics.map((metric) => [metric.title, metric.value])).toEqual([
            ["Job Start Time", expect.stringMatching(/^2026-10-1[234] \d{2}:\d{2}:00$/)],
            ["Job End Time", expect.stringMatching(/^2026-10-1[234] \d{2}:\d{2}:00$/)],
            ["Job Runtime (Wall Clock)", "1 hour and 5 minutes"],
        ]);
        expect(metrics.every((metric) => metric.plugin === "core")).toBe(true);
    });
});
