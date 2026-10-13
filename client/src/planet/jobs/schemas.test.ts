// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isSupportedKeyword, schemaKeywords } from "./__fixtures__/jsonSchema";
import { datasetResult, discoveredResult, prepareDocument, resultsDocument } from "./__fixtures__/results";
import { protocolSchema, schemaErrors } from "./__fixtures__/setup";
import { parsePrepare, parseResults, ProtocolError } from "./schemas";

const UUID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const JOB = "f2db41a1fa8ec1d3";

function fullResults() {
    return JSON.parse(
        JSON.stringify(
            resultsDocument(JOB, {
                outputs: {
                    out_file: datasetResult(UUID, {
                        metadata_files: { bam_index: { index: 0, size: 10 } },
                        extra_files: {
                            size: 1536,
                            entries: [
                                {
                                    path: "index.html",
                                    type: "file",
                                    offset: 512,
                                    size: 10,
                                    key: `datasets/${UUID}/extra/0`,
                                },
                                { path: "img", type: "directory" },
                                { path: "latest", type: "symlink", target: "index.html" },
                            ],
                        },
                        data: {
                            mode: "multipart",
                            size: 20,
                            part_size: 10,
                            parts: [{ part_number: 1, etag: '"a"', size: 10 }],
                        },
                    }),
                },
                discovered: [discoveredResult(UUID, 0, { collection: "parts", element_identifiers: ["a", "b"] })],
                output_collections: {
                    parts: {
                        name: null,
                        collection_type: "list:list",
                        populated_state: "ok",
                        populated_state_message: null,
                        elements: [
                            {
                                element_identifier: "a",
                                collection_type: "list",
                                elements: [{ element_identifier: "b", slot: 0 }],
                            },
                        ],
                    },
                },
                traceback: "Traceback (most recent call last): ...",
            }),
        ),
    );
}

/** Copies `document` with `path` set to `value` (or removed when `value` is undefined). */
function mutate(document: unknown, path: (string | number)[], value: unknown): unknown {
    const copy = JSON.parse(JSON.stringify(document));
    let node = copy;
    for (const key of path.slice(0, -1)) {
        node = node[key];
    }
    const last = path[path.length - 1]!;
    if (value === undefined) {
        delete node[last];
    } else {
        node[last] = value;
    }
    return copy;
}

describe("protocol schemas", () => {
    it("only use keywords the test validator applies", () => {
        for (const name of ["manifest", "prepare", "results"] as const) {
            const unsupported = [...schemaKeywords(protocolSchema(name))].filter(
                (keyword) => !isSupportedKeyword(keyword),
            );
            expect(unsupported, name).toEqual([]);
        }
    });
});

describe("parsePrepare", () => {
    it("accepts documents of prepare.schema.json", () => {
        const document = JSON.parse(JSON.stringify(prepareDocument(JOB)));
        expect(schemaErrors(document, "prepare")).toEqual([]);
        expect(parsePrepare(document)).toEqual(document);
        const failed = { protocol: 1, state: "error", errors: [{ phase: "templating", message: "x" }], timings: {} };
        expect(schemaErrors(failed, "prepare")).toEqual([]);
        expect(parsePrepare(failed)).toEqual(failed);
    });

    it.each([
        [["protocol"], 2],
        [["state"], "done"],
        [["errors"], undefined],
        [["errors", 0], { phase: "x" }],
        [["outputs", "out_file", "filtered"], "no"],
        [["outputs", "out_file", "extra"], true],
        [["command_line"], 3],
        [["timings"], []],
    ])("rejects %j = %j as the schema does", (path, value) => {
        const document = mutate(
            prepareDocument(JOB, { errors: [{ phase: "templating", message: "x" }] }),
            path as (string | number)[],
            value,
        );
        expect(schemaErrors(document, "prepare")).not.toEqual([]);
        expect(() => parsePrepare(document)).toThrow(ProtocolError);
    });
});

describe("parseResults", () => {
    it("accepts documents of results.schema.json", () => {
        const document = fullResults();
        expect(schemaErrors(document, "results")).toEqual([]);
        expect(parseResults(document)).toEqual(document);
    });

    it.each([
        [["kind"], "install"],
        [["attempt"], "1"],
        [["exit_code"], 1.5],
        [["termination"], "killed"],
        [["tool_stdout", "size"], -1],
        [["job_messages", 0], { desc: "no type" }],
        [["outputs", "out_file", "state"], "running"],
        [["outputs", "out_file", "metadata_files", "bam_index", "index"], "0"],
        [["outputs", "out_file", "extra_files", "entries", 0, "type"], "fifo"],
        [["outputs", "out_file", "data", "parts", 0, "part_number"], 0],
        [["outputs", "out_file", "warnings"], undefined],
        [["discovered", 0, "slot"], undefined],
        [["output_collections", "parts", "populated_state"], "partial"],
        [["output_collections", "parts", "elements", 0, "elements", 0, "element_identifier"], 1],
        [["timings", "tool_start"], 5],
    ])("rejects %j = %j as the schema does", (path, value) => {
        const document = fullResults();
        if (path[0] === "job_messages") {
            document.job_messages = [{ type: "exit_code", desc: "x" }];
        }
        const mutated = mutate(document, path as (string | number)[], value);
        expect(schemaErrors(mutated, "results")).not.toEqual([]);
        expect(() => parseResults(mutated)).toThrow(ProtocolError);
    });

    it("names the property that does not match", () => {
        const document = mutate(fullResults(), ["outputs", "out_file", "size"], "8");
        expect(() => parseResults(document)).toThrow(
            "results.json is invalid at /outputs/out_file/size: expected an integer",
        );
    });
});

describe("parseResults limits", () => {
    it("rejects dataset UUIDs the browser could not have allocated", () => {
        for (const uuid of ["../../jobs/x", "1B4E28BA-2FA1-41D2-883F-0016D3CCA427", ""]) {
            const document = resultsDocument(JOB, { outputs: { out_file: datasetResult(uuid) } });
            expect(() => parseResults(document)).toThrow("results.json is invalid at /outputs/out_file/uuid");
        }
        const discovered = resultsDocument(JOB, { discovered: [discoveredResult("slot", 0)] });
        expect(() => parseResults(discovered)).toThrow("/discovered/0/uuid");
    });

    it("rejects documents nested deeper than the limit, without exhausting the stack", () => {
        let deep: unknown = "leaf";
        for (let level = 0; level < 100_000; level++) {
            deep = [deep];
        }
        const document = resultsDocument(JOB, {
            outputs: { out_file: datasetResult(UUID, { metadata: { nested: deep } }) },
        });
        expect(() => parseResults(document)).toThrow(ProtocolError);
        expect(() => parsePrepare({ ...prepareDocument(JOB), environment: deep })).toThrow("nested deeper than 64");
    });
});
