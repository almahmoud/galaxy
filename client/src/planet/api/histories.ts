/**
 * GET/POST /api/histories, GET /api/histories/count, GET /api/histories/deleted, GET/PUT/DELETE
 * /api/histories/{history_id}, POST /api/histories/deleted/{history_id}/undelete and PUT
 * /api/histories/batch/{delete,undelete}. The serializer follows `HistorySerializer` (`managers/histories.py`).
 */

import type { components } from "@/api/schema";
import {
    CONTENT_STORES,
    type HdaRecord,
    type HdcaRecord,
    histories,
    type HistoryRecord,
    JOB_STORES,
    type ReadTx,
    readTx,
    withTransaction,
    type WriteTx,
} from "@/planet/db";
import { json, passthrough, type TypedResponse } from "@/planet/sw/responses";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import {
    type FilteredTerm,
    HISTORY_FILTER_SPEC,
    type HistoryFilter,
    type HistoryFilterSubject,
    matchesHistoryFilters,
    parseFilters,
    parseSearch,
    type RawTextTerm,
    readQueryFilters,
    sqlLike,
} from "@/planet/util/filters";
import { queryBool } from "@/planet/util/query";
import { niceSize } from "@/planet/util/sizes";
import { DATASET_STATES, type DatasetState, NON_READY_JOB_STATES } from "@/planet/util/states";

import {
    asObject,
    copyContentsInto,
    invalidValue,
    normalizeTags,
    pagination,
    purgeHda,
    readBool,
    readNullableString,
    readString,
    readStringList,
    resolveKeys,
    serializationParams,
} from "./contents";
import { type UserProfile, userProfile } from "./users";

type HistoryActiveContentCounts = components["schemas"]["HistoryActiveContentCounts"];

/** Every key the history serializer can produce, with its type. */
export interface HistoryFields {
    id: string;
    model_class: "History";
    name: string;
    deleted: boolean;
    purged: boolean;
    archived: boolean;
    count: number;
    url: string;
    published: boolean;
    annotation: string | null;
    tags: string[];
    update_time: string;
    preferred_object_store_id: string | null;
    contents_url: string;
    email_hash: string | null;
    empty: boolean;
    size: number;
    nice_size: string;
    user_id: string;
    create_time: string;
    importable: boolean;
    slug: string | null;
    username: string;
    username_and_slug: string | null;
    genome_build: string | null;
    state: DatasetState;
    state_details: Record<string, number>;
    state_ids: Record<string, string[]>;
    hid_counter: number;
    contents_active: HistoryActiveContentCounts;
    contents_states: Record<string, number>;
    hdas: string[];
    non_ready_jobs: string[];
    title: string;
    users_shared_with: string[];
}

export type HistoryKey = keyof HistoryFields;

export const HISTORY_SUMMARY_KEYS = [
    "id",
    "model_class",
    "name",
    "deleted",
    "purged",
    "archived",
    "count",
    "url",
    "published",
    "annotation",
    "tags",
    "update_time",
    "preferred_object_store_id",
] as const satisfies readonly HistoryKey[];

export const HISTORY_DETAILED_KEYS = [
    ...HISTORY_SUMMARY_KEYS,
    "contents_url",
    "email_hash",
    "empty",
    "size",
    "user_id",
    "create_time",
    "importable",
    "slug",
    "username",
    "username_and_slug",
    "genome_build",
    "state",
    "state_details",
    "state_ids",
    "hid_counter",
] as const satisfies readonly HistoryKey[];

export const HISTORY_DEV_DETAILED_KEYS = [
    ...HISTORY_SUMMARY_KEYS,
    "contents_url",
    "size",
    "user_id",
    "create_time",
    "importable",
    "slug",
    "username_and_slug",
    "genome_build",
    "contents_active",
    "hid_counter",
] as const satisfies readonly HistoryKey[];

const HISTORY_SHARING_KEYS = [
    "id",
    "title",
    "email_hash",
    "importable",
    "published",
    "username",
    "username_and_slug",
    "users_shared_with",
] as const satisfies readonly HistoryKey[];

