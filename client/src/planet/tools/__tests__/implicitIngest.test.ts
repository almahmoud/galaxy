// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCollection, buildDce, collections, datasets, hdas, jobs, withTransaction } from "@/planet/db";

import { prepareDocument } from "../../jobs/__fixtures__/results";
import {
    addDataset,
    addJob,
    addOutput,
    addPendingCollection,
    datamashBundle,
    markDispatched,
    newHistory,
    resetDb,
    teardownDb,
    testDeps,
    withArchive,
} from "../../jobs/__fixtures__/setup";
import { readPrepare } from "../../jobs/ingest";
import { toolArchiveStaticPath } from "../../jobs/keys";
import { prepareDispatch } from "../../jobs/manifest";

beforeEach(resetDb);
afterEach(teardownDb);

describe("implicit collections at ingest", () => {
    it("settles the leaf of a mapped job whose collection output its stage-in filtered", async () => {
        const historyId = await newHistory();
        const input = await addDataset(historyId, { name: "scores.tsv" }, { file_size: 10, total_size: 10 });
        const out = await addOutput(historyId, { name: "datamash out_file", extension: "auto" });
        const parts = await addPendingCollection(historyId, "Parts");
        const bundle = datamashBundle();
        const job = await addJob(historyId, {
            tool_id: bundle.id,
            tool_version: bundle.version,
            params: { in_file: { src: "hda", id: input.hda.id } },
            outputs: [{ name: "out_file", src: "hda", id: out.hda.id }],
            output_collections: [{ name: "parts", src: "hdca", id: parts.id }],
            implicit_collection_jobs_id: "0123456789abcdef",
        });
        await hdas.update(out.hda.id, { creating_job_id: job.id });
        await datasets.update(out.dataset.id, { job_id: job.id });
        // The run's implicit collection holds the job's collection as one of its elements.
        const implicit = await withTransaction(["collections", "dces"], "readwrite", async (tx) => {
            const record = buildCollection({ collection_type: "list:list", populated_state: "ok" }, tx.now);
            await tx.store("collections").add(record);
            await tx.store("dces").add(
                buildDce({
                    collection_id: record.id,
                    element_index: 0,
                    element_identifier: "sample",
                    element_type: "dataset_collection",
                    child_collection_id: parts.collection_id,
                }),
            );
            return record;
        });
        const { bundle: archived, tar } = await withArchive(bundle);
        const deps = testDeps([archived], {}, { [toolArchiveStaticPath(archived.source!.repo_tar!.path)]: tar });
        const dispatched = await markDispatched(job.id, await prepareDispatch(await jobs.getOrThrow(job.id), deps));
        deps.s3.put(
            `jobs/${job.id}/a1/prepare.json`,
            prepareDocument(job.id, {
                outputs: {
                    out_file: { filtered: false, format: "tabular", label: "Datamash on data 1" },
                    parts: { filtered: true, format: null, label: "parts" },
                },
            }),
        );
        await readPrepare(dispatched, deps);

        expect(await collections.getHdca(parts.id)).toMatchObject({ deleted: true, visible: false });
        expect(await collections.getCollection(parts.collection_id)).toMatchObject({
            populated_state: "ok",
            element_count: 0,
        });
        expect(await collections.getCollection(implicit.id)).toMatchObject({ populated_state: "ok" });
    });

    it("leaves a filtered collection that no implicit collection holds as it was", async () => {
        const historyId = await newHistory();
        const parts = await addPendingCollection(historyId, "Parts");
        const input = await addDataset(historyId, { name: "scores.tsv" }, { file_size: 10, total_size: 10 });
        const bundle = datamashBundle();
        const job = await addJob(historyId, {
            tool_id: bundle.id,
            tool_version: bundle.version,
            params: { in_file: { src: "hda", id: input.hda.id } },
            output_collections: [{ name: "parts", src: "hdca", id: parts.id }],
        });
        const { bundle: archived, tar } = await withArchive(bundle);
        const deps = testDeps([archived], {}, { [toolArchiveStaticPath(archived.source!.repo_tar!.path)]: tar });
        const dispatched = await markDispatched(job.id, await prepareDispatch(await jobs.getOrThrow(job.id), deps));
        deps.s3.put(
            `jobs/${job.id}/a1/prepare.json`,
            prepareDocument(job.id, { outputs: { parts: { filtered: true, format: null, label: "parts" } } }),
        );
        await readPrepare(dispatched, deps);
        expect(await collections.getCollection(parts.collection_id)).toMatchObject({ populated_state: "new" });
    });
});
