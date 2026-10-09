/** Histories, hid allocation and the current history. */

import { ApiError } from "@/planet/util/errors";

import { touchHistory } from "./propagation";
import { buildHistory, type NewHistory } from "./records";
import { CONTENT_STORES, type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { HistoryRecord } from "./types";

export type { NewHistory };

/** Fields a history update may change. */
export type HistoryPatch = Partial<
    Pick<
        HistoryRecord,
        | "name"
        | "annotation"
        | "tags"
        | "genome_build"
        | "deleted"
        | "purged"
        | "archived"
        | "published"
        | "importable"
        | "slug"
        | "preferred_object_store_id"
    >
>;

export interface HistoryListOptions {
    /** Include deleted (not purged) histories. Default false. */
    deleted?: boolean;
    /** Include purged histories. Default false. */
    purged?: boolean;
    /** Include archived histories. Default false. */
    archived?: boolean;
}

/** Creates a history. */
export function create(input: NewHistory = {}, tx?: WriteTx): Promise<HistoryRecord> {
    return useWrite(tx, ["histories"], async (t) => {
        const history = buildHistory(input, t.now);
        await t.store("histories").add(history);
        t.notify({ type: "history-changed", historyId: history.id });
        return history;
    });
}

/** Returns the history, or undefined. */
export function get(id: string, tx?: ReadTx): Promise<HistoryRecord | undefined> {
    return useRead(tx, ["histories"], (t) => t.store("histories").get(id));
}

/** Returns the history or throws a 404 {@link ApiError}. */
export async function getOrThrow(id: string, tx?: ReadTx): Promise<HistoryRecord> {
    const history = await get(id, tx);
    if (!history) {
        throw ApiError.notFound("History not found");
    }
    return history;
}

/** Returns histories ordered by `update_time`, newest first. */
export function list(options: HistoryListOptions = {}, tx?: ReadTx): Promise<HistoryRecord[]> {
    return useRead(tx, ["histories"], async (t) => {
        const all = await t.store("histories").index("update_time").getAll();
        return all
            .reverse()
            .filter(
                (history) =>
                    (options.purged || !history.purged) &&
                    (options.deleted || !history.deleted || (options.purged && history.purged)) &&
                    (options.archived || !history.archived),
            );
    });
}

/** Counts the histories {@link list} would return. */
export async function count(options: HistoryListOptions = {}, tx?: ReadTx): Promise<number> {
    return (await list(options, tx)).length;
}

/** Applies `patch` and bumps `update_time`. */
export function update(id: string, patch: HistoryPatch, tx?: WriteTx): Promise<HistoryRecord> {
    return useWrite(tx, ["histories"], async (t) => {
        const store = t.store("histories");
        const history = await store.get(id);
        if (!history) {
            throw ApiError.notFound("History not found");
        }
        const next: HistoryRecord = { ...history, ...patch, update_time: t.now };
        if (next.purged) {
            next.deleted = true;
        }
        await store.put(next);
        t.notify({ type: "history-changed", historyId: id });
        return next;
    });
}

/**
 * Marks the history deleted, and purged when `purge` is set. Contents and stored objects are left to the
 * caller.
 */
export function markDeleted(id: string, options: { purge?: boolean } = {}, tx?: WriteTx): Promise<HistoryRecord> {
    return update(id, options.purge ? { deleted: true, purged: true } : { deleted: true }, tx);
}

/** Clears `deleted`. Purged histories cannot be undeleted. */
export function undelete(id: string, tx?: WriteTx): Promise<HistoryRecord> {
    return useWrite(tx, ["histories"], async (t) => {
        const history = await getOrThrow(id, t);
        if (history.purged) {
            throw ApiError.badRequest("Cannot undelete a purged history");
        }
        return update(id, { deleted: false }, t);
    });
}

/** Sets the history's `update_time` to `tx.now`. Call it in the transaction that changes an item. */
export function touch(historyId: string, tx: WriteTx): Promise<void> {
    return touchHistory(historyId, tx);
}

/**
 * Reserves `count` consecutive hids in the history and returns the first. Call it in the transaction
 * that inserts the items so concurrent writers never share a hid.
 */
export async function allocateHids(historyId: string, count: number, tx: WriteTx): Promise<number> {
    const store = tx.store("histories");
    const history = await store.get(historyId);
    if (!history) {
        throw ApiError.notFound("History not found");
    }
    const first = history.hid_counter;
    history.hid_counter = first + count;
    history.update_time = tx.now;
    await store.put(history);
    tx.notify({ type: "history-changed", historyId });
    return first;
}

/** Reserves one hid (see {@link allocateHids}). */
export function nextHid(historyId: string, tx: WriteTx): Promise<number> {
    return allocateHids(historyId, 1, tx);
}

/** Returns the current history id as stored. The history may since have been deleted. */
export function getCurrentId(tx?: ReadTx): Promise<string | undefined> {
    return useRead(tx, ["kv"], async (t) => {
        const id = await t.store("kv").get("current_history_id");
        return typeof id === "string" ? id : undefined;
    });
}

/** Makes `id` the current history and returns it. */
export function setCurrent(id: string, tx?: WriteTx): Promise<HistoryRecord> {
    return useWrite(tx, ["histories", "kv"], async (t) => {
        const history = await getOrThrow(id, t);
        if (history.purged) {
            throw ApiError.badRequest("Cannot switch to a purged history");
        }
        await t.store("kv").put(id, "current_history_id");
        t.notify({ type: "current-history-changed", historyId: id });
        return history;
    });
}

/** Returns the current history, creating and selecting a new one when it is missing or purged. */
export function getOrCreateCurrent(tx?: WriteTx): Promise<HistoryRecord> {
    return useWrite(tx, ["histories", "kv"], async (t) => {
        const id = await t.store("kv").get("current_history_id");
        const current = typeof id === "string" ? await t.store("histories").get(id) : undefined;
        if (current && !current.purged) {
            return current;
        }
        const history = await create({}, t);
        await t.store("kv").put(history.id, "current_history_id");
        t.notify({ type: "current-history-changed", historyId: history.id });
        return history;
    });
}

/** Content counts as Galaxy's `contents_active`: deleted and hidden overlap. */
export interface ActiveCounts {
    active: number;
    deleted: number;
    hidden: number;
}

/** Counts the history's datasets and collections by `deleted`/`visible`. */
export function activeCounts(historyId: string, tx?: ReadTx): Promise<ActiveCounts> {
    return useRead(tx, ["hdas", "hdcas"], async (t) => {
        const counts: ActiveCounts = { active: 0, deleted: 0, hidden: 0 };
        const items = [
            ...(await t.store("hdas").index("history_id").getAll(historyId)),
            ...(await t.store("hdcas").index("history_id").getAll(historyId)),
        ];
        for (const item of items) {
            if (item.deleted) {
                counts.deleted++;
            }
            if (!item.visible) {
                counts.hidden++;
            }
            if (!item.deleted && item.visible) {
                counts.active++;
            }
        }
        return counts;
    });
}

/**
 * Bytes used by the history: the total size of each distinct non-purged dataset of its non-purged HDAs,
 * counted once (Galaxy's `History.disk_size`).
 */
export function diskSize(historyId: string, tx?: ReadTx): Promise<number> {
    return useRead(tx, CONTENT_STORES, async (t) => {
        const datasetIds = new Set<string>();
        for (const hda of await t.store("hdas").index("history_id").getAll(historyId)) {
            if (!hda.purged) {
                datasetIds.add(hda.dataset_id);
            }
        }
        let total = 0;
        const datasets = t.store("datasets");
        for (const datasetId of datasetIds) {
            const dataset = await datasets.get(datasetId);
            if (dataset && !dataset.purged) {
                total += dataset.total_size ?? dataset.file_size ?? 0;
            }
        }
        return total;
    });
}
