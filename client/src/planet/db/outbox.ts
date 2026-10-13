/** The leader tab's work queue. Entries are processed in `not_before` order and removed when done. */

import { ApiError } from "@/planet/util/errors";

import { buildOutboxEntry, type NewOutboxEntry } from "./records";
import { type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { OutboxKind, OutboxRecord } from "./types";

export type { NewOutboxEntry };

/** Adds an entry and nudges the leader (`outbox-changed`) after commit. */
export function enqueue(input: NewOutboxEntry, tx?: WriteTx): Promise<OutboxRecord> {
    return useWrite(tx, ["outbox"], async (t) => {
        const entry = buildOutboxEntry(input, t.now);
        await t.store("outbox").add(entry);
        t.notify({ type: "outbox-changed" });
        return entry;
    });
}

/** Returns the entry, or undefined. */
export function get(id: string, tx?: ReadTx): Promise<OutboxRecord | undefined> {
    return useRead(tx, ["outbox"], (t) => t.store("outbox").get(id));
}

/** Returns entries whose `not_before` is at or before `time` (a Galaxy timestamp), oldest first. */
export function due(time: string, tx?: ReadTx): Promise<OutboxRecord[]> {
    return useRead(tx, ["outbox"], (t) => t.store("outbox").index("not_before").getAll(IDBKeyRange.upperBound(time)));
}

/** Returns every entry, oldest `not_before` first. */
export function list(tx?: ReadTx): Promise<OutboxRecord[]> {
    return useRead(tx, ["outbox"], (t) => t.store("outbox").index("not_before").getAll());
}

/** Returns the entries for a job. */
export function listForJob(jobId: string, tx?: ReadTx): Promise<OutboxRecord[]> {
    return useRead(tx, ["outbox"], (t) => t.store("outbox").index("job_id").getAll(jobId));
}

/** Records a failed attempt and postpones the entry until `notBefore`. */
export function reschedule(id: string, notBefore: string, error: string | null, tx?: WriteTx): Promise<OutboxRecord> {
    return useWrite(tx, ["outbox"], async (t) => {
        const store = t.store("outbox");
        const entry = await store.get(id);
        if (!entry) {
            throw ApiError.notFound("Outbox entry not found");
        }
        const next: OutboxRecord = { ...entry, not_before: notBefore, attempts: entry.attempts + 1, last_error: error };
        await store.put(next);
        t.notify({ type: "outbox-changed" });
        return next;
    });
}

/** Postpones the entry until `notBefore` without counting a failed attempt. */
export function postpone(id: string, notBefore: string, tx?: WriteTx): Promise<OutboxRecord | undefined> {
    return useWrite(tx, ["outbox"], async (t) => {
        const store = t.store("outbox");
        const entry = await store.get(id);
        if (!entry) {
            return undefined;
        }
        const next: OutboxRecord = { ...entry, not_before: notBefore };
        await store.put(next);
        return next;
    });
}

/** Removes every entry of `kind` for a job. */
export function removeForJob(jobId: string, kind: OutboxKind, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["outbox"], async (t) => {
        const store = t.store("outbox");
        for (const entry of await store.index("job_id").getAll(jobId)) {
            if (entry.kind === kind) {
                await store.delete(entry.id);
            }
        }
    });
}

/** Removes the entry. */
export function remove(id: string, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["outbox"], async (t) => {
        await t.store("outbox").delete(id);
    });
}
