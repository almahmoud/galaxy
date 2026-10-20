import { describe, expect, it } from "vitest";

import { isBackupError } from "../errors";
import { MIN_PASSPHRASE_BITS, passphraseProblem, passphraseStrength } from "../keys";
import type { StatePayload } from "../payload";
import { checkRecords } from "../validate";
import { installedTool } from "./helpers";

const INSTANCE = "a1b2c3d4";
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TOOL = installedTool() as unknown as Record<string, unknown>;

function dataset(uuid = UUID): Record<string, unknown> {
    return {
        id: "d1",
        uuid,
        object_key: `datasets/${uuid}/data`,
        meta_key: `datasets/${uuid}/meta.json`,
        extra_files: { key: `datasets/${uuid}/extra.tar`, index_key: `datasets/${uuid}/extra.json` },
        metadata_files: { bam_index: { key: `datasets/${uuid}/meta/0`, file_size: 12 } },
    };
}

function job(k8s: Record<string, unknown> | null): Record<string, unknown> {
    return { id: "j1", state: "running", k8s };
}

function k8s(name = `planet-${INSTANCE}-j1-a1`, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { name, attempt: 1, multipart: [{ key: `datasets/${UUID}/data`, upload_id: "u1" }], ...extra };
}

function payload(stores: Record<string, Record<string, unknown>[]>): StatePayload {
    return {
        format: "planet-state",
        version: 1,
        schema_version: 2,
        instance_id: INSTANCE,
        created: "2026-10-13T12:00:00.000Z",
        clock: 1,
        stores,
    };
}

function problem(stores: Record<string, Record<string, unknown>[]>, builtIn: string[] = []): string | null {
    try {
        checkRecords(payload(stores), new Set(builtIn));
        return null;
    } catch (error) {
        expect(isBackupError(error, "format")).toBe(true);
        return (error as Error).message;
    }
}

function withBundle(change: (bundle: Record<string, unknown>) => void, tool = TOOL): Record<string, unknown> {
    const bundle = structuredClone(tool.bundle) as Record<string, unknown>;
    change(bundle);
    return { ...tool, bundle };
}

