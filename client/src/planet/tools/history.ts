/**
 * The history items a tool form or a tool run works with, read from IndexedDB in one transaction so the form engine
 * and submission can run synchronously afterwards. Items are Galaxy's HDAs and HDCAs with what parameter handling
 * reads from them (state, extension, dbkey, tags, metadata, collection structure).
 */

import type { CollectionRecord, DatasetState, HdaRecord, HdcaRecord, HistoryRecord, ReadTx } from "@/planet/db";

/** An HDA. `state` is the dataset's state; `effectiveState` adds the HDA's metadata override. */
export interface DatasetItem {
    readonly src: "hda";
    readonly id: string;
    readonly hid: number;
    readonly name: string;
    readonly extension: string;
    readonly dbkey: string;
    readonly state: DatasetState;
    readonly effectiveState: DatasetState;
    readonly visible: boolean;
    readonly deleted: boolean;
    readonly purged: boolean;
    readonly tags: readonly string[];
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly historyId: string;
    readonly datasetId: string;
    readonly uuid: string;
    readonly fileSize: number | null;
    readonly totalSize: number | null;
    /** The element identifier of a dataset a tool run maps over (`element_identifier` set by `expand_meta_parameters`). */
    readonly elementIdentifier?: string;
}

/** A collection element (`DatasetCollectionElement`): a dataset or a nested collection. */
export interface CollectionElementItem {
    /** The element's id. */
    readonly id: string;
    readonly identifier: string;
    readonly dataset: DatasetItem | null;
    readonly collection: CollectionContent | null;
    /** Sample sheet row values. */
    readonly columns: unknown[] | null;
}

/** Galaxy's `DatasetCollection` with its elements. */
export interface CollectionContent {
    readonly id: string;
    readonly collectionType: string;
    /** `populated_state` is `ok` here and in every nested collection. */
    readonly populated: boolean;
    readonly elements: readonly CollectionElementItem[];
    readonly columnDefinitions: unknown[] | null;
    readonly fields: unknown[] | null;
}

/**
 * An HDCA, or a collection element holding a nested collection (`src` `dce`), which tool parameters take where Galaxy
 * maps a tool over subcollections.
 */
export interface CollectionItem {
    readonly src: "hdca" | "dce";
    readonly id: string;
    /** The HDCA's hid; 0 for a collection element, which has none. */
    readonly hid: number;
    /** The HDCA's name, or the element's identifier. */
    readonly name: string;
    readonly visible: boolean;
    readonly deleted: boolean;
    readonly tags: readonly string[];
    readonly historyId: string;
    readonly collection: CollectionContent;
}

export type HistoryItem = DatasetItem | CollectionItem;

/** A reference to an item, as tool states and requests carry them. */
export interface ItemReference {
    src: string;
    id: string;
}

/** Marks the items this module reads, so `{src, id}` references in requests are never mistaken for them. */
const ITEM = Symbol("planet.historyItem");

function branded<T extends object>(item: T): T {
    Object.defineProperty(item, ITEM, { value: true });
    return item;
}

function isBranded(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[ITEM] === true;
}

export function isDatasetItem(value: unknown): value is DatasetItem {
    return isBranded(value) && value.src === "hda";
}

export function isCollectionItem(value: unknown): value is CollectionItem {
    return isBranded(value) && (value.src === "hdca" || value.src === "dce");
}

/** The dataset of a collection element a tool run maps over, carrying the element's identifier. */
export function mappedDataset(dataset: DatasetItem, identifier: string): DatasetItem {
    return branded<DatasetItem>({ ...dataset, elementIdentifier: identifier });
}

/** A collection element holding a nested collection, as a parameter value (`src` `dce`). */
export function elementCollection(
    element: CollectionElementItem & { collection: CollectionContent },
    historyId: string,
): CollectionItem {
    return branded<CollectionItem>({
        src: "dce",
        id: element.id,
        hid: 0,
        name: element.identifier,
        visible: true,
        deleted: false,
        tags: [],
        historyId,
        collection: element.collection,
    });
}

export function isHistoryItem(value: unknown): value is HistoryItem {
    return isDatasetItem(value) || isCollectionItem(value);
}

