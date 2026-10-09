/**
 * The toolbox: GET /api/tool_panels, /api/tool_panels/{view}, /api/tools (flat list, panel structure, version
 * lookup and search), /api/tools/{tool_id}, /api/tools/{tool_id}/citations and /api/tags/tool_tags, answered from
 * the build's `toolbox/` data plus tools installed into IndexedDB. Missing toolbox data gives an empty panel with
 * only the upload tool, never an error.
 *
 * Tool forms (/api/tools/{tool_id}/build), tool runs (POST /api/tools) and uploads (POST /api/tools/fetch) answer
 * 501 until the tool layer lands. DOI citations are resolved to BibTeX through doi.org, as Galaxy does.
 */

import * as db from "@/planet/db";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";

import { loadStaticJson, stringAsBool } from "./datatypes";
import { normalizeFavorites, readPreferences } from "./users";

/** A `ToolPanelEntry` payload (`/api/tools/{tool_id}` and the entries of `/api/tools`). */
export interface ToolEntry {
    model_class: string;
    id: string;
    name: string;
    version: string;
    description?: string | null;
    labels?: unknown[];
    edam_operations?: string[];
    edam_topics?: string[];
    hidden?: boolean | string;
    panel_section_id?: string | null;
    panel_section_name?: string | null;
    tool_shed_repository?: { name?: string; owner?: string } | null;
    tool_tags?: string[];
    [key: string]: unknown;
}

interface PanelViewModel {
    id: string;
    model_class: string;
    name: string;
    description: string | null;
    view_type: string;
    searchable: boolean;
}

interface PanelViews {
    default_panel_view: string;
    views: Record<string, PanelViewModel>;
}

/** A panel element of `/api/tool_panels/{view}`: a tool entry, a section (`tools` holds ids) or a label. */
type PanelElement = Record<string, unknown> & { model_class?: string; id?: string };

const DEFAULT_PANEL_VIEW = "default";
const UPLOAD_TOOL_ID = "upload1";
const UPLOAD_SECTION = { id: "getext", name: "Get Data" };
const FAVORITES_TERMS = new Set(["#favs", "#favorites", "#favourites"]);
const NOT_YET = {
    form: "Tool forms arrive in a later Planet release.",
    run: "Running tools arrives in a later Planet release.",
    upload: "Uploading data arrives in a later Planet release.",
} as const;

/** Galaxy's upload tool, offered even when the deployment has no generated toolbox. */
const UPLOAD_ENTRY: ToolEntry = {
    model_class: "Tool",
    id: UPLOAD_TOOL_ID,
    name: "Upload File",
    version: "1.1.7",
    description: "from your computer",
    labels: [],
    icon: null,
    edam_operations: ["operation_0224"],
    edam_topics: [],
    hidden: false,
    is_workflow_compatible: false,
    xrefs: [],
    versions: ["1.1.7"],
    hidden_versions: [],
    link: `/tool_runner?tool_id=${UPLOAD_TOOL_ID}`,
    has_parameters: true,
    panel_section_id: UPLOAD_SECTION.id,
    panel_section_name: UPLOAD_SECTION.name,
    form_style: "regular",
};

const DEFAULT_VIEW_MODEL: PanelViewModel = {
    id: DEFAULT_PANEL_VIEW,
    // Galaxy reports the metaclass name of its local default view class.
    model_class: "ABCMeta",
    name: "Full Tool Panel",
    description: "Galaxy's fully configured toolbox panel with all sections, tools, and configured workflows loaded.",
    view_type: "default",
    searchable: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolEntry(value: unknown): value is ToolEntry {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.version === "string"
    );
}

/** Panel entries of ready, visible tools installed into IndexedDB. */
async function installedEntries(): Promise<ToolEntry[]> {
    let records: db.ToolRecord[];
    try {
        records = await db.tools.list();
    } catch (error) {
        console.error("Planet installed tools failed to load", error);
        return [];
    }
    return records
        .filter((record) => record.status === "ready" && !record.hidden)
        .map((record) => (isRecord(record.bundle) ? record.bundle.panel_entry : undefined))
        .filter(isToolEntry);
}

