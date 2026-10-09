/**
 * History contents: GET /api/histories/{history_id}/contents (`v=dev` and legacy, with the stats media type), GET
 * /api/histories/{history_id}/contents/{type}s, GET/PUT/DELETE /api/histories/{history_id}/contents/{type}s/{id} and
 * the legacy /contents/{id} forms, and PUT /api/histories/{history_id}/contents/bulk.
 *
 * Also the dataset and collection serializers shared with other handlers: `HDASerializer` and `HDCASerializer`
 * (`managers/hdas.py`, `managers/hdcas.py`) and the element view of `dictify_dataset_collection_instance`
 * (`managers/collections_util.py`).
 */

import type { components } from "@/api/schema";
import {
    type CollectionRecord,
    collections,
    CONTENT_STORES,
    contents,
    type DatasetRecord,
    datasets,
    type DceRecord,
    type HdaRecord,
    hdas,
    type HdcaRecord,
    histories,
    JOB_STORES,
    type JobRecord,
    jobs,
    type ReadTx,
    readTx,
    withTransaction,
    type WriteTx,
} from "@/planet/db";
import { json, noContent, passthrough, type TypedResponse } from "@/planet/sw/responses";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { type ContentsFilter, parseContentsFilters } from "@/planet/util/filters";
import { escapeHtml } from "@/planet/util/html";
import { niceSize } from "@/planet/util/sizes";
import { type DatasetState, FINISHED_JOB_STATES, TERMINAL_JOB_STATES } from "@/planet/util/states";

import { loadStaticData, parseKeys } from "./configuration";

type Schemas = components["schemas"];
type DatasetHash = Schemas["DatasetHash"];
type DatasetSource = Schemas["DatasetSource"];
type DisplayApp = Schemas["DisplayApp"];
type MetadataFile = Schemas["MetadataFile"];
type DatasetPermissions = Schemas["DatasetPermissions"];
type ValidatedState = Schemas["DatasetValidatedState"];
type PopulatedState = Schemas["DatasetCollectionPopulatedState"];
type ElementsStatesDict = Schemas["ElementsStatesDict"];
type HDCJobStateSummary = Schemas["HDCJobStateSummary"];
type JobSourceType = Schemas["JobSourceType"];
type DCESummary = Schemas["DCESummary"];
type SampleSheetColumnDefinition = Schemas["SampleSheetColumnDefinition"];
type OldestCreateTimeByObjectStoreId = Schemas["OldestCreateTimeByObjectStoreId"];
type BulkOperationItemError = Schemas["BulkOperationItemError"];
type HistoryContentBulkOperationResult = Schemas["HistoryContentBulkOperationResult"];

type ContentRow = contents.ContentRow;
type ContentType = contents.ContentType;
type NewCollectionTree = collections.NewCollectionTree;
type NewElement = collections.NewElement;

/** Stores a contents read transaction needs. */
const READ_STORES = [...CONTENT_STORES, "jobs"] as const;

const STATS_MEDIA_TYPE = "application/vnd.galaxy.history.contents.stats+json";

// ---------------------------------------------------------------------------------------------------------------
// Request parsing shared by the history and contents handlers

export interface SerializationParams {
    view?: string | null;
    keys?: readonly string[] | null;
}

/** Reads `view` and the comma-separated `keys` from the query string. */
export function serializationParams(query: URLSearchParams): SerializationParams {
    return { view: query.get("view"), keys: parseKeys(query.get("keys")) };
}

/**
 * Resolves `view` and `keys` like Galaxy's `serialize_to_view`: a view and keys combine, keys alone replace the
 * default view.
 *
 * @throws ApiError 400 for an unknown view
 */
export function resolveKeys(
    views: Readonly<Record<string, readonly string[]>>,
    params: SerializationParams,
    defaultView: string,
): string[] {
    const keys = params.keys ?? [];
    const viewKeys = (view: string): readonly string[] => {
        const found = views[view];
        if (!found) {
            throw new ApiError(400, `unknown view - ${view}`, ErrorCodes.USER_REQUEST_INVALID_PARAMETER, {
                view,
                available_views: Object.keys(views),
            });
        }
        return found;
    };
    if (params.view) {
        return [...viewKeys(params.view), ...keys];
    }
    return keys.length ? [...keys] : [...viewKeys(defaultView)];
}

/**
 * Reads a boolean query parameter the way FastAPI parses one; `fallback` applies when it is absent.
 *
 * @throws ApiError 400 for any other value
 */
export function queryBool<T extends boolean | null>(query: URLSearchParams, name: string, fallback: T): boolean | T {
    const value = query.get(name);
    if (value === null || value === "") {
        return fallback;
    }
    const lowered = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(lowered)) {
        return true;
    }
    if (["false", "0", "no", "off"].includes(lowered)) {
        return false;
    }
    throw ApiError.badRequest(`Invalid boolean value for ${name}: ${value}`);
}

function queryInt(query: URLSearchParams, name: string): number | null {
    const value = query.get(name);
    if (value === null || value === "") {
        return null;
    }
    if (!/^[+-]?\d+$/.test(value.trim())) {
        throw ApiError.badRequest(`Invalid integer value for ${name}: ${value}`);
    }
    const parsed = Number.parseInt(value, 10);
    if (parsed < 0) {
        throw ApiError.badRequest(`${name} must be greater than or equal to 0`);
    }
    return parsed;
}

/** Reads `offset` and `limit` (non-negative integers). */
export function pagination(query: URLSearchParams): { offset: number; limit: number | null } {
    return { offset: queryInt(query, "offset") ?? 0, limit: queryInt(query, "limit") };
}

/** Checks that a request body is a JSON object. */
export function asObject(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw ApiError.badRequest("Request body must be a JSON object", ErrorCodes.USER_INVALID_JSON);
    }
    return body as Record<string, unknown>;
}

/** The error Galaxy's `ModelValidator` raises for a value of the wrong type. */
export function invalidValue(key: string, expected: string): ApiError {
    return new ApiError(400, `${key} must be ${expected}`, ErrorCodes.USER_REQUEST_INVALID_PARAMETER, { key });
}

export function readString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    if (typeof value !== "string") {
        throw invalidValue(key, "a string");
    }
    return value;
}

export function readNullableString(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    if (value !== null && typeof value !== "string") {
        throw invalidValue(key, "a string or null");
    }
    return value;
}

export function readBool(payload: Record<string, unknown>, key: string): boolean {
    const value = payload[key];
    if (typeof value !== "boolean") {
        throw invalidValue(key, "a boolean");
    }
    return value;
}

/** Reads a list of strings (`ModelValidator.basestring_list`). */
export function readStringList(payload: Record<string, unknown>, key: string): string[] {
    const value = payload[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw invalidValue(key, "a list of strings");
    }
    return value;
}

function parseContentType(value: string): ContentType {
    if (value !== "dataset" && value !== "dataset_collection") {
        throw new ApiError(400, `Unknown contents type: ${value}`, ErrorCodes.UNKNOWN_CONTENTS_TYPE);
    }
    return value;
}

/** Escapes markup in user text the way Galaxy's `sanitize_html` treats text without allowed tags. */
function sanitizeText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------------------------------------------
// Datatypes

interface DatatypeMapping {
    ext_to_class_name: Record<string, string>;
    class_to_classes: Record<string, Record<string, boolean>>;
}

const DATA_CLASS = "galaxy.datatypes.data.Data";

/** Datatype class lookups backed by the build's `/api/datatypes/mapping` payload. */
export class DatatypeInfo {
    constructor(private readonly mapping: DatatypeMapping | null) {}

    /** True when the mapping was loaded; without it every extension behaves like `data`. */
    get available(): boolean {
        return this.mapping !== null;
    }

    /** True when `extension` is a registered datatype. */
    has(extension: string): boolean {
        return this.mapping !== null && Object.hasOwn(this.mapping.ext_to_class_name, extension);
    }

    /** The datatype class, as `module.Class`. */
    className(extension: string | null): string {
        if (!extension || !this.mapping || !Object.hasOwn(this.mapping.ext_to_class_name, extension)) {
            return DATA_CLASS;
        }
        return this.mapping.ext_to_class_name[extension]!;
    }

    /** True when the extension's class is `className` or a subclass of it. */
    isA(extension: string | null, className: string): boolean {
        const own = this.className(extension);
        return own === className || this.mapping?.class_to_classes[own]?.[className] === true;
    }
}

function isMapping(value: unknown): value is DatatypeMapping {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const mapping = value as Record<string, unknown>;
    return typeof mapping.ext_to_class_name === "object" && typeof mapping.class_to_classes === "object";
}

/** Loads the datatype mapping. Serialization degrades to `data` behaviour when it is unavailable. */
export async function loadDatatypeInfo(): Promise<DatatypeInfo> {
    try {
        const mapping = await loadStaticData<unknown>("datatypes/mapping.json");
        return new DatatypeInfo(isMapping(mapping) ? mapping : null);
    } catch {
        return new DatatypeInfo(null);
    }
}

async function requireDatatypeInfo(): Promise<DatatypeInfo> {
    const info = await loadDatatypeInfo();
    if (!info.available) {
        throw new ApiError(503, "The datatype registry is unavailable", ErrorCodes.CONFIG_ERROR);
    }
    return info;
}

// ---------------------------------------------------------------------------------------------------------------
// Peek rendering (`Data.display_peek`, `TabularData.make_html_table` and their overrides)

