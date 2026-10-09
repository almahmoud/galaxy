/**
 * Keeps `update_time` consistent the way Galaxy's triggers do: a change to an item bumps its history,
 * a change to a dataset or collection also bumps every HDCA that contains it.
 */

import { ApiError } from "@/planet/util/errors";

import type { WriteTx } from "./transaction";

/** Sets the history's `update_time` to `tx.now` and announces the change after commit. */
export async function touchHistory(historyId: string, tx: WriteTx): Promise<void> {
    const store = tx.store("histories");
    const history = await store.get(historyId);
    if (!history) {
        throw ApiError.notFound("History not found");
    }
    if (history.update_time !== tx.now) {
        history.update_time = tx.now;
        await store.put(history);
    }
    tx.notify({ type: "history-changed", historyId });
}

/**
 * Bumps every HDCA (and its collection) that contains any of `collectionIds`, directly or through parent
 * collections, and touches their histories. Needs `collections`, `hdcas`, `dces` and `histories`.
 */
export async function bumpCollections(collectionIds: Iterable<string>, tx: WriteTx): Promise<void> {
    const seen = new Set<string>();
    const queue = [...collectionIds];
    const histories = new Set<string>();
    while (queue.length) {
        const collectionId = queue.pop()!;
        if (seen.has(collectionId)) {
            continue;
        }
        seen.add(collectionId);
        const collections = tx.store("collections");
        const collection = await collections.get(collectionId);
        if (collection && collection.update_time !== tx.now) {
            collection.update_time = tx.now;
            await collections.put(collection);
        }
        const hdcas = tx.store("hdcas");
        for (const hdca of await hdcas.index("collection_id").getAll(collectionId)) {
            if (hdca.update_time !== tx.now) {
                hdca.update_time = tx.now;
                await hdcas.put(hdca);
            }
            histories.add(hdca.history_id);
        }
        for (const parent of await tx.store("dces").index("child_collection_id").getAll(collectionId)) {
            queue.push(parent.collection_id);
        }
    }
    for (const historyId of histories) {
        await touchHistory(historyId, tx);
    }
}

/** Bumps the collections containing any of `hdaIds` (see {@link bumpCollections}). */
export async function bumpCollectionsOfHdas(hdaIds: Iterable<string>, tx: WriteTx): Promise<void> {
    const collectionIds = new Set<string>();
    const index = tx.store("dces").index("hda_id");
    for (const hdaId of hdaIds) {
        for (const element of await index.getAll(hdaId)) {
            collectionIds.add(element.collection_id);
        }
    }
    if (collectionIds.size) {
        await bumpCollections(collectionIds, tx);
    }
}
