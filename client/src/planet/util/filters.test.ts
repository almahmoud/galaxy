// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ApiError } from "./errors";
import {
    type ContentsFilterSubject,
    matchesContentsFilters,
    matchesHistoryFilters,
    matchesTag,
    parseContentsFilters,
    parseHistoryFilters,
    parseSearch,
    readQueryFilters,
    sqlLike,
} from "./filters";
import { parseGalaxyTime } from "./time";

function query(pairs: [string, string][]): URLSearchParams {
    const params = new URLSearchParams();
    for (const [q, qv] of pairs) {
        params.append("q", q);
        params.append("qv", qv);
    }
    return params;
}

function dataset(overrides: Partial<ContentsFilterSubject> = {}): ContentsFilterSubject {
    return {
        history_content_type: "dataset",
        id: "0123456789abcdef",
        hid: 3,
        name: "Reads.fastq",
        state: "ok",
        extension: "fastqsanger",
        visible: true,
        deleted: false,
        purged: false,
        tags: ["name:sample1", "group:condition:treated", "raw"],
        annotation: "First run",
        genome_build: "hg38",
        create_time: "2026-10-09T10:00:00.000000",
        update_time: "2026-10-09T11:00:00.000000",
        object_store_id: null,
        tool_ids: ["upload1"],
        ...overrides,
    };
}

describe("readQueryFilters", () => {
    it("splits the operator after the last dash and pairs q with qv by position", () => {
        const params = query([
            ["deleted", "false"],
            ["name-contains", "reads"],
            ["update_time-ge", "2026-10-09"],
        ]);
        params.append("q", "visible");
        expect(readQueryFilters(params)).toEqual([
            { attr: "deleted", op: "eq", value: "false" },
            { attr: "name", op: "contains", value: "reads" },
            { attr: "update_time", op: "ge", value: "2026-10-09" },
        ]);
    });
});

describe("parseContentsFilters", () => {
    it("parses the history panel's default and watcher filters", () => {
        const filters = parseContentsFilters(
            query([
                ["deleted", "false"],
                ["visible", "true"],
                ["update_time-ge", "2026-10-09T11:00:00.000Z"],
                ["hid-le", "10"],
                ["state-in", "ok,error"],
                ["extension-in", "bam,sam"],
                ["related-eq", "4"],
                ["history_content_type-eq", "dataset_collection"],
            ]),
        );
        expect(filters).toEqual([
            { attr: "deleted", op: "eq", value: false },
            { attr: "visible", op: "eq", value: true },
            { attr: "update_time", op: "ge", value: parseGalaxyTime("2026-10-09T11:00:00.000Z") },
            { attr: "hid", op: "le", value: 10 },
            { attr: "state", op: "in", value: ["ok", "error"] },
            { attr: "extension", op: "in", value: ["bam", "sam"] },
            { attr: "related", op: "eq", value: [4] },
            { attr: "history_content_type", op: "eq", value: "dataset_collection" },
        ]);
    });

    it.each([
        ["unknown", "x", "bad filter"],
        ["deleted-contains", "x", "bad filter"],
        ["deleted", "yes", "unparsable value for filter"],
        ["hid", "three", "unparsable value for filter"],
        ["state", "done", "unparsable value for filter"],
        ["create_time-gt", "last week", "unparsable value for filter"],
        ["history_content_type", "file", "unparsable value for filter"],
        ["__proto__", "x", "bad filter"],
    ])("rejects %s=%s", (q, qv, message) => {
        let caught: unknown;
        try {
            parseContentsFilters(query([[q, qv]]));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).status).toBe(400);
        expect((caught as ApiError).errCode).toBe(400008);
        expect((caught as ApiError).message).toBe(message);
    });
});

describe("matchesContentsFilters", () => {
    const match = (pairs: [string, string][], item = dataset()) =>
        matchesContentsFilters(item, parseContentsFilters(query(pairs)));

    it("matches names: eq is exact, contains ignores case, like uses SQL wildcards", () => {
        expect(match([["name", "Reads.fastq"]])).toBe(true);
        expect(match([["name", "reads.fastq"]])).toBe(false);
        expect(match([["name-contains", "READS"]])).toBe(true);
        expect(match([["name-like", "Reads%"]])).toBe(true);
        expect(match([["name-like", "reads%"]])).toBe(false);
    });

    it("matches tags like Galaxy's tag filter", () => {
        expect(match([["tag", "name"]])).toBe(true);
        expect(match([["tag", "name:sample1"]])).toBe(true);
        expect(match([["tag", "name:sample"]])).toBe(false);
        expect(match([["tag-contains", "sample"]])).toBe(true);
        expect(match([["tag", "RAW"]])).toBe(true);
        expect(match([["tag-has", "treat"]])).toBe(true);
    });

    it("matches state, extension, genome build, annotation and tools", () => {
        expect(match([["state", "ok"]])).toBe(true);
        expect(match([["state-in", "error,paused"]])).toBe(false);
        expect(match([["extension", "fastqsanger"]])).toBe(true);
        expect(match([["extension-like", "fastq%"]])).toBe(true);
        expect(match([["genome_build", "HG38"]])).toBe(true);
        expect(match([["genome_build-contains", "g3"]])).toBe(true);
        expect(match([["genome_build", "hg38"]], dataset({ genome_build: '["hg38"]' }))).toBe(true);
        expect(match([["annotation-has", "RUN"]])).toBe(true);
        expect(match([["tool_id", "upload1"]])).toBe(true);
        expect(match([["tool_id-contains", "cat"]])).toBe(false);
    });

    it("matches hids, times and flags", () => {
        expect(match([["hid-ge", "3"]])).toBe(true);
        expect(match([["hid-gt", "3"]])).toBe(false);
        expect(match([["update_time-ge", "2026-10-09T11:00:00"]])).toBe(true);
        expect(match([["update_time-gt", "2026-10-09T11:00:00"]])).toBe(false);
        expect(match([["create_time-lt", "2026-10-09T10:00:00.000001"]])).toBe(true);
        expect(
            match([
                ["deleted", "false"],
                ["visible", "true"],
            ]),
        ).toBe(true);
        expect(match([["visible", "false"]])).toBe(false);
        expect(match([["related", "[1,3]"]])).toBe(true);
        expect(match([["type_id-in", "dataset-0123456789abcdef,dataset_collection-1"]])).toBe(true);
    });

    it("matches collections by their leaf extensions and never by genome build", () => {
        const collection = dataset({
            history_content_type: "dataset_collection",
            extension: null,
            leaf_extensions: ["bam", "bam"],
            genome_build: null,
            state: "ok",
        });
        expect(match([["extension", "bam"]], collection)).toBe(true);
        expect(match([["extension-in", "sam,bam"]], collection)).toBe(true);
        expect(match([["extension", "sam"]], collection)).toBe(false);
        expect(match([["extension", "sam"]], { ...collection, leaf_extensions: [] })).toBe(true);
        expect(match([["genome_build", "hg38"]], collection)).toBe(false);
        expect(match([["history_content_type", "dataset_collection"]], collection)).toBe(true);
    });
});

