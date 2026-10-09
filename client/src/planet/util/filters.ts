/**
 * Galaxy index filters: repeated `q`/`qv` query parameters (`q=name-contains&qv=foo&q=deleted&qv=false`)
 * and the free-text `search` syntax (`name:foo tag:'my tag' is:deleted`).
 *
 * Parsing follows `galaxy.managers.base.ModelFilterParser`; matching follows the SQL the server builds
 * for `managers/history_contents.py` and `managers/histories.py`.
 */

import { ApiError } from "./errors";
import { type DatasetState, isDatasetState } from "./states";
import { parseGalaxyTime } from "./time";

/** Filter operators accepted after the `-` in a `q` value. Without an operator Galaxy uses `eq`. */
export type FilterOp = "eq" | "contains" | "has" | "like" | "in" | "gt" | "ge" | "lt" | "le";

/** One `(attribute, operator, value)` triple before validation. */
export interface RawFilter {
    attr: string;
    op: string;
    value: string;
}

type TimeAttr = "create_time" | "update_time";
type CompareOp = "gt" | "ge" | "lt" | "le";

/** A validated history-contents filter. Times are microseconds since the epoch. */
export type ContentsFilter =
    | { attr: "history_content_type"; op: "eq"; value: "dataset" | "dataset_collection" }
    | { attr: "type_id"; op: "eq" | "in"; value: string[] }
    | { attr: "hid"; op: "eq" | CompareOp; value: number }
    | { attr: "name"; op: "eq" | "contains" | "like"; value: string }
    | { attr: "state"; op: "eq" | "in"; value: DatasetState[] }
    | { attr: "extension"; op: "eq" | "in"; value: string[] }
    | { attr: "extension"; op: "like"; value: string }
    | { attr: "object_store_id"; op: "eq" | "in"; value: string[] }
    | { attr: "quota_source_label"; op: "eq"; value: string }
    | { attr: "visible" | "deleted" | "purged"; op: "eq"; value: boolean }
    | { attr: TimeAttr; op: CompareOp; value: number }
    | { attr: "tag"; op: "eq" | "contains" | "has"; value: string }
    | { attr: "annotation"; op: "contains" | "has"; value: string }
    | { attr: "genome_build"; op: "eq" | "contains" | "has"; value: string }
    | { attr: "tool_id"; op: "eq" | "contains"; value: string }
    | { attr: "related"; op: "eq"; value: number[] };

/** A validated filter for the history list (`GET /api/histories?q=...`). */
export type HistoryFilter =
    | { attr: "name" | "genome_build" | "slug"; op: "eq" | "contains" | "like"; value: string }
    | { attr: TimeAttr; op: CompareOp; value: number }
    | { attr: "deleted" | "purged" | "published" | "importable"; op: "eq"; value: boolean }
    | { attr: "tag"; op: "eq" | "contains" | "has"; value: string }
    | { attr: "annotation"; op: "contains" | "has"; value: string }
    | { attr: "username"; op: "eq" | "contains"; value: string };

/**
 * The fields a history item exposes to filters. Collections have `extension: null`; their leaf
 * dataset extensions go in `leaf_extensions` when an extension filter is evaluated.
 */
export interface ContentsFilterSubject {
    history_content_type: "dataset" | "dataset_collection";
    id: string;
    hid: number;
    name: string;
    /** Dataset state for datasets (the HDA override first), `populated_state` for collections. */
    state: string;
    extension: string | null;
    leaf_extensions?: readonly string[];
    visible: boolean;
    deleted: boolean;
    purged: boolean;
    tags: readonly string[];
    annotation: string | null;
    genome_build: string | null;
    create_time: string;
    update_time: string;
    object_store_id: string | null;
    /** Tools of the jobs that created the dataset, or the collection's leaf datasets. */
    tool_ids: readonly string[];
}

