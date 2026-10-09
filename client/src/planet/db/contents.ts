/**
 * History contents: the union of a history's datasets (HDAs) and collections (HDCAs), filtered and ordered
 * like `HistoryContentsManager` (`lib/galaxy/managers/history_contents.py`).
 */

import { ApiError } from "@/planet/util/errors";
import { type ContentsFilter, type ContentsFilterSubject, matchesContentsFilters } from "@/planet/util/filters";
import { formatGalaxyTime } from "@/planet/util/time";

import { leafHdaIds } from "./collections";
import { CONTENT_STORES, type ReadTx, useRead } from "./tx";
import type {
    CollectionRecord,
    DatasetRecord,
    DatasetState,
    HdaRecord,
    HdcaRecord,
    JobRecord,
    PopulatedState,
} from "./types";

export type ContentType = "dataset" | "dataset_collection";

/** A dataset in a history. `state` is the HDA override or the dataset state. */
export interface DatasetRow {
    type: "dataset";
    hda: HdaRecord;
    dataset: DatasetRecord;
    state: DatasetState;
}

/** A collection in a history. `state` is the collection's `populated_state`. */
export interface CollectionRow {
    type: "dataset_collection";
    hdca: HdcaRecord;
    collection: CollectionRecord;
    state: PopulatedState;
}

export type ContentRow = DatasetRow | CollectionRow;

export type ContentsOrderKey = "create_time" | "extension" | "hid" | "history_id" | "name" | "update_time" | "size";

export interface ContentsOrder {
    key: ContentsOrderKey;
    descending: boolean;
}

export interface ContentsQuery {
    /** Filters from `parseContentsFilters`. Expand `related` to hids before passing it. */
    filters?: readonly ContentsFilter[];
    /** Defaults to hid, descending (Galaxy's `order=hid`). */
    order?: ContentsOrder;
    offset?: number;
    /** Null or undefined returns every match. */
    limit?: number | null;
    /** Restrict to datasets or collections. */
    types?: readonly ContentType[];
}

export interface ContentsResult {
    /** The requested page. */
    rows: ContentRow[];
    /** Matches before `offset`/`limit` (Galaxy's `total_matches`). */
    total: number;
}

const ORDER_KEYS: readonly ContentsOrderKey[] = [
    "create_time",
    "extension",
    "hid",
    "history_id",
    "name",
    "update_time",
    "size",
];

/**
 * Parses Galaxy's `order` parameter: `<key>`, `<key>-dsc` (both descending) or `<key>-asc`.
 *
 * @throws ApiError 400 for an unknown key
 */
export function parseContentsOrder(value: string | null | undefined, fallback = "hid"): ContentsOrder {
    const raw = value || fallback;
    for (const key of ORDER_KEYS) {
        if (raw === key || raw === `${key}-dsc`) {
            return { key, descending: true };
        }
        if (raw === `${key}-asc`) {
            return { key, descending: false };
        }
    }
    throw new ApiError(400, "Unknown order_by", undefined, { order_by: raw, available: ORDER_KEYS });
}

/** The `history_content_type-id` pair used by `type_id` filters and the client's item keys. */
export function typeId(row: ContentRow): string {
    return row.type === "dataset" ? `dataset-${row.hda.id}` : `dataset_collection-${row.hdca.id}`;
}

function sortValue(row: ContentRow, key: ContentsOrderKey): string | number | null {
    const item = row.type === "dataset" ? row.hda : row.hdca;
    switch (key) {
        case "hid":
            return item.hid;
        case "name":
            return item.name;
        case "create_time":
            return item.create_time;
        case "update_time":
            return item.update_time;
        case "history_id":
            return item.history_id;
        case "extension":
            return row.type === "dataset" ? row.hda.extension : null;
        case "size":
            return row.type === "dataset" ? row.dataset.file_size : null;
    }
}

function compareValues(a: string | number, b: string | number): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders rows like Galaxy on PostgreSQL: nulls sort as the largest value, except for `size`, where they
 * come last when descending and first when ascending. Ties are broken by hid.
 */