export const HISTORY_VIEWS: Readonly<Record<string, readonly HistoryKey[]>> = {
    summary: HISTORY_SUMMARY_KEYS,
    detailed: HISTORY_DETAILED_KEYS,
    "dev-detailed": HISTORY_DEV_DETAILED_KEYS,
    sharing: HISTORY_SHARING_KEYS,
};

export type HistorySummaryView = Pick<HistoryFields, (typeof HISTORY_SUMMARY_KEYS)[number]>;
export type HistoryDetailedView = Pick<HistoryFields, (typeof HISTORY_DETAILED_KEYS)[number]>;
export type HistoryDevDetailedView = Pick<HistoryFields, (typeof HISTORY_DEV_DETAILED_KEYS)[number]>;

/** A serialized history whose keys were chosen at request time. */
export type HistoryView = Partial<HistoryFields>;

/** Keys whose values need a pass over the history's contents. */
const AGGREGATE_KEYS: ReadonlySet<string> = new Set<HistoryKey>([
    "size",
    "nice_size",
    "state",
    "state_details",
    "state_ids",
    "contents_active",
    "contents_states",
    "hdas",
    "non_ready_jobs",
]);

/** Values computed from a history's contents and jobs. */
interface HistoryAggregates {
    size: number;
    stateDetails: Record<string, number>;
    stateIds: Record<string, string[]>;
    contentsActive: HistoryActiveContentCounts;
    contentsStates: Record<string, number>;
    hdaIds: string[];
    nonReadyJobIds: string[];
}

function emptyStateCounts(): Record<string, number> {
    return Object.fromEntries(DATASET_STATES.map((state) => [state, 0]));
}

async function aggregate(historyId: string, tx: ReadTx): Promise<HistoryAggregates> {
    const hdas: HdaRecord[] = await tx.store("hdas").index("history_id").getAll(historyId);
    const hdcas: HdcaRecord[] = await tx.store("hdcas").index("history_id").getAll(historyId);
    hdas.sort((a, b) => a.hid - b.hid);
    const datasets = await Promise.all(hdas.map((hda) => tx.store("datasets").get(hda.dataset_id)));
    const collections = await Promise.all(hdcas.map((hdca) => tx.store("collections").get(hdca.collection_id)));
    const jobs = await tx.store("jobs").index("history_id").getAll(historyId);

    const stateDetails = emptyStateCounts();
    const stateIds: Record<string, string[]> = Object.fromEntries(DATASET_STATES.map((state) => [state, []]));
    const contentsActive: HistoryActiveContentCounts = { active: 0, deleted: 0, hidden: 0 };
    const contentsStates: Record<string, number> = {};
    const sized = new Set<string>();
    let size = 0;

    const count = (item: { deleted: boolean; visible: boolean }, state: string | undefined) => {
        if (item.deleted) {
            contentsActive.deleted++;
        }
        if (!item.visible) {
            contentsActive.hidden++;
        }
        if (!item.deleted && item.visible) {
            contentsActive.active++;
            if (state) {
                contentsStates[state] = (contentsStates[state] ?? 0) + 1;
            }
        }
    };

    hdas.forEach((hda, index) => {
        const dataset = datasets[index];
        const state: DatasetState = hda._state ?? dataset?.state ?? "new";
        (stateIds[state] ??= []).push(hda.id);
        if (!hda.deleted) {
            stateDetails[state] = (stateDetails[state] ?? 0) + 1;
        }
        count(hda, state);
        if (dataset && !hda.purged && !dataset.purged && !sized.has(dataset.id)) {
            sized.add(dataset.id);
            size += dataset.total_size ?? dataset.file_size ?? 0;
        }
    });
    hdcas.forEach((hdca, index) => count(hdca, collections[index]?.populated_state));

    return {
        size,
        stateDetails,
        stateIds,
        contentsActive,
        contentsStates,
        hdaIds: hdas.map((hda) => hda.id),
        nonReadyJobIds: jobs.filter((job) => NON_READY_JOB_STATES.has(job.state)).map((job) => job.id),
    };
}

