/** Planet settings and secrets (singleton records). */

import { ApiError, ErrorCodes } from "@/planet/util/errors";

import { SECRETS_KEY, SETTINGS_KEY } from "./schema";
import { rebindsSecret, rebindsToken } from "./secretBindings";
import { type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { PlanetSecrets, PlanetSettings, StoredSettings } from "./types";

/**
 * A settings change. Omitted fields keep their value. `cluster.token` and `storage.secret_access_key`
 * replace the stored secret; an empty string or null clears it. A change to the settings a secret belongs to
 * (`secretBindings.ts`) clears the secret unless the change supplies one. `instance_id` cannot change.
 */
export interface SettingsUpdate {
    cluster?: Partial<StoredSettings["cluster"]> & { token?: string | null };
    storage?: Partial<StoredSettings["storage"]> & { secret_access_key?: string | null };
    user?: Partial<StoredSettings["user"]>;
}

const EMPTY_SECRETS: PlanetSecrets = { cluster_token: null, storage_secret_access_key: null };

function toPublic(stored: StoredSettings, secrets: PlanetSecrets): PlanetSettings {
    return {
        instance_id: stored.instance_id,
        cluster: { ...stored.cluster, has_token: Boolean(secrets.cluster_token) },
        storage: { ...stored.storage, has_secret: Boolean(secrets.storage_secret_access_key) },
        user: { ...stored.user },
    };
}

async function readStored(tx: ReadTx): Promise<StoredSettings> {
    const stored = await tx.store("settings").get(SETTINGS_KEY);
    if (!stored) {
        throw new ApiError(500, "Planet settings are missing", ErrorCodes.INCONSISTENT_DATABASE);
    }
    return stored;
}

/** Returns the settings as the API exposes them: no secrets, `has_token`/`has_secret` flags. */
export function get(tx?: ReadTx): Promise<PlanetSettings> {
    return useRead(tx, ["settings", "secrets"], async (t) => {
        const stored = await readStored(t);
        const secrets = (await t.store("secrets").get(SECRETS_KEY)) ?? EMPTY_SECRETS;
        return toPublic(stored, secrets);
    });
}

/** Whether the cluster and the storage settings, secrets included, are complete enough to run jobs. */
export function configured(current: PlanetSettings): { cluster: boolean; storage: boolean } {
    const { cluster, storage } = current;
    return {
        cluster: Boolean(cluster.gateway_url && cluster.namespace && cluster.has_token),
        storage: Boolean(storage.endpoint && storage.bucket && storage.access_key_id && storage.has_secret),
    };
}

/** Returns the stored settings without secret flags. */
export function getStored(tx?: ReadTx): Promise<StoredSettings> {
    return useRead(tx, ["settings"], readStored);
}

/** Returns the stored secrets. For Planet's own S3 and Kubernetes clients; never send them to a page. */
export function getSecrets(tx?: ReadTx): Promise<PlanetSecrets> {
    return useRead(tx, ["secrets"], async (t) => (await t.store("secrets").get(SECRETS_KEY)) ?? EMPTY_SECRETS);
}

/** Applies `update` (see {@link SettingsUpdate}) and returns the public settings. */
export function update(change: SettingsUpdate, tx?: WriteTx): Promise<PlanetSettings> {
    return useWrite(tx, ["settings", "secrets"], async (t) => {
        const stored = await readStored(t);
        const secrets = { ...((await t.store("secrets").get(SECRETS_KEY)) ?? EMPTY_SECRETS) };
        const { token, ...cluster } = change.cluster ?? {};
        const { secret_access_key: secretAccessKey, ...storage } = change.storage ?? {};
        const next: StoredSettings = {
            instance_id: stored.instance_id,
            cluster: { ...stored.cluster, ...cluster },
            storage: { ...stored.storage, ...storage },
            user: { ...stored.user, ...(change.user ?? {}) },
        };
        if (token !== undefined) {
            secrets.cluster_token = token || null;
        } else if (rebindsToken(cluster, stored.cluster)) {
            secrets.cluster_token = null;
        }
        if (secretAccessKey !== undefined) {
            secrets.storage_secret_access_key = secretAccessKey || null;
        } else if (rebindsSecret(storage, stored.storage)) {
            secrets.storage_secret_access_key = null;
        }
        await t.store("settings").put(next, SETTINGS_KEY);
        await t.store("secrets").put(secrets, SECRETS_KEY);
        t.notify({ type: "settings-changed" });
        return toPublic(next, secrets);
    });
}

type FieldKind = "string" | "number" | "boolean";

const CLUSTER_FIELDS: Record<string, FieldKind> = {
    gateway_url: "string",
    namespace: "string",
    token: "string",
    runtime_image: "string",
    job_service_account: "string",
    default_cpu: "string",
    default_memory: "string",
    default_walltime_seconds: "number",
    scratch_default: "string",
    arch_policy: "string",
    user_namespaces: "boolean",
};

const STORAGE_FIELDS: Record<string, FieldKind> = {
    endpoint: "string",
    cluster_endpoint: "string",
    bucket: "string",
    prefix: "string",
    region: "string",
    path_style: "boolean",
    access_key_id: "string",
    secret_access_key: "string",
};

const USER_FIELDS: Record<string, FieldKind> = { email: "string", username: "string" };

const IGNORED_FIELDS = new Set(["has_token", "has_secret"]);

function readSection(
    input: unknown,
    section: string,
    fields: Record<string, FieldKind>,
): Record<string, unknown> | undefined {
    if (input === undefined) {
        return undefined;
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw invalid(`${section} must be an object`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        const kind = fields[key];
        if (!kind) {
            if (IGNORED_FIELDS.has(key)) {
                continue;
            }
            throw invalid(`Unknown setting ${section}.${key}`);
        }
        const nullableSecret = (key === "token" || key === "secret_access_key") && value === null;
        if (!nullableSecret && typeof value !== kind) {
            throw invalid(`${section}.${key} must be a ${kind}`);
        }
        out[key] = typeof value === "string" ? value.trim() : value;
    }
    return out;
}

function invalid(message: string): ApiError {
    return new ApiError(400, message, ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID);
}

/**
 * Validates an untrusted settings payload (the body of `PUT /api/planet/settings`) and returns it as a
 * {@link SettingsUpdate}. Read-only fields (`instance_id`, `has_token`, `has_secret`) are ignored.
 *
 * @throws ApiError 400 for unknown fields or wrong types
 */
export function parseSettingsUpdate(input: unknown): SettingsUpdate {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw invalid("Settings must be a JSON object");
    }
    const body = input as Record<string, unknown>;
    for (const key of Object.keys(body)) {
        if (!["cluster", "storage", "user", "instance_id"].includes(key)) {
            throw invalid(`Unknown setting ${key}`);
        }
    }
    const cluster = readSection(body.cluster, "cluster", CLUSTER_FIELDS);
    const storage = readSection(body.storage, "storage", STORAGE_FIELDS);
    const user = readSection(body.user, "user", USER_FIELDS);
    if (cluster?.arch_policy !== undefined && !["amd64-only", "any"].includes(cluster.arch_policy as string)) {
        throw invalid('cluster.arch_policy must be "amd64-only" or "any"');
    }
    const walltime = cluster?.default_walltime_seconds;
    if (walltime !== undefined && (!Number.isInteger(walltime) || (walltime as number) <= 0)) {
        throw invalid("cluster.default_walltime_seconds must be a positive integer");
    }
    return { cluster, storage, user } as SettingsUpdate;
}
