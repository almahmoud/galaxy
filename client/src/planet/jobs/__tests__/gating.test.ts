// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, datasets, hdas, JOB_STORES, jobs, outbox, readTx, writeTx } from "@/planet/db";

import {
    checkInputs,
    DEPENDENT_PAUSE_MESSAGE,
    GATING_READ_STORES,
    PAUSE_SUFFIX,
    pauseDependents,
    pauseJob,
} from "../gating";
import { hdaState, resetDb, seedHistory, seedJob } from "./fakes";

beforeEach(resetDb);
afterEach(resetDb);

async function readiness(jobId: string) {
    const job = (await jobs.get(jobId))!;
    return readTx(GATING_READ_STORES, (t) => checkInputs(job, t));
}

describe("input readiness", () => {
    it("follows Galaxy's job handler for dataset inputs", async () => {
        const { history, input, inputDataset } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        expect(await readiness(job.id)).toEqual({ status: "ready" });

        for (const [state, expected] of [
            ["queued", { status: "wait", reasons: ["Input dataset 'input.bed' is in queued state"] }],
            ["deferred", { status: "ready" }],
            [
                "paused",
                {
                    status: "pause",
                    message: `Input dataset 'input.bed' was paused before the job started. ${PAUSE_SUFFIX}`,
                },
            ],
        ] as const) {
            await datasets.update(inputDataset.id, { state });
            expect(await readiness(job.id)).toEqual(expected);
        }

        await datasets.update(inputDataset.id, { state: "ok" });
        await hdas.update(input.id, { _state: "setting_metadata" });
        expect((await readiness(job.id)).status).toBe("wait");
        await hdas.update(input.id, { _state: "failed_metadata" });
        expect(await readiness(job.id)).toEqual({
            status: "pause",
            message: `Input dataset 'input.bed' failed to properly set metadata. ${PAUSE_SUFFIX}`,
        });
        await hdas.update(input.id, { _state: null, deleted: true });
        expect((await readiness(job.id)).status).toBe("pause");
        await hdas.update(input.id, { purged: true });
        expect(await readiness(job.id)).toEqual({
            status: "fail",
            message: "Input dataset 'input.bed' was deleted before the job started",
        });
    });

    it("joins every problem into one pause message", async () => {
        const { history, input, inputDataset } = await seedHistory();
        const second = await hdas.createWithDataset({ history_id: history.id, name: "reads.fq" }, { state: "error" });
        await datasets.update(inputDataset.id, { state: "error" });
        const { job } = await seedJob(history.id, [input.id, second.hda.id]);
        expect(await readiness(job.id)).toEqual({
            status: "pause",
            message: `Input dataset 'input.bed' is in error state, Input dataset 'reads.fq' is in error state. ${PAUSE_SUFFIX}`,
        });
    });

    it("waits for collections to be populated and checks their elements", async () => {
        const { history, input, inputDataset } = await seedHistory();
        const { hdca, collection } = await collections.createHdca({
            hdca: { history_id: history.id, name: "pairs" },
            collection: {
                collection_type: "list:paired",
                elements: [
                    {
                        identifier: "s1",
                        collection: {
                            collection_type: "paired",
                            elements: [{ identifier: "forward", hda_id: input.id }],
                        },
                    },
                ],
            },
        });
        const job = await jobs.create({
            tool_id: "cat1",
            tool_version: "1.0.0",
            history_id: history.id,
            inputs: [{ name: "input1", src: "hdca", id: hdca.id }],
        });
        expect(await readiness(job.id)).toEqual({ status: "ready" });

        await datasets.update(inputDataset.id, { state: "running" });
        expect((await readiness(job.id)).status).toBe("wait");

        await collections.updateCollection(collection.id, { populated_state: "new" });
        expect(await readiness(job.id)).toEqual({
            status: "wait",
            reasons: ["Input dataset collection 'pairs' is not populated yet"],
        });
        await collections.updateCollection(collection.id, { populated_state: "failed" });
        expect((await readiness(job.id)).status).toBe("pause");
    });
});

describe("pausing", () => {
    it("pauses undispatched jobs and their outputs, and only those", async () => {
        const { history, input } = await seedHistory();
        const { job, outputHdaId } = await seedJob(history.id, [input.id]);
        expect(await writeTx(JOB_STORES, (t) => pauseJob(job.id, "Because.", t))).toBe(true);
        expect((await jobs.get(job.id))?.state).toBe("paused");
        expect(await hdaState(outputHdaId)).toBe("paused");
        expect((await hdas.get(outputHdaId))?.info).toBe("Because.");
        expect(await outbox.listForJob(job.id)).toEqual([]);

        const running = await seedJob(history.id, [input.id]);
        await jobs.update(running.job.id, { state: "running" });
        expect(await writeTx(JOB_STORES, (t) => pauseJob(running.job.id, "No.", t))).toBe(false);
    });

    it("pauses the jobs that read a failed job's outputs, also through copies and collections", async () => {
        const { history, input } = await seedHistory();
        const failed = await seedJob(history.id, [input.id]);
        const direct = await seedJob(history.id, [failed.outputHdaId]);
        const copy = await hdas.copy(failed.outputHdaId, history.id);
        const viaCopy = await seedJob(history.id, [copy.id]);
        const { hdca } = await collections.createHdca({
            hdca: { history_id: history.id, name: "list" },
            collection: { collection_type: "list", elements: [{ identifier: "a", hda_id: failed.outputHdaId }] },
        });
        const viaCollection = await jobs.create({
            tool_id: "cat1",
            tool_version: "1",
            history_id: history.id,
            inputs: [{ name: "input1", src: "hdca", id: hdca.id }],
        });
        const unrelated = await seedJob(history.id, [input.id]);

        const paused = await writeTx(JOB_STORES, (t) => pauseDependents(failed.job.id, t));
        expect(new Set(paused)).toEqual(new Set([direct.job.id, viaCopy.job.id, viaCollection.id]));
        expect((await hdas.get(direct.outputHdaId))?.info).toBe(DEPENDENT_PAUSE_MESSAGE);
        expect((await jobs.get(unrelated.job.id))?.state).toBe("new");
    });
});