export function compareRows(a: ContentRow, b: ContentRow, order: ContentsOrder): number {
    const direction = order.descending ? -1 : 1;
    const left = sortValue(a, order.key);
    const right = sortValue(b, order.key);
    let result: number;
    if (left === null || right === null) {
        if (left === right) {
            result = 0;
        } else if (order.key === "size") {
            result = -direction * (left === null ? 1 : -1);
        } else {
            result = direction * (left === null ? 1 : -1);
        }
    } else {
        result = direction * compareValues(left, right);
    }
    if (result !== 0) {
        return result;
    }
    const itemA = a.type === "dataset" ? a.hda : a.hdca;
    const itemB = b.type === "dataset" ? b.hda : b.hdca;
    return direction * (itemA.hid - itemB.hid) || compareValues(a.type, b.type) || compareValues(itemA.id, itemB.id);
}

function lowerUpdateTimeBound(filters: readonly ContentsFilter[]): { value: string; open: boolean } | null {
    let bound: { micros: number; open: boolean } | null = null;
    for (const filter of filters) {
        if (filter.attr === "update_time" && (filter.op === "ge" || filter.op === "gt")) {
            if (!bound || filter.value > bound.micros || (filter.value === bound.micros && filter.op === "gt")) {
                bound = { micros: filter.value, open: filter.op === "gt" };
            }
        }
    }
    if (!bound || bound.micros < 0) {
        return null;
    }
    try {
        return { value: formatGalaxyTime(bound.micros), open: bound.open };
    } catch {
        return null;
    }
}

function updateTimeRange(historyId: string, bound: { value: string; open: boolean }): IDBKeyRange {
    return IDBKeyRange.bound([historyId, bound.value], [historyId, "\uffff"], bound.open, false);
}

function loadHdas(tx: ReadTx, historyId: string, bound: { value: string; open: boolean } | null) {
    const store = tx.store("hdas");
    return bound
        ? store.index("history_update_time").getAll(updateTimeRange(historyId, bound))
        : store.index("history_id").getAll(historyId);
}

function loadHdcas(tx: ReadTx, historyId: string, bound: { value: string; open: boolean } | null) {
    const store = tx.store("hdcas");
    return bound
        ? store.index("history_update_time").getAll(updateTimeRange(historyId, bound))
        : store.index("history_id").getAll(historyId);
}

async function toolIdsOf(tx: ReadTx, jobIds: Iterable<string | null>, cache: Map<string, JobRecord | undefined>) {
    const out = new Set<string>();
    for (const jobId of jobIds) {
        if (!jobId) {
            continue;
        }
        if (!cache.has(jobId)) {
            cache.set(jobId, await tx.store("jobs").get(jobId));
        }
        const job = cache.get(jobId);
        if (job) {
            out.add(job.tool_id);
        }
    }
    return [...out];
}

function datasetSubject(row: DatasetRow, toolIds: readonly string[]): ContentsFilterSubject {
    const { hda } = row;
    return {
        history_content_type: "dataset",
        id: hda.id,
        hid: hda.hid,
        name: hda.name,
        state: row.state,
        extension: hda.extension,
        visible: hda.visible,
        deleted: hda.deleted,
        purged: hda.purged,
        tags: hda.tags,
        annotation: hda.annotation,
        genome_build: hda.dbkey,
        create_time: hda.create_time,
        update_time: hda.update_time,
        object_store_id: null,
        tool_ids: toolIds,
    };
}

function collectionSubject(
    row: CollectionRow,
    leafExtensions: readonly string[],
    toolIds: readonly string[],
): ContentsFilterSubject {
    const { hdca } = row;
    return {
        history_content_type: "dataset_collection",
        id: hdca.id,
        hid: hdca.hid,
        name: hdca.name,
        state: row.state,
        extension: null,
        leaf_extensions: leafExtensions,
        visible: hdca.visible,
        deleted: hdca.deleted,
        purged: false,
        tags: hdca.tags,
        annotation: hdca.annotation,
        genome_build: null,
        create_time: hdca.create_time,
        update_time: hdca.update_time,
        object_store_id: null,
        tool_ids: toolIds,
    };
}

/**
 * Lists a history's contents. The `tx`, when given, must include {@link CONTENT_STORES}, plus `jobs` when a
 * `tool_id` filter is present. An `update_time-ge`/`-gt` filter is served from an index.
 */