/** The fields a history exposes to filters. */
export interface HistoryFilterSubject {
    name: string;
    genome_build: string | null;
    slug: string | null;
    create_time: string;
    update_time: string;
    deleted: boolean;
    purged: boolean;
    published: boolean;
    importable: boolean;
    tags: readonly string[];
    annotation: string | null;
    username: string;
}

type ValueParser = (raw: string) => unknown;
type FilterSpec = Readonly<Record<string, Readonly<Partial<Record<FilterOp, ValueParser>>>>>;

class FilterValueError extends Error {}

const text: ValueParser = (raw) => raw;

const bool: ValueParser = (raw) => {
    if (raw === "True" || raw === "true") {
        return true;
    }
    if (raw === "False" || raw === "false") {
        return false;
    }
    throw new FilterValueError(`invalid boolean: ${raw}`);
};

const integer: ValueParser = (raw) => {
    const trimmed = raw.trim().replace(/_/g, "");
    if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new FilterValueError(`invalid literal for int() with base 10: '${raw}'`);
    }
    return Number.parseInt(trimmed, 10);
};

const time: ValueParser = (raw) => {
    try {
        return parseGalaxyTime(raw);
    } catch (error) {
        throw new FilterValueError((error as Error).message);
    }
};

const list: ValueParser = (raw) => raw.split(",").filter((part) => part !== "");
const single: ValueParser = (raw) => [raw];

const states =
    (split: boolean): ValueParser =>
    (raw) => {
        const values = split ? raw.split(",").filter((part) => part !== "") : [raw];
        for (const value of values) {
            if (!isDatasetState(value)) {
                throw new FilterValueError(`invalid state in filter: ${value}`);
            }
        }
        return values;
    };

const contentType: ValueParser = (raw) => {
    if (raw !== "dataset" && raw !== "dataset_collection") {
        throw new FilterValueError(`invalid history_content_type: ${raw}`);
    }
    return raw;
};

const nonEmptyList: ValueParser = (raw) => {
    const values = list(raw) as string[];
    if (values.length === 0) {
        throw new FilterValueError("empty extension list");
    }
    return values;
};

const hidList: ValueParser = (raw) => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new FilterValueError(`unparsable value for related filter: ${raw}`);
    }
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (!values.every((value) => Number.isInteger(value))) {
        throw new FilterValueError(`unparsable value for related filter: ${raw}`);
    }
    return values as number[];
};

const compare = { gt: time, ge: time, lt: time, le: time } as const;

/** Filters accepted by `GET /api/histories/{history_id}/contents`. */
export const CONTENTS_FILTER_SPEC: FilterSpec = {
    history_content_type: { eq: contentType },
    type_id: { eq: single, in: list },
    hid: { eq: integer, ge: integer, le: integer, gt: integer, lt: integer },
    name: { eq: text, contains: text, like: text },
    state: { eq: states(false), in: states(true) },
    extension: { eq: single, in: nonEmptyList, like: text },
    object_store_id: { eq: single, in: list },
    quota_source_label: { eq: text },
    visible: { eq: bool },
    deleted: { eq: bool },
    purged: { eq: bool },
    create_time: compare,
    update_time: compare,
    tag: { eq: text, contains: text, has: text },
    annotation: { contains: text, has: text },
    genome_build: { eq: text, contains: text, has: text },
    tool_id: { eq: text, contains: text },
    related: { eq: hidList },
};

/** Filters accepted by `GET /api/histories`. */
export const HISTORY_FILTER_SPEC: FilterSpec = {
    name: { eq: text, contains: text, like: text },
    genome_build: { eq: text, contains: text, like: text },
    slug: { eq: text, contains: text, like: text },
    create_time: compare,
    update_time: compare,
    deleted: { eq: bool },
    purged: { eq: bool },
    published: { eq: bool },
    importable: { eq: bool },
    tag: { eq: text, contains: text, has: text },
    annotation: { contains: text, has: text },
    username: { eq: text, contains: text },
};