/** The history state Galaxy derives from the states of its non-deleted datasets. */
function historyState(history: HistoryRecord, counts: Record<string, number>): DatasetState {
    if (history.hid_counter <= 1) {
        return "new";
    }
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const n = (state: DatasetState) => counts[state] ?? 0;
    if (n("running") > 0 || n("setting_metadata") > 0 || n("upload") > 0) {
        return "running";
    }
    if (n("queued") > 0 || n("new") > 0) {
        return "queued";
    }
    if (n("error") > 0 || n("failed_metadata") > 0) {
        return "error";
    }
    if (n("ok") + n("deferred") === total) {
        return "ok";
    }
    return "error";
}

type HistoryValueContext = { history: HistoryRecord; user: UserProfile; aggregates: HistoryAggregates | undefined };

function requireAggregates(context: HistoryValueContext): HistoryAggregates {
    if (!context.aggregates) {
        throw new Error("history aggregates were not loaded");
    }
    return context.aggregates;
}

const HISTORY_SERIALIZERS: { [K in HistoryKey]: (context: HistoryValueContext) => HistoryFields[K] } = {
    id: ({ history }) => history.id,
    model_class: () => "History",
    name: ({ history }) => history.name,
    deleted: ({ history }) => history.deleted,
    purged: ({ history }) => history.purged,
    archived: ({ history }) => history.archived,
    count: ({ history }) => history.hid_counter - 1,
    url: ({ history }) => `/api/histories/${history.id}`,
    published: ({ history }) => history.published,
    annotation: ({ history }) => history.annotation?.trim() || null,
    tags: ({ history }) => [...history.tags],
    update_time: ({ history }) => history.update_time,
    preferred_object_store_id: ({ history }) => history.preferred_object_store_id,
    contents_url: ({ history }) => `/api/histories/${history.id}/contents`,
    email_hash: () => null,
    empty: ({ history }) => history.hid_counter <= 1,
    size: (context) => requireAggregates(context).size,
    nice_size: (context) => niceSize(requireAggregates(context).size),
    user_id: ({ user }) => user.id,
    create_time: ({ history }) => history.create_time,
    importable: ({ history }) => history.importable,
    slug: ({ history }) => history.slug,
    username: ({ user }) => user.username,
    username_and_slug: ({ history, user }) =>
        history.slug && user.username ? `u/${user.username}/h/${history.slug}` : null,
    genome_build: ({ history }) => history.genome_build,
    state: (context) => historyState(context.history, requireAggregates(context).stateDetails),
    state_details: (context) => requireAggregates(context).stateDetails,
    state_ids: (context) => requireAggregates(context).stateIds,
    hid_counter: ({ history }) => history.hid_counter,
    contents_active: (context) => requireAggregates(context).contentsActive,
    contents_states: (context) => requireAggregates(context).contentsStates,
    hdas: (context) => requireAggregates(context).hdaIds,
    non_ready_jobs: (context) => requireAggregates(context).nonReadyJobIds,
    title: ({ history }) => history.name,
    users_shared_with: () => [],
};

function isHistoryKey(key: string): key is HistoryKey {
    return Object.hasOwn(HISTORY_SERIALIZERS, key);
}

function serializeOne(context: HistoryValueContext, keys: readonly string[]): HistoryView {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        if (isHistoryKey(key) && !Object.hasOwn(out, key)) {
            out[key] = HISTORY_SERIALIZERS[key](context);
        }
    }
    return out as HistoryView;
}

/**
 * Serializes histories with the given keys (see {@link resolveKeys}). Unknown keys are skipped, as in Galaxy. Pass
 * `tx` (over {@link CONTENT_STORES}, `jobs` and `settings`) to read in an existing transaction.
 */
