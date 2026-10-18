import { describe, expect, it, vi } from "vitest";

import { installableRevisions, searchRepositories, searchTools, ToolShedError } from "../toolshed";

function answering(body: unknown, init: ResponseInit = {}) {
    return vi.fn<typeof fetch>(
        async () =>
            new Response(typeof body === "string" ? body : JSON.stringify(body), {
                headers: { "Content-Type": "application/json" },
                ...init,
            }),
    );
}

const REPOSITORIES = {
    total_results: "2",
    page: "1",
    page_size: "10",
    hits: [
        {
            score: 2332.7,
            repository: {
                id: "e3a05b9b4d4d2121",
                name: "datamash_ops",
                repo_owner_username: "iuc",
                description: "GNU Datamash is a command-line program\nwhich performs basic\n\noperations.",
                remote_repository_url: "https://github.com/galaxyproject/tools-iuc/tree/main/tools/datamash",
                homepage_url: "javascript:alert(1)",
                times_downloaded: 6031,
                categories: "text manipulation",
            },
        },
        { score: 1, repository: { name: "../evil", repo_owner_username: "x" } },
    ],
};

describe("Tool Shed client", () => {
    it("searches repositories without credentials or referrer", async () => {
        const fetch = answering(REPOSITORIES);
        const page = await searchRepositories(" datamash ", 1, { fetch });
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe("https://toolshed.g2.bx.psu.edu/api/repositories?q=datamash&page=1&page_size=10");
        expect(init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", mode: "cors" });
        expect(page.total).toBe(2);
        expect(page.hits).toEqual([
            {
                owner: "iuc",
                name: "datamash_ops",
                description: "GNU Datamash is a command-line program which performs basic operations.",
                homepage_url: null,
                remote_repository_url: "https://github.com/galaxyproject/tools-iuc/tree/main/tools/datamash",
                times_downloaded: 6031,
                categories: "text manipulation",
            },
        ]);
    });

    it("searches tools", async () => {
        const fetch = answering({
            total_results: "7",
            page: "2",
            hits: [
                {
                    tool: {
                        id: "datamash_ops",
                        repo_owner_username: "iuc",
                        repo_name: "datamash_ops",
                        name: "Datamash",
                        description: "(operations on tabular data)",
                    },
                    score: 38.5,
                },
            ],
        });
        const page = await searchTools("datamash", 2, { fetch });
        expect(fetch.mock.calls[0]![0]).toContain("/api/tools?q=datamash&page=2");
        expect(page).toEqual({
            total: 7,
            page: 2,
            hits: [
                {
                    id: "datamash_ops",
                    name: "Datamash",
                    description: "(operations on tabular data)",
                    owner: "iuc",
                    repository: "datamash_ops",
                },
            ],
        });
    });

    it("lists installable revisions newest first", async () => {
        const fetch = answering(["2f3c6f2dcf39", "<b>x</b>", "aaafc0ac4dd2"]);
        expect(await installableRevisions("iuc", "datamash_ops", { fetch })).toEqual(["aaafc0ac4dd2", "2f3c6f2dcf39"]);
        expect(fetch.mock.calls[0]![0]).toBe(
            "https://toolshed.g2.bx.psu.edu/api/repositories/get_ordered_installable_revisions?owner=iuc&name=datamash_ops",
        );
    });

    it("explains failures", async () => {
        await expect(searchRepositories("", 1, { fetch: answering(REPOSITORIES) })).rejects.toThrow(/Enter what/);
        await expect(searchTools("x", 1, { fetch: answering("oops", { status: 502 }) })).rejects.toThrow(/HTTP 502/);
        await expect(searchTools("x", 1, { fetch: answering("not json") })).rejects.toThrow(ToolShedError);
        const offline = vi.fn<typeof fetch>(async () => {
            throw new TypeError("Failed to fetch");
        });
        await expect(searchTools("x", 1, { fetch: offline })).rejects.toThrow(/could not be reached/);
        await expect(installableRevisions("a/b", "c", { fetch: offline })).rejects.toThrow(/valid owner and name/);
    });

    it("refuses answers larger than expected", async () => {
        const fetch = answering(JSON.stringify({ hits: [], padding: "x".repeat(5 * 1024 * 1024) }));
        await expect(searchTools("x", 1, { fetch })).rejects.toThrow(/larger answer/);
    });
});