/**
 * Reads repeated `q`/`qv` parameters into raw triples. `q` values carry an optional operator after the
 * last `-` (`create_time-lt`); `q` and `qv` pair up by position and extra values are ignored.
 */
export function readQueryFilters(query: URLSearchParams, attrKey = "q", valueKey = "qv"): RawFilter[] {
    const attrs = query.getAll(attrKey);
    const values = query.getAll(valueKey);
    const count = Math.min(attrs.length, values.length);
    const filters: RawFilter[] = [];
    for (let i = 0; i < count; i++) {
        const raw = attrs[i]!;
        const split = raw.lastIndexOf("-");
        const attr = split === -1 ? raw : raw.slice(0, split);
        const op = split === -1 ? "eq" : raw.slice(split + 1);
        filters.push({ attr, op, value: values[i]! });
    }
    return filters;
}

/**
 * Validates raw filters against `spec` and converts their values.
 *
 * @throws ApiError 400 (`USER_REQUEST_INVALID_PARAMETER`) for an unknown attribute, operator or value
 */
export function parseFilters<F>(raw: readonly RawFilter[], spec: FilterSpec): F[] {
    return raw.map(({ attr, op, value }) => {
        const parser = Object.hasOwn(spec, attr) ? spec[attr]![op as FilterOp] : undefined;
        if (!parser) {
            throw new ApiError(400, "bad filter", undefined, { column: attr, operation: op });
        }
        try {
            return { attr, op, value: parser(value) } as F;
        } catch (error) {
            if (error instanceof FilterValueError) {
                throw new ApiError(400, "unparsable value for filter", undefined, {
                    column: attr,
                    operation: op,
                    value,
                    ValueError: error.message,
                });
            }
            throw error;
        }
    });
}

/** Parses the `q`/`qv` filters of a history contents request. */
export function parseContentsFilters(query: URLSearchParams): ContentsFilter[] {
    return parseFilters<ContentsFilter>(readQueryFilters(query), CONTENTS_FILTER_SPEC);
}

/** Parses the `q`/`qv` filters of a history list request. */
export function parseHistoryFilters(query: URLSearchParams): HistoryFilter[] {
    return parseFilters<HistoryFilter>(readQueryFilters(query), HISTORY_FILTER_SPEC);
}

function lower(value: string | null | undefined): string {
    return (value ?? "").toLowerCase();
}

type LikeToken = { kind: "any" } | { kind: "one" } | { kind: "char"; char: string };

/**
 * SQL `LIKE` with `%` and `_` wildcards and `\` as escape, case-sensitive as in PostgreSQL. Runs in
 * O(value × pattern) time for any pattern.
 */
export function sqlLike(value: string, pattern: string): boolean {
    const tokens: LikeToken[] = [];
    const chars = Array.from(pattern);
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i]!;
        if (char === "\\" && i + 1 < chars.length) {
            tokens.push({ kind: "char", char: chars[++i]! });
        } else if (char === "%") {
            if (tokens[tokens.length - 1]?.kind !== "any") {
                tokens.push({ kind: "any" });
            }
        } else if (char === "_") {
            tokens.push({ kind: "one" });
        } else {
            tokens.push({ kind: "char", char });
        }
    }
    const text = Array.from(value);
    let v = 0;
    let p = 0;
    let anyAt = -1;
    let resumeAt = 0;
    while (v < text.length) {
        const token = tokens[p];
        if (token && (token.kind === "one" || (token.kind === "char" && token.char === text[v]))) {
            v++;
            p++;
        } else if (token?.kind === "any") {
            anyAt = p++;
            resumeAt = v;
        } else if (anyAt !== -1) {
            p = anyAt + 1;
            v = ++resumeAt;
        } else {
            return false;
        }
    }
    while (tokens[p]?.kind === "any") {
        p++;
    }
    return p === tokens.length;
}