export async function serializeHistories(
    records: readonly HistoryRecord[],
    keys: readonly string[],
    tx?: ReadTx,
): Promise<HistoryView[]> {
    const needsAggregates = keys.some((key) => AGGREGATE_KEYS.has(key));
    const run = async (t: ReadTx) => {
        const user = await userProfile(t);
        const aggregates = needsAggregates
            ? await Promise.all(records.map((history) => aggregate(history.id, t)))
            : records.map(() => undefined);
        return records.map((history, index) => serializeOne({ history, user, aggregates: aggregates[index] }, keys));
    };
    return tx ? run(tx) : readTx([...CONTENT_STORES, "jobs", "settings"], run);
}

/** Serializes one history (see {@link serializeHistories}). */
export async function serializeHistory(
    history: HistoryRecord,
    keys: readonly string[],
    tx?: ReadTx,
): Promise<HistoryView> {
    const [serialized] = await serializeHistories([history], keys, tx);
    return serialized!;
}

/** Serializes a history in a fixed view with a precise type. */
export async function serializeHistoryView<K extends HistoryKey>(
    history: HistoryRecord,
    keys: readonly K[],
    tx?: ReadTx,
): Promise<Pick<HistoryFields, K>> {
    return (await serializeHistory(history, keys, tx)) as Pick<HistoryFields, K>;
}

function filterSubject(history: HistoryRecord, user: UserProfile): HistoryFilterSubject {
    return {
        name: history.name,
        genome_build: history.genome_build,
        slug: history.slug,
        create_time: history.create_time,
        update_time: history.update_time,
        deleted: history.deleted,
        purged: history.purged,
        published: history.published,
        importable: history.importable,
        tags: history.tags,
        annotation: history.annotation,
        username: user.username,
    };
}

type HistoryComparator = (a: HistoryRecord, b: HistoryRecord, sizes: ReadonlyMap<string, number>) => number;

function compare(a: string | number, b: string | number): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function lowerAscii(value: string): string {
    return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * Parses the `order` parameter of the history list (`HistoryManager.parse_order_by`); a comma-separated value
 * stacks orders.
 *
 * @throws ApiError 400 for an unknown order
 */
export function parseHistoryOrder(value: string | null): { comparators: HistoryComparator[]; needsSize: boolean } {
    const comparators: HistoryComparator[] = [];
    let needsSize = false;
    for (const part of (value || "create_time-dsc").split(",")) {
        let comparator: HistoryComparator;
        switch (part) {
            case "create_time":
            case "create_time-dsc":
                comparator = (a, b) => -compare(a.create_time, b.create_time);
                break;
            case "create_time-asc":
                comparator = (a, b) => compare(a.create_time, b.create_time);
                break;
            case "update_time":
            case "update_time-dsc":
                comparator = (a, b) => -compare(a.update_time, b.update_time);
                break;
            case "update_time-asc":
                comparator = (a, b) => compare(a.update_time, b.update_time);
                break;
            case "name":
            case "name-asc":
                comparator = (a, b) => compare(lowerAscii(a.name), lowerAscii(b.name));
                break;
            case "name-dsc":
                comparator = (a, b) => -compare(lowerAscii(a.name), lowerAscii(b.name));
                break;
            case "size":
            case "size-dsc":
                needsSize = true;
                comparator = (a, b, sizes) => -compare(sizes.get(a.id) ?? 0, sizes.get(b.id) ?? 0);
                break;
            case "size-asc":
                needsSize = true;
                comparator = (a, b, sizes) => compare(sizes.get(a.id) ?? 0, sizes.get(b.id) ?? 0);
                break;
            default:
                throw new ApiError(400, "Unknown order_by", ErrorCodes.USER_REQUEST_INVALID_PARAMETER, {
                    order_by: part,
                    available: ["create_time", "update_time", "name", "size"],
                });
        }
        comparators.push(comparator);
    }
    return { comparators, needsSize };
}

/** Ties keep creation order, as Galaxy's integer ids do. */
function tiebreak(a: HistoryRecord, b: HistoryRecord, descending: boolean): number {
    const result = compare(a.create_time, b.create_time) || compare(a.id, b.id);
    return descending ? -result : result;
}

async function historySizes(records: readonly HistoryRecord[], tx: ReadTx): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (const history of records) {
        sizes.set(history.id, await histories.diskSize(history.id, tx));
    }
    return sizes;
}