/** Classes whose `display_peek` returns the stored peek unchanged. */
const RAW_PEEK_CLASSES = [
    "galaxy.datatypes.annotation.SnapHmm",
    "galaxy.datatypes.annotation.Augustus",
    "galaxy.datatypes.anvio.AnvioComposite",
    "galaxy.datatypes.binary.Ab1",
    "galaxy.datatypes.binary.CompressedArchive",
    "galaxy.datatypes.binary.Bref3",
    "galaxy.datatypes.binary.CompressedZipArchive",
    "galaxy.datatypes.binary.BamNative",
    "galaxy.datatypes.binary.H5",
    "galaxy.datatypes.binary.NetCDF4",
    "galaxy.datatypes.binary.Loom",
    "galaxy.datatypes.binary.Anndata",
    "galaxy.datatypes.binary.Grib",
    "galaxy.datatypes.binary.GmxBinary",
    "galaxy.datatypes.binary.Biom2",
    "galaxy.datatypes.binary.Cool",
    "galaxy.datatypes.binary.MCool",
    "galaxy.datatypes.binary.H5MLM",
    "galaxy.datatypes.binary.Scf",
    "galaxy.datatypes.binary.Sff",
    "galaxy.datatypes.binary.BigWig",
    "galaxy.datatypes.binary.TwoBit",
    "galaxy.datatypes.binary.SQlite",
    "galaxy.datatypes.binary.ExcelXls",
    "galaxy.datatypes.binary.Sra",
    "galaxy.datatypes.binary.PostgresqlArchive",
    "galaxy.datatypes.binary.MongoDBArchive",
    "galaxy.datatypes.binary.Fast5Archive",
    "galaxy.datatypes.binary.SearchGuiArchive",
    "galaxy.datatypes.binary.NetCDF",
    "galaxy.datatypes.binary.Dcd",
    "galaxy.datatypes.binary.Vel",
    "galaxy.datatypes.binary.BafTar",
    "galaxy.datatypes.binary.Pretext",
    "galaxy.datatypes.binary.JP2",
    "galaxy.datatypes.binary.Npz",
    "galaxy.datatypes.binary.FITS",
    "galaxy.datatypes.binary.Numpy",
    "galaxy.datatypes.binary.Hic",
    "galaxy.datatypes.blast._BlastDb",
    "galaxy.datatypes.blast.LastDb",
    "galaxy.datatypes.constructive_solid_geometry.Ply",
    "galaxy.datatypes.constructive_solid_geometry.Vtk",
    "galaxy.datatypes.flow.FCS",
    "galaxy.datatypes.gis.Shapefile",
    "galaxy.datatypes.molecules.OBFS",
    "galaxy.datatypes.msa.Hmmer",
    "galaxy.datatypes.msa.HmmerPress",
    "galaxy.datatypes.neo4j.Neo4j",
    "galaxy.datatypes.ngsindex.BowtieIndex",
    "galaxy.datatypes.plant_tribes.Smat",
    "galaxy.datatypes.plant_tribes.PlantTribesKsComponents",
    "galaxy.datatypes.proteomics.ThermoRAW",
    "galaxy.datatypes.spaln._SpalnDb",
    "galaxy.datatypes.text.Json",
    "galaxy.datatypes.tracks.UCSCTrackHub",
];

const INTERVAL_ALIASES = { chromCol: "Chrom", startCol: "Start", endCol: "End", strandCol: "Strand", nameCol: "Name" };

interface TablePeek {
    columnNames?: readonly string[];
    aliases?: Readonly<Record<string, string>>;
    skipchars?: readonly string[];
}

/** `make_html_table` arguments of the tabular `display_peek` overrides, most specific class first. */
const TABLE_PEEKS: readonly [string, TablePeek][] = [
    [
        "galaxy.datatypes.tabular.Sam",
        {
            columnNames: [
                "QNAME",
                "FLAG",
                "RNAME",
                "POS",
                "MAPQ",
                "CIGAR",
                "MRNM",
                "MPOS",
                "ISIZE",
                "SEQ",
                "QUAL",
                "OPT",
            ],
        },
    ],
    [
        "galaxy.datatypes.tabular.BaseVcf",
        { columnNames: ["Chrom", "Pos", "ID", "Ref", "Alt", "Qual", "Filter", "Info", "Format", "data"] },
    ],
    [
        "galaxy.datatypes.interval.Gff3",
        { columnNames: ["Seqid", "Source", "Type", "Start", "End", "Score", "Strand", "Phase", "Attributes"] },
    ],
    [
        "galaxy.datatypes.interval.Gtf",
        { columnNames: ["Seqname", "Source", "Feature", "Start", "End", "Score", "Strand", "Frame", "Attributes"] },
    ],
    [
        "galaxy.datatypes.interval.Gff",
        { columnNames: ["Seqname", "Source", "Feature", "Start", "End", "Score", "Strand", "Frame", "Group"] },
    ],
    ["galaxy.datatypes.tabular.Pileup", { aliases: { chromCol: "Chrom", startCol: "Start", baseCol: "Base" } }],
    ["galaxy.datatypes.interval.Wiggle", { skipchars: ["track", "#"] }],
    ["galaxy.datatypes.interval.CustomTrack", { skipchars: ["track", "#"] }],
    ["galaxy.datatypes.interval.Interval", { aliases: INTERVAL_ALIASES }],
    ["galaxy.datatypes.tabular.TabularData", {}],
];

const MAX_PEEK_COLUMNS = 50;
const GENERIC_TABULAR = "galaxy.datatypes.tabular.Tabular";

const LINE_BREAKS: ReadonlySet<string> = new Set([
    "\n",
    "\r",
    "\v",
    "\f",
    "\x1c",
    "\x1d",
    "\x1e",
    "\x85",
    "\u2028",
    "\u2029",
]);

/** Python's `str.splitlines()`. */
function splitLines(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (LINE_BREAKS.has(char)) {
            lines.push(text.slice(start, i));
            if (char === "\r" && text[i + 1] === "\n") {
                i++;
            }
            start = i + 1;
        }
    }
    if (start < text.length) {
        lines.push(text.slice(start));
    }
    return lines;
}

function pythonInt(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) {
        return Number.parseInt(value, 10);
    }
    return null;
}

function peekColumns(metadata: Record<string, unknown>): number {
    const columns = pythonInt(metadata.columns) ?? 0;
    return Math.max(0, Math.min(columns, MAX_PEEK_COLUMNS));
}

function tablePeekHeader(metadata: Record<string, unknown>, options: TablePeek, columns: number): string {
    const names =
        options.columnNames ??
        (Array.isArray(metadata.column_names) && metadata.column_names.length ? metadata.column_names : []);
    const headers: (string | null)[] = new Array(columns).fill(null);
    for (let i = 0; i < Math.min(columns, names.length); i++) {
        const name = names[i];
        if (headers[i] === null && name !== null && name !== undefined) {
            headers[i] = String(name);
        }
    }
    for (const [name, value] of Object.entries(metadata)) {
        if (!name.endsWith("Col")) {
            continue;
        }
        const index = (pythonInt(value) ?? 0) - 1;
        if (index >= 0 && index < columns && headers[index] === null) {
            headers[index] = options.aliases?.[name] ?? name;
        }
    }
    const cells = headers.map(
        (header, index) => `<th>${header === null ? String(index + 1) : `${index + 1}.${escapeHtml(header)}`}</th>`,
    );
    return `<tr>${cells.join("")}</tr>`;
}

function tablePeekRows(peek: string, metadata: Record<string, unknown>, options: TablePeek, columns: number): string {
    const delimiter = typeof metadata.delimiter === "string" && metadata.delimiter ? metadata.delimiter : "\t";
    const skipchars = options.skipchars ?? [];
    let out = "";
    for (const line of splitLines(peek)) {
        if (skipchars.some((prefix) => line.startsWith(prefix))) {
            out += `<tr><td colspan="100%">${escapeHtml(line)}</td></tr>`;
        } else if (line) {
            const elems = line.split(delimiter).slice(0, MAX_PEEK_COLUMNS);
            while (elems.length < columns) {
                elems.push("");
            }
            if (elems.length !== columns) {
                out += `<tr><td colspan="100%">${escapeHtml(line)}</td></tr>`;
            } else {
                out += `<tr>${elems.map((elem) => `<td>${escapeHtml(elem)}</td>`).join("")}</tr>`;
            }
        }
    }
    return out;
}

/**
 * Renders an HDA's stored peek text as Galaxy's `display_peek` does for its datatype: unchanged for binary formats,
 * a table with headers for tabular formats, one row per line otherwise. Returns null when there is no peek.
 */
