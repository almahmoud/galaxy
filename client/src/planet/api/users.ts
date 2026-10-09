/**
 * The single Planet user: GET /api/users, GET /api/users/{user_id}, the favorites and theme preferences, disk usage
 * and PUT /api/users/current/recalculate_disk_usage.
 */

import type { components } from "@/api/schema";
import { CONTENT_STORES, type ReadTx, readTx, settings, type WriteTx, writeTx } from "@/planet/db";
import { noContent } from "@/planet/sw/responses";
import type { Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { niceSize } from "@/planet/util/sizes";

type DetailedUserModel = components["schemas"]["DetailedUserModel"];
type UserModel = components["schemas"]["UserModel"];
type UserQuotaUsage = components["schemas"]["UserQuotaUsage"];
type FavoriteObjectsSummary = components["schemas"]["FavoriteObjectsSummary"];

/** Encoded id of the Planet user. There is one user per Planet instance, so the id is fixed. */
export const PLANET_USER_ID = "f9cad7b01a472135";

/** `kv` key of the user's preferences (Galaxy's `User.preferences`, string values). */
const PREFERENCES_KEY = "preferences";

export const FAVORITE_OBJECT_TYPES = ["tools", "tags", "edam_operations", "edam_topics"] as const;

export type FavoriteObjectType = (typeof FAVORITE_OBJECT_TYPES)[number];

export interface FavoriteOrderEntry {
    object_type: FavoriteObjectType;
    object_id: string;
}

/** Galaxy's normalized favorites document (`managers/favorites.py`). */
export interface Favorites {
    tools: string[];
    tags: string[];
    edam_operations: string[];
    edam_topics: string[];
    order: FavoriteOrderEntry[];
}

/** The fields of the user that other serializers need. */
export interface UserProfile {
    id: string;
    email: string;
    username: string;
}

/** Returns the user's id, email and username (from Planet settings). */
export async function userProfile(tx?: ReadTx): Promise<UserProfile> {
    const stored = await settings.getStored(tx);
    return { id: PLANET_USER_ID, email: stored.user.email, username: stored.user.username };
}

/**
 * Checks a `{user_id}` path parameter. `current` and the Planet user's id are accepted.
 *
 * @throws ApiError 400 for any other id, as Galaxy answers for users the caller cannot see
 */
export function resolveUserId(userId: string): string {
    if (userId !== "current" && userId !== PLANET_USER_ID) {
        throw ApiError.badRequest("Invalid user id specified");
    }
    return PLANET_USER_ID;
}

/** Reads the preferences map stored in `kv`. */
export async function readPreferences(tx: ReadTx): Promise<Record<string, string>> {
    const stored = await tx.store("kv").get(PREFERENCES_KEY);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
        return {};
    }
    const preferences: Record<string, string> = {};
    for (const [name, value] of Object.entries(stored)) {
        if (typeof value === "string") {
            preferences[name] = value;
        }
    }
    return preferences;
}

async function writePreferences(preferences: Record<string, string>, tx: WriteTx): Promise<void> {
    await tx.store("kv").put(preferences, PREFERENCES_KEY);
}

/**
 * Bytes used by the user: the total size of each distinct, non-purged dataset that a non-purged HDA in any history
 * points to (Galaxy's `User.total_disk_usage` for the default quota source).
 */
export function totalDiskUsage(tx?: ReadTx): Promise<number> {
    const run = async (t: ReadTx): Promise<number> => {
        const datasetIds = new Set<string>();
        for (const hda of await t.store("hdas").getAll()) {
            if (!hda.purged) {
                datasetIds.add(hda.dataset_id);
            }
        }
        const datasets = await Promise.all([...datasetIds].map((id) => t.store("datasets").get(id)));
        let total = 0;
        for (const dataset of datasets) {
            if (dataset && !dataset.purged) {
                total += dataset.total_size ?? dataset.file_size ?? 0;
            }
        }
        return total;
    };
    return tx ? run(tx) : readTx(CONTENT_STORES, run);
}

/** Galaxy's `UserModel` for the Planet user (`/api/whoami`, `/api/users`). */
export async function userSummary(): Promise<UserModel> {
    const profile = await userProfile();
    return {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        active: true,
        deleted: false,
        last_password_change: null,
        model_class: "User",
    };
}