/** The datasets of a collection, depth first in element order (`DatasetCollection.dataset_instances`). */
export function collectionDatasets(collection: CollectionContent): DatasetItem[] {
    const out: DatasetItem[] = [];
    for (const element of collection.elements) {
        if (element.dataset) {
            out.push(element.dataset);
        } else if (element.collection) {
            out.push(...collectionDatasets(element.collection));
        }
    }
    return out;
}

/** A history's active items plus any other items a request referenced. */
export class HistorySnapshot {
    private readonly byKey = new Map<string, HistoryItem>();

    constructor(
        readonly history: HistoryRecord | null,
        /** The history's datasets, newest first. */
        readonly datasets: readonly DatasetItem[],
        /** The history's collections, newest first. */
        readonly collections: readonly CollectionItem[],
        referenced: readonly HistoryItem[] = [],
        /** Referenced collection elements by element id: their dataset, or their collection as a `dce` item. */
        elements: ReadonlyMap<string, HistoryItem> = new Map(),
    ) {
        for (const item of [...datasets, ...collections, ...referenced]) {
            this.byKey.set(`${item.src}:${item.id}`, item);
        }
        for (const [id, item] of elements) {
            this.byKey.set(`dce:${id}`, item);
        }
    }

    /** An empty snapshot, for forms built without a history. */
    static empty(): HistorySnapshot {
        return new HistorySnapshot(null, [], []);
    }

    get(src: string, id: string): HistoryItem | undefined {
        return this.byKey.get(`${src}:${id}`);
    }

    /** Active (not deleted), visible datasets of the history, newest first. */
    activeVisibleDatasets(): DatasetItem[] {
        return this.datasets.filter((item) => !item.deleted && item.visible);
    }

