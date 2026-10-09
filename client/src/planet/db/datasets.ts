/** Datasets: the stored bytes and their state, shared by every HDA copy. */

import { ApiError } from "@/planet/util/errors";

import { bumpCollectionsOfHdas, touchHistory } from "./propagation";
import { buildDataset, datasetKeys, type NewDataset } from "./records";
import { CONTENT_STORES, type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { DatasetRecord, DatasetState } from "./types";

export type { NewDataset };
export { datasetKeys };

/** Fields a dataset update may change. */
export type DatasetPatch = Partial<Omit<DatasetRecord, "id" | "uuid" | "create_time" | "update_time">>;

/** Creates a dataset (state `new` unless given). It belongs to no history until an HDA points to it. */
export function create(input: NewDataset = {}, tx?: WriteTx): Promise<DatasetRecord> {
    return useWrite(tx, ["datasets"], async (t) => {
        const dataset = buildDataset(input, t.now);
        await t.store("datasets").add(dataset);
        return dataset;
    });
}

/** Returns the dataset, or undefined. */
export function get(id: string, tx?: ReadTx): Promise<DatasetRecord | undefined> {
    return useRead(tx, ["datasets"], (t) => t.store("datasets").get(id));
}

/** Returns the dataset or throws a 404 {@link ApiError}. */
export async function getOrThrow(id: string, tx?: ReadTx): Promise<DatasetRecord> {
    const dataset = await get(id, tx);
    if (!dataset) {
        throw ApiError.notFound("Dataset not found");
    }
    return dataset;
}

/** Returns the dataset with this UUID, or undefined. */
export function getByUuid(uuid: string, tx?: ReadTx): Promise<DatasetRecord | undefined> {
    return useRead(tx, ["datasets"], (t) => t.store("datasets").index("uuid").get(uuid));
}

/** Returns the datasets created by a job. */
export function listForJob(jobId: string, tx?: ReadTx): Promise<DatasetRecord[]> {
    return useRead(tx, ["datasets"], (t) => t.store("datasets").index("job_id").getAll(jobId));
}

/**
 * Applies `patch`, then bumps `update_time` on every HDA copy, their histories and the collections that
 * contain them. Use it for every state change so history polling sees it.
 */
export function update(id: string, patch: DatasetPatch, tx?: WriteTx): Promise<DatasetRecord> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        const store = t.store("datasets");
        const dataset = await store.get(id);
        if (!dataset) {
            throw ApiError.notFound("Dataset not found");
        }
        const next: DatasetRecord = { ...dataset, ...patch, update_time: t.now };
        await store.put(next);
        const hdas = t.store("hdas");
        const copies = await hdas.index("dataset_id").getAll(id);
        const historyIds = new Set<string>();
        for (const hda of copies) {
            hda.update_time = t.now;
            await hdas.put(hda);
            historyIds.add(hda.history_id);
        }
        for (const historyId of historyIds) {
            await touchHistory(historyId, t);
        }
        await bumpCollectionsOfHdas(
            copies.map((hda) => hda.id),
            t,
        );
        return next;
    });
}

/** Sets the dataset state (see {@link update}). */
export function setState(id: string, state: DatasetState, tx?: WriteTx): Promise<DatasetRecord> {
    return update(id, { state }, tx);
}