/** `GET /api/histories` without `search`: `q`/`qv` filters, `order`, `offset` and `limit`. */
async function indexByFilters(query: URLSearchParams, deletedOnly: boolean): Promise<HistoryView[]> {
    if (queryBool(query, "all", false)) {
        throw ApiError.forbidden("Only admins can query all histories", ErrorCodes.ADMIN_REQUIRED);
    }
    const raw = readQueryFilters(query);
    const isDeletedFilter = (value: string) => (filter: { attr: string; op: string; value: string }) =>
        filter.attr === "deleted" && filter.op === "eq" && filter.value.toLowerCase() === value;
    const anyDeleted = raw.findIndex(isDeletedFilter("none"));
    let deletedFilter: boolean | null = null;
    if (anyDeleted !== -1) {
        raw.splice(anyDeleted, 1);
    } else if (deletedOnly) {
        deletedFilter = true;
    } else if (!raw.some(isDeletedFilter("true"))) {
        deletedFilter = false;
    }
    const filters = parseFilters<HistoryFilter>(raw, HISTORY_FILTER_SPEC);
    const { comparators, needsSize } = parseHistoryOrder(query.get("order"));
    const { offset, limit } = pagination(query);
    const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "summary");

    return readTx([...CONTENT_STORES, "jobs", "settings"], async (t) => {
        const user = await userProfile(t);
        const all = await t.store("histories").getAll();
        const matched = all.filter(
            (history) =>
                !history.archived &&
                (deletedFilter === null || history.deleted === deletedFilter) &&
                matchesHistoryFilters(filterSubject(history, user), filters),
        );
        const sizes = needsSize ? await historySizes(matched, t) : new Map<string, number>();
        matched.sort((a, b) => {
            for (const comparator of comparators) {
                const result = comparator(a, b, sizes);
                if (result) {
                    return result;
                }
            }
            return tiebreak(a, b, true);
        });
        const page = matched.slice(offset, limit === null ? undefined : offset + limit);
        return serializeHistories(page, keys, t);
    });
}

function ilikeContains(value: string | null, text: string): boolean {
    return value !== null && value.toLowerCase().includes(text.toLowerCase());
}

function splitTag(tag: string): { name: string; value: string | null } {
    const separator = tag.indexOf(":");
    return separator === -1
        ? { name: tag, value: null }
        : { name: tag.slice(0, separator), value: tag.slice(separator + 1) };
}

/** Galaxy's `tag_filter` (`model/index_filter_util.py`) against stored tag strings. */
export function matchesTagTerm(tags: readonly string[], text: string, quoted: boolean): boolean {
    return tags.some((tag) => {
        const { name, value } = splitTag(tag);
        const separator = text.lastIndexOf(":");
        if (separator !== -1) {
            const key = text.slice(0, separator);
            const wanted = text.slice(separator + 1);
            if (quoted) {
                return name === key && value === wanted;
            }
            return sqlLike(name.toLowerCase(), key.toLowerCase()) && ilikeContains(value, wanted);
        }
        if (quoted) {
            return name === text;
        }
        return ilikeContains(name, text) || (name.toLowerCase() === "name" && ilikeContains(value, text));
    });
}

function matchesText(value: string, term: FilteredTerm): boolean {
    return term.quoted ? value === term.text : ilikeContains(value, term.text);
}

type HistorySortBy = "create_time" | "name" | "update_time" | "username";