/** Every tool listed by `/api/tools?in_panel=false`: the built-in toolbox, the upload tool and installed tools. */
export async function listToolEntries(): Promise<ToolEntry[]> {
    const [curated, installed] = await Promise.all([
        loadStaticJson<unknown[]>("toolbox/tools.json"),
        installedEntries(),
    ]);
    const entries = (Array.isArray(curated) ? curated : []).filter(isToolEntry);
    const seen = new Set(entries.map((entry) => entry.id));
    if (!seen.has(UPLOAD_TOOL_ID)) {
        entries.unshift(UPLOAD_ENTRY);
        seen.add(UPLOAD_TOOL_ID);
    }
    for (const entry of installed) {
        if (!seen.has(entry.id)) {
            entries.push(entry);
            seen.add(entry.id);
        }
    }
    return entries;
}

/** Returns the panel entry of a tool, or undefined. */
export async function getToolEntry(toolId: string): Promise<ToolEntry | undefined> {
    return (await listToolEntries()).find((entry) => entry.id === toolId);
}

/** Path of a bundle below the static data root: each `/`-separated segment percent-encoded. */
export function bundlePath(toolId: string, version: string): string {
    const segments = [...toolId.split("/"), ...version.split("/")].map(encodeURIComponent);
    return `toolbox/bundles/${segments.join("/")}.json`;
}

/**
 * Returns the Planet tool bundle of a tool version (the latest listed version when `version` is omitted), from
 * IndexedDB for installed tools or the build's static data for built-in ones.
 */
export async function getToolBundle(toolId: string, version?: string): Promise<Record<string, unknown> | undefined> {
    const resolved = version ?? (await getToolEntry(toolId))?.version;
    if (!resolved) {
        return undefined;
    }
    const record = await db.tools.get(toolId, resolved).catch(() => undefined);
    if (record && isRecord(record.bundle)) {
        return record.bundle;
    }
    const bundle = await loadStaticJson<unknown>(bundlePath(toolId, resolved));
    return isRecord(bundle) ? bundle : undefined;
}

async function panelViews(): Promise<PanelViews> {
    const views = await loadStaticJson<PanelViews>("toolbox/panels.json");
    if (isRecord(views) && isRecord(views.views) && typeof views.default_panel_view === "string") {
        return views;
    }
    return { default_panel_view: DEFAULT_PANEL_VIEW, views: { [DEFAULT_PANEL_VIEW]: DEFAULT_VIEW_MODEL } };
}

function containsTool(panel: Record<string, PanelElement>, toolId: string): boolean {
    return Object.values(panel).some(
        (element) =>
            element.id === toolId || (Array.isArray(element.tools) && (element.tools as unknown[]).includes(toolId)),
    );
}

/** `/api/tool_panels/{view}`: `{element id: tool entry | section with tool ids | label}`. */
async function panelView(view: string): Promise<Record<string, PanelElement>> {
    const views = await panelViews();
    const viewId = view === "default_panel_view" ? views.default_panel_view : view;
    if (!Object.hasOwn(views.views, viewId)) {
        throw ApiError.badRequest(`No panel view ${viewId} found.`);
    }
    const stored =
        (await loadStaticJson<Record<string, PanelElement>>(
            `toolbox/panel_views/${encodeURIComponent(viewId)}.json`,
        )) ??
        (viewId === DEFAULT_PANEL_VIEW
            ? await loadStaticJson<Record<string, PanelElement>>("toolbox/panel.json")
            : undefined);
    const panel: Record<string, PanelElement> = isRecord(stored) ? { ...(stored as Record<string, PanelElement>) } : {};
    if (viewId === DEFAULT_PANEL_VIEW && !containsTool(panel, UPLOAD_TOOL_ID)) {
        const section = panel[UPLOAD_SECTION.id];
        if (section && Array.isArray(section.tools)) {
            panel[UPLOAD_SECTION.id] = { ...section, tools: [UPLOAD_TOOL_ID, ...(section.tools as unknown[])] };
        } else {
            return {
                [UPLOAD_SECTION.id]: {
                    model_class: "ToolSection",
                    id: UPLOAD_SECTION.id,
                    name: UPLOAD_SECTION.name,
                    version: "",
                    description: null,
                    links: null,
                    tools: [UPLOAD_TOOL_ID],
                },
                ...panel,
            };
        }
    }
    return panel;
}

