/**
 * The toolbox: GET /api/tool_panels, /api/tool_panels/{view}, /api/tools (flat list, panel structure, version
 * lookup and search), /api/tools/{tool_id}, /api/tools/{tool_id}/citations and /api/tags/tool_tags, answered from
 * the build's `toolbox/` data plus tools installed into IndexedDB. Missing toolbox data gives an empty panel with
 * only the upload tool, never an error. DOI citations are resolved to BibTeX through doi.org, as Galaxy does.
 *
 * Tool forms (GET and POST /api/tools/{tool_id}/build) and tool runs (POST /api/tools) use the tool engine in
 * `@/planet/tools`. Uploads (POST /api/tools/fetch) are handled by `./uploads`.
 */

import * as db from "@/planet/db";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import {
    buildToolForm,
    bundlePath,
    collectReferences,
    type ItemReference,
    readBundle,
    readSnapshot,
    type RequestContext,
    runTool,
    type StaticToolData,
    type ToolBundle,
} from "@/planet/tools";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { stringAsBool } from "@/planet/util/query";
import { loadOptionalStaticData } from "@/planet/util/staticData";

import { GALAXY_VERSION_MAJOR } from "./configuration";
import { ContentLoader, hdaElementObject, loadDatatypeInfo, normalizeTags, serializeHdcaInstance } from "./contents";
import type { DatatypeShow } from "./datatypes";
import { genomeBuilds } from "./genomes";
import { currentHistory } from "./legacyHistory";
import { normalizeFavorites, readPreferences } from "./users";

export { bundlePath };

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
        loadOptionalStaticData<unknown[]>("toolbox/tools.json"),
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

/**
 * Returns the tool bundle of a tool version, from IndexedDB for installed tools or the build's static data for
 * built-in ones. Without `version`, or when that version is not available, the latest listed version is used, as
 * Galaxy's toolbox does.
 */
export async function getToolBundle(toolId: string, version?: string | null): Promise<ToolBundle | undefined> {
    if (version) {
        // A Tool Shed GUID ends with its version, so other versions of the lineage have other ids.
        const lineageId = toolId.includes("/repos/")
            ? `${toolId.slice(0, toolId.lastIndexOf("/"))}/${version}`
            : toolId;
        const exact =
            (await readBundle(toolId, version)) ??
            (lineageId !== toolId ? await readBundle(lineageId, version) : undefined);
        if (exact) {
            return exact;
        }
    }
    const latest = (await getToolEntry(toolId))?.version;
    return latest && latest !== version ? readBundle(toolId, latest) : undefined;
}

/** The versions of a tool lineage, as the tool form lists them. */
export async function toolVersions(bundle: ToolBundle): Promise<string[]> {
    const entry = await getToolEntry(bundle.id);
    const versions = entry && Array.isArray(entry.versions) ? (entry.versions as string[]) : bundle.versions;
    return versions?.length ? versions : [bundle.version];
}