/** `GET /api/histories?search=...` (`HistoryManager.index_query`). Returns the page and `total_matches`. */
async function indexBySearch(query: URLSearchParams): Promise<{ items: HistoryView[]; total: number }> {
    const showOwn = queryBool(query, "show_own", true)!;
    const showPublished = queryBool(query, "show_published", true)!;
    const showShared = queryBool(query, "show_shared", false)!;
    const showArchived = queryBool(query, "show_archived", null);
    const sortBy = (query.get("sort_by") || "update_time") as HistorySortBy;
    if (!["create_time", "name", "update_time", "username"].includes(sortBy)) {
        throw ApiError.badRequest(`Invalid sort_by: ${sortBy}`);
    }
    const sortDesc = queryBool(query, "sort_desc", true)!;
    const { offset, limit } = pagination(query);
    const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "summary");
    const parsed = parseSearch(query.get("search") ?? "", { name: "name", user: "user", tag: "tag", is: "is" });

    let showDeleted = false;
    let showPurged = false;
    const predicates: ((history: HistoryRecord, user: UserProfile) => boolean)[] = [];
    for (const term of parsed.terms) {
        if (term.kind === "filter") {
            switch (term.filter) {
                case "tag":
                    predicates.push((history) => matchesTagTerm(history.tags, term.text, term.quoted));
                    break;
                case "name":
                    predicates.push((history) => matchesText(history.name, term));
                    break;
                case "user":
                    predicates.push((_, user) => matchesText(user.username, term));
                    break;
                case "is":
                    if (term.text === "deleted") {
                        showDeleted = true;
                    } else if (term.text === "purged") {
                        showPurged = true;
                    } else if (term.text === "importable") {
                        predicates.push((history) => history.importable);
                    } else if (term.text === "published") {
                        predicates.push((history) => history.published);
                    } else if (term.text === "shared_with_me") {
                        if (!showShared) {
                            throw ApiError.badRequest(
                                "Can only use tag is:shared_with_me if show_shared parameter also true.",
                            );
                        }
                        predicates.push(() => false);
                    }
                    break;
            }
        } else {
            const text: RawTextTerm = term;
            predicates.push(
                (history, user) =>
                    ilikeContains(history.name, text.text) ||
                    matchesTagTerm(history.tags, text.text, false) ||
                    ilikeContains(user.username, text.text),
            );
        }
    }
    if (showPublished || showShared) {
        showDeleted = false;
        showPurged = false;
    }
    const own = showOwn || (!showPublished && !showShared);

    return readTx([...CONTENT_STORES, "jobs", "settings"], async (t) => {
        const user = await userProfile(t);
        const all = await t.store("histories").getAll();
        const matched = all.filter((history) => {
            if (!(own || (showPublished && history.published))) {
                return false;
            }
            if (showPurged ? !history.purged : history.purged || history.deleted !== showDeleted) {
                return false;
            }
            if (showOwn && !showArchived && history.archived) {
                return false;
            }
            return predicates.every((predicate) => predicate(history, user));
        });
        const value = (history: HistoryRecord): string =>
            sortBy === "name" ? lowerAscii(history.name) : sortBy === "username" ? user.username : history[sortBy];
        matched.sort((a, b) => {
            const result = compare(value(a), value(b));
            return (sortDesc ? -result : result) || tiebreak(a, b, sortDesc);
        });
        const page = matched.slice(offset, limit === null ? undefined : offset + limit);
        return { items: await serializeHistories(page, keys, t), total: matched.length };
    });
}

/**
 * Marks a history deleted, and with `purge` also purges its datasets and deletes its collections
 * (`HistoryManager.purge`). Runs in `tx`, which must cover {@link JOB_STORES}.
 */
export async function deleteHistory(historyId: string, purge: boolean, tx: WriteTx): Promise<HistoryRecord> {
    const history = await histories.getOrThrow(historyId, tx);
    if (!purge) {
        return history.deleted ? history : histories.markDeleted(historyId, {}, tx);
    }
    for (const hda of await tx.store("hdas").index("history_id").getAll(historyId)) {
        if (!hda.purged) {
            await purgeHda(hda.id, tx);
        }
    }
    for (const hdca of await tx.store("hdcas").index("history_id").getAll(historyId)) {
        if (!hdca.deleted) {
            hdca.deleted = true;
            hdca.update_time = tx.now;
            await tx.store("hdcas").put(hdca);
        }
    }
    return histories.markDeleted(historyId, { purge: true }, tx);
}

