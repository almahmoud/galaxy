/**
 * The state payload: a versioned JSON copy of every IndexedDB store except `secrets`. Stores with a key path hold
 * their records; `settings` and `kv` hold `[key, value]` pairs. Left out: the secrets, `kv` entries that describe
 * this device or browser session ({@link isLocalKvKey}), and the pod and node names of jobs, which the job
 * monitor learns again from the cluster.
 */

import { getDb } from "@/planet/db/connection";
import { DB_VERSION, STORE_NAMES, type StoreName } from "@/planet/db/schema";
import { runTransaction } from "@/planet/db/transaction";
import type { JobRecord, StoredSettings } from "@/planet/db/types";
import { sha256Hex } from "@/planet/util/digest";

import { BackupError } from "./errors";
import { fromUtf8, MAX_PAYLOAD_BYTES, utf8 } from "./format";

export const PAYLOAD_FORMAT = "planet-state";
export const PAYLOAD_VERSION = 1;

/** Stores a snapshot never contains. */
export const EXCLUDED_STORES: ReadonlySet<StoreName> = new Set<StoreName>(["secrets"]);

/** Stores in a snapshot, in `STORE_NAMES` order. */
export const SNAPSHOT_STORES: readonly StoreName[] = STORE_NAMES.filter((name) => !EXCLUDED_STORES.has(name));

const LOCAL_KV_PREFIXES = ["leader", "backup:", "console:", "container:"];

/**
 * True for `kv` keys of this device or browser session: the timestamp clock, leader election (`leader*`), backup,
 * console requests and the container cache.
 */
export function isLocalKvKey(key: string): boolean {
    return key === "clock" || LOCAL_KV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export interface StatePayload {
    format: typeof PAYLOAD_FORMAT;
    version: typeof PAYLOAD_VERSION;
    schema_version: number;
    instance_id: string;
    /** ISO 8601 UTC time the records were read. */
    created: string;
    /** The `kv` timestamp clock when the records were read, in microseconds since the epoch. */
    clock: number;
    stores: Record<string, unknown[]>;
}

export interface CollectedState {
    /** The payload as UTF-8 JSON. */
    bytes: Uint8Array<ArrayBuffer>;
    /** SHA-256 of the stores, the same for the same records. */
    digest: string;
    counts: Record<string, number>;
    instance_id: string;
    created: string;
}

/** Turns values IndexedDB can hold but JSON cannot into an error instead of silently changing them. */
function strictJson(store: string): (this: unknown, key: string, value: unknown) => unknown {
    return function (this: unknown, key: string, value: unknown) {
        const raw = (this as Record<string, unknown>)[key];
        if (typeof raw === "number" && !Number.isFinite(raw)) {
            throw new BackupError("format", `A record in ${store} holds a number JSON cannot represent.`);
        }
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
            const prototype = Object.getPrototypeOf(raw);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new BackupError("format", `A record in ${store} holds a value JSON cannot represent.`);
            }
        }
        return value;
    };
}

function exportSettings(value: unknown): unknown {
    if (typeof value !== "object" || value === null) {
        return value;
    }
    const settings = value as StoredSettings & {
        cluster?: Record<string, unknown>;
        storage?: Record<string, unknown>;
    };
    const { token: _token, has_token: _hasToken, ...cluster } = (settings.cluster ?? {}) as Record<string, unknown>;
    const {
        secret_access_key: _secret,
        has_secret: _hasSecret,
        ...storage
    } = (settings.storage ?? {}) as Record<string, unknown>;
    return { ...settings, cluster, storage };
}

function exportJob(job: JobRecord): JobRecord {
    return job.k8s ? { ...job, k8s: { ...job.k8s, pod_name: null, node_name: null } } : job;
}