async function panelViews(): Promise<PanelViews> {
    const views = await loadOptionalStaticData<PanelViews>("toolbox/panels.json");
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
        (await loadOptionalStaticData<Record<string, PanelElement>>(
            `toolbox/panel_views/${encodeURIComponent(viewId)}.json`,
        )) ??
        (viewId === DEFAULT_PANEL_VIEW
            ? await loadOptionalStaticData<Record<string, PanelElement>>("toolbox/panel.json")
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
        const stored = await loadOptionalStaticData<unknown[]>("toolbox/tools_in_panel.json");
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
    const tags = await loadOptionalStaticData<Record<string, string[]>>("toolbox/tool_tags.json");
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
// Tool forms and runs

/** Planet runs uploads through `POST /api/tools/fetch`, not through the upload tool's form. */
const UPLOAD_THROUGH_FETCH =
    "Upload data with the upload dialog (POST /api/tools/fetch); the upload tool's form is not run by Planet.";

/** The build's datatype, genome and upload format data the tool engine reads. */
export async function loadStaticToolData(): Promise<StaticToolData> {
    const [datatypes, details, edamFormats, edamData, genomes, uploadFormats] = await Promise.all([
        loadDatatypeInfo(),
        loadOptionalStaticData<Record<string, DatatypeShow>>("datatypes/details.json"),
        loadOptionalStaticData<Record<string, string>>("datatypes/edam_formats.json"),
        loadOptionalStaticData<Record<string, string>>("datatypes/edam_data.json"),
        genomeBuilds(),
        loadOptionalStaticData<string[]>("datatypes/extensions.json"),
    ]);
    return {
        datatypes,
        datatypeDetails: isRecord(details) ? details : {},
        edamFormats: isRecord(edamFormats) ? (edamFormats as Record<string, string>) : {},
        edamData: isRecord(edamData) ? (edamData as Record<string, string>) : {},
        genomes,
        uploadFormats: Array.isArray(uploadFormats) ? uploadFormats : [],
    };
}

/** The history a tool request names (it must exist), or the current history. */
async function requestHistory(historyId: unknown): Promise<db.HistoryRecord> {
    if (typeof historyId === "string" && historyId) {
        return db.histories.getOrThrow(historyId);
    }
    return currentHistory();
}

/**
 * The tool engine's request context: the tool, the build's static data and the items of `history` plus the items
 * `references` name, read in one transaction.
 */
export async function toolRequestContext(
    tool: ToolBundle,
    history: db.HistoryRecord | null,
    references: readonly ItemReference[],
    origin: string,
): Promise<RequestContext> {
    const statics = await loadStaticToolData();
    const snapshot = await db.readTx(db.CONTENT_STORES, (tx) => readSnapshot(tx, history, references));
    return { ...statics, tool, snapshot, origin };
}

async function requireBundle(toolId: string, version: unknown): Promise<ToolBundle> {
    const bundle = await getToolBundle(toolId, typeof version === "string" ? version : null);
    if (!bundle) {
        throw ApiError.notFound(`Could not find tool with id '${toolId}'.`);
    }
    return bundle;
}

/** Query parameters as Galaxy's keyword arguments: repeated keys become lists. */
function queryKeywords(query: URLSearchParams): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of new Set(query.keys())) {
        const values = query.getAll(key);
        out[key] = values.length > 1 ? values : values[0];
    }
    return out;
}

/** `_parse_options_pagination`: an object, or its JSON. */
function optionsPagination(value: unknown): Record<string, Record<string, unknown>> {
    if (value === undefined || value === null || value === "") {
        return {};
    }
    let parsed = value;
    if (typeof value === "string") {
        try {
            parsed = JSON.parse(value);
        } catch (error) {
            throw ApiError.badRequest(`options_pagination must be a JSON object: ${String(error)}`);
        }
    }
    if (!isRecord(parsed)) {
        throw ApiError.badRequest("options_pagination must be a JSON object.");
    }
    return parsed as Record<string, Record<string, unknown>>;
}

/** `GET` and `POST /api/tools/{tool_id}/build`: the tool form for the given parameters. */
async function buildForm(request: PlanetRequest, toolId: string): Promise<Record<string, unknown>> {
    const keywords = request.method === "POST" ? await request.json() : queryKeywords(request.query);
    if (!isRecord(keywords)) {
        throw ApiError.badRequest("The request body must be a JSON object.");
    }
    const { history_id: historyId, options_pagination: pagination, ...rest } = keywords;
    const incoming = isRecord(rest.inputs) ? rest.inputs : rest;
    const bundle = await requireBundle(toolId, rest.tool_version);
    const history = await requestHistory(historyId);
    const rc = await toolRequestContext(bundle, history, collectReferences(incoming), request.url.origin);
    return buildToolForm(rc, incoming, {
        pagination: optionsPagination(pagination),
        versions: await toolVersions(bundle),
    });
}

/** `Job.to_dict(view="collection")`. */
function jobCollectionView(job: db.JobRecord): Record<string, unknown> {
    return {
        model_class: "Job",
        id: job.id,
        state: job.state,
        exit_code: job.exit_code,
        update_time: job.update_time,
        create_time: job.create_time,
        galaxy_version: GALAXY_VERSION_MAJOR,
        tool_id: job.tool_id,
        tool_version: job.tool_version,
        history_id: job.history_id,
    };
}