/**
 * Matches Galaxy's tag filter: `eq` on a bare name matches that tag name with any value, `eq` on
 * `name:value` matches the whole tag, and `contains`/`has` match a substring of `name:value`. Case is
 * ignored. Tags are stored as Galaxy serializes them (`group:x`, `name:foo`, `plain`).
 */
export function matchesTag(tags: readonly string[], op: "eq" | "contains" | "has", value: string): boolean {
    const needle = value.toLowerCase();
    return tags.some((tag) => {
        const full = tag.toLowerCase();
        if (op === "eq") {
            if (!needle.includes(":")) {
                const separator = full.indexOf(":");
                return (separator === -1 ? full : full.slice(0, separator)) === needle;
            }
            return full === needle;
        }
        return full.includes(needle);
    });
}

function compareNumbers(actual: number, op: CompareOp | "eq", expected: number): boolean {
    switch (op) {
        case "eq":
            return actual === expected;
        case "gt":
            return actual > expected;
        case "ge":
            return actual >= expected;
        case "lt":
            return actual < expected;
        case "le":
            return actual <= expected;
    }
}

function matchesText(actual: string, op: "eq" | "contains" | "like", value: string): boolean {
    switch (op) {
        case "eq":
            return actual === value;
        case "contains":
            return actual.toLowerCase().includes(value.toLowerCase());
        case "like":
            return sqlLike(actual, value);
    }
}

/**
 * Returns true when `item` satisfies `filter`. A `related` filter is matched as a list of hids: expand
 * the requested hid to every related hid (through the job graph) before matching.
 */
export function matchesContentsFilter(item: ContentsFilterSubject, filter: ContentsFilter): boolean {
    const isDataset = item.history_content_type === "dataset";
    switch (filter.attr) {
        case "history_content_type":
            return item.history_content_type === filter.value;
        case "type_id":
            return filter.value.includes(`${item.history_content_type}-${item.id}`);
        case "hid":
            return compareNumbers(item.hid, filter.op, filter.value);
        case "name":
            return matchesText(item.name, filter.op, filter.value);
        case "state":
            return (filter.value as string[]).includes(item.state);
        case "extension":
            if (filter.op === "like") {
                return item.extension !== null && sqlLike(item.extension, filter.value);
            }
            if (isDataset) {
                return item.extension !== null && filter.value.includes(item.extension);
            }
            return (item.leaf_extensions ?? []).every((extension) => filter.value.includes(extension));
        case "object_store_id":
            return item.object_store_id !== null && filter.value.includes(item.object_store_id);
        case "quota_source_label":
            return isDataset && filter.value === "__null__";
        case "visible":
            return item.visible === filter.value;
        case "deleted":
            return item.deleted === filter.value;
        case "purged":
            return item.purged === filter.value;
        case "create_time":
        case "update_time":
            return compareNumbers(parseGalaxyTime(item[filter.attr]), filter.op, filter.value);
        case "tag":
            return matchesTag(item.tags, filter.op, filter.value);
        case "annotation":
            return item.annotation !== null && lower(item.annotation).includes(lower(filter.value));
        case "genome_build": {
            if (!isDataset || item.genome_build === null) {
                return false;
            }
            const build = lower(item.genome_build);
            const needle = lower(filter.value);
            return filter.op === "eq" ? build === needle || build === `["${needle}"]` : build.includes(needle);
        }
        case "tool_id":
            return item.tool_ids.some((toolId) =>
                filter.op === "eq" ? toolId === filter.value : toolId.includes(filter.value),
            );
        case "related":
            return filter.value.includes(item.hid);
    }
}

/** Returns true when `item` satisfies every filter. */
export function matchesContentsFilters(item: ContentsFilterSubject, filters: readonly ContentsFilter[]): boolean {
    return filters.every((filter) => matchesContentsFilter(item, filter));
}