/** Reads every snapshot store in one transaction and serializes it. */
export async function collectState(now: number = Date.now()): Promise<CollectedState> {
    const db = await getDb();
    const { stores, counts, clock, instanceId } = await runTransaction(db, SNAPSHOT_STORES, "readonly", async (tx) => {
        const stores: Record<string, unknown[]> = {};
        const counts: Record<string, number> = {};
        let clock = 0;
        let instanceId = "";
        for (const name of SNAPSHOT_STORES) {
            const store = tx.store(name);
            if (store.keyPath === null) {
                const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
                const entries: [unknown, unknown][] = [];
                keys.forEach((key, index) => {
                    const value = values[index];
                    if (name === "kv") {
                        if (key === "clock" && typeof value === "number") {
                            clock = value;
                        }
                        if (typeof key === "string" && isLocalKvKey(key)) {
                            return;
                        }
                    }
                    if (name === "settings") {
                        const settings = value as Partial<StoredSettings> | undefined;
                        instanceId = typeof settings?.instance_id === "string" ? settings.instance_id : instanceId;
                        entries.push([key, exportSettings(value)]);
                        return;
                    }
                    entries.push([key, value]);
                });
                stores[name] = entries;
            } else if (name === "jobs") {
                stores[name] = ((await store.getAll()) as JobRecord[]).map(exportJob);
            } else {
                stores[name] = await store.getAll();
            }
            counts[name] = stores[name]!.length;
        }
        return { stores, counts, clock, instanceId };
    });
    const parts: string[] = [];
    for (const name of SNAPSHOT_STORES) {
        parts.push(`${JSON.stringify(name)}:${JSON.stringify(stores[name], strictJson(name))}`);
    }
    const storesJson = `{${parts.join(",")}}`;
    const created = new Date(now).toISOString();
    const head = {
        format: PAYLOAD_FORMAT,
        version: PAYLOAD_VERSION,
        schema_version: DB_VERSION,
        instance_id: instanceId,
        created,
        clock,
    };
    const json = `${JSON.stringify(head).slice(0, -1)},"stores":${storesJson}}`;
    if (json.length > MAX_PAYLOAD_BYTES) {
        throw new BackupError(
            "too_large",
            `Planet's records take more than ${MAX_PAYLOAD_BYTES / 1024 / 1024} MiB, more than a snapshot holds.`,
        );
    }
    return { bytes: utf8(json), digest: await sha256Hex(storesJson), counts, instance_id: instanceId, created };
}

function invalid(message: string): never {
    throw new BackupError("format", `The snapshot's records are invalid: ${message}.`);
}

function keyPathValid(record: unknown, keyPath: string | string[]): boolean {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
        return false;
    }
    const paths = typeof keyPath === "string" ? [keyPath] : keyPath;
    return paths.every((path) => {
        const value = (record as Record<string, unknown>)[path];
        return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
    });
}

/** Key paths of the stores, read from the database so the check follows its migrations. */
export async function storeKeyPaths(): Promise<Record<string, string | string[] | null>> {
    const db = await getDb();
    return runTransaction(db, SNAPSHOT_STORES, "readonly", (tx) =>
        Object.fromEntries(SNAPSHOT_STORES.map((name) => [name, tx.store(name).keyPath as string | string[] | null])),
    );
}

/**
 * Parses and validates a decrypted payload against this build's schema.
 *
 * @throws BackupError `schema_version` when it was written by a build with another IndexedDB schema
 */
export function parsePayload(bytes: Uint8Array, keyPaths: Record<string, string | string[] | null>): StatePayload {
    let value: unknown;
    try {
        value = JSON.parse(fromUtf8(bytes));
    } catch {
        invalid("they are not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        invalid("they are not a JSON object");
    }
    const payload = value as Record<string, unknown>;
    if (payload.format !== PAYLOAD_FORMAT) {
        invalid("the format is not planet-state");
    }
    if (payload.version !== PAYLOAD_VERSION) {
        throw new BackupError(
            "unsupported_version",
            `The snapshot's records use version ${String(payload.version)}; this Planet reads version ${PAYLOAD_VERSION}.`,
        );
    }
    if (payload.schema_version !== DB_VERSION) {
        throw new BackupError(
            "schema_version",
            `The snapshot was written by a Planet with database schema ${String(payload.schema_version)}; this Planet uses schema ${DB_VERSION}. Restore it with a matching Planet build.`,
        );
    }
    if (typeof payload.instance_id !== "string" || !/^[0-9a-f]{8}$/.test(payload.instance_id)) {
        invalid("the instance id is invalid");
    }
    if (typeof payload.created !== "string" || typeof payload.clock !== "number" || !Number.isFinite(payload.clock)) {
        invalid("the creation time or clock is invalid");
    }
    const stores = payload.stores;
    if (typeof stores !== "object" || stores === null || Array.isArray(stores)) {
        invalid("the stores are missing");
    }
    for (const name of Object.keys(stores)) {
        if (!(name in keyPaths)) {
            invalid(`this Planet has no store ${name}`);
        }
    }
    for (const [name, keyPath] of Object.entries(keyPaths)) {
        const items = (stores as Record<string, unknown>)[name];
        if (!Array.isArray(items)) {
            invalid(`store ${name} is missing`);
        }
        for (const item of items) {
            const valid =
                keyPath === null
                    ? Array.isArray(item) && item.length === 2 && typeof item[0] === "string"
                    : keyPathValid(item, keyPath);
            if (!valid) {
                invalid(`a record in ${name} has no valid key`);
            }
        }
    }
    const settings = (stores as Record<string, unknown[]>).settings as [string, unknown][];
    if (!settings.some(([key, entry]) => key === "settings" && typeof entry === "object" && entry !== null)) {
        invalid("the settings are missing");
    }
    return payload as unknown as StatePayload;
}