/** Applies an update payload (`HistoryDeserializer`); unknown keys are ignored. Runs in a {@link JOB_STORES} tx. */
async function updateHistory(historyId: string, payload: Record<string, unknown>, tx: WriteTx): Promise<HistoryRecord> {
    let history = await histories.getOrThrow(historyId, tx);
    const patch: histories.HistoryPatch = {};
    if ("name" in payload) {
        patch.name = readString(payload, "name");
    }
    if ("annotation" in payload) {
        patch.annotation = readNullableString(payload, "annotation");
    }
    if ("genome_build" in payload) {
        const value = readNullableString(payload, "genome_build");
        patch.genome_build = value ?? "?";
    }
    if ("tags" in payload) {
        patch.tags = normalizeTags(readStringList(payload, "tags"));
    }
    if ("importable" in payload) {
        patch.importable = readBool(payload, "importable");
    }
    if ("published" in payload) {
        patch.published = readBool(payload, "published");
        if (patch.published) {
            patch.importable = true;
        }
    }
    if ("preferred_object_store_id" in payload) {
        const value = readNullableString(payload, "preferred_object_store_id");
        if (value !== null) {
            throw ApiError.badRequest("Planet has no selectable object stores");
        }
        patch.preferred_object_store_id = null;
    }
    if (Object.keys(patch).length) {
        history = await histories.update(historyId, patch, tx);
    }
    if ("deleted" in payload) {
        const deleted = readBool(payload, "deleted");
        if (deleted !== history.deleted) {
            history = deleted ? await deleteHistory(historyId, false, tx) : await histories.undelete(historyId, tx);
        }
    }
    if ("purged" in payload && readBool(payload, "purged") && !history.purged) {
        history = await deleteHistory(historyId, true, tx);
    }
    return history;
}

interface CreateHistoryPayload {
    name: string | null;
    history_id: string | null;
    all_datasets: boolean;
    archive_source: unknown;
}

function parseFormBool(value: string | null, fallback: boolean): boolean {
    if (value === null || value === "") {
        return fallback;
    }
    return ["true", "1", "yes", "on"].includes(value.toLowerCase());
}

async function readCreatePayload(request: PlanetRequest): Promise<CreateHistoryPayload> {
    const contentType = request.headers.get("content-type") ?? "";
    let fields: Record<string, unknown>;
    if (contentType.includes("application/x-www-form-urlencoded")) {
        const form = new URLSearchParams(await request.text());
        fields = {
            name: form.get("name"),
            history_id: form.get("history_id"),
            all_datasets: parseFormBool(form.get("all_datasets"), true),
            archive_source: form.get("archive_source"),
        };
    } else if (contentType.includes("multipart/form-data")) {
        const form = await request.raw.formData();
        const text = (name: string) => {
            const value = form.get(name);
            return typeof value === "string" ? value : null;
        };
        fields = {
            name: text("name"),
            history_id: text("history_id"),
            all_datasets: parseFormBool(text("all_datasets"), true),
            archive_source: text("archive_source") ?? (form.get("archive_file") ? "file" : null),
        };
    } else {
        fields = asObject(await request.json());
    }
    const name = fields.name ?? null;
    if (name !== null && typeof name !== "string") {
        throw invalidValue("name", "a string");
    }
    const historyId = fields.history_id ?? null;
    if (historyId !== null && typeof historyId !== "string") {
        throw invalidValue("history_id", "a string");
    }
    const allDatasets = fields.all_datasets ?? true;
    if (typeof allDatasets !== "boolean") {
        throw invalidValue("all_datasets", "a boolean");
    }
    return { name, history_id: historyId, all_datasets: allDatasets, archive_source: fields.archive_source ?? null };
}