    /** Active, visible collections of the history, newest first. */
    activeVisibleCollections(): CollectionItem[] {
        return this.collections.filter((item) => !item.deleted && item.visible);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Loading

/** Nesting deeper than this is treated as corrupt data. */
const MAX_NESTING = 32;

class SnapshotReader {
    private readonly datasets = new Map<string, DatasetItem | null>();
    private readonly contents = new Map<string, CollectionContent | null>();

    constructor(private readonly tx: ReadTx) {}

    async datasetFromHda(hda: HdaRecord): Promise<DatasetItem | null> {
        const cached = this.datasets.get(hda.id);
        if (cached !== undefined) {
            return cached;
        }
        const dataset = await this.tx.store("datasets").get(hda.dataset_id);
        const item: DatasetItem | null = dataset
            ? branded<DatasetItem>({
                  src: "hda",
                  id: hda.id,
                  hid: hda.hid,
                  name: hda.name,
                  extension: hda.extension,
                  dbkey: hda.dbkey,
                  state: dataset.state,
                  effectiveState: hda._state ?? dataset.state,
                  visible: hda.visible,
                  deleted: hda.deleted,
                  purged: hda.purged,
                  tags: hda.tags,
                  metadata: hda.metadata,
                  historyId: hda.history_id,
                  datasetId: dataset.id,
                  uuid: dataset.uuid,
                  fileSize: dataset.file_size,
                  totalSize: dataset.total_size,
              })
            : null;
        this.datasets.set(hda.id, item);
        return item;
    }

    async dataset(id: string): Promise<DatasetItem | null> {
        const cached = this.datasets.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const hda = await this.tx.store("hdas").get(id);
        return hda ? this.datasetFromHda(hda) : null;
    }

    async content(record: CollectionRecord, depth = 0): Promise<CollectionContent> {
        const cached = this.contents.get(record.id);
        if (cached) {
            return cached;
        }
        if (depth > MAX_NESTING) {
            throw new Error("Collection nesting is too deep");
        }
        const dces = await this.tx
            .store("dces")
            .index("collection_index")
            .getAll(IDBKeyRange.bound([record.id, -Infinity], [record.id, Infinity]));
        const elements: CollectionElementItem[] = [];
        let populated = record.populated_state === "ok";
        for (const dce of dces) {
            const base = { id: dce.id, identifier: dce.element_identifier, columns: dce.columns };
            if (dce.hda_id) {
                elements.push({ ...base, dataset: await this.dataset(dce.hda_id), collection: null });
            } else if (dce.child_collection_id) {
                const child = await this.tx.store("collections").get(dce.child_collection_id);
                const nested = child ? await this.content(child, depth + 1) : null;
                populated &&= nested?.populated ?? false;
                elements.push({ ...base, dataset: null, collection: nested });
            }
        }
        const content: CollectionContent = {
            id: record.id,
            collectionType: record.collection_type,
            populated,
            elements,
            columnDefinitions: record.column_definitions,
            fields: record.fields,
        };
        this.contents.set(record.id, content);
        return content;
    }

    async collectionFromHdca(hdca: HdcaRecord): Promise<CollectionItem | null> {
        const record = await this.tx.store("collections").get(hdca.collection_id);
        if (!record) {
            return null;
        }
        return branded<CollectionItem>({
            src: "hdca",
            id: hdca.id,
            hid: hdca.hid,
            name: hdca.name,
            visible: hdca.visible,
            deleted: hdca.deleted,
            tags: hdca.tags,
            historyId: hdca.history_id,
            collection: await this.content(record),
        });
    }

    async collection(id: string): Promise<CollectionItem | null> {
        const hdca = await this.tx.store("hdcas").get(id);
        return hdca ? this.collectionFromHdca(hdca) : null;
    }

    /** A collection element: the dataset it holds, or its nested collection as a `dce` item. */
    async element(id: string): Promise<HistoryItem | null> {
        const dce = await this.tx.store("dces").get(id);
        if (!dce) {
            return null;
        }
        if (dce.hda_id) {
            return this.dataset(dce.hda_id);
        }
        const child = dce.child_collection_id ? await this.tx.store("collections").get(dce.child_collection_id) : null;
        if (!child) {
            return null;
        }
        const collection = await this.content(child);
        return elementCollection(
            { id: dce.id, identifier: dce.element_identifier, dataset: null, collection, columns: dce.columns },
            await this.owningHistory(dce.collection_id),
        );
    }

    /** The history of the HDCA whose collection contains `collectionId`, or "" when none does. */
    private async owningHistory(collectionId: string): Promise<string> {
        let current = collectionId;
        for (let depth = 0; depth <= MAX_NESTING; depth++) {
            const [hdca] = await this.tx.store("hdcas").index("collection_id").getAll(current);
            if (hdca) {
                return hdca.history_id;
            }
            const [parent] = await this.tx.store("dces").index("child_collection_id").getAll(current);
            if (!parent) {
                break;
            }
            current = parent.collection_id;
        }
        return "";
    }
}

function newestFirst<T extends { hid: number }>(items: T[]): T[] {
    return items.sort((a, b) => b.hid - a.hid);
}

/**
 * Reads a history's datasets and collections, and the items `references` name, in `tx` (which must cover the
 * content stores). Only IndexedDB requests are awaited.
 */
export async function readSnapshot(
    tx: ReadTx,
    history: HistoryRecord | null,
    references: readonly ItemReference[] = [],
): Promise<HistorySnapshot> {
    const reader = new SnapshotReader(tx);
    const datasets: DatasetItem[] = [];
    const collections: CollectionItem[] = [];
    if (history) {
        for (const hda of await tx.store("hdas").index("history_id").getAll(history.id)) {
            const item = await reader.datasetFromHda(hda);
            if (item) {
                datasets.push(item);
            }
        }
        for (const hdca of await tx.store("hdcas").index("history_id").getAll(history.id)) {
            const item = await reader.collectionFromHdca(hdca);
            if (item) {
                collections.push(item);
            }
        }
    }
    const referenced: HistoryItem[] = [];
    const elements = new Map<string, HistoryItem>();
    for (const reference of references) {
        if (reference.src === "dce") {
            const element = await reader.element(reference.id);
            if (element) {
                elements.set(reference.id, element);
            }
            continue;
        }
        const item =
            reference.src === "hda"
                ? await reader.dataset(reference.id)
                : reference.src === "hdca"
                  ? await reader.collection(reference.id)
                  : null;
        if (item) {
            referenced.push(item);
        }
    }
    return new HistorySnapshot(history, newestFirst(datasets), newestFirst(collections), referenced, elements);
}

/** Every `{src, id}` reference inside a JSON value (tool states, form data, job parameters). */
export function collectReferences(value: unknown, out: ItemReference[] = [], depth = 0): ItemReference[] {
    if (depth > 64 || typeof value !== "object" || value === null) {
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectReferences(item, out, depth + 1);
        }
        return out;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.src === "string" && typeof record.id === "string") {
        out.push({ src: record.src, id: record.id });
    }
    for (const key of Object.keys(record)) {
        collectReferences(record[key], out, depth + 1);
    }
    return out;
}