describe("history filters", () => {
    it("parses and matches history list filters", () => {
        const filters = parseHistoryFilters(
            query([
                ["name-contains", "rna"],
                ["deleted", "false"],
                ["username-eq", "Planet"],
            ]),
        );
        const history = {
            name: "RNA-seq",
            genome_build: null,
            slug: null,
            create_time: "2026-10-09T10:00:00.000000",
            update_time: "2026-10-09T10:00:00.000000",
            deleted: false,
            purged: false,
            published: false,
            importable: false,
            tags: [],
            annotation: null,
            username: "planet",
        };
        expect(matchesHistoryFilters(history, filters)).toBe(true);
        expect(matchesHistoryFilters({ ...history, deleted: true }, filters)).toBe(false);
    });
});

describe("helpers", () => {
    it("implements SQL LIKE", () => {
        expect(sqlLike("a.b", "a_b")).toBe(true);
        expect(sqlLike("a.b", "a%")).toBe(true);
        expect(sqlLike("a%b", "a\\%b")).toBe(true);
        expect(sqlLike("axb", "a\\%b")).toBe(false);
        expect(sqlLike("a(b", "a(b")).toBe(true);
        expect(sqlLike("abcbcd", "a%bcd")).toBe(true);
        expect(sqlLike("abc", "a%c%")).toBe(true);
        expect(sqlLike("abc", "_b_")).toBe(true);
        expect(sqlLike("abc", "__")).toBe(false);
        expect(sqlLike("", "%")).toBe(true);
        expect(sqlLike("x", "")).toBe(false);
    });

    it("matches LIKE patterns in bounded time", () => {
        const started = performance.now();
        expect(sqlLike("a".repeat(5000), "%a%a%a%a%a%a%a%a%a%a%b")).toBe(false);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    it("matches tags case-insensitively", () => {
        expect(matchesTag(["Name:Foo"], "eq", "name:foo")).toBe(true);
    });
});

describe("parseSearch", () => {
    const keys = { moo: "mookey" };

    it("matches galaxy.util.search tests", () => {
        let result = parseSearch("moo cow", {});
        expect(result.filterTerms).toEqual([]);
        expect(result.textTerms.map((term) => term.text)).toEqual(["moo", "cow"]);

        result = parseSearch("moo:mooterm cow", keys);
        expect(result.filterTerms).toEqual([{ kind: "filter", filter: "mookey", text: "mooterm", quoted: false }]);
        expect(result.textTerms.map((term) => term.text).join(" ")).toBe("cow");

        result = parseSearch(`moo:"moo term" cow`, keys);
        expect(result.filterTerms[0]).toEqual({ kind: "filter", filter: "mookey", text: "moo term", quoted: true });

        result = parseSearch("cow moo:'moo term' other side", keys);
        expect(result.filterTerms[0]?.text).toBe("moo term");
        expect(result.textTerms.map((term) => term.text).join(" ")).toBe("cow other side");

        result = parseSearch("cow 'other side' foo", keys);
        expect(result.textTerms).toEqual([
            { kind: "text", text: "cow", quoted: false },
            { kind: "text", text: "other side", quoted: true },
            { kind: "text", text: "foo", quoted: false },
        ]);

        result = parseSearch("cow moo:'moo' other side", keys, false);
        expect(result.filterTerms[0]?.quoted).toBe(false);
    });

    it("keeps name tags and Unicode words", () => {
        const result = parseSearch("tag:name:sample1 name:données is:deleted", {
            tag: "tag",
            name: "name",
            is: "is",
        });
        expect(result.filterTerms.map(({ filter, text }) => [filter, text])).toEqual([
            ["tag", "name:sample1"],
            ["name", "données"],
            ["is", "deleted"],
        ]);
    });
});