/** `/api/tools?in_panel=true`: the panel view with each section's tool ids replaced by their entries. */
async function toolsInPanel(view: string | null): Promise<unknown[]> {
    if (!view || view === DEFAULT_PANEL_VIEW) {
        const stored = await loadStaticJson<unknown[]>("toolbox/tools_in_panel.json");
        if (Array.isArray(stored) && stored.length) {
            return stored;
        }
    }
    const [panel, entries] = await Promise.all([panelView(view ?? DEFAULT_PANEL_VIEW), listToolEntries()]);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return Object.values(panel).map((element) => {
        if (!Array.isArray(element.tools)) {
            return element;
        }
        const { tools, ...section } = element;
        const elems = (tools as unknown[])
            .map((item) => (typeof item === "string" ? byId.get(item) : item))
            .filter((item) => item !== undefined);
        return { ...section, elems };
    });
}

// ---------------------------------------------------------------------------------------------------------
// Search: the subset of Whoosh query syntax the client builds (`createWhooshQuery`), over the fields of Galaxy's
// tool search schema, with Galaxy's default field boosts.

type QueryNode =
    | { kind: "term"; field: string | null; text: string; phrase: boolean }
    | { kind: "and" | "or"; children: QueryNode[] }
    | { kind: "not"; child: QueryNode };

type Token =
    | { type: "(" | ")" | "AND" | "OR" | "NOT" }
    | { type: "field"; name: string }
    | { type: "word" | "phrase"; text: string };

const SEARCH_FIELDS: Record<string, number> = {
    id: 20,
    id_exact: 200,
    name: 20,
    name_exact: 200,
    stub: 2,
    description: 8,
    section: 3,
    edam_operations: 3,
    edam_topics: 3,
    repository: 3,
    owner: 3,
    labels: 1,
    tool_tags: 1,
};

function tokenize(query: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < query.length) {
        const char = query[i]!;
        if (/\s/.test(char)) {
            i++;
        } else if (char === "(" || char === ")") {
            tokens.push({ type: char });
            i++;
        } else if (char === '"') {
            const end = query.indexOf('"', i + 1);
            const stop = end === -1 ? query.length : end;
            tokens.push({ type: "phrase", text: query.slice(i + 1, stop) });
            i = stop + 1;
        } else {
            let j = i;
            while (j < query.length && !/[\s()":]/.test(query[j]!)) {
                j++;
            }
            const word = query.slice(i, j);
            if (query[j] === ":" && word && Object.hasOwn(SEARCH_FIELDS, word)) {
                tokens.push({ type: "field", name: word });
                j++;
            } else if (word === "AND" || word === "OR" || word === "NOT") {
                tokens.push({ type: word });
            } else if (word) {
                tokens.push({ type: "word", text: word });
            } else {
                j++;
            }
            i = j;
        }
    }
    return tokens;
}

/** Parses a Whoosh-style query; adjacent clauses are OR'd as in Galaxy's `MultifieldParser(group=OrGroup)`. */
export function parseToolQuery(query: string): QueryNode | null {
    const tokens = tokenize(query);
    let position = 0;

    function parseOr(field: string | null): QueryNode | null {
        const children: QueryNode[] = [];
        while (position < tokens.length && tokens[position]!.type !== ")") {
            if (tokens[position]!.type === "OR") {
                position++;
                continue;
            }
            const node = parseAnd(field);
            if (node) {
                children.push(node);
            }
        }
        return children.length === 0 ? null : children.length === 1 ? children[0]! : { kind: "or", children };
    }

    function parseAnd(field: string | null): QueryNode | null {
        const children: QueryNode[] = [];
        const first = parseUnary(field);
        if (first) {
            children.push(first);
        }
        while (tokens[position]?.type === "AND") {
            position++;
            const next = parseUnary(field);
            if (next) {
                children.push(next);
            }
        }
        return children.length === 0 ? null : children.length === 1 ? children[0]! : { kind: "and", children };
    }

    function parseUnary(field: string | null): QueryNode | null {
        const token = tokens[position];
        if (!token) {
            return null;
        }
        if (token.type === "NOT") {
            position++;
            const child = parseUnary(field);
            return child ? { kind: "not", child } : null;
        }
        if (token.type === "field") {
            position++;
            return parseUnary(token.name);
        }
        if (token.type === "(") {
            position++;
            const inner = parseOr(field);
            if (tokens[position]?.type === ")") {
                position++;
            }
            return inner;
        }
        if (token.type === "word" || token.type === "phrase") {
            position++;
            const text = token.text.trim().toLowerCase();
            return text ? { kind: "term", field, text, phrase: token.type === "phrase" } : null;
        }
        position++;
        return null;
    }

    return parseOr(null);
}

interface SearchDocument {
    id: string;
    fields: Record<string, string>;
}