/** Returns true when `history` satisfies `filter`. */
export function matchesHistoryFilter(history: HistoryFilterSubject, filter: HistoryFilter): boolean {
    switch (filter.attr) {
        case "name":
        case "genome_build":
        case "slug": {
            const actual = history[filter.attr];
            return actual !== null && matchesText(actual, filter.op, filter.value);
        }
        case "create_time":
        case "update_time":
            return compareNumbers(parseGalaxyTime(history[filter.attr]), filter.op, filter.value);
        case "deleted":
        case "purged":
        case "published":
        case "importable":
            return history[filter.attr] === filter.value;
        case "tag":
            return matchesTag(history.tags, filter.op, filter.value);
        case "annotation":
            return history.annotation !== null && lower(history.annotation).includes(lower(filter.value));
        case "username":
            return filter.op === "eq"
                ? lower(history.username) === lower(filter.value)
                : lower(history.username).includes(lower(filter.value));
    }
}

/** Returns true when `history` satisfies every filter. */
export function matchesHistoryFilters(history: HistoryFilterSubject, filters: readonly HistoryFilter[]): boolean {
    return filters.every((filter) => matchesHistoryFilter(history, filter));
}

/** A free-text term of a search string. */
export interface RawTextTerm {
    kind: "text";
    text: string;
    quoted: boolean;
}

/** A `key:value` term of a search string; `filter` is the canonical filter name. */
export interface FilteredTerm {
    kind: "filter";
    filter: string;
    text: string;
    quoted: boolean;
}

export interface ParsedSearch {
    /** All terms in Galaxy's order. */
    terms: (RawTextTerm | FilteredTerm)[];
    textTerms: RawTextTerm[];
    filterTerms: FilteredTerm[];
}

const QUOTE_PATTERN = /'(.*?)'/;
const WORD = "[\\p{L}\\p{N}_]";

/**
 * Parses a Galaxy `search` string (`galaxy.util.search.parse_filters_structured`).
 *
 * @param filters maps the keys users type (`name`, `tag`, `is`) to canonical filter names
 * @param preserveQuotes mark terms written in quotes as `quoted`
 */
export function parseSearch(
    search: string,
    filters: Readonly<Record<string, string>>,
    preserveQuotes = true,
): ParsedSearch {
    const parsed: ParsedSearch = { terms: [], textTerms: [], filterTerms: [] };
    const addText = (value: string, quoted: boolean) => {
        const trimmed = value.trim();
        if (trimmed) {
            const term: RawTextTerm = { kind: "text", text: trimmed, quoted };
            parsed.terms.push(term);
            parsed.textTerms.push(term);
        }
    };
    const addTextTerms = (value: string) => {
        for (const part of value.split(/\s+/)) {
            addText(part, false);
        }
    };
    const keys = Object.keys(filters).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const reserved = keys.length
        ? new RegExp(`(${keys.join("|")}):(?:\\s+)?((?:${WORD}|-)+|'.*?')(:${WORD}+)?`, "u")
        : null;
    let space = search.replaceAll('"', "'");
    for (;;) {
        const keyed = reserved?.exec(space) ?? null;
        if (keyed) {
            const [whole, key = "", value = "", suffix] = keyed;
            const group =
                key === "tag" && value === "name" && suffix !== undefined ? value + suffix.trim() : value.trim();
            const term: FilteredTerm = {
                kind: "filter",
                filter: filters[key]!,
                text: group.replaceAll("'", ""),
                quoted: preserveQuotes && group.startsWith("'"),
            };
            parsed.terms.push(term);
            parsed.filterTerms.push(term);
            addTextTerms(space.slice(0, keyed.index));
            space = space.slice(keyed.index + whole.length);
            continue;
        }
        const quoted = QUOTE_PATTERN.exec(space);
        if (!quoted) {
            addTextTerms(space);
            break;
        }
        addTextTerms(space.slice(0, quoted.index));
        addText(quoted[1]!.trim(), true);
        space = space.slice(quoted.index + quoted[0].length);
    }
    return parsed;
}
