/**
 * Documents of the job protocol (planet/docs/job-protocol.md, planet/runtime/schemas/*.schema.json): the manifest
 * the browser writes, and `prepare.json` and `results.json`, which the pod writes and the browser checks with
 * {@link parsePrepare} and {@link parseResults} before using them.
 */

export const PROTOCOL_VERSION = 1;

/** A presigned request: a bare URL, or a URL with headers to send as given. */
export type ProtocolRequest = string | { url: string; headers?: Record<string, string> };

export type JobKind = "tool" | "upload" | "set_metadata" | "tool_install";

// ---------------------------------------------------------------------------------------------------------
// Tool bundles (planet/docs/tool-bundle.md), as far as the job protocol reads them

export interface BundleParameter {
    model_class?: string;
    type?: string;
    name: string;
    inputs?: BundleParameter[];
    test_param?: BundleParameter;
    cases?: { value: string; inputs?: BundleParameter[] }[];
    [key: string]: unknown;
}

export interface BundleOutput {
    model_class: string;
    name: string;
    format?: string | null;
    outputs?: BundleOutput[] | Record<string, BundleOutput>;
    [key: string]: unknown;
}

export interface ToolBundle {
    id: string;
    version: string;
    name?: string;
    profile?: string;
    inputs?: BundleParameter[];
    outputs?: BundleOutput[] | Record<string, BundleOutput>;
    requirements?: { type: string; name: string; version?: string | null }[];
    containers?: { type: string; identifier: string; shell?: string }[];
    resource_requirements?: { resource_type?: string; value_or_expression?: unknown }[];
    source?: { repo_tar?: { path: string; sha256: string; size: number } | null } | null;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------
// Manifest

export interface ManifestMultipart {
    parts: ProtocolRequest[];
    part_size?: number;
}

/** Presigned destinations of a dataset (`#/$defs/dataset_targets`). */
export interface ManifestDatasetTargets {
    uuid: string;
    data?: { put?: ProtocolRequest; multipart?: ManifestMultipart };
    meta?: ProtocolRequest;
    extra?: ProtocolRequest;
    extra_index?: ProtocolRequest;
    sanitized?: ProtocolRequest;
    metadata_files?: ProtocolRequest[];
    extra_objects?: { key: string; request: ProtocolRequest }[];
}

export interface ManifestOutput extends ManifestDatasetTargets {
    name: string;
    id?: string;
    hid?: number;
    object_id?: string;
    ext?: string;
    dbkey?: string;
    visible?: boolean;
    metadata?: Record<string, unknown>;
}

export interface ManifestInput {
    uuid: string;
    id?: string;
    hid?: number;
    name?: string;
    ext?: string;
    dbkey?: string;
    info?: string | null;
    tags?: string[];
    element_identifier?: string | null;
    created_from_basename?: string | null;
    metadata?: Record<string, unknown>;
    metadata_files?: Record<string, ProtocolRequest>;
    data?: ProtocolRequest;
    size?: number;
    extra?: ProtocolRequest;
}

export interface ManifestCollectionElement {
    element_identifier: string;
    input?: string;
    collection_type?: string;
    elements?: ManifestCollectionElement[];
    columns?: unknown;
}

export interface ManifestCollection {
    name?: string;
    id?: string;
    hid?: number;
    collection_type: string;
    element_identifier?: string;
    elements: ManifestCollectionElement[];
}

export interface ManifestOutputCollection {
    name?: string;
    id?: string;
    hid?: number;
    collection_type: string;
    elements?: { element_identifier: string; output: string; param_name?: string }[];
}

export interface ManifestJob {
    id: string;
    attempt: number;
    history_id?: string;
    walltime_seconds: number;
    slots: number;
    memory_mb: number | null;
    shell?: string;
}

export interface ManifestSetMetadataEntry {
    input: string;
    output: string;
    ext: string | null;
    detect: boolean;
    overwrite: boolean;
}

export interface Manifest {
    protocol: typeof PROTOCOL_VERSION;
    kind: JobKind;
    job: ManifestJob;
    tool?: ToolBundle & { archive?: { request: ProtocolRequest; directory?: string; sha256?: string } };
    params?: Record<string, unknown>;
    inputs?: Record<string, ManifestInput>;
    collections?: Record<string, ManifestCollection>;
    outputs: ManifestOutput[];
    output_collections?: Record<string, ManifestOutputCollection>;
    slots?: ManifestDatasetTargets[];
    job_files: {
        prepare?: ProtocolRequest;
        results: ProtocolRequest;
        stdout?: ProtocolRequest;
        stderr?: ProtocolRequest;
    };
    user?: { email?: string; username?: string };
    datatypes?: { source: "builtin" };
    limits?: { max_discovered_files?: number; max_metadata_value_size?: number; start_timeout_seconds?: number | null };
    upload?: { request: Record<string, unknown>; files: Record<string, { request: ProtocolRequest; size?: number }> };
    set_metadata?: { datasets: ManifestSetMetadataEntry[] };
    install?: ManifestInstall;
}

/** A presigned request and the object key it writes (`#/$defs/keyed_request`). */
export interface ManifestKeyedRequest {
    key: string;
    request: ProtocolRequest;
}

/** `install` of a `tool_install` manifest: the repository and a slot per tool it may install. */
export interface ManifestInstall {
    source: Record<string, unknown>;
    panel_section?: { id: string; name: string };
    slots: { bundle: ManifestKeyedRequest; repo_tar: ManifestKeyedRequest }[];
}

// ---------------------------------------------------------------------------------------------------------
// prepare.json and results.json

export interface PrepareOutputDecision {
    filtered: boolean;
    format: string | null;
    label: string;
}

export interface PrepareDocument {
    protocol: typeof PROTOCOL_VERSION;
    job_id?: string;
    attempt?: number;
    state: "ok" | "error";
    command_line?: string | null;
    version_command?: string | null;
    outputs?: Record<string, PrepareOutputDecision>;
    environment?: string[];
    configfiles?: string[];
    errors: { phase: string; message: string }[];
    timings: { stage_in_start?: string; stage_in_end?: string };
}

export interface ResultStream {
    text: string;
    size: number;
}

export interface ResultJobMessage {
    type: string;
    desc: string | null;
    code_desc?: string | null;
    error_level?: number | null;
    [key: string]: unknown;
}

export interface ExtraFileEntry {
    path: string;
    type: "file" | "directory" | "symlink";
    offset?: number;
    size?: number;
    target?: string;
    key?: string;
}

export interface DataUploadResult {
    mode: "put" | "multipart" | "none";
    size: number;
    etag?: string | null;
    part_size?: number;
    parts?: { part_number: number; etag: string | null; size: number }[];
}

/** A dataset record (`#/$defs/dataset` of results.schema.json, also stored as `datasets/<uuid>/meta.json`). */
export interface DatasetResult {
    uuid: string;
    state: "ok" | "error" | "failed_metadata" | "empty";
    name: string | null;
    ext: string;
    dbkey: string | null;
    visible: boolean;
    info: string | null;
    blurb: string | null;
    peek: string | null;
    display_peek?: string | null;
    metadata: Record<string, unknown>;
    metadata_files: Record<string, { index: number; size: number }>;
    size: number;
    total_size: number;
    extra_files: { size: number; entries: ExtraFileEntry[] } | null;
    created_from_basename?: string | null;
    tool_version?: string | null;
    sanitized: boolean;
    data?: DataUploadResult;
    errors: string[];
    warnings: string[];
}

export interface DiscoveredResult extends DatasetResult {
    slot: number;
    output?: string | null;
    designation?: string | null;
    collection?: string | null;
    element_identifiers?: string[];
}

export interface CollectionResultElement {
    element_identifier: string;
    slot?: number;
    output?: string;
    collection_type?: string;
    elements?: CollectionResultElement[];
    columns?: unknown;
}

export interface CollectionResult {
    name?: string | null;
    collection_type: string;
    populated_state: "new" | "ok" | "failed";
    populated_state_message?: string | null;
    elements: CollectionResultElement[];
}

export type Termination = "normal" | "oom" | "walltime" | "signal" | "not_started";

export interface ResultsDocument {
    protocol: typeof PROTOCOL_VERSION;
    kind: JobKind | "tool_install";
    job_id: string;
    attempt: number;
    state: "ok" | "error";
    exit_code: number | null;
    termination: Termination;
    command_line?: string | null;
    command_version?: string | null;
    job_messages: ResultJobMessage[];
    tool_stdout: ResultStream;
    tool_stderr: ResultStream;
    job_stdout: ResultStream;
    job_stderr: ResultStream;
    filtered_outputs: string[];
    outputs: Record<string, DatasetResult>;
    discovered: DiscoveredResult[];
    output_collections: Record<string, CollectionResult>;
    errors: string[];
    traceback?: string;
    timings: { tool_start?: string | null; tool_end?: string | null; stage_out_start?: string; stage_out_end?: string };
}

// ---------------------------------------------------------------------------------------------------------
// Structural checks

/** A pod document that does not follow the protocol. */
export class ProtocolError extends Error {
    constructor(
        readonly document: string,
        readonly path: string,
        detail: string,
    ) {
        super(`${document} is invalid at ${path || "the top level"}: ${detail}`);
        this.name = "ProtocolError";
    }
}

type Check = (value: unknown, path: string) => void;

class Mismatch extends Error {
    constructor(
        readonly path: string,
        readonly detail: string,
    ) {
        super(detail);
    }
}

function fail(path: string, detail: string): never {
    throw new Mismatch(path, detail);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const anything: Check = () => undefined;

const string: Check = (value, path) => {
    if (typeof value !== "string") {
        fail(path, "expected a string");
    }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A dataset UUID as the browser allocates them; keys are built from it. */
const uuid: Check = (value, path) => {
    if (typeof value !== "string" || !UUID.test(value)) {
        fail(path, "expected a dataset UUID");
    }
};

const boolean: Check = (value, path) => {
    if (typeof value !== "boolean") {
        fail(path, "expected a boolean");
    }
};

const number: Check = (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path, "expected a number");
    }
};

function integer(minimum = -Infinity): Check {
    return (value, path) => {
        if (!Number.isSafeInteger(value)) {
            fail(path, "expected an integer");
        }
        if ((value as number) < minimum) {
            fail(path, `expected at least ${minimum}`);
        }
    };
}

function nullable(check: Check): Check {
    return (value, path) => {
        if (value !== null) {
            check(value, path);
        }
    };
}

function oneOf(...values: readonly unknown[]): Check {
    return (value, path) => {
        if (!values.includes(value)) {
            fail(path, `expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
        }
    };
}

function arrayOf(item: Check): Check {
    return (value, path) => {
        if (!Array.isArray(value)) {
            fail(path, "expected an array");
        }
        value.forEach((element, index) => item(element, `${path}/${index}`));
    };
}

function recordOf(item: Check): Check {
    return (value, path) => {
        if (!isObject(value)) {
            fail(path, "expected an object");
        }
        for (const [key, element] of Object.entries(value)) {
            item(element, `${path}/${key}`);
        }
    };
}

/** An object with `required` and `optional` properties; other properties are allowed unless `closed`. */
function objectOf(required: Record<string, Check>, optional: Record<string, Check> = {}, closed = false): Check {
    return (value, path) => {
        if (!isObject(value)) {
            fail(path, "expected an object");
        }
        for (const [key, check] of Object.entries(required)) {
            if (!Object.hasOwn(value, key)) {
                fail(path, `missing property "${key}"`);
            }
            check(value[key], `${path}/${key}`);
        }
        for (const [key, check] of Object.entries(optional)) {
            if (Object.hasOwn(value, key)) {
                check(value[key], `${path}/${key}`);
            }
        }
        if (closed) {
            for (const key of Object.keys(value)) {
                if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) {
                    fail(path, `unexpected property "${key}"`);
                }
            }
        }
    };
}

function allOf(...checks: Check[]): Check {
    return (value, path) => checks.forEach((check) => check(value, path));
}

/** Pod documents nest no deeper than this (metadata values included). */
export const MAX_DOCUMENT_DEPTH = 64;

/** Fails when arrays and objects nest deeper than `limit`; iterative, so deep input cannot exhaust the stack. */
function checkDepth(value: unknown, limit: number): void {
    const pending: [unknown, number][] = [[value, 0]];
    while (pending.length) {
        const [item, depth] = pending.pop()!;
        if (typeof item !== "object" || item === null) {
            continue;
        }
        if (depth >= limit) {
            fail("", `nested deeper than ${limit} levels`);
        }
        for (const child of Object.values(item)) {
            if (typeof child === "object" && child !== null) {
                pending.push([child, depth + 1]);
            }
        }
    }
}

function parse<T>(document: string, check: Check, value: unknown): T {
    try {
        checkDepth(value, MAX_DOCUMENT_DEPTH);
        check(value, "");
    } catch (error) {
        if (error instanceof Mismatch) {
            throw new ProtocolError(document, error.path, error.detail);
        }
        throw error;
    }
    return value as T;
}

const protocol = oneOf(PROTOCOL_VERSION);

const prepareDocument = objectOf(
    {
        protocol,
        state: oneOf("ok", "error"),
        errors: arrayOf(objectOf({ phase: string, message: string })),
        timings: objectOf({}, { stage_in_start: string, stage_in_end: string }),
    },
    {
        job_id: string,
        attempt: integer(),
        command_line: nullable(string),
        version_command: nullable(string),
        outputs: recordOf(objectOf({ filtered: boolean, format: nullable(string), label: string }, {}, true)),
        environment: arrayOf(string),
        configfiles: arrayOf(string),
    },
);

const stream = objectOf({ text: string, size: integer(0) });

const extraFileEntry = objectOf(
    { path: string, type: oneOf("file", "directory", "symlink") },
    { offset: integer(), size: integer(), target: string, key: string },
);

const datasetRecord = objectOf(
    {
        uuid,
        state: oneOf("ok", "error", "failed_metadata", "empty"),
        name: nullable(string),
        ext: string,
        dbkey: nullable(string),
        visible: boolean,
        info: nullable(string),
        blurb: nullable(string),
        peek: nullable(string),
        metadata: objectOf({}),
        metadata_files: recordOf(objectOf({ index: integer(), size: integer() })),
        size: integer(0),
        total_size: integer(0),
        extra_files: nullable(objectOf({ size: integer(), entries: arrayOf(extraFileEntry) })),
        sanitized: boolean,
        errors: arrayOf(string),
        warnings: arrayOf(string),
    },
    {
        display_peek: nullable(string),
        created_from_basename: nullable(string),
        tool_version: nullable(string),
        data: objectOf(
            { mode: oneOf("put", "multipart", "none"), size: integer() },
            {
                etag: nullable(string),
                part_size: integer(),
                parts: arrayOf(objectOf({ part_number: integer(1), etag: nullable(string), size: integer() })),
            },
        ),
    },
);

const discoveredRecord = allOf(
    datasetRecord,
    objectOf(
        { slot: integer(0) },
        {
            output: nullable(string),
            designation: nullable(string),
            collection: nullable(string),
            element_identifiers: arrayOf(string),
        },
    ),
);

const collectionElement: Check = (value, path) =>
    objectOf(
        { element_identifier: string },
        {
            slot: integer(),
            output: string,
            collection_type: string,
            elements: arrayOf(collectionElement),
            columns: anything,
        },
    )(value, path);

const resultsDocument = objectOf(
    {
        protocol,
        kind: oneOf("tool", "upload", "set_metadata", "tool_install"),
        job_id: string,
        attempt: integer(),
        state: oneOf("ok", "error"),
        exit_code: nullable(integer()),
        termination: oneOf("normal", "oom", "walltime", "signal", "not_started"),
        job_messages: arrayOf(
            objectOf(
                { type: string, desc: nullable(string) },
                { code_desc: nullable(string), error_level: nullable(number) },
            ),
        ),
        tool_stdout: stream,
        tool_stderr: stream,
        job_stdout: stream,
        job_stderr: stream,
        outputs: recordOf(datasetRecord),
        discovered: arrayOf(discoveredRecord),
        output_collections: recordOf(
            objectOf(
                {
                    collection_type: string,
                    populated_state: oneOf("new", "ok", "failed"),
                    elements: arrayOf(collectionElement),
                },
                { name: nullable(string), populated_state_message: nullable(string) },
            ),
        ),
        filtered_outputs: arrayOf(string),
        errors: arrayOf(string),
        timings: objectOf(
            {},
            {
                tool_start: nullable(string),
                tool_end: nullable(string),
                stage_out_start: string,
                stage_out_end: string,
            },
        ),
    },
    { command_line: nullable(string), command_version: nullable(string), traceback: string },
);

/**
 * Checks a parsed `prepare.json` against the shape of prepare.schema.json.
 *
 * @throws ProtocolError naming the first property that does not match
 */
export function parsePrepare(value: unknown): PrepareDocument {
    return parse<PrepareDocument>("prepare.json", prepareDocument, value);
}

/**
 * Checks a parsed `results.json` against the shape of results.schema.json.
 *
 * @throws ProtocolError naming the first property that does not match
 */
export function parseResults(value: unknown): ResultsDocument {
    return parse<ResultsDocument>("results.json", resultsDocument, value);
}