export function renderPeek(hda: HdaRecord, datatypes: DatatypeInfo): string | null {
    const peek = hda.peek;
    if (!peek || peek === "no peek") {
        return null;
    }
    const extension = hda.extension;
    if (RAW_PEEK_CLASSES.some((name) => datatypes.isA(extension, name))) {
        return peek;
    }
    const table = TABLE_PEEKS.find(([name]) => datatypes.isA(extension, name))?.[1];
    if (table) {
        const columns = peekColumns(hda.metadata);
        const header =
            datatypes.className(extension) === GENERIC_TABULAR ? "" : tablePeekHeader(hda.metadata, table, columns);
        return `<table cellspacing="0" cellpadding="3">${header}${tablePeekRows(peek, hda.metadata, table, columns)}</table>`;
    }
    const rows = splitLines(peek)
        .map((line) => line.trim())
        .filter((line) => line)
        .map((line) => `<tr><td>${escapeHtml(line)}</td></tr>`);
    return `<table cellspacing="0" cellpadding="3">${rows.join("")}</table>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Tags

/**
 * Normalizes tags as Galaxy's tag handler stores them: `#x` becomes `name:x`, names and values lose whitespace,
 * a leading `.` is dropped from names, empty or overlong names are skipped and duplicates are removed. Entries may
 * hold several tags separated by `,` or `;`.
 */
export function normalizeTags(tags: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of tags.join(",").replace(/\p{C}/gu, "").split(/[,;]/)) {
        const tag = raw.startsWith("#") ? `name:${raw.slice(1)}` : raw;
        const separator = tag.search(/[=:]/);
        let name = (separator === -1 ? tag : tag.slice(0, separator)).replace(/\s/g, "");
        if (name.startsWith(".")) {
            name = name.slice(1);
        }
        if (!name || name.length > 255) {
            continue;
        }
        const value = separator === -1 ? null : tag.slice(separator + 1).replace(/\s/g, "") || null;
        const key = `${name.toLowerCase()}\u0000${value ?? ""}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(value === null ? name : `${name}:${value}`);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// HDA serializer

/** An HDA with what its serialization needs. */
export interface HdaItem {
    hda: HdaRecord;
    dataset: DatasetRecord;
    /** The job that created the dataset (or the original it was copied from). */
    job: JobRecord | null;
}

/** Every key the HDA serializer can produce, except the flattened `metadata_*` keys. */
export interface HdaFields {
    id: string;
    type_id: string;
    name: string | null;
    history_id: string;
    hid: number;
    history_content_type: "dataset";
    dataset_id: string;
    genome_build: string | null;
    state: DatasetState;
    extension: string | null;
    deleted: boolean;
    purged: boolean;
    visible: boolean;
    tags: string[];
    type: "file";
    url: string;
    create_time: string;
    update_time: string;
    object_store_id: string | null;
    quota_source_label: string | null;
    model_class: "HistoryDatasetAssociation";
    hda_ldda: "hda";
    copied_from_ldda_id: string | null;
    copied_from_history_dataset_association_id: string | null;
    copied_from_library_dataset_dataset_association_id: string | null;
    accessible: true;
    misc_info: string | null;
    misc_blurb: string | null;
    info: string | null;
    blurb: string | null;
    file_ext: string;
    file_size: number;
    size: number;
    nice_size: string;
    resubmitted: boolean;
    meta_files: MetadataFile[];
    data_type: string;
    peek: string | null;
    creating_job: string | null;
    rerunnable: boolean;
    uuid: string;
    permissions: DatasetPermissions;
    file_name: string | null;
    file_path: string | null;
    display_apps: DisplayApp[];
    display_types: DisplayApp[];
    validated_state: ValidatedState;
    validated_state_message: string | null;
    download_url: string;
    annotation: string | null;
    api_type: "file";
    created_from_basename: string | null;
    hashes: DatasetHash[];
    sources: DatasetSource[];
    drs_id: string;
    tool_version: string | null;
    parent_id: string | null;
    designation: string | null;
    dbkey: string;
    converted: Record<string, string>;
}

export type HdaKey = keyof HdaFields;

/** The pseudo-key that adds the flattened `metadata_<name>` entries. */
export const METADATA_KEY = "metadata";

type HdaViewKey = HdaKey | typeof METADATA_KEY;

export const HDA_SUMMARY_KEYS = [
    "id",
    "type_id",
    "name",
    "history_id",
    "hid",
    "history_content_type",
    "dataset_id",
    "genome_build",
    "state",
    "extension",
    "deleted",
    "purged",
    "visible",
    "tags",
    "type",
    "url",
    "create_time",
    "update_time",
    "object_store_id",
    "quota_source_label",
] as const satisfies readonly HdaKey[];

export const HDA_DETAILED_KEYS = [
    ...HDA_SUMMARY_KEYS,
    "model_class",
    "hda_ldda",
    "copied_from_ldda_id",
    "accessible",
    "misc_info",
    "misc_blurb",
    "file_ext",
    "file_size",
    "resubmitted",
    METADATA_KEY,
    "meta_files",
    "data_type",
    "peek",
    "creating_job",
    "rerunnable",
    "uuid",
    "permissions",
    "file_name",
    "display_apps",
    "display_types",
    "validated_state",
    "validated_state_message",
    "download_url",
    "annotation",
    "api_type",
    "created_from_basename",
    "hashes",
    "sources",
    "drs_id",
] as const satisfies readonly HdaViewKey[];

const HDA_EXTENDED_KEYS = [
    ...HDA_DETAILED_KEYS,
    "tool_version",
    "parent_id",
    "designation",
] as const satisfies readonly HdaViewKey[];

const HDA_INACCESSIBLE_KEYS = [
    "accessible",
    "id",
    "name",
    "history_id",
    "hid",
    "history_content_type",
    "state",
    "deleted",
    "visible",
] as const satisfies readonly HdaKey[];

export const HDA_VIEWS: Readonly<Record<string, readonly HdaViewKey[]>> = {
    summary: HDA_SUMMARY_KEYS,
    detailed: HDA_DETAILED_KEYS,
    extended: HDA_EXTENDED_KEYS,
    inaccessible: HDA_INACCESSIBLE_KEYS,
};

/** The flattened metadata entries (`metadata_dbkey`, `metadata_columns`, ...). */
export type FlattenedMetadata = Record<`metadata_${string}`, unknown>;

export type HdaSummaryView = Pick<HdaFields, (typeof HDA_SUMMARY_KEYS)[number]>;
export type HdaDetailedView = Pick<HdaFields, Exclude<(typeof HDA_DETAILED_KEYS)[number], typeof METADATA_KEY>> &
    FlattenedMetadata;

/** A serialized HDA whose keys were chosen at request time. */
export type HdaView = Partial<HdaFields> & FlattenedMetadata;

const INTERNAL_METADATA = new Set(["__extension__", "__validated_state__", "__validated_state_message__", "dbkey"]);

/** Galaxy's `_prefixed_metadata`: every stored metadata value except metadata files, with `dbkey` first. */
export function flattenMetadata(item: HdaItem): FlattenedMetadata {
    const out: FlattenedMetadata = { metadata_dbkey: item.hda.dbkey };
    for (const [name, value] of Object.entries(item.hda.metadata)) {
        if (!INTERNAL_METADATA.has(name) && !Object.hasOwn(item.dataset.metadata_files, name)) {
            out[`metadata_${name}`] = value;
        }
    }
    return out;
}

/** True when the tool behind `job` can be rerun from its form (uploads and internal tools cannot). */
function isRerunnable(job: JobRecord | null): boolean {
    return !!job && !job.tool_id.startsWith("__") && job.tool_id !== "upload1";
}

function hdaUrl(hda: HdaRecord): string {
    return `/api/histories/${hda.history_id}/contents/${hda.id}`;
}

type HdaContext = { item: HdaItem; datatypes: DatatypeInfo };

const HDA_SERIALIZERS: { [K in HdaKey]: (context: HdaContext) => HdaFields[K] } = {
    id: ({ item }) => item.hda.id,
    type_id: ({ item }) => `dataset-${item.hda.id}`,
    name: ({ item }) => item.hda.name,
    history_id: ({ item }) => item.hda.history_id,
    hid: ({ item }) => item.hda.hid,
    history_content_type: () => "dataset",
    dataset_id: ({ item }) => item.dataset.id,
    genome_build: ({ item }) => item.hda.dbkey,
    state: ({ item }) => hdas.effectiveState(item.hda, item.dataset),
    extension: ({ item }) => item.hda.extension,
    deleted: ({ item }) => item.hda.deleted,
    purged: ({ item }) => item.hda.purged,
    visible: ({ item }) => item.hda.visible,
    tags: ({ item }) => [...item.hda.tags],
    type: () => "file",
    url: ({ item }) => hdaUrl(item.hda),
    create_time: ({ item }) => item.hda.create_time,
    update_time: ({ item }) => item.hda.update_time,
    object_store_id: () => null,
    quota_source_label: () => null,
    model_class: () => "HistoryDatasetAssociation",
    hda_ldda: () => "hda",
    copied_from_ldda_id: ({ item }) => (item.hda.copied_from?.src === "ldda" ? item.hda.copied_from.id : null),
    copied_from_history_dataset_association_id: ({ item }) =>
        item.hda.copied_from?.src === "hda" ? item.hda.copied_from.id : null,
    copied_from_library_dataset_dataset_association_id: ({ item }) =>
        item.hda.copied_from?.src === "ldda" ? item.hda.copied_from.id : null,
    accessible: () => true,
    misc_info: ({ item }) => item.hda.info?.trim() ?? null,
    misc_blurb: ({ item }) => item.hda.blurb,
    info: ({ item }) => item.hda.info?.trim() ?? null,
    blurb: ({ item }) => item.hda.blurb,
    file_ext: ({ item }) => item.hda.extension,
    file_size: ({ item }) => item.dataset.file_size ?? 0,
    size: ({ item }) => item.dataset.file_size ?? 0,
    nice_size: ({ item }) => niceSize(item.dataset.file_size ?? 0),
    resubmitted: ({ item }) => !!item.job?.state_history.some((entry) => entry.state === "resubmitted"),
    meta_files: ({ item }) =>
        Object.keys(item.dataset.metadata_files).map((name) => ({
            file_type: name,
            download_url: `${hdaUrl(item.hda)}/metadata_file?metadata_file=${encodeURIComponent(name)}`,
        })),
    data_type: ({ item, datatypes }) => datatypes.className(item.hda.extension),
    peek: ({ item, datatypes }) => renderPeek(item.hda, datatypes),
    creating_job: ({ item }) => item.job?.id ?? item.hda.creating_job_id ?? item.dataset.job_id,
    rerunnable: ({ item }) => isRerunnable(item.job),
    uuid: ({ item }) => item.dataset.uuid,
    permissions: () => ({ manage: [], access: [] }),
    file_name: () => null,
    file_path: () => null,
    display_apps: () => [],
    display_types: () => [],
    validated_state: ({ item }) => item.hda.validated_state,
    validated_state_message: ({ item }) => item.hda.validated_state_message,
    download_url: ({ item }) => `${hdaUrl(item.hda)}/download`,
    annotation: ({ item }) => item.hda.annotation?.trim() || null,
    api_type: () => "file",
    created_from_basename: ({ item }) => item.dataset.created_from_basename,
    hashes: ({ item }) =>
        item.dataset.hashes.map((hash, index) => ({
            id: `${item.dataset.id}${index.toString(16).padStart(4, "0")}`,
            model_class: "DatasetHash",
            hash_function: hash.hash_function as DatasetHash["hash_function"],
            hash_value: hash.hash_value,
            extra_files_path: hash.extra_files_path,
        })),
    sources: ({ item }) =>
        item.dataset.sources.map((source, index) => ({
            id: `${item.dataset.id}${index.toString(16).padStart(4, "0")}`,
            source_uri: source.source_uri,
            transform: source.transform as DatasetSource["transform"],
            extra_files_path: source.extra_files_path,
        })),
    drs_id: ({ item }) => `hda-${item.hda.id}`,
    tool_version: ({ item }) => item.job?.tool_version ?? null,
    parent_id: () => null,
    designation: () => null,
    dbkey: ({ item }) => item.hda.dbkey,
    converted: () => ({}),
};

function isHdaKey(key: string): key is HdaKey {
    return Object.hasOwn(HDA_SERIALIZERS, key);
}

/** Serializes an HDA with the given keys (unknown keys are skipped, `metadata` adds the `metadata_*` entries). */
export function serializeHda(item: HdaItem, keys: readonly string[], datatypes: DatatypeInfo): HdaView {
    const context: HdaContext = { item, datatypes };
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        if (key === METADATA_KEY) {
            Object.assign(out, flattenMetadata(item));
        } else if (isHdaKey(key) && !Object.hasOwn(out, key)) {
            out[key] = HDA_SERIALIZERS[key](context);
        }
    }
    return out as HdaView;
}

/** `HDASerializer` summary view. */
export function hdaSummary(item: HdaItem, datatypes: DatatypeInfo): HdaSummaryView {
    return serializeHda(item, HDA_SUMMARY_KEYS, datatypes) as HdaSummaryView;
}

/** `HDASerializer` detailed view. */
export function hdaDetailed(item: HdaItem, datatypes: DatatypeInfo): HdaDetailedView {
    return serializeHda(item, HDA_DETAILED_KEYS, datatypes) as HdaDetailedView;
}

/**
 * Galaxy's `HistoryDatasetAssociation.to_dict()`, the HDA object inside collection elements, plus the `tags` and
 * `accessible` fields the API model requires.
 */
export function hdaElementObject(item: HdaItem, datatypes: DatatypeInfo): Record<string, unknown> {
    const { hda, dataset } = item;
    return {
        model_class: "HistoryDatasetAssociation",
        id: hda.id,
        hda_ldda: "hda",
        uuid: dataset.uuid,
        hid: hda.hid,
        file_ext: hda.extension,
        peek: renderPeek(hda, datatypes),
        name: hda.name,
        deleted: hda.deleted,
        purged: hda.purged,
        visible: hda.visible,
        state: hdas.effectiveState(hda, dataset),
        history_content_type: "dataset",
        file_size: dataset.file_size ?? 0,
        create_time: hda.create_time,
        update_time: hda.update_time,
        data_type: datatypes.className(hda.extension),
        genome_build: hda.dbkey,
        validated_state: hda.validated_state,
        validated_state_message: hda.validated_state_message,
        misc_info: hda.info?.trim() ?? null,
        misc_blurb: hda.blurb,
        history_id: hda.history_id,
        tags: [...hda.tags],
        accessible: true,
        ...flattenMetadata(item),
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Loading items for serialization

const JOB_STATE_SUMMARY_KEYS = [
    "new",
    "waiting",
    "running",
    "error",
    "paused",
    "skipped",
    "deleted_new",
    "resubmitted",
    "queued",
    "ok",
    "failed",
    "deleted",
    "upload",
] as const satisfies readonly Exclude<keyof HDCJobStateSummary, "all_jobs">[];

/** Element summaries of a collection (`dataset_states_and_extensions_summary`). */
export interface CollectionSummary {
    states: ElementsStatesDict;
    extensions: string[];
    deleted: number;
}

/**
 * Reads what serializers need, with per-request caches, inside one read transaction over
 * {@link CONTENT_STORES} and `jobs`. Only IndexedDB requests are awaited.
 */
export class ContentLoader {
    private readonly jobCache = new Map<string, JobRecord | undefined>();
    private readonly historyJobs = new Map<string, JobRecord[]>();
    private readonly summaries = new Map<string, CollectionSummary>();

    constructor(readonly tx: ReadTx) {}

    async job(id: string | null): Promise<JobRecord | null> {
        if (!id) {
            return null;
        }
        if (!this.jobCache.has(id)) {
            this.jobCache.set(id, await this.tx.store("jobs").get(id));
        }
        return this.jobCache.get(id) ?? null;
    }

    async jobsOfHistory(historyId: string): Promise<JobRecord[]> {
        let found = this.historyJobs.get(historyId);
        if (!found) {
            found = await this.tx.store("jobs").index("history_id").getAll(historyId);
            this.historyJobs.set(historyId, found);
            for (const job of found) {
                this.jobCache.set(job.id, job);
            }
        }
        return found;
    }

    async hdaItem(hda: HdaRecord, dataset?: DatasetRecord): Promise<HdaItem> {
        const resolved = dataset ?? (await this.tx.store("datasets").get(hda.dataset_id));
        if (!resolved) {
            throw new ApiError(500, "Dataset record missing for history dataset", ErrorCodes.INCONSISTENT_DATABASE);
        }
        return { hda, dataset: resolved, job: await this.job(hda.creating_job_id ?? resolved.job_id) };
    }

    async hdaItemById(id: string): Promise<HdaItem> {
        const hda = await this.tx.store("hdas").get(id);
        if (!hda) {
            throw ApiError.notFound("Dataset not found");
        }
        return this.hdaItem(hda);
    }

    async elements(collectionId: string): Promise<DceRecord[]> {
        return collections.elements(collectionId, this.tx);
    }

    async collection(id: string): Promise<CollectionRecord> {
        const found = await this.tx.store("collections").get(id);
        if (!found) {
            throw new ApiError(500, "Collection record missing", ErrorCodes.INCONSISTENT_DATABASE);
        }
        return found;
    }

    /** States, extensions and deleted count of a collection's leaf datasets; states come from the datasets. */
    async summary(collectionId: string): Promise<CollectionSummary> {
        const cached = this.summaries.get(collectionId);
        if (cached) {
            return cached;
        }
        const states: Record<string, number> = {};
        const extensions: string[] = [];
        let deleted = 0;
        for (const hdaId of await collections.leafHdaIds(collectionId, this.tx)) {
            const hda = await this.tx.store("hdas").get(hdaId);
            if (!hda) {
                continue;
            }
            const dataset = await this.tx.store("datasets").get(hda.dataset_id);
            if (hda.extension && !extensions.includes(hda.extension)) {
                extensions.push(hda.extension);
            }
            if (hda.deleted) {
                deleted++;
            }
            if (dataset?.state) {
                states[dataset.state] = (states[dataset.state] ?? 0) + 1;
            }
        }
        const summary: CollectionSummary = { states: states as ElementsStatesDict, extensions, deleted };
        this.summaries.set(collectionId, summary);
        return summary;
    }

    /** Galaxy's `DatasetCollection.populated`: populated, and so is every nested collection. */
    async populated(collection: CollectionRecord): Promise<boolean> {
        if (collection.populated_state !== "ok") {
            return false;
        }
        for (const element of await this.elements(collection.id)) {
            if (
                element.child_collection_id &&
                !(await this.populated(await this.collection(element.child_collection_id)))
            ) {
                return false;
            }
        }
        return true;
    }

    /** Counts of the jobs behind an HDCA by state (`job_state_summary_dict`); zeros when there are none. */
    async jobStateSummary(hdca: HdcaRecord): Promise<HDCJobStateSummary> {
        let sourceJobs: JobRecord[] = [];
        if (hdca.job_source_type === "Job") {
            const job = await this.job(hdca.job_source_id);
            sourceJobs = job ? [job] : [];
        } else if (hdca.job_source_type === "ImplicitCollectionJobs" && hdca.job_source_id) {
            sourceJobs = (await this.jobsOfHistory(hdca.history_id)).filter(
                (job) => job.implicit_collection_jobs_id === hdca.job_source_id,
            );
        }
        const summary = { all_jobs: sourceJobs.length } as HDCJobStateSummary;
        for (const key of JOB_STATE_SUMMARY_KEYS) {
            summary[key] = 0;
        }
        for (const job of sourceJobs) {
            if ((JOB_STATE_SUMMARY_KEYS as readonly string[]).includes(job.state)) {
                summary[job.state as (typeof JOB_STATE_SUMMARY_KEYS)[number]]++;
            }
        }
        return summary;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// HDCA serializer

/** Every key the HDCA serializer can produce. */
export interface HdcaFields {
    id: string;
    type_id: string;
    name: string | null;
    history_id: string;
    collection_id: string;
    hid: number;
    history_content_type: "dataset_collection";
    collection_type: string;
    populated_state: PopulatedState;
    populated_state_message: string | null;
    element_count: number | null;
    elements_datatypes: string[];
    elements_deleted: number;
    elements_states: ElementsStatesDict;
    job_source_id: string | null;
    job_source_type: JobSourceType | null;
    job_state_summary: HDCJobStateSummary;
    deleted: boolean;
    visible: boolean;
    type: "collection";
    url: string;
    create_time: string;
    update_time: string;
    tags: string[];
    contents_url: string;
    store_times_summary: OldestCreateTimeByObjectStoreId[];
    populated: boolean;
    elements: DCESummary[];
    model_class: "HistoryDatasetCollectionAssociation";
    annotation: string | null;
    column_definitions: SampleSheetColumnDefinition[] | null;
    implicit_collection_jobs_id: string | null;
}

export type HdcaKey = keyof HdcaFields;

/** `HDCASerializer`'s summary view plus `model_class`, which the API model adds to every HDCA it returns. */
export const HDCA_SUMMARY_KEYS = [
    "model_class",
    "id",
    "type_id",
    "name",
    "history_id",
    "collection_id",
    "hid",
    "history_content_type",
    "collection_type",
    "populated_state",
    "populated_state_message",
    "element_count",
    "elements_datatypes",
    "elements_deleted",
    "elements_states",
    "job_source_id",
    "job_source_type",
    "job_state_summary",
    "deleted",
    "visible",
    "type",
    "url",
    "create_time",
    "update_time",
    "tags",
    "contents_url",
    "store_times_summary",
] as const satisfies readonly HdcaKey[];

export const HDCA_DETAILED_KEYS = [...HDCA_SUMMARY_KEYS, "populated", "elements"] as const satisfies readonly HdcaKey[];

export const HDCA_VIEWS: Readonly<Record<string, readonly HdcaKey[]>> = {
    summary: HDCA_SUMMARY_KEYS,
    detailed: HDCA_DETAILED_KEYS,
};

/** Keys of `dictify_dataset_collection_instance` with `view="collection"` (plus `tags`, which the model requires). */
export const HDCA_COLLECTION_VIEW_KEYS = [
    "model_class",
    "id",
    "name",
    "hid",
    "history_id",
    "history_content_type",
    "visible",
    "deleted",
    "job_source_id",
    "job_source_type",
    "job_state_summary",
    "create_time",
    "update_time",
    "collection_id",
    "collection_type",
    "column_definitions",
    "populated",
    "populated_state",
    "populated_state_message",
    "element_count",
    "elements_datatypes",
    "elements_deleted",
    "elements_states",
    "type",
    "url",
    "contents_url",
    "tags",
] as const satisfies readonly HdcaKey[];

/** Keys of `dictify_dataset_collection_instance` with `view="element"`. */
export const HDCA_ELEMENT_VIEW_KEYS = [
    ...HDCA_COLLECTION_VIEW_KEYS,
    "elements",
    "implicit_collection_jobs_id",
] as const satisfies readonly HdcaKey[];

export type HdcaSummaryView = Pick<HdcaFields, (typeof HDCA_SUMMARY_KEYS)[number]>;
export type HdcaDetailedView = Pick<HdcaFields, (typeof HDCA_DETAILED_KEYS)[number]>;
export type HdcaElementView = Pick<HdcaFields, (typeof HDCA_ELEMENT_VIEW_KEYS)[number]>;

/** A serialized HDCA whose keys were chosen at request time. */
export type HdcaView = Partial<HdcaFields>;

/** How collection elements are rendered: through the serializers (`HDCASerializer`) or `dictify_element`. */
export type ElementStyle = "serializer" | "dictify";

type HdcaContext = {
    hdca: HdcaRecord;
    collection: CollectionRecord;
    summary: CollectionSummary;
    jobStateSummary: HDCJobStateSummary;
    populated: boolean;
    elements: DCESummary[] | null;
    /** `dictify` uses the HDCA's own times and typed URLs; the serializer proxies times to the collection. */
    style: ElementStyle;
};

const HDCA_SERIALIZERS: { [K in HdcaKey]: (context: HdcaContext) => HdcaFields[K] } = {
    id: ({ hdca }) => hdca.id,
    type_id: ({ hdca }) => `dataset_collection-${hdca.id}`,
    name: ({ hdca }) => hdca.name,
    history_id: ({ hdca }) => hdca.history_id,
    collection_id: ({ collection }) => collection.id,
    hid: ({ hdca }) => hdca.hid,
    history_content_type: () => "dataset_collection",
    collection_type: ({ collection }) => collection.collection_type,
    populated_state: ({ collection }) => collection.populated_state,
    populated_state_message: ({ collection }) => collection.populated_state_message,
    element_count: ({ collection }) => collection.element_count,
    elements_datatypes: ({ summary }) => [...summary.extensions],
    elements_deleted: ({ summary }) => summary.deleted,
    elements_states: ({ summary }) => ({ ...summary.states }),
    job_source_id: ({ hdca }) => hdca.job_source_id,
    job_source_type: ({ hdca }) => hdca.job_source_type,
    job_state_summary: ({ jobStateSummary }) => jobStateSummary,
    deleted: ({ hdca }) => hdca.deleted,
    visible: ({ hdca }) => hdca.visible,
    type: () => "collection",
    url: ({ hdca }) => `/api/histories/${hdca.history_id}/contents/dataset_collections/${hdca.id}`,
    create_time: ({ hdca, collection, style }) => (style === "dictify" ? hdca.create_time : collection.create_time),
    update_time: ({ hdca, collection, style }) => (style === "dictify" ? hdca.update_time : collection.update_time),
    tags: ({ hdca }) => [...hdca.tags],
    contents_url: ({ hdca, collection }) => `/api/dataset_collections/${hdca.id}/contents/${collection.id}`,
    store_times_summary: () => [],
    populated: ({ populated }) => populated,
    elements: ({ elements }) => elements ?? [],
    model_class: () => "HistoryDatasetCollectionAssociation",
    annotation: ({ hdca }) => hdca.annotation?.trim() || null,
    column_definitions: ({ collection }) => collection.column_definitions as SampleSheetColumnDefinition[] | null,
    implicit_collection_jobs_id: ({ hdca }) =>
        hdca.job_source_type === "ImplicitCollectionJobs" ? hdca.job_source_id : null,
};

function isHdcaKey(key: string): key is HdcaKey {
    return Object.hasOwn(HDCA_SERIALIZERS, key);
}

async function collectionObject(
    collection: CollectionRecord,
    loader: ContentLoader,
    datatypes: DatatypeInfo,
    style: ElementStyle,
): Promise<Record<string, unknown>> {
    const summary = await loader.summary(collection.id);
    return {
        model_class: "DatasetCollection",
        id: collection.id,
        create_time: collection.create_time,
        update_time: collection.update_time,
        collection_type: collection.collection_type,
        populated_state: collection.populated_state,
        populated_state_message: collection.populated_state_message,
        element_count: collection.element_count,
        elements_datatypes: [...summary.extensions],
        elements_states: { ...summary.states },
        elements_deleted: summary.deleted,
        column_definitions: collection.column_definitions,
        populated: await loader.populated(collection),
        elements: await serializeElements(collection.id, loader, datatypes, style),
    };
}

/**
 * Serializes a collection's elements: `DCESerializer` summaries (HDA summary objects) for `serializer`, or
 * `dictify_element` (`HDA.to_dict()` objects and element `columns`) for `dictify`. Nested collections recurse.
 */
export async function serializeElements(
    collectionId: string,
    loader: ContentLoader,
    datatypes: DatatypeInfo,
    style: ElementStyle,
): Promise<DCESummary[]> {
    const out: DCESummary[] = [];
    for (const element of await loader.elements(collectionId)) {
        let object: Record<string, unknown> | null = null;
        if (element.hda_id) {
            const hda = await loader.tx.store("hdas").get(element.hda_id);
            if (hda) {
                const item = await loader.hdaItem(hda);
                object = style === "dictify" ? hdaElementObject(item, datatypes) : { ...hdaSummary(item, datatypes) };
            }
        } else if (element.child_collection_id) {
            const child = await loader.tx.store("collections").get(element.child_collection_id);
            if (child) {
                object = await collectionObject(child, loader, datatypes, style);
            }
        }
        const serialized: Record<string, unknown> = {
            model_class: "DatasetCollectionElement",
            id: element.id,
            element_index: element.element_index,
            element_identifier: element.element_identifier,
            element_type: element.element_type,
        };
        if (style === "dictify") {
            serialized.columns = element.columns;
        }
        serialized.object = object;
        out.push(serialized as DCESummary);
    }
    return out;
}

/**
 * Serializes an HDCA with the given keys. `style` selects `HDCASerializer` (`serializer`) or
 * `dictify_dataset_collection_instance` (`dictify`) behaviour for times and elements.
 */
export async function serializeHdca(
    hdca: HdcaRecord,
    keys: readonly string[],
    loader: ContentLoader,
    datatypes: DatatypeInfo,
    style: ElementStyle = "serializer",
): Promise<HdcaView> {
    const collection = await loader.collection(hdca.collection_id);
    const wanted = new Set(keys);
    const context: HdcaContext = {
        hdca,
        collection,
        summary: await loader.summary(collection.id),
        jobStateSummary: await loader.jobStateSummary(hdca),
        populated: wanted.has("populated") ? await loader.populated(collection) : false,
        elements: wanted.has("elements") ? await serializeElements(collection.id, loader, datatypes, style) : null,
        style,
    };
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        if (isHdcaKey(key) && !Object.hasOwn(out, key)) {
            out[key] = HDCA_SERIALIZERS[key](context);
        }
    }
    return out as HdcaView;
}

/**
 * The HDCA as `dictify_dataset_collection_instance` returns it: `element` (with elements), `element-reference`
 * (elements too; Planet does not truncate) or `collection` (without).
 */
export function serializeHdcaInstance(
    hdca: HdcaRecord,
    view: string,
    loader: ContentLoader,
    datatypes: DatatypeInfo,
): Promise<HdcaView> {
    const keys =
        view === "element" || view === "element-reference" ? HDCA_ELEMENT_VIEW_KEYS : HDCA_COLLECTION_VIEW_KEYS;
    return serializeHdca(hdca, keys, loader, datatypes, "dictify");
}

// ---------------------------------------------------------------------------------------------------------------
// Listing

/** Parses Galaxy's `details` parameter: `all` or a comma-separated list of ids. */
function parseDetails(value: string | null): "all" | Set<string> | null {
    if (value === null) {
        return null;
    }
    return value === "all" ? "all" : new Set(value.split(",").filter((id) => id));
}

function relatedEndpoints(job: JobRecord, hdcaIdsByCollection: ReadonlyMap<string, string[]>) {
    const outputs: { type: ContentType; id: string }[] = job.outputs.map((output) => ({
        type: "dataset",
        id: output.id,
    }));
    for (const output of job.output_collections) {
        if (output.src === "hdca") {
            outputs.push({ type: "dataset_collection", id: output.id });
        } else {
            for (const hdcaId of hdcaIdsByCollection.get(output.id) ?? []) {
                outputs.push({ type: "dataset_collection", id: hdcaId });
            }
        }
    }
    const inputs: { type: ContentType; id: string }[] = [];
    for (const input of job.inputs) {
        if (input.src === "hda") {
            inputs.push({ type: "dataset", id: input.id });
        } else if (input.src === "hdca") {
            inputs.push({ type: "dataset_collection", id: input.id });
        }
    }
    return { inputs, outputs };
}

/**
 * Hids related to `hid` through one job in either direction (`JobConnectionsManager.get_related_hids`): the outputs
 * of jobs that used the item and the inputs of the job that made it. Items outside the history are left out.
 */
export async function relatedHids(historyId: string, hid: number, tx: ReadTx): Promise<number[]> {
    const result = [hid];
    const item = await contents.getByHid(historyId, hid, tx);
    if (!item) {
        return result;
    }
    const itemId = item.type === "dataset" ? item.hda.id : item.hdca.id;
    const hdcas = await tx.store("hdcas").index("history_id").getAll(historyId);
    const hdcaIdsByCollection = new Map<string, string[]>();
    for (const hdca of hdcas) {
        hdcaIdsByCollection.set(hdca.collection_id, [...(hdcaIdsByCollection.get(hdca.collection_id) ?? []), hdca.id]);
    }
    const matches = (endpoint: { type: ContentType; id: string }) =>
        endpoint.type === item.type && endpoint.id === itemId;
    const related: { type: ContentType; id: string }[] = [];
    for (const job of await tx.store("jobs").index("history_id").getAll(historyId)) {
        const { inputs, outputs } = relatedEndpoints(job, hdcaIdsByCollection);
        if (inputs.some(matches)) {
            related.push(...outputs);
        }
        if (outputs.some(matches)) {
            related.push(...inputs);
        }
    }
    for (const endpoint of related) {
        const found = await contents.getItem(endpoint.type, endpoint.id, tx);
        if (found) {
            const record = found.type === "dataset" ? found.hda : found.hdca;
            if (record.history_id === historyId) {
                result.push(record.hid);
            }
        }
    }
    return result;
}

/**
 * Parses the `q`/`qv` filters of a contents request, replacing a `related` filter by the hids it designates
 * (`parse_query_filters_with_relations`).
 */
async function parseFiltersWithRelations(
    query: URLSearchParams,
    historyId: string,
    tx: ReadTx,
): Promise<ContentsFilter[]> {
    const q = query.getAll("q");
    const qv = query.getAll("qv");
    const relatedIndex = q.findIndex((name) => name === "related" || name === "related-eq");
    if (relatedIndex === -1 || relatedIndex >= qv.length) {
        return parseContentsFilters(query);
    }
    const value = qv[relatedIndex]!;
    if (!/^\d+$/.test(value)) {
        throw new ApiError(400, "unparsable value for related filter", ErrorCodes.USER_REQUEST_INVALID_PARAMETER, {
            column: "related",
            operation: "eq",
            value,
            ValueError: "invalid type in filter",
        });
    }
    const hids = await relatedHids(historyId, Number.parseInt(value, 10), tx);
    const rewritten = new URLSearchParams();
    q.forEach((name, index) => {
        if (index !== relatedIndex && index < qv.length) {
            rewritten.append("q", name);
            rewritten.append("qv", qv[index]!);
        }
    });
    rewritten.append("q", "related-eq");
    rewritten.append("qv", JSON.stringify(hids));
    return parseContentsFilters(rewritten);
}

function contentsResponse(body: unknown): TypedResponse<never> {
    return passthrough(json(body));
}

async function serializeRow(
    row: ContentRow,
    loader: ContentLoader,
    datatypes: DatatypeInfo,
    hdaKeys: readonly string[],
    hdcaKeys: readonly string[],
): Promise<HdaView | HdcaView> {
    if (row.type === "dataset") {
        return serializeHda(await loader.hdaItem(row.hda, row.dataset), hdaKeys, datatypes);
    }
    return serializeHdca(row.hdca, hdcaKeys, loader, datatypes);
}

/** `GET /api/histories/{history_id}/contents?v=dev` (`HistoriesContentsService.__index_v2`). */
async function indexV2(
    historyId: string,
    query: URLSearchParams,
    statsRequested: boolean,
    types: readonly ContentType[] | undefined,
): Promise<TypedResponse<never>> {
    const details = parseDetails(query.get("details"));
    const order = contents.parseContentsOrder((query.get("order") || "hid-asc").split(",")[0]);
    const { offset, limit } = pagination(query);
    // The index always serializes with a view (`summary` unless given), so `keys` add to it.
    const params: SerializationParams = serializationParams(query);
    const keys = [...(params.keys ?? []), ...(statsRequested ? ["elements_datatypes"] : [])];
    const view = params.view || "summary";
    const summaryKeys = resolveKeys(HDA_VIEWS, { view, keys }, "summary");
    const detailedKeys = resolveKeys(HDA_VIEWS, { view: "detailed", keys }, "detailed");
    const hdcaKeys = resolveKeys(HDCA_VIEWS, { view, keys }, "summary");
    const datatypes = await loadDatatypeInfo();

    const { items, total } = await readTx(READ_STORES, async (t) => {
        await histories.getOrThrow(historyId, t);
        const filters = await parseFiltersWithRelations(query, historyId, t);
        const result = await contents.list(historyId, { filters, order, offset, limit, types }, t);
        const loader = new ContentLoader(t);
        const serialized: (HdaView | HdcaView)[] = [];
        for (const row of result.rows) {
            const detailed =
                row.type === "dataset" && details !== null && (details === "all" || details.has(row.hda.id));
            const item = await serializeRow(row, loader, datatypes, detailed ? detailedKeys : summaryKeys, hdcaKeys);
            if (typeof item.url === "string") {
                const id = row.type === "dataset" ? row.hda.id : row.hdca.id;
                item.url = `/api/histories/${historyId}/contents/${row.type}s/${id}`;
            }
            serialized.push(item);
        }
        return { items: serialized, total: result.total };
    });
    return contentsResponse(statsRequested ? { contents: items, stats: { total_matches: total } } : items);
}

function parseTypes(query: URLSearchParams): ContentType[] {
    const raw = query
        .getAll("types")
        .flatMap((value) => value.split(","))
        .filter((value) => value);
    if (!raw.length) {
        return ["dataset", "dataset_collection"];
    }
    return raw.map((value) => {
        if (value !== "dataset" && value !== "dataset_collection") {
            throw new ApiError(400, `Unknown contents type: ${value}`, ErrorCodes.UNKNOWN_CONTENTS_TYPE);
        }
        return value;
    });
}

/** `GET /api/histories/{history_id}/contents` without `v=dev` (`__index_legacy`). */
async function indexLegacy(
    historyId: string,
    query: URLSearchParams,
    restrictTo: readonly ContentType[] | undefined,
): Promise<TypedResponse<never>> {
    const ids = query.get("ids");
    const idSet = ids ? new Set(ids.split(",").filter((id) => id)) : null;
    const details = idSet ? "all" : parseDetails(query.get("details"));
    const types = restrictTo ?? parseTypes(query);
    const deleted = queryBool(query, "deleted", null);
    const visible = queryBool(query, "visible", null);
    const filters: ContentsFilter[] = [];
    if (deleted !== null) {
        filters.push({ attr: "deleted", op: "eq", value: deleted });
    }
    if (visible !== null) {
        filters.push({ attr: "visible", op: "eq", value: visible });
    }
    const datatypes = await loadDatatypeInfo();
    const items = await readTx(READ_STORES, async (t) => {
        await histories.getOrThrow(historyId, t);
        const result = await contents.list(historyId, { filters, types, order: { key: "hid", descending: false } }, t);
        const loader = new ContentLoader(t);
        const out: (HdaView | HdcaView)[] = [];
        for (const row of result.rows) {
            const id = row.type === "dataset" ? row.hda.id : row.hdca.id;
            if (idSet && !idSet.has(id)) {
                continue;
            }
            const detailed = details !== null && (details === "all" || details.has(id));
            if (row.type === "dataset") {
                const keys = detailed ? HDA_DETAILED_KEYS : HDA_SUMMARY_KEYS;
                out.push(serializeHda(await loader.hdaItem(row.hda, row.dataset), keys, datatypes));
            } else {
                out.push(await serializeHdcaInstance(row.hdca, detailed ? "element" : "collection", loader, datatypes));
            }
        }
        return out;
    });
    return contentsResponse(items);
}

function indexContents(request: PlanetRequest, historyId: string, types?: readonly ContentType[]) {
    const { query } = request;
    const version = query.get("v");
    if (version === null || version === "") {
        return indexLegacy(historyId, query, types);
    }
    if (version !== "dev") {
        throw ApiError.badRequest("Only `dev` value is allowed for the v parameter");
    }
    const statsRequested = (request.headers.get("accept") ?? "").includes(STATS_MEDIA_TYPE);
    return indexV2(historyId, query, statsRequested, types);
}

// ---------------------------------------------------------------------------------------------------------------
// Mutations. Each runs in a write transaction over JOB_STORES; repositories bump update_time and the history.

/** Galaxy's set-metadata tool, run as a cluster job after a datatype change. */
export const SET_METADATA_TOOL_ID = "__SET_METADATA__";
const SET_METADATA_TOOL_VERSION = "1.0.1";

const DELETED_JOB_INFO = "Job output deleted by user before job completed.";

/**
 * Marks a job deleting and discards its outputs (`Job.mark_deleted` with jobs tracked in the database). The
 * `job-changed` event tells the leader to cancel the Kubernetes job.
 */
export async function markJobDeleted(job: JobRecord, tx: WriteTx, info = DELETED_JOB_INFO): Promise<void> {
    if (FINISHED_JOB_STATES.has(job.state)) {
        return;
    }
    await jobs.update(job.id, { state: "deleting", info }, tx);
    for (const output of job.outputs) {
        const hda = await tx.store("hdas").get(output.id);
        if (!hda) {
            continue;
        }
        await hdas.update(hda.id, { deleted: true, _state: null }, tx);
        await datasets.update(hda.dataset_id, { state: "discarded" }, tx);
        for (const shared of await hdas.listForDataset(hda.dataset_id, tx)) {
            await hdas.update(shared.id, { deleted: true, blurb: "deleted", peek: "Job deleted", info }, tx);
        }
    }
}

/** Stops the HDA's creating job when all of the job's outputs are deleted (`stop_creating_job`). */
async function stopCreatingJob(hda: HdaRecord, tx: WriteTx): Promise<void> {
    if (!hda.creating_job_id) {
        return;
    }
    const job = await tx.store("jobs").get(hda.creating_job_id);
    if (!job || FINISHED_JOB_STATES.has(job.state)) {
        return;
    }
    for (const output of job.outputs) {
        const other = await tx.store("hdas").get(output.id);
        if (other && !other.deleted) {
            return;
        }
    }
    await markJobDeleted(job, tx);
}

async function hdaOrThrow(id: string, tx: ReadTx): Promise<HdaRecord> {
    const hda = await tx.store("hdas").get(id);
    if (!hda) {
        throw ApiError.notFound("Dataset not found");
    }
    return hda;
}

/** Marks an HDA deleted, optionally stopping its creating job. */
export async function deleteHda(id: string, tx: WriteTx, options: { stopJob?: boolean } = {}): Promise<HdaRecord> {
    const hda = await hdaOrThrow(id, tx);
    const updated = hda.deleted ? await hdas.update(id, {}, tx) : await hdas.update(id, { deleted: true }, tx);
    if (options.stopJob) {
        await stopCreatingJob(updated, tx);
    }
    return updated;
}

/** Clears `deleted`. Purged datasets cannot be recovered. */
export async function undeleteHda(id: string, tx: WriteTx): Promise<HdaRecord> {
    const hda = await hdaOrThrow(id, tx);
    if (hda.purged) {
        throw ApiError.badRequest("This item has been permanently deleted and cannot be recovered.");
    }
    return hdas.update(id, { deleted: false }, tx);
}

/**
 * Purges an HDA (`HDAManager.purge`): marks it deleted and purged, stops its creating job and, when no other copy
 * remains unpurged, marks the dataset purged so the leader removes its objects from the bucket.
 */
export async function purgeHda(id: string, tx: WriteTx): Promise<HdaRecord> {
    const hda = await hdaOrThrow(id, tx);
    const updated = await hdas.update(id, { deleted: true, purged: true }, tx);
    if (hda.purged) {
        return updated;
    }
    await stopCreatingJob(updated, tx);
    const copies = await hdas.listForDataset(hda.dataset_id, tx);
    const dataset = await tx.store("datasets").get(hda.dataset_id);
    if (dataset && !dataset.purged && copies.every((copy) => copy.purged)) {
        await datasets.update(dataset.id, { deleted: true, purged: true }, tx);
    }
    return updated;
}

async function hdcaOrThrow(id: string, tx: ReadTx): Promise<HdcaRecord> {
    const hdca = await tx.store("hdcas").get(id);
    if (!hdca) {
        throw ApiError.notFound("Collection not found");
    }
    return hdca;
}

/** Deletes an HDCA and, when `recursive`, its datasets; `purge` also purges them (`DatasetCollectionManager.delete`). */
export async function deleteHdca(
    id: string,
    tx: WriteTx,
    options: { recursive?: boolean; purge?: boolean } = {},
): Promise<HdcaRecord> {
    const hdca = await hdcaOrThrow(id, tx);
    const updated = await collections.updateHdca(id, { deleted: true }, tx);
    if (options.recursive) {
        for (const hdaId of await collections.leafHdaIds(hdca.collection_id, tx)) {
            const hda = await tx.store("hdas").get(hdaId);
            if (!hda) {
                continue;
            }
            if (!hda.deleted) {
                await hdas.update(hdaId, { deleted: true }, tx);
            }
            if (options.purge && !hda.purged) {
                await purgeHda(hdaId, tx);
            }
        }
    }
    return updated;
}

/** True unless a job that is not terminal uses the HDA as input or output (`ok_to_edit_metadata`). */
async function okToEditMetadata(hda: HdaRecord, tx: ReadTx): Promise<boolean> {
    for (const job of await tx.store("jobs").index("history_id").getAll(hda.history_id)) {
        if (TERMINAL_JOB_STATES.has(job.state)) {
            continue;
        }
        const uses =
            job.inputs.some((input) => input.src === "hda" && input.id === hda.id) ||
            job.outputs.some((output) => output.id === hda.id);
        if (uses) {
            return false;
        }
    }
    return true;
}

/**
 * Changes an HDA's datatype (`auto` keeps it and asks for sniffing) and queues Galaxy's set-metadata tool as a job:
 * the HDA shows `setting_metadata` until the job finishes. The job's `params.datatype` is the requested extension.
 */
export async function changeDatatype(id: string, datatype: string, tx: WriteTx): Promise<JobRecord> {
    const hda = await hdaOrThrow(id, tx);
    if (!(await okToEditMetadata(hda, tx))) {
        throw ApiError.forbidden(
            "This dataset is currently being used as input or output. You cannot change datatype until the jobs have completed or you have canceled them.",
        );
    }
    const patch: hdas.HdaPatch = { _state: "setting_metadata" };
    if (datatype !== "auto") {
        patch.extension = datatype;
    }
    await hdas.update(id, patch, tx);
    return jobs.create(
        {
            tool_id: SET_METADATA_TOOL_ID,
            tool_version: SET_METADATA_TOOL_VERSION,
            history_id: hda.history_id,
            state: "new",
            params: { input1: { src: "hda", id }, overwrite: true, validate: false, datatype },
            inputs: [{ name: "input1", src: "hda", id }],
        },
        tx,
    );
}

/** Sets an HDA's dbkey and its `dbkey` metadata when present (`set_dbkey`). */
async function changeDbkey(id: string, dbkey: string, tx: WriteTx): Promise<void> {
    const hda = await hdaOrThrow(id, tx);
    const metadata = Object.hasOwn(hda.metadata, "dbkey") ? { ...hda.metadata, dbkey } : hda.metadata;
    await hdas.update(id, { dbkey, metadata }, tx);
}

/** Copies a history's datasets and collections into another history, keeping hids (`History.copy`). */
export async function copyContentsInto(
    sourceHistoryId: string,
    targetHistoryId: string,
    allDatasets: boolean,
    tx: WriteTx,
): Promise<void> {
    const source = await histories.getOrThrow(sourceHistoryId, tx);
    const store = tx.store("histories");
    const target = await store.get(targetHistoryId);
    if (!target) {
        throw ApiError.notFound("History not found");
    }
    target.hid_counter = Math.max(target.hid_counter, source.hid_counter);
    target.update_time = tx.now;
    await store.put(target);

    const copied = new Map<string, string>();
    const sourceHdas = (await tx.store("hdas").index("history_id").getAll(source.id)).sort((a, b) => a.hid - b.hid);
    for (const hda of sourceHdas) {
        if (!allDatasets && hda.deleted) {
            continue;
        }
        const copy = await hdas.create(
            { ...hda, id: undefined, history_id: targetHistoryId, copied_from: { src: "hda", id: hda.id } },
            tx,
        );
        copied.set(hda.id, copy.id);
    }

    const elementHda = async (hdaId: string): Promise<string> => {
        const known = copied.get(hdaId);
        if (known) {
            return known;
        }
        const original = await hdaOrThrow(hdaId, tx);
        const copy = await hdas.create(
            {
                ...original,
                id: undefined,
                hid: undefined,
                visible: false,
                history_id: targetHistoryId,
                copied_from: { src: "hda", id: hdaId },
            },
            tx,
        );
        copied.set(hdaId, copy.id);
        return copy.id;
    };
    const copyTree = async (collection: CollectionRecord): Promise<NewCollectionTree> => {
        const elements: NewElement[] = [];
        for (const element of await collections.elements(collection.id, tx)) {
            if (element.hda_id) {
                elements.push({
                    identifier: element.element_identifier,
                    hda_id: await elementHda(element.hda_id),
                    columns: element.columns,
                });
            } else if (element.child_collection_id) {
                const child = await tx.store("collections").get(element.child_collection_id);
                if (child) {
                    elements.push({
                        identifier: element.element_identifier,
                        collection: await copyTree(child),
                        columns: element.columns,
                    });
                }
            }
        }
        return {
            collection_type: collection.collection_type,
            populated_state: collection.populated_state,
            populated_state_message: collection.populated_state_message,
            fields: collection.fields,
            column_definitions: collection.column_definitions,
            elements,
        };
    };

    const sourceHdcas = (await tx.store("hdcas").index("history_id").getAll(source.id)).sort((a, b) => a.hid - b.hid);
    for (const hdca of sourceHdcas) {
        if (!allDatasets && hdca.deleted) {
            continue;
        }
        const collection = await tx.store("collections").get(hdca.collection_id);
        if (!collection) {
            continue;
        }
        const { collection_id: _collectionId, ...fields } = hdca;
        await collections.createHdca(
            {
                hdca: { ...fields, id: undefined, history_id: targetHistoryId, copied_from_hdca_id: hdca.id },
                collection: await copyTree(collection),
            },
            tx,
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Show, update, delete

async function showItem(type: ContentType, id: string, query: URLSearchParams): Promise<TypedResponse<never>> {
    const params = serializationParams(query);
    const datatypes = await loadDatatypeInfo();
    const body = await readTx(READ_STORES, async (t) => {
        const loader = new ContentLoader(t);
        if (type === "dataset") {
            return serializeHda(await loader.hdaItemById(id), resolveKeys(HDA_VIEWS, params, "detailed"), datatypes);
        }
        return serializeHdcaInstance(await hdcaOrThrow(id, t), params.view || "element", loader, datatypes);
    });
    return contentsResponse(body);
}

/** Applies a dataset update payload (`HDADeserializer`); unknown keys are ignored. */
async function updateDataset(
    id: string,
    payload: Record<string, unknown>,
    tx: WriteTx,
    datatypes: DatatypeInfo | null,
) {
    let hda = await hdaOrThrow(id, tx);
    const deleting = payload.deleted === true;
    if (!deleting && hdas.effectiveState(hda, await datasets.getOrThrow(hda.dataset_id, tx)) === "upload") {
        throw ApiError.conflict("Please wait until this dataset finishes uploading");
    }
    const patch: hdas.HdaPatch = {};
    if ("name" in payload) {
        patch.name = readString(payload, "name");
    }
    if ("info" in payload) {
        patch.info = readString(payload, "info");
    }
    if ("misc_info" in payload) {
        patch.info = readNullableString(payload, "misc_info") ?? "";
    }
    if ("visible" in payload) {
        patch.visible = readBool(payload, "visible");
    }
    if ("genome_build" in payload) {
        patch.dbkey = readNullableString(payload, "genome_build") ?? "?";
        if (Object.hasOwn(hda.metadata, "dbkey")) {
            patch.metadata = { ...hda.metadata, dbkey: patch.dbkey };
        }
    }
    if ("tags" in payload) {
        patch.tags = normalizeTags(readStringList(payload, "tags"));
    }
    if ("annotation" in payload) {
        patch.annotation = readNullableString(payload, "annotation");
    }
    if (Object.keys(patch).length) {
        hda = await hdas.update(id, patch, tx);
    }
    if ("deleted" in payload) {
        const deleted = readBool(payload, "deleted");
        if (deleted !== hda.deleted) {
            hda = deleted ? await deleteHda(id, tx) : await undeleteHda(id, tx);
        }
        if (deleted) {
            await stopCreatingJob(hda, tx);
        }
    }
    if ("purged" in payload && readBool(payload, "purged") && !hda.purged) {
        hda = await purgeHda(id, tx);
    }
    if ("datatype" in payload && datatypes) {
        const datatype = readString(payload, "datatype");
        if (datatype !== "auto" && !datatypes.has(datatype)) {
            throw ApiError.badRequest(`Data type '${datatype}' is not registered`);
        }
        if (datatype !== hda.extension) {
            await changeDatatype(id, datatype, tx);
        }
    }
}

/** Applies a collection update payload and returns the changed values (`DatasetCollectionManager.update`). */
async function updateCollection(
    id: string,
    payload: Record<string, unknown>,
    tx: WriteTx,
): Promise<Record<string, unknown>> {
    const hdca = await hdcaOrThrow(id, tx);
    const patch: collections.HdcaPatch = {};
    const changed: Record<string, unknown> = {};
    if (payload.name !== undefined && payload.name !== null) {
        const name = sanitizeText(readString(payload, "name"));
        if (name !== hdca.name) {
            patch.name = changed.name = name;
        }
    }
    for (const key of ["deleted", "visible"] as const) {
        if (payload[key] !== undefined && payload[key] !== null) {
            const value = readBool(payload, key);
            if (value !== hdca[key]) {
                patch[key] = changed[key] = value;
            }
        }
    }
    if ("annotation" in payload) {
        patch.annotation = changed.annotation = readNullableString(payload, "annotation");
    }
    if (payload.tags !== undefined && payload.tags !== null) {
        patch.tags = normalizeTags(readStringList(payload, "tags").map(sanitizeText));
    }
    if (Object.keys(patch).length) {
        const updated = await collections.updateHdca(id, patch, tx);
        if (patch.tags) {
            changed.tags = [...updated.tags];
        }
    }
    return changed;
}

async function updateItem(request: PlanetRequest, type: ContentType, id: string): Promise<TypedResponse<never>> {
    const payload = asObject(await request.json());
    if (type === "dataset_collection") {
        return contentsResponse(
            await withTransaction(JOB_STORES, "readwrite", (t) => updateCollection(id, payload, t)),
        );
    }
    const datatypes = "datatype" in payload ? await requireDatatypeInfo() : null;
    await withTransaction(JOB_STORES, "readwrite", (t) => updateDataset(id, payload, t, datatypes));
    return showItem("dataset", id, request.query);
}

async function deleteItem(request: PlanetRequest, type: ContentType, id: string): Promise<TypedResponse<never>> {
    const payload = asObject(await request.json());
    const purge = payload.purge === true || queryBool(request.query, "purge", false);
    const recursive = payload.recursive === true || queryBool(request.query, "recursive", false);
    const stopJob = payload.stop_job === true || queryBool(request.query, "stop_job", false);
    await withTransaction(JOB_STORES, "readwrite", async (t) => {
        if (type === "dataset_collection") {
            await deleteHdca(id, t, { recursive, purge });
            return;
        }
        const hda = await hdaOrThrow(id, t);
        if (hdas.effectiveState(hda, await datasets.getOrThrow(hda.dataset_id, t)) === "upload") {
            throw ApiError.conflict("Please wait until this dataset finishes uploading");
        }
        if (purge) {
            await purgeHda(id, t);
        } else {
            await deleteHda(id, t, { stopJob });
        }
    });
    return noContent();
}

// ---------------------------------------------------------------------------------------------------------------
// Bulk operations

const BULK_OPERATIONS = [
    "hide",
    "unhide",
    "delete",
    "undelete",
    "purge",
    "change_datatype",
    "change_dbkey",
    "add_tags",
    "remove_tags",
] as const;

type BulkOperation = (typeof BULK_OPERATIONS)[number];

interface BulkPayload {
    operation: BulkOperation;
    items: { history_content_type: ContentType; id: string }[] | null;
    params: Record<string, unknown> | null;
}

function parseBulkPayload(body: unknown): BulkPayload {
    const payload = asObject(body);
    const operation = payload.operation;
    if (typeof operation !== "string" || !(BULK_OPERATIONS as readonly string[]).includes(operation)) {
        throw invalidValue("operation", `one of ${BULK_OPERATIONS.join(", ")}`);
    }
    let items: BulkPayload["items"] = null;
    if (payload.items !== undefined && payload.items !== null) {
        if (!Array.isArray(payload.items)) {
            throw invalidValue("items", "a list");
        }
        items = payload.items.map((item) => {
            const entry = asObject(item);
            if (typeof entry.id !== "string" || typeof entry.history_content_type !== "string") {
                throw invalidValue("items", "a list of {id, history_content_type}");
            }
            return { id: entry.id, history_content_type: parseContentType(entry.history_content_type) };
        });
    }
    const params = payload.params === undefined || payload.params === null ? null : asObject(payload.params);
    return { operation: operation as BulkOperation, items, params };
}

function requireParam(params: Record<string, unknown> | null, key: string, type: string): string | string[] {
    const value = params?.[key];
    if (key === "tags") {
        if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
            throw invalidValue(`params.${key}`, "a list of strings");
        }
        return value;
    }
    if (typeof value !== "string") {
        throw invalidValue(`params.${key}`, `a string (${type})`);
    }
    return value;
}

async function applyToHda(
    operation: BulkOperation,
    hda: HdaRecord,
    params: Record<string, unknown> | null,
    tx: WriteTx,
): Promise<void> {
    switch (operation) {
        case "hide":
        case "unhide":
            await hdas.update(hda.id, { visible: operation === "unhide" }, tx);
            return;
        case "delete":
            await deleteHda(hda.id, tx);
            return;
        case "undelete":
            await undeleteHda(hda.id, tx);
            return;
        case "purge":
            if (hda.purged) {
                await hdas.update(hda.id, {}, tx);
            } else {
                await purgeHda(hda.id, tx);
            }
            return;
        case "change_datatype":
            await changeDatatype(hda.id, requireParam(params, "datatype", "datatype") as string, tx);
            return;
        case "change_dbkey":
            await changeDbkey(hda.id, requireParam(params, "dbkey", "dbkey") as string, tx);
            return;
        case "add_tags":
            await hdas.update(
                hda.id,
                { tags: normalizeTags([...hda.tags, ...(requireParam(params, "tags", "") as string[])]) },
                tx,
            );
            return;
        case "remove_tags": {
            const removed = new Set(requireParam(params, "tags", "") as string[]);
            await hdas.update(hda.id, { tags: normalizeTags(hda.tags.filter((tag) => !removed.has(tag))) }, tx);
            return;
        }
    }
}

async function applyToHdca(
    operation: BulkOperation,
    hdca: HdcaRecord,
    params: Record<string, unknown> | null,
    tx: WriteTx,
): Promise<void> {
    switch (operation) {
        case "hide":
        case "unhide":
            await collections.updateHdca(hdca.id, { visible: operation === "unhide" }, tx);
            return;
        case "delete":
            await deleteHdca(hdca.id, tx, { recursive: true });
            return;
        case "undelete":
            await collections.updateHdca(hdca.id, { deleted: false }, tx);
            return;
        case "purge":
            await deleteHdca(hdca.id, tx, { recursive: true, purge: true });
            return;
        case "change_datatype":
        case "change_dbkey":
            for (const hdaId of await collections.leafHdaIds(hdca.collection_id, tx)) {
                await applyToHda(operation, await hdaOrThrow(hdaId, tx), params, tx);
            }
            if (operation === "change_datatype") {
                await collections.updateHdca(hdca.id, {}, tx);
            }
            return;
        case "add_tags":
            await collections.updateHdca(
                hdca.id,
                { tags: normalizeTags([...hdca.tags, ...(requireParam(params, "tags", "") as string[])]) },
                tx,
            );
            return;
        case "remove_tags": {
            const removed = new Set(requireParam(params, "tags", "") as string[]);
            await collections.updateHdca(
                hdca.id,
                { tags: normalizeTags(hdca.tags.filter((tag) => !removed.has(tag))) },
                tx,
            );
            return;
        }
    }
}

/** Whether `dbkey` is a build listed in the generated `/api/genomes` payload (`is_registered_dbkey`). */
async function isRegisteredDbkey(dbkey: string): Promise<boolean> {
    const genomes = await loadStaticData<unknown>("genomes.json");
    return Array.isArray(genomes) && genomes.some((entry) => Array.isArray(entry) && entry[1] === dbkey);
}

async function validateBulkParams(payload: BulkPayload): Promise<void> {
    if (payload.operation === "change_dbkey") {
        const dbkey = requireParam(payload.params, "dbkey", "dbkey") as string;
        if (!(await isRegisteredDbkey(dbkey))) {
            throw ApiError.badRequest(`Database/build '${dbkey}' is not registered`);
        }
    }
    if (payload.operation === "change_datatype") {
        const datatype = requireParam(payload.params, "datatype", "datatype") as string;
        const datatypes = await requireDatatypeInfo();
        if (datatype !== "auto" && !datatypes.has(datatype)) {
            throw ApiError.badRequest(`Data type '${datatype}' is not registered`);
        }
    }
    if (payload.operation === "add_tags" || payload.operation === "remove_tags") {
        requireParam(payload.params, "tags", "");
    }
}

/** `PUT /api/histories/{history_id}/contents/bulk` (`HistoriesContentsService.bulk_operation`). */
async function bulkOperation(
    historyId: string,
    query: URLSearchParams,
    body: unknown,
): Promise<HistoryContentBulkOperationResult> {
    const payload = parseBulkPayload(body);
    await validateBulkParams(payload);
    return withTransaction(JOB_STORES, "readwrite", async (t) => {
        await histories.getOrThrow(historyId, t);
        const targets: ContentRow[] = [];
        if (payload.items?.length) {
            for (const item of payload.items) {
                const row = await contents.getItem(item.history_content_type, item.id, t);
                if (!row) {
                    if (item.history_content_type === "dataset_collection") {
                        throw ApiError.notFound("Collection not found");
                    }
                    continue;
                }
                if (row.type === "dataset" && row.hda.history_id !== historyId) {
                    continue;
                }
                targets.push(row);
            }
        } else {
            targets.push(...(await contents.list(historyId, { filters: parseContentsFilters(query) }, t)).rows);
        }
        const errors: BulkOperationItemError[] = [];
        for (const row of targets) {
            try {
                if (row.type === "dataset") {
                    await applyToHda(payload.operation, await hdaOrThrow(row.hda.id, t), payload.params, t);
                } else {
                    await applyToHdca(payload.operation, await hdcaOrThrow(row.hdca.id, t), payload.params, t);
                }
            } catch (caught) {
                if (!(caught instanceof ApiError)) {
                    throw caught;
                }
                errors.push({
                    item: { id: row.type === "dataset" ? row.hda.id : row.hdca.id, history_content_type: row.type },
                    error: caught.message,
                });
            }
        }
        return { success_count: targets.length - errors.length, errors };
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

export function register(router: Router): void {
    router.route("/api/histories/{history_id}/contents", "get", (request) =>
        indexContents(request, request.params.history_id),
    );

    router.route("/api/histories/{history_id}/contents/{type}s", "get", (request) =>
        indexContents(request, request.params.history_id, [parseContentType(request.params.type)]),
    );

    router.route("/api/histories/{history_id}/contents/{type}s/{id}", "get", ({ params, query }) =>
        showItem(parseContentType(params.type), params.id, query),
    );

    router.route("/api/histories/{history_id}/contents/{id}", "get", ({ params, query }) =>
        showItem(parseContentType(query.get("type") || "dataset"), params.id, query),
    );

    router.route("/api/histories/{history_id}/contents/{type}s/{id}", "put", (request) =>
        updateItem(request, parseContentType(request.params.type), request.params.id),
    );

    router.route("/api/histories/{history_id}/contents/{id}", "put", (request) =>
        updateItem(request, parseContentType(request.query.get("type") || "dataset"), request.params.id),
    );

    router.route("/api/histories/{history_id}/contents/{type}s/{id}", "delete", (request) =>
        deleteItem(request, parseContentType(request.params.type), request.params.id),
    );

    router.route("/api/histories/{history_id}/contents/{id}", "delete", (request) =>
        deleteItem(request, parseContentType(request.query.get("type") || "dataset"), request.params.id),
    );

    router.route("/api/histories/{history_id}/contents/bulk", "put", async ({ params, query, json: body }) =>
        bulkOperation(params.history_id, query, await body()),
    );
}
