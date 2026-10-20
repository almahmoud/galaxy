import { describe, expect, it, vi } from "vitest";

import { GitHubCommitError, GitHubUnavailableError, MAX_COMPARISONS, verifyGitHubCommit } from "../github";
import type { GitHubSource } from "../source";

const COMMIT = "a".repeat(40);
const SOURCE: GitHubSource = { type: "github", repository: "Planet/Demo", ref: COMMIT, path: "tools/demo" };

interface FakeRepository {
    full_name?: string;
    default_branch?: string;
    /** The status of `compare/<base>...<COMMIT>` by base. */
    compare?: Record<string, string>;
    branches?: { name: string; commit: { sha: string } }[];
    tags?: { name: string; commit: { sha: string } }[];
    commitExists?: boolean;
}

function github(repository: FakeRepository | null, overrides: (url: URL) => Response | undefined = () => undefined) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
        const url = new URL(String(input));
        const answer = overrides(url);
        if (answer) {
            return answer;
        }
        const json = (body: unknown) => new Response(JSON.stringify(body));
        const path = url.pathname;
        if (!repository) {
            return new Response("{}", { status: 404 });
        }
        if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
            return json({
                full_name: repository.full_name ?? "planet/demo",
                default_branch: repository.default_branch,
            });
        }
        const compare = /\/compare\/(.+)\.\.\.([0-9a-f]{40})$/.exec(path);
        if (compare) {
            const status = repository.compare?.[decodeURIComponent(compare[1]!)];
            return status ? json({ status, commits: [], files: [] }) : new Response("{}", { status: 404 });
        }
        if (path.endsWith("/branches")) {
            return json(repository.branches ?? []);
        }
        if (path.endsWith("/tags")) {
            return json(repository.tags ?? []);
        }
        if (path.endsWith(`/commits/${COMMIT}`)) {
            return repository.commitExists ? json({ sha: COMMIT }) : new Response("{}", { status: 422 });
        }
        return new Response("{}", { status: 404 });
    });
    return fetchMock;
}

describe("verifyGitHubCommit", () => {
    it("accepts a commit on the default branch and spells the repository as GitHub does", async () => {
        const fetch = github({ default_branch: "main", compare: { main: "behind" } });
        expect(await verifyGitHubCommit(SOURCE, { fetch })).toEqual({ ...SOURCE, repository: "planet/demo" });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[1]![0])).toBe(
            `https://api.github.com/repos/planet/demo/compare/main...${COMMIT}?per_page=1`,
        );
    });

    it("accepts the head of a tag and an ancestor of another branch", async () => {
        const tagged = github({
            default_branch: "main",
            compare: { main: "diverged" },
            tags: [{ name: "v1", commit: { sha: COMMIT } }],
        });
        expect((await verifyGitHubCommit(SOURCE, { fetch: tagged })).ref).toBe(COMMIT);
        const branched = github({
            default_branch: "main",
            compare: { main: "ahead", ["b".repeat(40)]: "identical" },
            branches: [
                { name: "main", commit: { sha: "c".repeat(40) } },
                { name: "release/1.x", commit: { sha: "b".repeat(40) } },
            ],
        });
        expect((await verifyGitHubCommit(SOURCE, { fetch: branched })).ref).toBe(COMMIT);
    });

    it("refuses commits of forks, unknown commits, unknown and renamed repositories", async () => {
        const fork = github({ default_branch: "main", compare: { main: "diverged" }, commitExists: true });
        await expect(verifyGitHubCommit(SOURCE, { fetch: fork })).rejects.toThrow(
            new GitHubCommitError(
                `Commit ${COMMIT} is not on a branch or tag of planet/demo. GitHub also serves commits of forks under ` +
                    "the name of the repository they were forked from; install a fork's commit from the fork.",
            ),
        );
        const unknown = github({ default_branch: "main", commitExists: false });
        await expect(verifyGitHubCommit(SOURCE, { fetch: unknown })).rejects.toThrow(
            `GitHub has no commit ${COMMIT} in planet/demo.`,
        );
        await expect(verifyGitHubCommit(SOURCE, { fetch: github(null) })).rejects.toThrow(
            "GitHub has no public repository Planet/Demo.",
        );
        const renamed = github({ full_name: "planet/demo-tools", default_branch: "main" });
        await expect(verifyGitHubCommit(SOURCE, { fetch: renamed })).rejects.toThrow(
            "Planet/Demo is now planet/demo-tools on GitHub. Install from planet/demo-tools.",
        );
    });

    it("compares with a bounded number of branches and tags", async () => {
        const branches = Array.from({ length: MAX_COMPARISONS + 3 }, (_, index) => ({
            name: `b${index}`,
            commit: { sha: index.toString(16).padStart(40, "0") },
        }));
        const fetch = github({ default_branch: "main", branches, commitExists: true });
        await expect(verifyGitHubCommit(SOURCE, { fetch })).rejects.toThrow(
            `compared it with the default branch and ${MAX_COMPARISONS} of the other ${MAX_COMPARISONS + 3}`,
        );
        const comparisons = fetch.mock.calls.filter(([url]) => String(url).includes("/compare/"));
        expect(comparisons).toHaveLength(MAX_COMPARISONS + 1);
    });

    it("treats a large comparison as not reachable", async () => {
        const large = "x".repeat(5 * 1024 * 1024);
        const fetch = github({ default_branch: "main", commitExists: true }, (url) =>
            url.pathname.includes("/compare/")
                ? new Response(JSON.stringify({ status: "diverged", files: [large] }))
                : undefined,
        );
        await expect(verifyGitHubCommit(SOURCE, { fetch })).rejects.toThrow(GitHubCommitError);
    });

    it("reports GitHub's rate limit and failures as unavailable", async () => {
        const reset = Date.UTC(2026, 9, 19, 14, 5) / 1000;
        const limited = github(
            null,
            () =>
                new Response("{}", {
                    status: 403,
                    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
                }),
        );
        await expect(verifyGitHubCommit(SOURCE, { fetch: limited })).rejects.toThrow(
            new GitHubUnavailableError(
                "GitHub's limit of API requests from this network is used up. Try again after 14:05 UTC.",
            ),
        );
        const failing = github(null, () => new Response("{}", { status: 500 }));
        await expect(verifyGitHubCommit(SOURCE, { fetch: failing })).rejects.toThrow("HTTP 500");
        const offline = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        await expect(verifyGitHubCommit(SOURCE, { fetch: offline })).rejects.toThrow("GitHub could not be reached");
    });
});
