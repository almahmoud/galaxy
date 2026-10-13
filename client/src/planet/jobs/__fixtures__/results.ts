/** Builders for the documents a job's pod writes, shaped like planet_runtime's `stage_out` output. */

import type { DatasetResult, DiscoveredResult, PrepareDocument, ResultsDocument } from "../schemas";

export function datasetResult(uuid: string, overrides: Partial<DatasetResult> = {}): DatasetResult {
    return {
        uuid,
        state: "ok",
        name: "out_file",
        ext: "tabular",
        dbkey: "hg38",
        visible: true,
        info: "",
        blurb: "2 lines",
        peek: "a\t2\nb\t5\n",
        display_peek: "<table><tr><td>a</td><td>2</td></tr></table>",
        metadata: { columns: 2, column_types: ["str", "int"], data_lines: 2 },
        metadata_files: {},
        size: 8,
        total_size: 8,
        extra_files: null,
        created_from_basename: null,
        tool_version: "datamash (GNU datamash) 1.9",
        sanitized: false,
        data: { mode: "put", size: 8, etag: '"d41d8cd98f00b204e9800998ecf8427e"' },
        errors: [],
        warnings: [],
        ...overrides,
    };
}

export function discoveredResult(
    uuid: string,
    slot: number,
    overrides: Partial<DiscoveredResult> = {},
): DiscoveredResult {
    return {
        ...datasetResult(uuid, { name: `part ${slot}`, ...overrides }),
        slot,
        output: null,
        designation: null,
        collection: null,
        element_identifiers: [],
        ...overrides,
    };
}

export function resultsDocument(jobId: string, overrides: Partial<ResultsDocument> = {}): ResultsDocument {
    return {
        protocol: 1,
        kind: "tool",
        job_id: jobId,
        attempt: 1,
        state: "ok",
        exit_code: 0,
        termination: "normal",
        command_line:
            "datamash --sort -g 1 count 2 < '/planet/inputs/dataset_x.dat' > '/planet/job/outputs/dataset_y.dat'",
        command_version: "datamash (GNU datamash) 1.9",
        job_messages: [],
        tool_stdout: { text: "", size: 0 },
        tool_stderr: { text: "", size: 0 },
        job_stdout: { text: "", size: 0 },
        job_stderr: { text: "", size: 0 },
        filtered_outputs: [],
        outputs: {},
        discovered: [],
        output_collections: {},
        errors: [],
        timings: {
            tool_start: "2026-10-13T10:00:00.000000",
            tool_end: "2026-10-13T10:02:05.500000",
            stage_out_start: "2026-10-13T10:02:06.000000",
            stage_out_end: "2026-10-13T10:02:07.000000",
        },
        ...overrides,
    };
}

export function prepareDocument(jobId: string, overrides: Partial<PrepareDocument> = {}): PrepareDocument {
    return {
        protocol: 1,
        job_id: jobId,
        attempt: 1,
        state: "ok",
        command_line: "datamash --sort -g 1 count 2",
        version_command: "datamash --version",
        outputs: { out_file: { filtered: false, format: "tsv", label: "Datamash on data 1" } },
        environment: ["HOME", "TMPDIR", "TMP", "TEMP"],
        configfiles: [],
        errors: [],
        timings: { stage_in_start: "2026-10-13T09:59:00.000000", stage_in_end: "2026-10-13T09:59:30.000000" },
        ...overrides,
    };
}