describe("snapshot record checks", () => {
    it("accepts the records Planet writes", () => {
        expect(
            problem({
                datasets: [dataset(), { ...dataset(), extra_files: null, metadata_files: {} }],
                uploads: [{ id: "0123456789abcdef", key: "uploads/0123456789abcdef" }],
                jobs: [job(null), job(k8s())],
                outbox: [
                    { id: "o1", kind: "purge", payload: { dataset_ids: ["d1"] } },
                    { id: "o2", kind: "dispatch", job_id: "j1", payload: { attempt: 2 } },
                ],
                tools: [
                    TOOL,
                    installedTool("github.com/repos/someone/tools/my_tool/2.0+galaxy1", "2.0+galaxy1") as never,
                ],
            }),
        ).toBeNull();
    });

    it("refuses datasets that name objects outside their own uuid", () => {
        const other = "11111111-2222-4333-8444-555555555555";
        for (const change of [
            { uuid: "../x" },
            { object_key: `datasets/${other}/data` },
            { meta_key: "state/a1b2c3d4/latest.json" },
            { extra_files: { key: `datasets/${other}/extra.tar`, index_key: `datasets/${UUID}/extra.json` } },
            { metadata_files: { bai: { key: `datasets/${UUID}/meta/../../${other}/data`, file_size: 1 } } },
            { metadata_files: { bai: { key: `datasets/${other}/meta/0`, file_size: 1 } } },
            { metadata_files: [] },
        ]) {
            expect(problem({ datasets: [{ ...dataset(), ...change }] }), JSON.stringify(change)).toMatch(/dataset/);
        }
    });

    it("refuses uploads of another object", () => {
        expect(problem({ uploads: [{ id: "u1", key: `datasets/${UUID}/data` }] })).toMatch(/upload u1/);
    });

    it("refuses Kubernetes Jobs of other instances and multipart uploads outside dataset data", () => {
        for (const value of [
            k8s("planet-ffffffff-j1-a1"),
            k8s("kube-system-thing"),
            k8s(`planet-${INSTANCE}-UPPER`),
            k8s(undefined, { attempt: 0 }),
            k8s(undefined, { multipart: [{ key: "uploads/x", upload_id: "u1" }] }),
            k8s(undefined, { multipart: null }),
        ]) {
            expect(problem({ jobs: [job(value)] }), JSON.stringify(value)).toMatch(/job j1/);
        }
    });

    it("refuses purge entries that name more than dataset ids, and unknown entries", () => {
        expect(problem({ outbox: [{ id: "o1", kind: "purge", payload: { uuids: [UUID] } }] })).toMatch(/purge/);
        expect(
            problem({ outbox: [{ id: "o1", kind: "purge", payload: { dataset_ids: ["d1"], uuids: [UUID] } }] }),
        ).toMatch(/purge/);
        expect(problem({ outbox: [{ id: "o1", kind: "purge", payload: { dataset_ids: [7] } }] })).toMatch(/purge/);
        expect(problem({ outbox: [{ id: "o1", kind: "delete_bucket", payload: null }] })).toMatch(/unknown kind/);
    });

    it("refuses tools that are not installations Planet stored", () => {
        const cases: [string, Record<string, unknown>][] = [
            ["curated", { ...TOOL, source: "curated" }],
            ["not ready", { ...TOOL, status: "installing" }],
            ["unknown host", { ...TOOL, tool_id: "toolshed.example.org/repos/me/tool/tool/1.0" }],
            ["built-in style id", { ...TOOL, tool_id: "cat1", tool_version: "1.0" }],
            ["version mismatch", { ...TOOL, tool_version: "2.0" }],
            ["bundle of another tool", withBundle((bundle) => (bundle.id = "toolshed.g2.bx.psu.edu/repos/x/y/z/1.0"))],
            [
                "archive outside installs",
                withBundle(
                    (bundle) => ((bundle.source as { repo_tar: { path: string } }).repo_tar.path = "datasets/x"),
                ),
            ],
            ["no archive", withBundle((bundle) => delete bundle.source)],
            ["code files", withBundle((bundle) => (bundle.code = ["evil.py"]))],
            ["data source", withBundle((bundle) => (bundle.tool_type = "data_source"))],
            ["another panel section", { ...TOOL, panel_section_id: "text_manipulation" }],
            ["fetched bundle", { ...TOOL, bundle_url: "https://example.org/bundle.json" }],
        ];
        for (const [what, tool] of cases) {
            expect(problem({ tools: [tool] }), what).toMatch(/tool/);
        }
    });

    it("refuses installed tools with the id of a tool built into this build", () => {
        expect(problem({ tools: [TOOL] }, [String(TOOL.tool_id)])).toMatch(/built into Planet/);
    });
});

describe("passphrase strength", () => {
    it("refuses repeated characters, runs, repetitions and common words", () => {
        for (const weak of ["aaaaaaaaaaaa", "abcdefghijklm", "123456789012", "abcabcabcabc", "passwordpassword"]) {
            expect(passphraseStrength(weak).level, weak).toBe("weak");
            expect(passphraseProblem(weak), weak).toMatch(/easy to guess/);
        }
    });

    it("accepts several unrelated words and random characters", () => {
        expect(passphraseStrength("correct horse battery staple").level).toBe("strong");
        expect(passphraseStrength("xkqwmzpdrtvb").bits).toBeGreaterThanOrEqual(MIN_PASSPHRASE_BITS);
        expect(passphraseProblem("xkqwmzpdrtvb")).toBeNull();
        expect(passphraseProblem("planet e2e backup passphrase")).toBeNull();
    });
});
