/**
 * Checks, before a GitHub installation is created, that its commit is part of the named repository's history.
 *
 * codeload.github.com serves every commit of a repository's fork network under each repository's name, so the
 * install pod can prove which commit it read and that GitHub served it as `<owner>/<name>`, but not that the commit
 * belongs to that repository rather than to one of its forks. GitHub's REST API answers that: the commit is the head
 * of a branch or tag of the repository, or an ancestor of one (`compare/<ref>...<commit>` is `behind` or
 * `identical`). The check holds when the installation is created; later force pushes can drop the commit from every
 * branch. Requests carry no credentials or referrer; GitHub allows 60 of them an hour per address.
 */

import type { GitHubSource } from "./source";

export const GITHUB_API = "https://api.github.com";
/** Comparisons with branches and tags other than the default branch, at most. */
export const MAX_COMPARISONS = 8;
const PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const COMMIT = /^[0-9a-f]{40}$/;

/** The commit cannot be shown to belong to the repository; the message says why, for people to read. */
export class GitHubCommitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GitHubCommitError";
    }
}

/** GitHub could not be asked; the message says why, for people to read. */
export class GitHubUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GitHubUnavailableError";
    }
}

export interface GitHubOptions {
    signal?: AbortSignal;
    /** Defaults to the global fetch. */
    fetch?: typeof fetch;
    /** Defaults to {@link GITHUB_API}. */
    baseUrl?: string;
}

/** Thrown inside {@link getJson} for answers larger than the limit. */
class TooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
            throw new TooLargeError();
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

function rateLimitMessage(response: Response): string {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const when =
        Number.isFinite(reset) && reset > 0
            ? ` after ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC`
            : " later";
    return `GitHub's limit of API requests from this network is used up. Try again${when}.`;
}

/** GETs a GitHub API path; resolves to null for 404 and 422 (unknown repository, ref or commit). */
async function getJson(path: string, options: GitHubOptions): Promise<unknown> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
        response = await (options.fetch ?? globalThis.fetch)(`${options.baseUrl ?? GITHUB_API}${path}`, {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: { Accept: "application/vnd.github+json" },
            signal,
        });
    } catch (error) {
        if (options.signal?.aborted) {
            throw error;
        }
        throw new GitHubUnavailableError(
            timeout.aborted
                ? "GitHub did not answer in time. Try again later."
                : "GitHub could not be reached. Check your connection and try again.",
        );
    }
    if (response.status === 404 || response.status === 422) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (
            (response.status === 403 || response.status === 429) &&
            response.headers.get("x-ratelimit-remaining") === "0"
        ) {
            throw new GitHubUnavailableError(rateLimitMessage(response));
        }
        throw new GitHubUnavailableError(`GitHub answered with HTTP ${response.status}. Try again later.`);
    }
    try {
        return JSON.parse(await readLimited(response));
    } catch (error) {
        if (error instanceof TooLargeError) {
            throw error;
        }
        throw new GitHubUnavailableError("GitHub sent an answer Planet cannot read.");
    }
}

function refPath(ref: string): string {
    return ref.split("/").map(encodeURIComponent).join("/");
}

/** True when `commit` is `base` or one of its ancestors. */
async function reachableFrom(
    repository: string,
    base: string,
    commit: string,
    options: GitHubOptions,
): Promise<boolean> {
    let comparison: unknown;
    try {
        // One commit per page: a reachable commit adds none, and the answer stays small.
        comparison = await getJson(`/repos/${repository}/compare/${refPath(base)}...${commit}?per_page=1`, options);
    } catch (error) {
        // Large answers list commits or files the base does not have.
        if (error instanceof TooLargeError) {
            return false;
        }
        throw error;
    }
    return isRecord(comparison) && (comparison.status === "behind" || comparison.status === "identical");
}

/** Names and head commits of a repository's branches or tags (first page). */
async function refHeads(repository: string, kind: "branches" | "tags", options: GitHubOptions) {
    const listed = await getJson(`/repos/${repository}/${kind}?per_page=${PAGE_SIZE}`, options).catch((error) => {
        if (error instanceof TooLargeError) {
            return [];
        }
        throw error;
    });
    return (Array.isArray(listed) ? listed : []).flatMap((item): { name: string; sha: string }[] => {
        const sha = isRecord(item) && isRecord(item.commit) ? item.commit.sha : null;
        return isRecord(item) && typeof item.name === "string" && typeof sha === "string" && COMMIT.test(sha)
            ? [{ name: item.name, sha }]
            : [];
    });
}

/**
 * Checks that the commit of `source` is on a branch or tag of its repository and returns the source with the
 * repository's name as GitHub spells it.
 *
 * @throws GitHubCommitError when the repository or commit does not exist or the commit is on none of the branches
 *   and tags compared
 * @throws GitHubUnavailableError when GitHub cannot be asked
 */
export async function verifyGitHubCommit(source: GitHubSource, options: GitHubOptions = {}): Promise<GitHubSource> {
    const metadata = await getJson(`/repos/${source.repository}`, options).catch((error) => {
        throw error instanceof TooLargeError
            ? new GitHubUnavailableError("GitHub sent an answer Planet cannot read.")
            : error;
    });
    const fullName = isRecord(metadata) && typeof metadata.full_name === "string" ? metadata.full_name : null;
    const defaultBranch =
        isRecord(metadata) && typeof metadata.default_branch === "string" ? metadata.default_branch : null;
    if (!fullName || !defaultBranch) {
        throw new GitHubCommitError(`GitHub has no public repository ${source.repository}.`);
    }
    if (fullName.toLowerCase() !== source.repository.toLowerCase()) {
        throw new GitHubCommitError(`${source.repository} is now ${fullName} on GitHub. Install from ${fullName}.`);
    }
    const verified = { ...source, repository: fullName };
    if (await reachableFrom(fullName, defaultBranch, source.ref, options)) {
        return verified;
    }
    const refs = [...(await refHeads(fullName, "branches", options)), ...(await refHeads(fullName, "tags", options))];
    if (refs.some((ref) => ref.sha === source.ref)) {
        return verified;
    }
    const others = [...new Set(refs.filter((ref) => ref.name !== defaultBranch).map((ref) => ref.sha))];
    for (const head of others.slice(0, MAX_COMPARISONS)) {
        if (await reachableFrom(fullName, head, source.ref, options)) {
            return verified;
        }
    }
    const exists = await getJson(`/repos/${fullName}/commits/${source.ref}`, options).catch((error) => {
        if (error instanceof TooLargeError) {
            return true;
        }
        throw error;
    });
    if (exists === null) {
        throw new GitHubCommitError(`GitHub has no commit ${source.ref} in ${fullName}.`);
    }
    const checked =
        others.length > MAX_COMPARISONS
            ? ` Planet compared it with the default branch and ${MAX_COMPARISONS} of the other ${others.length} branches and tags.`
            : "";
    throw new GitHubCommitError(
        `Commit ${source.ref} is not on a branch or tag of ${fullName}.${checked} GitHub also serves commits of ` +
            "forks under the name of the repository they were forked from; install a fork's commit from the fork.",
    );
}