/** Galaxy's `DetailedUserModel` for the Planet user (`/api/users/current`, `/context`). */
export async function detailedUser(): Promise<DetailedUserModel> {
    const { profile, preferences, usage } = await readTx([...CONTENT_STORES, "settings", "kv"], async (t) => ({
        profile: await userProfile(t),
        preferences: await readPreferences(t),
        usage: await totalDiskUsage(t),
    }));
    return {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        display_name: null,
        is_admin: false,
        deleted: false,
        purged: false,
        preferences,
        preferred_object_store_id: null,
        total_disk_usage: usage,
        nice_total_disk_usage: niceSize(usage),
        quota: "unlimited",
        quota_bytes: null,
        quota_percent: null,
    };
}

function defaultUsage(total: number): UserQuotaUsage {
    return {
        quota_source_label: null,
        total_disk_usage: total,
        quota: "unlimited",
        quota_bytes: null,
        quota_percent: null,
    };
}

function isFavoriteType(value: string): value is FavoriteObjectType {
    return (FAVORITE_OBJECT_TYPES as readonly string[]).includes(value);
}

function parseFavoriteType(value: string): FavoriteObjectType {
    if (!isFavoriteType(value)) {
        throw ApiError.badRequest(`Unsupported favorite object type '${value}'.`);
    }
    return value;
}

/** Normalizes a stored favorites document like Galaxy's `FavoritesManager`. */
export function normalizeFavorites(raw: unknown): Favorites {
    const source =
        typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const favorites: Favorites = { tools: [], tags: [], edam_operations: [], edam_topics: [], order: [] };
    for (const type of FAVORITE_OBJECT_TYPES) {
        const ids = Array.isArray(source[type]) ? (source[type] as unknown[]) : [];
        for (const id of ids) {
            if (typeof id === "string" && id && !favorites[type].includes(id)) {
                favorites[type].push(id);
            }
        }
    }
    const seen = new Set<string>();
    for (const entry of Array.isArray(source.order) ? (source.order as unknown[]) : []) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const { object_type: type, object_id: id } = entry as Record<string, unknown>;
        if (typeof type !== "string" || typeof id !== "string" || !isFavoriteType(type)) {
            continue;
        }
        const key = `${type}\u0000${id}`;
        if (favorites[type].includes(id) && !seen.has(key)) {
            seen.add(key);
            favorites.order.push({ object_type: type, object_id: id });
        }
    }
    for (const type of FAVORITE_OBJECT_TYPES) {
        for (const id of favorites[type]) {
            const key = `${type}\u0000${id}`;
            if (!seen.has(key)) {
                seen.add(key);
                favorites.order.push({ object_type: type, object_id: id });
            }
        }
    }
    return favorites;
}

function parseStoredFavorites(preferences: Record<string, string>): Favorites {
    const stored = preferences.favorites;
    if (!stored) {
        return normalizeFavorites({});
    }
    try {
        return normalizeFavorites(JSON.parse(stored));
    } catch {
        return normalizeFavorites({});
    }
}

/** Applies `change` to the stored favorites and returns the saved document. */
function updateFavorites(change: (favorites: Favorites) => Favorites): Promise<FavoriteObjectsSummary> {
    return writeTx(["kv"], async (t) => {
        const preferences = await readPreferences(t);
        const next = normalizeFavorites(change(parseStoredFavorites(preferences)));
        await writePreferences({ ...preferences, favorites: JSON.stringify(next) }, t);
        return next;
    });
}

function readObjectId(body: unknown): string {
    const objectId =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>).object_id : undefined;
    if (typeof objectId !== "string") {
        throw ApiError.badRequest("object_id must be a string", ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID);
    }
    const trimmed = objectId.trim();
    if (!trimmed) {
        throw ApiError.badRequest("Favorite cannot be empty.");
    }
    return trimmed;
}