/** `POST /api/tools`: runs a tool with the legacy form payload and answers Galaxy's `JobCreateResponse`. */
async function runToolRequest(request: PlanetRequest): Promise<Record<string, unknown>> {
    const payload = await request.json();
    if (!isRecord(payload)) {
        throw ApiError.badRequest("The request body must be a JSON object.");
    }
    if (payload.action === "rerun") {
        throw ApiError.badRequest("'rerun' action has been deprecated");
    }
    if (typeof payload.tool_id !== "string" || !payload.tool_id) {
        throw ApiError.missingParameter("Must specify a valid tool_id to use this endpoint.");
    }
    const bundle = await requireBundle(payload.tool_id, payload.tool_version);
    if (bundle.id === UPLOAD_TOOL_ID) {
        throw ApiError.badRequest(UPLOAD_THROUGH_FETCH);
    }
    const inputs = payload.inputs ?? {};
    if (!isRecord(inputs)) {
        throw ApiError.badRequest(`inputs invalid ${JSON.stringify(inputs)}`);
    }
    const inputFormat = payload.input_format ?? "legacy";
    if (inputFormat !== "legacy") {
        throw ApiError.badRequest(
            inputFormat === "21.01"
                ? "Planet accepts tool parameters in the legacy input format only."
                : `input_format invalid ${String(inputFormat)}`,
        );
    }
    if (inputs.rerun_remap_job_id !== undefined && inputs.rerun_remap_job_id !== null) {
        throw ApiError.badRequest("Resuming the dependent jobs of a rerun job is not supported by Planet yet.");
    }
    const history = await requestHistory(payload.history_id);
    if (history.purged || history.archived) {
        throw ApiError.forbidden("History is immutable", ErrorCodes.ITEM_IS_IMMUTABLE);
    }
    const tags = Array.isArray(payload.__tags)
        ? normalizeTags(payload.__tags.filter((tag): tag is string => typeof tag === "string"))
        : [];
    const rc = await toolRequestContext(bundle, history, collectReferences(inputs), request.url.origin);
    const result = await runTool(rc, inputs, {
        tags,
        request: {
            tool_id: bundle.id,
            tool_version: bundle.version,
            history_id: history.id,
            use_cached_job: Boolean(payload.use_cached_job),
            preferred_object_store_id: payload.preferred_object_store_id ?? null,
            __tags: tags,
        },
    });
    return db.readTx([...db.CONTENT_STORES, "jobs"], async (tx) => {
        const loader = new ContentLoader(tx);
        const outputs: Record<string, unknown>[] = [];
        const outputCollections: Record<string, unknown>[] = [];
        for (const created of result.jobs) {
            for (const { name, hda, dataset } of created.datasets) {
                outputs.push({
                    ...hdaElementObject({ hda, dataset, job: created.job }, rc.datatypes),
                    output_name: name,
                });
            }
            for (const { name, hdca } of created.collections) {
                outputCollections.push({
                    ...(await serializeHdcaInstance(hdca, "element", loader, rc.datatypes)),
                    output_name: name,
                });
            }
        }
        const response: Record<string, unknown> = {
            outputs,
            output_collections: outputCollections,
            jobs: result.jobs.map(({ job }) => jobCollectionView(job)),
            implicit_collections: [],
            produces_entry_points: false,
        };
        if (result.errors.length) {
            response.errors = result.errors.map((error) => error.toEnvelope());
        }
        return response;
    });
}

// ---------------------------------------------------------------------------------------------------------
// Handlers

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
    router.untyped("/api/tools", "post", runToolRequest);

    router.untyped("/api/tools/{tool_path:path}", "get", (request) => {
        const { toolId, action } = toolAction(request.params.tool_path!);
        if (action === "build") {
            return buildForm(request, toolId);
        }
        return action === "citations" ? toolCitations(toolId) : showTool(toolId);
    });
    router.untyped("/api/tools/{tool_path:path}", "post", (request) => {
        const { toolId, action } = toolAction(request.params.tool_path!);
        if (action === "build") {
            return buildForm(request, toolId);
        }
        throw ApiError.notFound(`No route for /api/tools/${request.params.tool_path}`);
    });

    router.route("/api/tags/tool_tags", "get", toolTags);
}
