/** History dataset associations (HDAs): datasets placed in histories. */

import { ApiError } from "@/planet/util/errors";

import * as contents from "./contents";
import { allocateHids } from "./histories";
import { bumpCollectionsOfHdas, touchHistory } from "./propagation";
import { buildDataset, buildHda, type NewDataset, type NewHda } from "./records";
import { CONTENT_STORES, type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { DatasetRecord, DatasetState, HdaRecord } from "./types";

export type { NewHda };

/** Fields an HDA update may change. */
export type HdaPatch = Partial<Omit<HdaRecord, "id" | "history_id" | "hid" | "create_time" | "update_time">>;

/** An HDA with its dataset and effective state. */
export interface HdaWithDataset {
    hda: HdaRecord;
    dataset: DatasetRecord;
    state: DatasetState;
}

/** The state Galaxy reports for an HDA: its `_state` override, else the dataset's state. */
export function effectiveState(hda: HdaRecord, dataset: DatasetRecord): DatasetState {
    return hda._state ?? dataset.state;
}

/** Returns the HDA, or undefined. */
export function get(id: string, tx?: ReadTx): Promise<HdaRecord | undefined> {
    return useRead(tx, ["hdas"], (t) => t.store("hdas").get(id));
}

/** Returns the HDA or throws a 404 {@link ApiError}. */
export async function getOrThrow(id: string, tx?: ReadTx): Promise<HdaRecord> {
    const hda = await get(id, tx);
    if (!hda) {
        throw ApiError.notFound("Dataset not found");
    }
    return hda;
}

/** Returns the HDA with its dataset, or undefined. */
export function getWithDataset(id: string, tx?: ReadTx): Promise<HdaWithDataset | undefined> {
    return useRead(tx, ["hdas", "datasets"], async (t) => {
        const hda = await t.store("hdas").get(id);
        if (!hda) {
            return undefined;
        }
        const dataset = await t.store("datasets").get(hda.dataset_id);
        if (!dataset) {
            throw new ApiError(500, "Dataset record missing for history dataset", 500002);
        }
        return { hda, dataset, state: effectiveState(hda, dataset) };
    });
}

/** Like {@link getWithDataset} but throws a 404 {@link ApiError} when missing. */
export async function getWithDatasetOrThrow(id: string, tx?: ReadTx): Promise<HdaWithDataset> {
    const row = await getWithDataset(id, tx);
    if (!row) {
        throw ApiError.notFound("Dataset not found");
    }
    return row;
}

/** Returns the HDA with this hid in the history, or undefined. */
export function getByHid(historyId: string, hid: number, tx?: ReadTx): Promise<HdaRecord | undefined> {
    return useRead(tx, ["hdas"], (t) => t.store("hdas").index("history_hid").get([historyId, hid]));
}

/** Returns every HDA (in any history) that points to the dataset. */
export function listForDataset(datasetId: string, tx?: ReadTx): Promise<HdaRecord[]> {
    return useRead(tx, ["hdas"], (t) => t.store("hdas").index("dataset_id").getAll(datasetId));
}

/** Returns the HDAs created by a job. */
export function listForJob(jobId: string, tx?: ReadTx): Promise<HdaRecord[]> {
    return useRead(tx, ["hdas"], (t) => t.store("hdas").index("creating_job_id").getAll(jobId));
}

/**
 * Returns the history's datasets joined with their dataset records, filtered and ordered like
 * {@link contents.list}.
 */
export async function listForHistory(
    historyId: string,
    query: Omit<contents.ContentsQuery, "types"> = {},
    tx?: ReadTx,
): Promise<{ rows: HdaWithDataset[]; total: number }> {
    const result = await contents.list(historyId, { ...query, types: ["dataset"] }, tx);
    return {
        rows: result.rows.map((row) => {
            if (row.type !== "dataset") {
                throw new Error("unexpected collection row");
            }
            return { hda: row.hda, dataset: row.dataset, state: row.state };
        }),
        total: result.total,
    };
}

/**
 * Inserts an HDA for an existing dataset. A missing or zero `hid` is allocated from the history in the
 * same transaction. Touches the history.
 */
export function create(input: NewHda, tx?: WriteTx): Promise<HdaRecord> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        if (!(await t.store("datasets").get(input.dataset_id))) {
            throw ApiError.notFound("Dataset not found");
        }
        const hda = buildHda(input, t.now);
        if (!hda.hid) {
            hda.hid = await allocateHids(hda.history_id, 1, t);
        }
        await t.store("hdas").add(hda);
        await touchHistory(hda.history_id, t);
        return hda;
    });
}

/** Creates a dataset and an HDA pointing to it in one transaction. */
export function createWithDataset(
    hdaInput: Omit<NewHda, "dataset_id">,
    datasetInput: NewDataset = {},
    tx?: WriteTx,
): Promise<{ hda: HdaRecord; dataset: DatasetRecord }> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        const dataset = buildDataset(datasetInput, t.now);
        await t.store("datasets").add(dataset);
        const hda = await create({ ...hdaInput, dataset_id: dataset.id }, t);
        return { hda, dataset };
    });
}

/**
 * Copies an HDA into a history (Galaxy's `HistoryDatasetAssociation.copy`): the copy shares the dataset,
 * gets a new hid and records `copied_from`.
 */
export function copy(id: string, historyId: string, tx?: WriteTx): Promise<HdaRecord> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        const source = await getOrThrow(id, t);
        return create(
            { ...source, id: undefined, hid: undefined, history_id: historyId, copied_from: { src: "hda", id } },
            t,
        );
    });
}

/** Applies `patch`, bumps `update_time`, touches the history and bumps containing collections. */
export function update(id: string, patch: HdaPatch, tx?: WriteTx): Promise<HdaRecord> {
    return useWrite(tx, CONTENT_STORES, async (t) => {
        const store = t.store("hdas");
        const hda = await store.get(id);
        if (!hda) {
            throw ApiError.notFound("Dataset not found");
        }
        const next: HdaRecord = { ...hda, ...patch, update_time: t.now };
        if (next.purged) {
            next.deleted = true;
        }
        await store.put(next);
        await touchHistory(next.history_id, t);
        await bumpCollectionsOfHdas([id], t);
        return next;
    });
}