function searchDocument(entry: ToolEntry, tags: readonly string[]): SearchDocument {
    const repository = entry.tool_shed_repository ?? null;
    const slashes = [...entry.id.matchAll(/\//g)].map((match) => match.index!);
    const stub = slashes.length >= 5 ? entry.id.slice(slashes[1]! + 1, slashes[4]) : entry.id;
    const lower = (value: unknown) => String(value ?? "").toLowerCase();
    return {
        id: entry.id,
        fields: {
            id: lower(entry.id),
            id_exact: lower(entry.id),
            name: lower(entry.name),
            name_exact: lower(entry.name).trim(),
            stub: lower(stub),
            description: lower(entry.description),
            section: lower(entry.panel_section_name),
            edam_operations: (entry.edam_operations ?? []).map(lower).join(" "),
            edam_topics: (entry.edam_topics ?? []).map(lower).join(" "),
            repository: lower(repository?.name),
            owner: lower(repository?.owner),
            labels: (entry.labels ?? []).map(lower).join(" "),
            tool_tags: tags.map(lower).join("\n"),
        },
    };
}

function words(text: string): string[] {
    return text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

function stem(word: string): string {
    return word.length > 4 ? word.replace(/(ing|ed|es|s)$/, "") : word;
}

function matchesField(field: string, value: string, text: string, phrase: boolean): boolean {
    if (!value) {
        return false;
    }
    const prefix = !phrase && text.endsWith("*");
    const term = prefix ? text.slice(0, -1) : text;
    if (!term) {
        return false;
    }
    switch (field) {
        case "name":
        case "id_exact":
            // n-gram fields: any substring matches.
            return value.includes(term);
        case "name_exact":
        case "id":
            return prefix ? value.startsWith(term) : value === term;
        case "tool_tags":
            return value.split("\n").some((tag) => (prefix ? tag.startsWith(term) : tag === term));
        case "description": {
            if (phrase) {
                return value.includes(term);
            }
            const root = stem(term);
            return words(value).some((word) => word.startsWith(root));
        }
        default:
            if (phrase) {
                return value.includes(term);
            }
            return words(value).some((word) => (prefix ? word.startsWith(term) : word === term));
    }
}

function scoreNode(node: QueryNode, doc: SearchDocument): number {
    switch (node.kind) {
        case "term": {
            const fields = node.field ? [node.field] : Object.keys(SEARCH_FIELDS);
            let score = 0;
            for (const field of fields) {
                if (matchesField(field, doc.fields[field] ?? "", node.text, node.phrase)) {
                    score += SEARCH_FIELDS[field] ?? 1;
                }
            }
            return score;
        }
        case "and": {
            let total = 0;
            for (const child of node.children) {
                const score = scoreNode(child, doc);
                if (score <= 0) {
                    return 0;
                }
                total += score;
            }
            return total;
        }
        case "or":
            return node.children.reduce((total, child) => total + scoreNode(child, doc), 0);
        case "not":
            return scoreNode(node.child, doc) > 0 ? 0 : Number.MIN_VALUE;
    }
}

/** Tool ids matching `query`, best match first (ties by id), like Galaxy's tool search. */
export async function searchTools(query: string): Promise<string[]> {
    const tree = parseToolQuery(query);
    if (!tree) {
        return [];
    }
    const [entries, tags] = await Promise.all([listToolEntries(), toolTags()]);
    const scored: { id: string; score: number }[] = [];
    for (const entry of entries) {
        const score = scoreNode(tree, searchDocument(entry, tags[entry.id] ?? entry.tool_tags ?? []));
        if (score > 0) {
            scored.push({ id: entry.id, score });
        }
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.map((hit) => hit.id);
}

async function toolTags(): Promise<Record<string, string[]>> {
    const tags = await loadStaticJson<Record<string, string[]>>("toolbox/tool_tags.json");
    return isRecord(tags) ? (tags as Record<string, string[]>) : {};
}

/** The user's favorite tools that the toolbox has, for the reserved favorites search terms. */
async function favoriteToolIds(): Promise<string[]> {
    const preferences = await db.readTx(["kv"], (tx) => readPreferences(tx));
    if (!preferences.favorites) {
        return [];
    }
    let stored: unknown;
    try {
        stored = JSON.parse(preferences.favorites);
    } catch {
        return [];
    }
    const available = new Set((await listToolEntries()).map((entry) => entry.id));
    return normalizeFavorites(stored).tools.filter((id) => available.has(id));
}

// ---------------------------------------------------------------------------------------------------------
// Citations

const doiBibtex = new Map<string, Promise<string>>();

function doiFallback(doi: string): string {
    return `@MISC{${doi},\n                DOI = {${doi}},\n                note = {Failed to fetch BibTeX for DOI.}\n            }`;
}

async function fetchDoiBibtex(doi: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`https://doi.org/${encodeURI(doi)}`, {
            headers: { Accept: "application/x-bibtex" },
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.text();
    } finally {
        clearTimeout(timer);
    }
}

/** BibTeX for a DOI from doi.org, cached for the worker's lifetime; Galaxy's placeholder entry on failure. */
function bibtexForDoi(doi: string): Promise<string> {
    let pending = doiBibtex.get(doi);
    if (!pending) {
        pending = fetchDoiBibtex(doi).catch(() => {
            doiBibtex.delete(doi);
            return doiFallback(doi);
        });
        doiBibtex.set(doi, pending);
    }
    return pending;
}

type CitationItem = { format: "bibtex"; content: string } | { format: "error"; error: string; tool_id: string };

async function toolCitations(toolId: string): Promise<CitationItem[]> {
    const bundle = await getToolBundle(toolId);
    if (!bundle) {
        return [
            {
                format: "error",
                error: `Tool '${toolId}' not found. Citations for this tool may be missing.`,
                tool_id: toolId,
            },
        ];
    }
    const citations = Array.isArray(bundle.citations) ? bundle.citations : [];
    const out: CitationItem[] = [];
    const seen = new Set<string>();
    for (const citation of citations) {
        if (!isRecord(citation) || typeof citation.content !== "string") {
            continue;
        }
        const content = citation.content.trim();
        const key = `${citation.type}:${content}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (citation.type === "bibtex") {
            out.push({ format: "bibtex", content: citation.content });
        } else if (citation.type === "doi") {
            out.push({ format: "bibtex", content: await bibtexForDoi(content) });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------
// Handlers

function notYetAvailable(feature: keyof typeof NOT_YET): never {
    throw new ApiError(501, NOT_YET[feature], ErrorCodes.NOT_IMPLEMENTED);
}

async function showTool(toolId: string): Promise<ToolEntry> {
    const entry = await getToolEntry(toolId);
    if (!entry) {
        throw ApiError.notFound(`Could not find tool with id '${toolId}'.`);
    }
    return entry;
}

async function toolsIndex({ query }: PlanetRequest): Promise<unknown> {
    const q = query.get("q") ?? "";
    if (q) {
        return FAVORITES_TERMS.has(q) ? favoriteToolIds() : searchTools(q);
    }
    const toolId = query.get("tool_id") ?? "";
    if (toolId) {
        const entry = await getToolEntry(toolId);
        return entry ? [entry.version] : [];
    }
    if (stringAsBool(query.get("in_panel") ?? "True")) {
        return toolsInPanel(query.get("view"));
    }
    return listToolEntries();
}

/** Splits `/api/tools/{rest}` into the tool id (which may contain `/`) and a trailing action. */
function toolAction(rest: string): { toolId: string; action: "show" | "build" | "citations" } {
    for (const action of ["build", "citations"] as const) {
        if (rest.endsWith(`/${action}`)) {
            return { toolId: rest.slice(0, -action.length - 1), action };
        }
    }
    return { toolId: rest, action: "show" };
}

export function register(router: Router): void {
    router.untyped("/api/tool_panels", "get", panelViews);
    router.untyped("/api/tool_panels/{view}", "get", ({ params }) => panelView(params.view!));

    router.untyped("/api/tools", "get", toolsIndex);
    router.untyped("/api/tools", "post", () => notYetAvailable("run"));
    router.route("/api/tools/fetch", "post", () => notYetAvailable("upload"));

    router.untyped("/api/tools/{tool_path:path}", "get", ({ params }) => {
        const { toolId, action } = toolAction(params.tool_path!);
        if (action === "build") {
            notYetAvailable("form");
        }
        return action === "citations" ? toolCitations(toolId) : showTool(toolId);
    });
    router.untyped("/api/tools/{tool_path:path}", "post", ({ params }) => {
        const { action } = toolAction(params.tool_path!);
        if (action === "build") {
            notYetAvailable("form");
        }
        throw ApiError.notFound(`No route for /api/tools/${params.tool_path}`);
    });

    router.route("/api/tags/tool_tags", "get", toolTags);
}