export function list(historyId: string, query: ContentsQuery = {}, tx?: ReadTx): Promise<ContentsResult> {
    return useRead(tx, [...CONTENT_STORES, "jobs"], async (t) => {
        const filters = query.filters ?? [];
        const types = new Set<ContentType>(query.types ?? ["dataset", "dataset_collection"]);
        const bound = lowerUpdateTimeBound(filters);
        const needsLeaves = filters.some((filter) => filter.attr === "extension" && filter.op !== "like");
        const needsTools = filters.some((filter) => filter.attr === "tool_id");
        const jobs = new Map<string, JobRecord | undefined>();
        const matched: ContentRow[] = [];

        if (types.has("dataset")) {
            const hdas = await loadHdas(t, historyId, bound);
            const datasets = await Promise.all(hdas.map((hda) => t.store("datasets").get(hda.dataset_id)));
            for (const [index, hda] of hdas.entries()) {
                const dataset = datasets[index];
                if (!dataset) {
                    continue;
                }
                const row: DatasetRow = { type: "dataset", hda, dataset, state: hda._state ?? dataset.state };
                const toolIds = needsTools ? await toolIdsOf(t, [hda.creating_job_id], jobs) : [];
                if (matchesContentsFilters(datasetSubject(row, toolIds), filters)) {
                    matched.push(row);
                }
            }
        }

        if (types.has("dataset_collection")) {
            const hdcas = await loadHdcas(t, historyId, bound);
            const collections = await Promise.all(hdcas.map((hdca) => t.store("collections").get(hdca.collection_id)));
            for (const [index, hdca] of hdcas.entries()) {
                const collection = collections[index];
                if (!collection) {
                    continue;
                }
                const row: CollectionRow = {
                    type: "dataset_collection",
                    hdca,
                    collection,
                    state: collection.populated_state,
                };
                let leaves: HdaRecord[] = [];
                if (needsLeaves || needsTools) {
                    const ids = await leafHdaIds(collection.id, t);
                    leaves = (await Promise.all(ids.map((id) => t.store("hdas").get(id)))).filter(
                        (hda): hda is HdaRecord => hda !== undefined,
                    );
                }
                const toolIds = needsTools
                    ? await toolIdsOf(
                          t,
                          leaves.map((hda) => hda.creating_job_id),
                          jobs,
                      )
                    : [];
                const subject = collectionSubject(
                    row,
                    leaves.map((hda) => hda.extension),
                    toolIds,
                );
                if (matchesContentsFilters(subject, filters)) {
                    matched.push(row);
                }
            }
        }

        const order = query.order ?? { key: "hid", descending: true };
        matched.sort((a, b) => compareRows(a, b, order));
        const offset = Math.max(0, query.offset ?? 0);
        const end = query.limit === null || query.limit === undefined ? undefined : offset + Math.max(0, query.limit);
        return { rows: matched.slice(offset, end), total: matched.length };
    });
}

/** Returns one item by type and id, or undefined. */
export function getItem(type: ContentType, id: string, tx?: ReadTx): Promise<ContentRow | undefined> {
    return useRead(tx, CONTENT_STORES, async (t) => {
        if (type === "dataset") {
            const hda = await t.store("hdas").get(id);
            const dataset = hda && (await t.store("datasets").get(hda.dataset_id));
            return hda && dataset ? { type, hda, dataset, state: hda._state ?? dataset.state } : undefined;
        }
        const hdca = await t.store("hdcas").get(id);
        const collection = hdca && (await t.store("collections").get(hdca.collection_id));
        return hdca && collection ? { type, hdca, collection, state: collection.populated_state } : undefined;
    });
}

/** Returns the item with this hid in the history (a dataset or a collection), or undefined. */
export function getByHid(historyId: string, hid: number, tx?: ReadTx): Promise<ContentRow | undefined> {
    return useRead(tx, CONTENT_STORES, async (t) => {
        const hda = await t.store("hdas").index("history_hid").get([historyId, hid]);
        if (hda) {
            return getItem("dataset", hda.id, t);
        }
        const hdca = await t.store("hdcas").index("history_hid").get([historyId, hid]);
        return hdca ? getItem("dataset_collection", hdca.id, t) : undefined;
    });
}
