/** Resumable page-to-S3 upload sessions. */

import { ApiError } from "@/planet/util/errors";

import { buildUpload, type NewUpload } from "./records";
import { type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { UploadRecord } from "./types";

export type { NewUpload };

/** Fields an upload update may change. */
export type UploadPatch = Partial<Omit<UploadRecord, "id" | "key" | "create_time" | "update_time">>;

/** Creates an upload session (state `pending`, key `uploads/<id>`). */
export function create(input: NewUpload, tx?: WriteTx): Promise<UploadRecord> {
    return useWrite(tx, ["uploads"], async (t) => {
        const upload = buildUpload(input, t.now);
        await t.store("uploads").add(upload);
        t.notify({ type: "upload-changed", uploadId: upload.id });
        return upload;
    });
}

/** Returns the upload session, or undefined. */
export function get(id: string, tx?: ReadTx): Promise<UploadRecord | undefined> {
    return useRead(tx, ["uploads"], (t) => t.store("uploads").get(id));
}

/** Returns the upload session or throws a 404 {@link ApiError}. */
export async function getOrThrow(id: string, tx?: ReadTx): Promise<UploadRecord> {
    const upload = await get(id, tx);
    if (!upload) {
        throw ApiError.notFound("Upload session not found");
    }
    return upload;
}

/** Returns the sessions in a state. */
export function listByState(state: UploadRecord["state"], tx?: ReadTx): Promise<UploadRecord[]> {
    return useRead(tx, ["uploads"], (t) => t.store("uploads").index("state").getAll(state));
}

/** Applies `patch` and bumps `update_time`. */
export function update(id: string, patch: UploadPatch, tx?: WriteTx): Promise<UploadRecord> {
    return useWrite(tx, ["uploads"], async (t) => {
        const store = t.store("uploads");
        const upload = await store.get(id);
        if (!upload) {
            throw ApiError.notFound("Upload session not found");
        }
        const next: UploadRecord = { ...upload, ...patch, update_time: t.now };
        await store.put(next);
        t.notify({ type: "upload-changed", uploadId: id });
        return next;
    });
}

/** Removes the session record. Abort or delete its S3 object first. */
export function remove(id: string, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["uploads"], async (t) => {
        await t.store("uploads").delete(id);
        t.notify({ type: "upload-changed", uploadId: id });
    });
}