/** Creates a history, or copies one (`History.copy`): hids and the hid counter are kept. */
async function createHistory(payload: CreateHistoryPayload): Promise<HistoryRecord> {
    if (payload.archive_source) {
        throw ApiError.notImplemented("Importing histories from archives is not available in Planet");
    }
    return withTransaction(JOB_STORES, "readwrite", async (t) => {
        if (!payload.history_id) {
            return histories.create({ name: payload.name || undefined }, t);
        }
        const source = await histories.getOrThrow(payload.history_id, t);
        const created = await histories.create(
            {
                name: payload.name || `Copy of '${source.name}'`,
                annotation: source.annotation,
                tags: [...source.tags],
            },
            t,
        );
        await copyContentsInto(source.id, created.id, payload.all_datasets, t);
        const store = t.store("histories");
        const copy = await store.get(created.id);
        copy!.hid_counter = source.hid_counter;
        copy!.update_time = t.now;
        await store.put(copy!);
        return copy!;
    });
}

function readIds(body: Record<string, unknown>): string[] {
    return readStringList(body, "ids");
}

/**
 * Sends serialized histories. Their keys are chosen per request (`view`, `keys`), so the schema's union of views
 * cannot type them; the fixed views are checked against the schema in the tests.
 */
function historyResponse(body: HistoryView | HistoryView[], headers?: HeadersInit): TypedResponse<never> {
    return passthrough(json(body, { headers }));
}

export function register(router: Router): void {
    router.route("/api/histories", "get", async ({ query }) => {
        if (query.get("search") === null) {
            return historyResponse(await indexByFilters(query, queryBool(query, "deleted", false)!));
        }
        const { items, total } = await indexBySearch(query);
        return historyResponse(items, { total_matches: String(total) });
    });

    router.route("/api/histories/deleted", "get", async ({ query }) =>
        historyResponse(await indexByFilters(query, true)),
    );

    router.route("/api/histories/count", "get", async () => {
        const all = await histories.list({ deleted: false, archived: false });
        return all.length;
    });

    router.route("/api/histories", "post", async (request) => {
        const created = await createHistory(await readCreatePayload(request));
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(request.query), "detailed");
        return historyResponse(await serializeHistory(created, keys));
    });

    router.route("/api/histories/{history_id}", "get", async ({ params, query }) => {
        const history = await histories.getOrThrow(params.history_id);
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "detailed");
        return historyResponse(await serializeHistory(history, keys));
    });

    router.route("/api/histories/{history_id}", "put", async ({ params, query, json: body }) => {
        const payload = asObject(await body());
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "detailed");
        const history = await withTransaction(JOB_STORES, "readwrite", (t) =>
            updateHistory(params.history_id, payload, t),
        );
        return historyResponse(await serializeHistory(history, keys));
    });

    router.route("/api/histories/{history_id}", "delete", async ({ params, query, json: body }) => {
        const payload = asObject(await body());
        const purge = queryBool(query, "purge", false)! || payload.purge === true;
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "detailed");
        const history = await withTransaction(JOB_STORES, "readwrite", (t) =>
            deleteHistory(params.history_id, purge, t),
        );
        return historyResponse(await serializeHistory(history, keys));
    });

    router.route("/api/histories/deleted/{history_id}/undelete", "post", async ({ params, query }) => {
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "detailed");
        const history = await histories.undelete(params.history_id);
        return historyResponse(await serializeHistory(history, keys));
    });

    router.route("/api/histories/batch/delete", "put", async ({ query, json: body }) => {
        const payload = asObject(await body());
        const ids = readIds(payload);
        const purge = queryBool(query, "purge", false)! || payload.purge === true;
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "detailed");
        const deleted = await withTransaction(JOB_STORES, "readwrite", async (t) => {
            const out: HistoryRecord[] = [];
            for (const id of ids) {
                out.push(await deleteHistory(id, purge, t));
            }
            return out;
        });
        return historyResponse(await serializeHistories(deleted, keys));
    });

    router.route("/api/histories/batch/undelete", "put", async ({ query, json: body }) => {
        const ids = readIds(asObject(await body()));
        const keys = resolveKeys(HISTORY_VIEWS, serializationParams(query), "detailed");
        const restored = await withTransaction(["histories"], "readwrite", async (t) => {
            const out: HistoryRecord[] = [];
            for (const id of ids) {
                out.push(await histories.undelete(id, t));
            }
            return out;
        });
        return historyResponse(await serializeHistories(restored, keys));
    });
}
