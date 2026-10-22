/**
 * Client of the main Tool Shed's search API, used by the welcome page. Only the routes that answer CORS requests
 * are used: `/api/repositories?q=`, `/api/tools?q=` and
 * `/api/repositories/get_ordered_installable_revisions`. Requests carry no credentials and no referrer; answers are
 * checked and shortened before they are shown, as text only.
 */

import { MAIN_TOOL_SHED } from "./source";

export const SEARCH_PAGE_SIZE = 10;
const MAX_QUERY_LENGTH = 200;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_TEXT_LENGTH = 400;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CHANGESET = /^[0-9a-f]{12,40}$/;

export interface RepositoryHit {
    owner: string;
    name: string;
    description: string | null;
    homepage_url: string | null;
    /** Where the repository's sources are developed, such as a GitHub directory. */
    remote_repository_url: string | null;
    times_downloaded: number | null;
    categories: string | null;
}

export interface ToolHit {
    /** The tool's XML id. */
    id: string;
    name: string;
    description: string | null;
    owner: string;
    repository: string;
}

export interface SearchPage<T> {
    hits: T[];
    total: number;
    page: number;
}

/** The Tool Shed could not be searched; the message says why, for people to read. */
export class ToolShedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ToolShedError";
    }
}

export interface ToolShedOptions {
    signal?: AbortSignal;
    /** Defaults to the global fetch. */
    fetch?: typeof fetch;
    /** Defaults to {@link MAIN_TOOL_SHED}. */
    baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortText(value: unknown, limit = MAX_TEXT_LENGTH): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) {
        return null;
    }
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function httpsUrl(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

function count(value: unknown): number | null {
    const number = typeof value === "string" ? Number(value) : value;
    return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function readLimited(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new ToolShedError("The Tool Shed sent a larger answer than expected.");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

async function getJson(path: string, params: Record<string, string>, options: ToolShedOptions): Promise<unknown> {
    const url = new URL(path, options.baseUrl ?? MAIN_TOOL_SHED);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
        response = await (options.fetch ?? globalThis.fetch)(url.href, {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: { Accept: "application/json" },
            signal,
        });
    } catch (error) {
        if (options.signal?.aborted) {
            throw error;
        }
        throw new ToolShedError(
            timeout.aborted
                ? "The Tool Shed did not answer in time. Try again later."
                : "The Tool Shed could not be reached. Check your connection and try again.",
        );
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ToolShedError(`The Tool Shed answered with HTTP ${response.status}. Try again later.`);
    }
    try {
        return JSON.parse(await readLimited(response));
    } catch (error) {
        if (error instanceof ToolShedError) {
            throw error;
        }
        throw new ToolShedError("The Tool Shed sent an answer Planet cannot read.");
    }
}

function searchQuery(query: string): string {
    const text = query.trim();
    if (!text) {
        throw new ToolShedError("Enter what to search for.");
    }
    return text.slice(0, MAX_QUERY_LENGTH);
}

function page<T>(value: unknown, parse: (hit: unknown) => T | null, requested: number): SearchPage<T> {
    if (!isRecord(value) || !Array.isArray(value.hits)) {
        throw new ToolShedError("The Tool Shed sent an answer Planet cannot read.");
    }
    const hits = value.hits.map(parse).filter((hit): hit is T => hit !== null);
    return { hits, total: count(value.total_results) ?? hits.length, page: count(value.page) ?? requested };
}

function repositoryHit(value: unknown): RepositoryHit | null {
    const repository = isRecord(value) && isRecord(value.repository) ? value.repository : null;
    const owner = repository?.repo_owner_username;
    const name = repository?.name;
    if (typeof owner !== "string" || typeof name !== "string" || !NAME.test(owner) || !NAME.test(name)) {
        return null;
    }
    return {
        owner,
        name,
        description: shortText(repository!.description),
        homepage_url: httpsUrl(repository!.homepage_url),
        remote_repository_url: httpsUrl(repository!.remote_repository_url),
        times_downloaded: count(repository!.times_downloaded),
        categories: shortText(repository!.categories, 200),
    };
}

function toolHit(value: unknown): ToolHit | null {
    const tool = isRecord(value) && isRecord(value.tool) ? value.tool : null;
    const owner = tool?.repo_owner_username;
    const repository = tool?.repo_name;
    const id = shortText(tool?.id, 255);
    if (typeof owner !== "string" || typeof repository !== "string" || !NAME.test(owner) || !NAME.test(repository)) {
        return null;
    }
    if (!id) {
        return null;
    }
    return { id, name: shortText(tool!.name, 255) ?? id, description: shortText(tool!.description), owner, repository };
}

/** Searches repositories by name, description and owner (`/api/repositories?q=`); `page` starts at 1. */
export async function searchRepositories(
    query: string,
    pageNumber = 1,
    options: ToolShedOptions = {},
): Promise<SearchPage<RepositoryHit>> {
    const params = { q: searchQuery(query), page: String(pageNumber), page_size: String(SEARCH_PAGE_SIZE) };
    return page(await getJson("/api/repositories", params, options), repositoryHit, pageNumber);
}

/** Searches tools by name, id and help (`/api/tools?q=`); `page` starts at 1. */
export async function searchTools(
    query: string,
    pageNumber = 1,
    options: ToolShedOptions = {},
): Promise<SearchPage<ToolHit>> {
    const params = { q: searchQuery(query), page: String(pageNumber), page_size: String(SEARCH_PAGE_SIZE) };
    return page(await getJson("/api/tools", params, options), toolHit, pageNumber);
}

/** The changesets of a repository that can be installed, newest first. */
export async function installableRevisions(
    owner: string,
    name: string,
    options: ToolShedOptions = {},
): Promise<string[]> {
    if (!NAME.test(owner) || !NAME.test(name)) {
        throw new ToolShedError("The repository needs a valid owner and name.");
    }
    const value = await getJson("/api/repositories/get_ordered_installable_revisions", { owner, name }, options);
    if (!Array.isArray(value)) {
        throw new ToolShedError("The Tool Shed sent an answer Planet cannot read.");
    }
    return value.filter((item): item is string => typeof item === "string" && CHANGESET.test(item)).reverse();
}

/** The repository's page on the Tool Shed. */
export function repositoryPageUrl(owner: string, name: string, baseUrl = MAIN_TOOL_SHED): string {
    return `${baseUrl}/view/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