function readOrder(body: unknown): FavoriteOrderEntry[] {
    const order = typeof body === "object" && body !== null ? (body as Record<string, unknown>).order : undefined;
    if (order === undefined) {
        return [];
    }
    if (!Array.isArray(order)) {
        throw ApiError.badRequest("order must be a list", ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID);
    }
    return order.map((entry) => {
        const { object_type: type, object_id: id } =
            typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
        if (typeof type !== "string" || typeof id !== "string") {
            throw ApiError.badRequest(
                "order entries need object_type and object_id",
                ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID,
            );
        }
        return { object_type: parseFavoriteType(type), object_id: id };
    });
}

function addFavorite(type: FavoriteObjectType, objectId: string): Promise<FavoriteObjectsSummary> {
    return updateFavorites((favorites) => {
        if (!favorites[type].includes(objectId)) {
            favorites[type].push(objectId);
        }
        return favorites;
    });
}

function removeFavorite(type: FavoriteObjectType, objectId: string): Promise<FavoriteObjectsSummary> {
    return updateFavorites((favorites) => {
        if (!favorites[type].includes(objectId)) {
            throw ApiError.notFound("Given object is not in the list of favorites");
        }
        favorites[type] = favorites[type].filter((id) => id !== objectId);
        return favorites;
    });
}

function setFavoriteOrder(order: FavoriteOrderEntry[]): Promise<FavoriteObjectsSummary> {
    return updateFavorites((favorites) => {
        const current = new Set(favorites.order.map((entry) => `${entry.object_type}\u0000${entry.object_id}`));
        const requested = new Set(order.map((entry) => `${entry.object_type}\u0000${entry.object_id}`));
        if (
            order.length !== favorites.order.length ||
            requested.size !== current.size ||
            [...requested].some((key) => !current.has(key))
        ) {
            throw ApiError.badRequest("Favorite order must contain every current favorite exactly once.");
        }
        const next: Favorites = { tools: [], tags: [], edam_operations: [], edam_topics: [], order };
        for (const entry of order) {
            next[entry.object_type].push(entry.object_id);
        }
        return next;
    });
}

export function register(router: Router): void {
    router.route("/api/users", "get", async () => [await userSummary()]);

    router.route("/api/users/{user_id}", "get", async ({ params }) => {
        resolveUserId(params.user_id);
        return detailedUser();
    });

    router.route("/api/users/{user_id}/favorites/{object_type}", "put", async ({ params, json }) => {
        resolveUserId(params.user_id);
        return addFavorite(parseFavoriteType(params.object_type), readObjectId(await json()));
    });

    // Tool ids contain slashes, so the id takes the rest of the path as in Galaxy's route.
    router.untyped(
        "/api/users/{user_id}/favorites/{object_type}/{object_id:path}",
        "delete",
        async ({ params }): Promise<FavoriteObjectsSummary> => {
            resolveUserId(params.user_id!);
            return removeFavorite(parseFavoriteType(params.object_type!), params.object_id!);
        },
    );

    router.route("/api/users/{user_id}/favorites/order", "put", async ({ params, json }) => {
        resolveUserId(params.user_id);
        return setFavoriteOrder(readOrder(await json()));
    });

    router.route("/api/users/{user_id}/theme/{theme}", "put", async ({ params }) => {
        resolveUserId(params.user_id);
        const theme = params.theme;
        await writeTx(["kv"], async (t) => {
            await writePreferences({ ...(await readPreferences(t)), theme }, t);
        });
        return theme;
    });

    router.route("/api/users/{user_id}/usage", "get", async ({ params }) => {
        resolveUserId(params.user_id);
        return [defaultUsage(await totalDiskUsage())];
    });

    router.route("/api/users/{user_id}/usage/{label}", "get", async ({ params }) => {
        resolveUserId(params.user_id);
        if (params.label === "__null__") {
            return defaultUsage(await totalDiskUsage());
        }
        return { ...defaultUsage(0), quota_source_label: params.label };
    });

    router.route("/api/users/{user_id}/objectstore_usage", "get", ({ params }) => {
        resolveUserId(params.user_id);
        return [];
    });

    // Disk usage is computed on every read, so there is nothing to recalculate.
    router.route("/api/users/current/recalculate_disk_usage", "put", () => noContent());
    router.route("/api/users/recalculate_disk_usage", "put", () => noContent());
}
