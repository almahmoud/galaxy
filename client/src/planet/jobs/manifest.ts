/**
 * Dispatch of a job (leader responsibility 3 of notes/phase34-contracts.md): builds the manifest of protocol
 * version 1 (planet/docs/job-protocol.md) from IndexedDB, creates the bucket objects it refers to, writes
 * `jobs/<job>/manifest.json` and returns what the Kubernetes Job needs.
 *
 * Expected job records:
 * - tool jobs: `params` holds Galaxy's job state, nested (conditionals as objects, repeats as arrays) or as the flat
 *   `a|b` keys of a tool form; data values are `{src, id}` references, alone, in lists or in `{values: [...]}`.
 *   `outputs` and `output_collections` list the datasets and collections created at submit.
 * - upload jobs (`__DATA_FETCH__`): `request` is the fetch request, with uploaded files as `{"src": "planet",
 *   "file": <upload id>}` or as `src: "files"` items matched to its `files_<n>|file_data` session ids; `outputs` lists
 *   the datasets of `hdas` targets in element order and `output_collections` the collections of `hdca` targets in
 *   target order.
 * - set-metadata jobs (`__SET_METADATA__`): `inputs` names the datasets; `params` may set `ext` (a new datatype),
 *   `detect` (sniff the datatype) and `overwrite`.
 */

import {
    type CollectionRecord,
    type DatasetRecord,
    type DceRecord,
    type HdaRecord,
    type HdcaRecord,
    type JobRecord,
    type ReadTx,
    readTx,
    type UploadRecord,
} from "@/planet/db";
import { newUuid, randomHex } from "@/planet/util/ids";
import { galaxyNow } from "@/planet/util/time";

import type { JobDeps } from "./deps";
import { slotsAndMemory } from "./k8sJob";
import { jobObjectKeys, jobTimeLimits } from "./keys";
import {
    abortMultipartUploads,
    createMultipartUpload,
    datasetTargets,
    DispatchError,
    type DispatchRecord,
    ensureToolArchive,
    EXTRA_OBJECT_POOL,
    MULTIPART_INPUT_THRESHOLD,
    type MultipartUpload,
    readDispatchRecord,
    RequestSigner,
    writeDispatchRecord,
    writeJson,
} from "./objects";
import {
    type BundleOutput,
    type BundleParameter,
    type JobKind,
    type Manifest,
    type ManifestCollection,
    type ManifestCollectionElement,
    type ManifestInput,
    type ManifestJob,
    type ManifestOutput,
    type ManifestOutputCollection,
    PROTOCOL_VERSION,
    type ToolBundle,
} from "./schemas";

export { DispatchError };

export const DATA_FETCH_TOOL_ID = "__DATA_FETCH__";
export const SET_METADATA_TOOL_ID = "__SET_METADATA__";
/** Datasets a tool job may discover (`slots`). */
export const DEFAULT_SLOT_COUNT = 32;
/** Galaxy's default `max_metadata_value_size`. */
export const MAX_METADATA_VALUE_SIZE = 5 * 1024 * 1024;
/**
 * How long stage-out waits for the tool container to start before it writes `not_started` results. It covers
 * pulls of large images, which the kubelet does before it starts the tool container.
 */
export const DEFAULT_START_TIMEOUT_SECONDS = 900;

export interface DispatchPlan {
    kind: JobKind;
    attempt: number;
    /** Random id of this dispatch, in its dispatch record and as an annotation of the Kubernetes Job. */
    dispatchId: string;
    manifestKey: string;
    /** Presigned GET of the manifest for `PLANET_MANIFEST_URL`; expires after `manifestExpirySeconds`. */
    manifestUrl: string;
    deadlineSeconds: number;
    walltimeSeconds: number;
    /** The tool container's image (kind `tool`), or null. */
    toolImage: string | null;
    resources: { cpu: string; memory: string; scratch: string };
    /** Multipart uploads created for this attempt; ingest completes or aborts them. */
    multipart: { key: string; uploadId: string }[];
}

export interface DispatchOptions {
    /**
     * The manifest's `job.attempt`, which results must repeat to be ingested and which names the attempt's objects
     * (`jobs/<job>/a<attempt>/`). Defaults to 1.
     */
    attempt?: number;
}

/** The protocol kind of a job. */
export function jobKind(job: Pick<JobRecord, "tool_id">): JobKind {
    if (job.tool_id === DATA_FETCH_TOOL_ID) {
        return "upload";
    }
    if (job.tool_id === SET_METADATA_TOOL_ID) {
        return "set_metadata";
    }
    return "tool";
}

/**
 * Prepares an attempt of a job: copies the tool archive into the bucket on first use, creates multipart uploads
 * for large outputs, presigns every request the pod needs, writes the attempt's manifest and dispatch record. Call
 * it before creating the attempt's Kubernetes Job, and only when no Job of the attempt exists: the attempt's objects
 * are rewritten and the uploads of the record they replace are aborted.
 *
 * @throws DispatchError when the job cannot run (`permanent`) or not yet (inputs or uploads not ready)
 */
export async function prepareDispatch(
    job: JobRecord,
    deps: JobDeps,
    options: DispatchOptions = {},
): Promise<DispatchPlan> {
    const kind = jobKind(job);
    const attempt = options.attempt ?? 1;
    const keys = jobObjectKeys(job.id, attempt);
    const cluster = deps.settings.cluster;
    // The first request also teaches the client the bucket's clock, which every presigned request below relies on.
    const previous = await readDispatchRecord(deps.s3, job.id, attempt, deps.signal);
    if (previous?.multipart.length) {
        await abortMultipartUploads(deps.s3, previous.multipart, deps.signal);
    }
    const dispatchId = randomHex(8);

    const bundle = kind === "tool" ? await loadBundle(job, deps) : null;
    const image = bundle ? await resolveImage(bundle, deps) : { image: null };
    const limits = jobTimeLimits(cluster.default_walltime_seconds);
    const resources = jobResources(cluster, bundle);
    const snapshot = await loadSnapshot(job, kind);
    const sign = new RequestSigner(deps.s3, limits.requestExpirySeconds);
    const manifestJob: ManifestJob = {
        id: job.id,
        attempt,
        ...(job.history_id ? { history_id: job.history_id } : {}),
        walltime_seconds: limits.walltimeSeconds,
        slots: resources.slots,
        memory_mb: resources.memoryMb,
        ...(image.shell ? { shell: image.shell } : {}),
    };
    const context: BuildContext = { job: snapshot.job, manifestJob, snapshot, deps, sign, created: [] };

    try {
        const manifest = await buildManifest(kind, context, bundle);
        const record: DispatchRecord = {
            protocol: PROTOCOL_VERSION,
            job_id: job.id,
            attempt,
            dispatch_id: dispatchId,
            kind,
            create_time: galaxyNow(),
            walltime_seconds: limits.walltimeSeconds,
            deadline_seconds: limits.deadlineSeconds,
            slots: resources.slots,
            memory_mb: resources.memoryMb,
            slot_uuids: (manifest.slots ?? []).map((slot) => slot.uuid),
            multipart: context.created,
        };
        await writeDispatchRecord(deps.s3, record, deps.signal);
        await writeJson(deps.s3, keys.manifest, manifest, deps.signal);
        const manifestUrl = await deps.s3.presignGet(keys.manifest, limits.manifestExpirySeconds, {
            endpoint: "cluster",
        });
        return {
            kind,
            attempt,
            dispatchId,
            manifestKey: keys.manifest,
            manifestUrl,
            deadlineSeconds: limits.deadlineSeconds,
            walltimeSeconds: limits.walltimeSeconds,
            toolImage: image.image,
            resources: { cpu: resources.cpu, memory: resources.memory, scratch: resources.scratch },
            multipart: context.created.map((upload) => ({ key: upload.key, uploadId: upload.upload_id })),
        };
    } catch (error) {
        await abortMultipartUploads(deps.s3, context.created);
        throw error;
    }
}

/** What the job manager records when it adopts the Kubernetes Job of an earlier, unrecorded dispatch. */
export type AdoptedDispatch = Pick<DispatchPlan, "kind" | "attempt" | "dispatchId" | "multipart">;

/**
 * Returns the attempt's dispatch record as an adopted dispatch when the existing Kubernetes Job of the attempt was
 * created from it (`dispatchId` is the Job's dispatch-id annotation). Nothing is written or aborted: the Job's pod
 * may already use the manifest, slots and uploads of that record.
 *
 * @returns null when the attempt has no record or the Job belongs to another dispatch
 */
export async function adoptDispatch(
    job: JobRecord,
    deps: JobDeps,
    options: { attempt: number; dispatchId: string | null },
): Promise<AdoptedDispatch | null> {
    if (!options.dispatchId) {
        return null;
    }
    const record = await readDispatchRecord(deps.s3, job.id, options.attempt, deps.signal);
    if (!record?.dispatch_id || record.dispatch_id !== options.dispatchId || record.kind !== jobKind(job)) {
        return null;
    }
    return {
        kind: record.kind,
        attempt: record.attempt,
        dispatchId: record.dispatch_id,
        multipart: record.multipart.map((upload) => ({ key: upload.key, uploadId: upload.upload_id })),
    };
}

/** Aborts the multipart uploads of an attempt's dispatch record. Call it once no Kubernetes Job of the attempt exists. */
export async function abortDispatch(job: JobRecord, deps: JobDeps, options: { attempt: number }): Promise<void> {
    const record = await readDispatchRecord(deps.s3, job.id, options.attempt, deps.signal);
    if (record?.multipart.length) {
        await abortMultipartUploads(deps.s3, record.multipart, deps.signal);
    }
}

interface BuildContext {
    job: JobRecord;
    manifestJob: ManifestJob;
    snapshot: Snapshot;
    deps: JobDeps;
    sign: RequestSigner;
    /** Multipart uploads created while building, aborted when the dispatch fails. */
    created: MultipartUpload[];
}

async function buildManifest(kind: JobKind, context: BuildContext, bundle: ToolBundle | null): Promise<Manifest> {
    switch (kind) {
        case "tool":
            return buildToolManifest(context, bundle!);
        case "upload":
            return buildUploadManifest(context);
        case "set_metadata":
            return buildSetMetadataManifest(context);
    }
}

function baseManifest(kind: JobKind, context: BuildContext): Manifest {
    const user = context.deps.settings.user;
    return {
        protocol: PROTOCOL_VERSION,
        kind,
        job: context.manifestJob,
        outputs: [],
        job_files: { results: "" },
        user: { email: user.email, username: user.username },
        datatypes: { source: "builtin" },
    };
}

async function jobFiles(context: BuildContext, kind: JobKind): Promise<Manifest["job_files"]> {
    const keys = jobObjectKeys(context.job.id, context.manifestJob.attempt);
    const results = await context.sign.put(keys.results);
    if (kind !== "tool") {
        return { results };
    }
    const [prepare, stdout, stderr] = await Promise.all([
        context.sign.put(keys.prepare),
        context.sign.put(keys.stdout),
        context.sign.put(keys.stderr),
    ]);
    return { prepare, results, stdout, stderr };
}

async function slotTargets(context: BuildContext, count: number): Promise<NonNullable<Manifest["slots"]>> {
    return Promise.all(
        Array.from({ length: count }, () => datasetTargets(context.sign, newUuid(), { data: true, extraObjects: 0 })),
    );
}

function limitsFor(slots: number, kind: JobKind): NonNullable<Manifest["limits"]> {
    return {
        max_discovered_files: slots,
        max_metadata_value_size: MAX_METADATA_VALUE_SIZE,
        start_timeout_seconds: kind === "tool" ? DEFAULT_START_TIMEOUT_SECONDS : null,
    };
}

// ---------------------------------------------------------------------------------------------------------
// Tool, container and resources

async function loadBundle(job: JobRecord, deps: JobDeps): Promise<ToolBundle> {
    const bundle = await deps.loadToolBundle(job.tool_id, job.tool_version);
    if (!bundle || typeof bundle.id !== "string" || typeof bundle.version !== "string") {
        throw new DispatchError(`Tool ${job.tool_id} ${job.tool_version} is not installed.`, true);
    }
    return bundle;
}

async function resolveImage(bundle: ToolBundle, deps: JobDeps): Promise<{ image: string | null; shell?: string }> {
    const explicit = (bundle.containers ?? []).find((container) => container.type === "docker");
    const image = deps.resolveContainer ? await deps.resolveContainer(bundle) : (explicit?.identifier ?? null);
    if (deps.resolveContainer && !image) {
        throw new DispatchError(`No container image is known for tool ${bundle.id} ${bundle.version}.`, true);
    }
    return explicit && image === explicit.identifier && explicit.shell ? { image, shell: explicit.shell } : { image };
}

export interface JobResources {
    cpu: string;
    memory: string;
    scratch: string;
    /** `GALAXY_SLOTS` as the Job spec sets it ({@link slotsAndMemory}): the CPU request rounded up. */
    slots: number;
    /** `GALAXY_MEMORY_MB`. */
    memoryMb: number | null;
}

const QUANTITY_PATTERN = /^([0-9]+(?:\.[0-9]+)?)(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;
const QUANTITY_FACTORS: Record<string, number> = {
    "": 1,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    Pi: 2 ** 50,
    Ei: 2 ** 60,
};

/** Value of a Kubernetes quantity such as `500m`, `4Gi` or `2`. */
export function parseQuantity(text: string, setting: string): number {
    const match = QUANTITY_PATTERN.exec(text.trim());
    if (!match) {
        throw new DispatchError(`The ${setting} setting ${JSON.stringify(text)} is not a Kubernetes quantity.`, true);
    }
    return Number(match[1]) * QUANTITY_FACTORS[match[2] ?? ""]!;
}

function requirement(bundle: ToolBundle | null, type: string): number | null {
    for (const item of bundle?.resource_requirements ?? []) {
        if (item.resource_type !== type) {
            continue;
        }
        // Expressions are tool-author code; only literal values are used.
        const value =
            typeof item.value_or_expression === "string" ? Number(item.value_or_expression) : item.value_or_expression;
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return value;
        }
    }
    return null;
}

/**
 * Resources of the job's pod: the configured defaults, raised to the tool's `cores_min`, `ram_min` and
 * `tmpdir_min` resource requirements (MiB for sizes, as in Galaxy).
 */
export function jobResources(cluster: JobDeps["settings"]["cluster"], bundle: ToolBundle | null): JobResources {
    let cpu = cluster.default_cpu;
    const cores = parseQuantity(cluster.default_cpu, "default CPU");
    const coresMin = requirement(bundle, "cores_min");
    if (coresMin !== null && coresMin > cores) {
        cpu = Number.isInteger(coresMin) ? String(coresMin) : `${Math.ceil(coresMin * 1000)}m`;
    }
    let memory = cluster.default_memory;
    const memoryBytes = parseQuantity(cluster.default_memory, "default memory");
    const ramMin = requirement(bundle, "ram_min");
    if (ramMin !== null && ramMin * 2 ** 20 > memoryBytes) {
        memory = `${Math.ceil(ramMin)}Mi`;
    }
    let scratch = cluster.scratch_default;
    const tmpdirMin = requirement(bundle, "tmpdir_min");
    if (tmpdirMin !== null && tmpdirMin * 2 ** 20 > parseQuantity(cluster.scratch_default, "scratch")) {
        scratch = `${Math.ceil(tmpdirMin)}Mi`;
    }
    // The manifest's slots and memory are what the Job spec gives the tool container (GALAXY_SLOTS, GALAXY_MEMORY_MB).
    const { slots, memoryMb } = slotsAndMemory({ cpu, memory });
    return { cpu, memory, scratch, slots, memoryMb: memoryMb >= 1 ? memoryMb : null };
}

// ---------------------------------------------------------------------------------------------------------
// IndexedDB snapshot

interface Snapshot {
    job: JobRecord;
    hdas: Map<string, HdaRecord>;
    datasets: Map<string, DatasetRecord>;
    hdcas: Map<string, HdcaRecord>;
    collections: Map<string, CollectionRecord>;
    dces: Map<string, DceRecord>;
    /** Elements by collection id, in element order. */
    elements: Map<string, DceRecord[]>;
    uploads: Map<string, UploadRecord>;
}

const SNAPSHOT_STORES = ["jobs", "hdas", "datasets", "hdcas", "collections", "dces", "uploads"] as const;
const MAX_COLLECTION_DEPTH = 32;

/** Reads every record the manifest refers to, in one read transaction. */
async function loadSnapshot(job: JobRecord, kind: JobKind): Promise<Snapshot> {
    return readTx(SNAPSHOT_STORES, async (tx) => {
        const current = await tx.store("jobs").get(job.id);
        if (!current) {
            throw new DispatchError("The job no longer exists.", true);
        }
        const snapshot: Snapshot = {
            job: current,
            hdas: new Map(),
            datasets: new Map(),
            hdcas: new Map(),
            collections: new Map(),
            dces: new Map(),
            elements: new Map(),
            uploads: new Map(),
        };
        const loader = new SnapshotLoader(tx, snapshot);
        for (const association of current.outputs) {
            await loader.hda(association.id);
        }
        for (const association of current.output_collections) {
            if (association.src === "hdca") {
                await loader.hdca(association.id);
            }
        }
        if (kind === "tool") {
            for (const ref of collectRefs(current.params)) {
                await loader.ref(ref);
            }
        } else if (kind === "set_metadata") {
            for (const input of current.inputs) {
                await loader.ref({ src: input.src, id: input.id });
            }
        } else {
            for (const id of uploadIds(fetchPayload(current))) {
                const upload = await tx.store("uploads").get(id);
                if (upload) {
                    snapshot.uploads.set(id, upload);
                }
            }
        }
        return snapshot;
    });
}

class SnapshotLoader {
    constructor(
        private readonly tx: ReadTx,
        private readonly snapshot: Snapshot,
    ) {}

    async ref(ref: DataRef): Promise<void> {
        if (ref.src === "hda") {
            await this.hda(ref.id);
        } else if (ref.src === "hdca") {
            await this.hdca(ref.id);
        } else if (ref.src === "dce") {
            await this.dce(ref.id);
        } else {
            throw new DispatchError(`Inputs of type ${ref.src} are not supported.`, true);
        }
    }

    async hda(id: string): Promise<void> {
        if (this.snapshot.hdas.has(id)) {
            return;
        }
        const hda = await this.tx.store("hdas").get(id);
        if (!hda) {
            throw new DispatchError(`Dataset ${id} of the job no longer exists.`, true);
        }
        this.snapshot.hdas.set(id, hda);
        const dataset = await this.tx.store("datasets").get(hda.dataset_id);
        if (!dataset) {
            throw new DispatchError(`The dataset record of history dataset ${hda.hid} is missing.`, true);
        }
        this.snapshot.datasets.set(dataset.id, dataset);
    }

    async hdca(id: string): Promise<void> {
        if (this.snapshot.hdcas.has(id)) {
            return;
        }
        const hdca = await this.tx.store("hdcas").get(id);
        if (!hdca) {
            throw new DispatchError(`Collection ${id} of the job no longer exists.`, true);
        }
        this.snapshot.hdcas.set(id, hdca);
        await this.collection(hdca.collection_id, 0);
    }

    async dce(id: string): Promise<void> {
        if (this.snapshot.dces.has(id)) {
            return;
        }
        const dce = await this.tx.store("dces").get(id);
        if (!dce) {
            throw new DispatchError(`Collection element ${id} of the job no longer exists.`, true);
        }
        this.snapshot.dces.set(id, dce);
        await this.element(dce, 0);
    }

    private async collection(id: string, depth: number): Promise<void> {
        if (this.snapshot.collections.has(id)) {
            return;
        }
        if (depth > MAX_COLLECTION_DEPTH) {
            throw new DispatchError("Collection nesting is too deep.", true);
        }
        const collection = await this.tx.store("collections").get(id);
        if (!collection) {
            throw new DispatchError(`Collection ${id} of the job no longer exists.`, true);
        }
        this.snapshot.collections.set(id, collection);
        const elements = await this.tx
            .store("dces")
            .index("collection_index")
            .getAll(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
        this.snapshot.elements.set(id, elements);
        for (const element of elements) {
            this.snapshot.dces.set(element.id, element);
            await this.element(element, depth + 1);
        }
    }

    private async element(dce: DceRecord, depth: number): Promise<void> {
        if (dce.hda_id) {
            await this.hda(dce.hda_id);
        } else if (dce.child_collection_id) {
            await this.collection(dce.child_collection_id, depth);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Tool state and data references

interface DataRef {
    src: string;
    id: string;
}

const REF_SOURCES = new Set(["hda", "hdca", "dce", "ldda"]);
const VALUES_WRAPPER_KEYS = new Set(["values", "batch", "product"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRef(value: unknown): DataRef | null {
    if (!isRecord(value) || typeof value.src !== "string" || !REF_SOURCES.has(value.src)) {
        return null;
    }
    const id = value.id;
    return typeof id === "string" || typeof id === "number" ? { src: value.src, id: String(id) } : null;
}

/** The data references a parameter value holds, or null when it is not a data value. */
function refsOf(value: unknown): DataRef[] | null {
    const single = asRef(value);
    if (single) {
        return [single];
    }
    let items: unknown[] | null = null;
    if (Array.isArray(value) && value.length) {
        items = value;
    } else if (
        isRecord(value) &&
        Array.isArray(value.values) &&
        Object.keys(value).every((key) => VALUES_WRAPPER_KEYS.has(key))
    ) {
        items = value.values;
    }
    if (!items) {
        return null;
    }
    const refs = items.map(asRef);
    return refs.every((ref): ref is DataRef => ref !== null) ? refs : null;
}

function collectRefs(value: unknown, out: DataRef[] = []): DataRef[] {
    const refs = refsOf(value);
    if (refs) {
        out.push(...refs);
    } else if (Array.isArray(value)) {
        value.forEach((item) => collectRefs(item, out));
    } else if (isRecord(value)) {
        Object.values(value).forEach((item) => collectRefs(item, out));
    }
    return out;
}

function inputKind(input: BundleParameter): "repeat" | "section" | "conditional" | "parameter" {
    const kind = (input.model_class ?? input.type ?? "").toLowerCase();
    return kind === "repeat" || kind === "section" || kind === "conditional" ? kind : "parameter";
}

function caseIndex(conditional: BundleParameter, value: unknown): number {
    const test = conditional.test_param;
    const text =
        typeof value === "boolean" && test
            ? String(value ? (test.truevalue ?? "true") : (test.falsevalue ?? "false"))
            : String(value);
    const cases = conditional.cases ?? [];
    const index = cases.findIndex((item) => item.value === text);
    return index >= 0 || typeof value !== "boolean" ? index : cases.findIndex((item) => item.value === String(value));
}

/** Expands the flat `a|b` keys of a tool form into Galaxy's nested job state, following the bundle's inputs. */
export function expandFlatState(inputs: BundleParameter[], flat: Record<string, unknown>): Record<string, unknown> {
    const consumed = new Set<string>();
    const read = (key: string) => {
        consumed.add(key);
        return flat[key];
    };
    const fill = (definitions: BundleParameter[], prefix: string, target: Record<string, unknown>) => {
        for (const input of definitions) {
            const key = `${prefix}${input.name}`;
            const kind = inputKind(input);
            if (kind !== "parameter" && Object.hasOwn(flat, key)) {
                target[input.name] = read(key);
                continue;
            }
            if (kind === "repeat") {
                const pattern = new RegExp(`^${escapeRegExp(key)}_(\\d+)\\|`);
                const indices = [...new Set(Object.keys(flat).flatMap((name) => pattern.exec(name)?.[1] ?? []))].map(
                    Number,
                );
                target[input.name] = indices
                    .sort((a, b) => a - b)
                    .map((index, position) => {
                        const item: Record<string, unknown> = { __index__: position };
                        fill(input.inputs ?? [], `${key}_${index}|`, item);
                        return item;
                    });
            } else if (kind === "section") {
                const section: Record<string, unknown> = {};
                fill(input.inputs ?? [], `${key}|`, section);
                target[input.name] = section;
            } else if (kind === "conditional" && input.test_param) {
                const testKey = `${key}|${input.test_param.name}`;
                const group: Record<string, unknown> = {};
                if (Object.hasOwn(flat, testKey)) {
                    group[input.test_param.name] = read(testKey);
                }
                const index = caseIndex(input, group[input.test_param.name]);
                if (index >= 0) {
                    group.__current_case__ = index;
                    fill(input.cases?.[index]?.inputs ?? [], `${key}|`, group);
                }
                target[input.name] = group;
            } else if (Object.hasOwn(flat, key)) {
                target[input.name] = read(key);
            }
        }
    };
    const state: Record<string, unknown> = {};
    fill(inputs, "", state);
    for (const [key, value] of Object.entries(flat)) {
        if (!consumed.has(key) && (!key.includes("|") || isIdentifierKey(key))) {
            state[key] = value;
        }
    }
    return state;
}

/** `<input>|__identifier__`: the element identifier Galaxy stores with job parameters of mapped-over inputs. */
function isIdentifierKey(key: string): boolean {
    return key.endsWith("|__identifier__");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The job's tool state in Galaxy's nested form, without values that only make sense on a Galaxy server. */
export function toolState(job: Pick<JobRecord, "params">, bundle: Pick<ToolBundle, "inputs">): Record<string, unknown> {
    const params = job.params ?? {};
    const flat = Object.keys(params).some((key) => key.includes("|") && !isIdentifierKey(key));
    const state = flat ? expandFlatState(bundle.inputs ?? [], params) : { ...params };
    // A path on the Galaxy server; the pod computes its own.
    delete state.chromInfo;
    return state;
}

/** Turns the job's datasets and collections into manifest `inputs` and `collections`. */
class InputRegistry {
    private readonly datasets = new Map<
        string,
        { hda: HdaRecord; dataset: DatasetRecord; identifier: string | null }
    >();
    readonly collections: Record<string, ManifestCollection> = {};

    constructor(
        private readonly snapshot: Snapshot,
        private readonly requireReady: boolean,
    ) {}

    /** Converts every data reference of `value` to a manifest reference. */
    convert(value: unknown): unknown {
        const refs = refsOf(value);
        if (refs) {
            const converted = refs.map((ref) => this.reference(ref));
            return converted.length === 0 ? null : converted.length === 1 ? converted[0] : converted;
        }
        if (Array.isArray(value)) {
            return value.map((item) => this.convert(item));
        }
        if (isRecord(value)) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.convert(item)]));
        }
        return value;
    }

    reference(ref: DataRef): { src: "hda" | "hdca" | "dce"; key: string } {
        if (ref.src === "hda") {
            return { src: "hda", key: this.dataset(ref.id, null) };
        }
        if (ref.src === "hdca") {
            const hdca = this.snapshot.hdcas.get(ref.id)!;
            const collection = this.snapshot.collections.get(hdca.collection_id)!;
            this.collections[ref.id] = {
                name: hdca.name,
                id: hdca.id,
                hid: hdca.hid,
                collection_type: collection.collection_type,
                elements: this.elements(collection.id),
            };
            return { src: "hdca", key: ref.id };
        }
        const dce = this.snapshot.dces.get(ref.id)!;
        if (dce.hda_id) {
            return { src: "hda", key: this.dataset(dce.hda_id, dce.element_identifier) };
        }
        const child = this.snapshot.collections.get(dce.child_collection_id!)!;
        this.collections[ref.id] = {
            id: dce.id,
            collection_type: child.collection_type,
            element_identifier: dce.element_identifier,
            elements: this.elements(child.id),
        };
        return { src: "dce", key: ref.id };
    }

    /** Registers an HDA and returns its key in `inputs`. */
    dataset(hdaId: string, identifier: string | null): string {
        const existing = this.datasets.get(hdaId);
        if (existing) {
            existing.identifier ??= identifier;
            return hdaId;
        }
        const hda = this.snapshot.hdas.get(hdaId)!;
        const dataset = this.snapshot.datasets.get(hda.dataset_id)!;
        const state = hda._state ?? dataset.state;
        if (this.requireReady && (state !== "ok" || dataset.purged)) {
            throw new DispatchError(
                `Input dataset ${hda.hid}: ${hda.name} is not ready (${dataset.purged ? "purged" : state}).`,
                dataset.purged,
            );
        }
        this.datasets.set(hdaId, { hda, dataset, identifier });
        return hdaId;
    }

    private elements(collectionId: string): ManifestCollectionElement[] {
        return (this.snapshot.elements.get(collectionId) ?? []).map((element) => {
            const entry: ManifestCollectionElement = { element_identifier: element.element_identifier };
            if (element.hda_id) {
                entry.input = this.dataset(element.hda_id, null);
            } else if (element.child_collection_id) {
                const child = this.snapshot.collections.get(element.child_collection_id)!;
                entry.collection_type = child.collection_type;
                entry.elements = this.elements(child.id);
            }
            if (element.columns) {
                entry.columns = element.columns;
            }
            return entry;
        });
    }

    /** Total size of the registered datasets. */
    get bytes(): number {
        let total = 0;
        for (const { dataset } of this.datasets.values()) {
            total += dataset.total_size ?? dataset.file_size ?? 0;
        }
        return total;
    }

    async inputs(sign: RequestSigner): Promise<Record<string, ManifestInput>> {
        const entries = await Promise.all(
            [...this.datasets].map(async ([key, { hda, dataset, identifier }]) => {
                const metadataFiles = await Promise.all(
                    Object.entries(dataset.metadata_files).map(
                        async ([name, file]) => [name, await sign.get(file.key)] as const,
                    ),
                );
                const input: ManifestInput = {
                    uuid: dataset.uuid,
                    id: hda.id,
                    hid: hda.hid,
                    name: hda.name,
                    ext: hda.extension,
                    dbkey: hda.dbkey,
                    info: hda.info,
                    tags: hda.tags,
                    element_identifier: identifier,
                    created_from_basename: dataset.created_from_basename,
                    metadata: hda.metadata,
                    metadata_files: Object.fromEntries(metadataFiles),
                    data: await sign.get(dataset.object_key),
                };
                if (Number.isSafeInteger(dataset.file_size) && dataset.file_size! >= 0) {
                    input.size = dataset.file_size!;
                }
                if (dataset.extra_files) {
                    input.extra = await sign.get(dataset.extra_files.key);
                }
                return [key, input] as const;
            }),
        );
        return Object.fromEntries(entries);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Outputs

async function extraObjectPool(extension: string, deps: JobDeps): Promise<number> {
    try {
        const info = await deps.datatype(extension);
        const composite = Boolean(info.details?.composite_files?.length);
        return composite || info.isA("galaxy.datatypes.text.Html") ? EXTRA_OBJECT_POOL : 0;
    } catch {
        return 0;
    }
}

async function outputRecord(
    context: BuildContext,
    name: string,
    hdaId: string,
    options: { inputBytes: number; data: boolean; objectId?: string },
): Promise<ManifestOutput> {
    const hda = context.snapshot.hdas.get(hdaId)!;
    const dataset = context.snapshot.datasets.get(hda.dataset_id)!;
    let multipart: MultipartUpload | undefined;
    if (options.data && options.inputBytes > MULTIPART_INPUT_THRESHOLD) {
        multipart = await createMultipartUpload(
            context.deps.s3,
            name,
            dataset.uuid,
            options.inputBytes,
            context.deps.signal,
        );
        context.created.push(multipart);
    }
    const targets = await datasetTargets(context.sign, dataset.uuid, {
        data: options.data,
        extraObjects: await extraObjectPool(hda.extension, context.deps),
        multipart,
    });
    return {
        name,
        id: hda.id,
        hid: hda.hid,
        ...(options.objectId !== undefined ? { object_id: options.objectId } : {}),
        ext: hda.extension,
        dbkey: hda.dbkey,
        visible: hda.visible,
        ...targets,
    };
}

function bundleOutputs(bundle: ToolBundle): BundleOutput[] {
    const outputs = bundle.outputs ?? [];
    return Array.isArray(outputs) ? outputs : Object.values(outputs);
}

/** Template variables of a static collection's datasets (`ToolEvaluator` binds each to its element). */
function staticElementParams(bundle: ToolBundle, collectionName: string): Map<string, string> {
    const params = new Map<string, string>();
    const definition = bundleOutputs(bundle).find((output) => output.name === collectionName);
    const elements = definition?.outputs;
    if (Array.isArray(elements)) {
        elements.forEach((element) => params.set(element.name, element.name));
    } else if (elements) {
        Object.entries(elements).forEach(([identifier, element]) => params.set(identifier, element.name));
    }
    return params;
}

function outputCollections(context: BuildContext, bundle: ToolBundle): Record<string, ManifestOutputCollection> {
    const { job, snapshot } = context;
    const outputNames = new Map(job.outputs.map((output) => [output.id, output.name]));
    const result: Record<string, ManifestOutputCollection> = {};
    for (const association of job.output_collections) {
        if (association.src !== "hdca") {
            continue;
        }
        const hdca = snapshot.hdcas.get(association.id)!;
        const collection = snapshot.collections.get(hdca.collection_id)!;
        const params = staticElementParams(bundle, association.name);
        const elements = (snapshot.elements.get(collection.id) ?? []).flatMap((element) => {
            const output = element.hda_id ? outputNames.get(element.hda_id) : undefined;
            if (!output) {
                return [];
            }
            const paramName = params.get(element.element_identifier);
            return [
                {
                    element_identifier: element.element_identifier,
                    output,
                    ...(paramName ? { param_name: paramName } : {}),
                },
            ];
        });
        result[association.name] = {
            name: hdca.name,
            id: hdca.id,
            hid: hdca.hid,
            collection_type: collection.collection_type,
            elements,
        };
    }
    return result;
}

// ---------------------------------------------------------------------------------------------------------
// Kinds

async function buildToolManifest(context: BuildContext, bundle: ToolBundle): Promise<Manifest> {
    const { job, deps, sign } = context;
    const registry = new InputRegistry(context.snapshot, true);
    const params = registry.convert(toolState(job, bundle)) as Record<string, unknown>;
    const archive = await ensureToolArchive(deps, bundle);
    const inputBytes = registry.bytes;
    const outputs: ManifestOutput[] = [];
    for (const association of job.outputs) {
        outputs.push(await outputRecord(context, association.name, association.id, { inputBytes, data: true }));
    }
    const [inputs, slots, files] = await Promise.all([
        registry.inputs(sign),
        slotTargets(context, DEFAULT_SLOT_COUNT),
        jobFiles(context, "tool"),
    ]);
    const tool: NonNullable<Manifest["tool"]> = { ...bundle };
    if (archive) {
        tool.archive = { request: await sign.get(archive.key), sha256: archive.sha256 };
    }
    return {
        ...baseManifest("tool", context),
        tool,
        params,
        inputs,
        collections: registry.collections,
        outputs,
        output_collections: outputCollections(context, bundle),
        slots,
        job_files: files,
        limits: limitsFor(slots.length, "tool"),
    };
}

async function buildSetMetadataManifest(context: BuildContext): Promise<Manifest> {
    const { job, snapshot, sign } = context;
    const registry = new InputRegistry(snapshot, false);
    const params = job.params ?? {};
    const ext = typeof params.ext === "string" && params.ext ? params.ext : null;
    const outputs: ManifestOutput[] = [];
    const datasets: NonNullable<Manifest["set_metadata"]>["datasets"] = [];
    for (const association of job.inputs) {
        if (association.src !== "hda") {
            throw new DispatchError("Metadata can only be set on datasets.", true);
        }
        const key = registry.dataset(association.id, null);
        const hda = snapshot.hdas.get(association.id)!;
        const dataset = snapshot.datasets.get(hda.dataset_id)!;
        const targets = await datasetTargets(sign, dataset.uuid, {
            data: false,
            extraObjects: dataset.extra_files ? await extraObjectPool(ext ?? hda.extension, context.deps) : 0,
        });
        if (!dataset.extra_files) {
            delete targets.extra;
            delete targets.extra_index;
        }
        outputs.push({ name: association.name, id: hda.id, hid: hda.hid, ...targets });
        datasets.push({
            input: key,
            output: association.name,
            ext,
            detect: params.detect === true || params.detect === "true",
            overwrite: params.overwrite === true || params.overwrite === "true",
        });
    }
    if (!datasets.length) {
        throw new DispatchError("The metadata job names no dataset.", true);
    }
    return {
        ...baseManifest("set_metadata", context),
        inputs: await registry.inputs(sign),
        outputs,
        job_files: await jobFiles(context, "set_metadata"),
        set_metadata: { datasets },
        limits: limitsFor(0, "set_metadata"),
    };
}

// Uploads ---------------------------------------------------------------------------------------------------

const FILE_DATA_KEY = /^files_(\d+)\|file_data$/;
/** `galaxy.util.hash_util.HASH_NAME_MAP` keys accepted as item properties (`replace_request_syntax_sugar`). */
const HASH_NAMES = ["MD5", "SHA-1", "SHA-256", "SHA-512"];
const URL_PREFIXES = ["http://", "https://", "ftp://", "ftps://"];

/** The fetch payload of an upload job. */
function fetchPayload(job: JobRecord): Record<string, unknown> {
    if (isRecord(job.request) && Array.isArray(job.request.targets)) {
        return job.request;
    }
    throw new DispatchError("The upload job has no fetch request.", true);
}

/** Upload session ids in `files_<n>|file_data` order. */
function fileSessions(payload: Record<string, unknown>): { sessionId: string; name: string | null }[] {
    return Object.entries(payload)
        .flatMap(([key, value]) => {
            const match = FILE_DATA_KEY.exec(key);
            if (!match || !isRecord(value) || typeof value.session_id !== "string") {
                return [];
            }
            const name = typeof value.name === "string" ? value.name : null;
            return [{ index: Number(match[1]), sessionId: value.session_id, name }];
        })
        .sort((a, b) => a.index - b.index)
        .map(({ sessionId, name }) => ({ sessionId, name }));
}

function uploadIds(payload: Record<string, unknown>): string[] {
    const ids = fileSessions(payload).map((file) => file.sessionId);
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
        } else if (isRecord(value)) {
            if (value.src === "planet" && typeof value.file === "string") {
                ids.push(value.file);
            }
            Object.values(value).forEach(visit);
        }
    };
    visit(payload.targets);
    return [...new Set(ids)];
}

/** Galaxy's `replace_request_syntax_sugar`: `items`/`items_from` and hash properties. */
function replaceSyntaxSugar(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach(replaceSyntaxSugar);
        return;
    }
    if (!isRecord(value)) {
        return;
    }
    if ("items" in value) {
        value.elements = value.items;
        delete value.items;
    }
    if ("items_from" in value) {
        value.elements_from = value.items_from;
        delete value.items_from;
    }
    Object.values(value).forEach(replaceSyntaxSugar);
    if ("src" in value || "filename" in value) {
        const hashes: { hash_function: string; hash_value: unknown }[] = [];
        for (const name of HASH_NAMES) {
            for (const key of [name, name.toLowerCase()]) {
                if (key in value && value[key] !== null && value[key] !== undefined) {
                    hashes.push({ hash_function: name, hash_value: value[key] });
                    delete value[key];
                }
            }
        }
        const existing = Array.isArray(value.hashes) ? value.hashes : [];
        value.hashes = [...existing, ...hashes];
    }
}

interface RewrittenUpload {
    request: Record<string, unknown>;
    /** Upload sessions the request refers to. */
    uploads: UploadRecord[];
    /** Bytes uploaded for each `hdas` element, by the id of its dataset (URLs and pasted text count as 0). */
    outputBytes: Map<string, number>;
}

/** Size of the uploaded files an element refers to, its composite parts included. */
function uploadedBytes(value: unknown, used: ReadonlyMap<string, UploadRecord>): number {
    if (Array.isArray(value)) {
        return value.reduce((sum: number, item) => sum + uploadedBytes(item, used), 0);
    }
    if (!isRecord(value)) {
        return 0;
    }
    const own = value.src === "planet" ? (used.get(String(value.file))?.size ?? 0) : 0;
    return Object.values(value).reduce((sum: number, item) => sum + uploadedBytes(item, used), own);
}

/**
 * Rewrites a fetch payload for the pod as Galaxy rewrites it before running `data_fetch.py`: uploaded files become
 * `{"src": "planet", "file": <upload id>}`, items get Galaxy's internal fields, `hdas` elements get the `object_id`
 * of the dataset created for them, and server-side sources are refused.
 */
function rewriteFetchRequest(context: BuildContext, outputIds: string[]): RewrittenUpload {
    const payload = fetchPayload(context.job);
    const request: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(structuredClone(payload))) {
        if (key !== "history_id" && key !== "key" && !key.startsWith("files_") && !key.startsWith("__files_")) {
            request[key] = value;
        }
    }
    request.check_content = true;
    replaceSyntaxSugar(request.targets);

    const sessions = fileSessions(payload);
    let nextFile = 0;
    const used = new Map<string, UploadRecord>();
    const upload = (id: string): UploadRecord => {
        const record = context.snapshot.uploads.get(id);
        if (!record) {
            throw new DispatchError(`Upload ${id} no longer exists.`, true);
        }
        if (record.state !== "uploaded") {
            const failed = record.state === "failed" || record.state === "aborted";
            throw new DispatchError(`Upload of ${record.name} is ${failed ? record.state : "not complete"}.`, failed);
        }
        used.set(id, record);
        return record;
    };
    const visit = (value: unknown) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!isRecord(value)) {
            return;
        }
        if ("src" in value) {
            rewriteItem(value);
        }
        Object.values(value).forEach(visit);
    };
    const rewriteItem = (item: Record<string, unknown>) => {
        switch (item.src) {
            case "files": {
                const file = sessions[nextFile++];
                if (!file) {
                    throw new DispatchError("Failed to find uploaded file matching target with src='files'", true);
                }
                const record = upload(file.sessionId);
                item.src = "planet";
                item.file = record.id;
                if (!("name" in item)) {
                    item.name = file.name ?? record.name;
                }
                item.in_place = false;
                item.purge_source = true;
                break;
            }
            case "planet":
                upload(String(item.file));
                item.in_place = false;
                item.purge_source = true;
                break;
            case "pasted":
                if (typeof item.paste_content !== "string") {
                    throw new DispatchError("src of type 'pasted' requires paste_content field", true);
                }
                break;
            case "url": {
                const url = typeof item.url === "string" ? item.url : "";
                if (!URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
                    throw new DispatchError(`Invalid URL [${url}] found in src definition.`, true);
                }
                item.in_place = false;
                break;
            }
            case "composite":
                break;
            default:
                throw new DispatchError(`Uploads from src '${String(item.src)}' are not supported.`, true);
        }
        if (!("purge_source" in item)) {
            item.purge_source = false;
        }
    };
    const targets = request.targets as unknown[];
    visit(targets);

    // Datasets precreated for `hdas` targets, matched to elements as `_precreate_fetched_hdas` does.
    const outputBytes = new Map<string, number>();
    let nextOutput = 0;
    for (const target of targets) {
        if (!isRecord(target) || !isRecord(target.destination)) {
            throw new DispatchError("Each target must specify a 'destination'", true);
        }
        if (target.destination.type === "hdca") {
            // The pod creates the collection's elements in slots; the browser fills the existing collection.
            delete target.destination.object_id;
        } else if (target.destination.type === "hdas" && !target.elements_from) {
            for (const element of Array.isArray(target.elements) ? target.elements : []) {
                if (!isRecord(element)) {
                    continue;
                }
                if (element.object_id !== undefined && element.object_id !== null) {
                    const objectId = String(element.object_id);
                    if (!outputIds.includes(objectId)) {
                        throw new DispatchError(`Upload element refers to unknown dataset ${objectId}.`, true);
                    }
                    element.object_id = objectId;
                } else {
                    const id = outputIds[nextOutput];
                    if (!id) {
                        throw new DispatchError("The upload has more elements than datasets.", true);
                    }
                    element.object_id = id;
                }
                const objectId = String(element.object_id);
                outputBytes.set(objectId, (outputBytes.get(objectId) ?? 0) + uploadedBytes(element, used));
                nextOutput++;
            }
        } else if (target.destination.type !== "hdas") {
            throw new DispatchError(`Uploads to ${String(target.destination.type)} are not supported.`, true);
        }
    }

    return { request, uploads: [...used.values()], outputBytes };
}

/** Datasets an upload discovers: collection elements and expanded archives or directories. */
function uploadSlotCount(targets: unknown[]): number {
    let count = 0;
    let dynamic = false;
    const leaves = (value: unknown): number => {
        if (Array.isArray(value)) {
            return value.reduce((sum: number, item) => sum + leaves(item), 0);
        }
        if (!isRecord(value)) {
            return 0;
        }
        if (value.elements_from) {
            dynamic = true;
        }
        return Array.isArray(value.elements) ? leaves(value.elements) : "src" in value ? 1 : 0;
    };
    for (const target of targets) {
        if (!isRecord(target) || !isRecord(target.destination)) {
            continue;
        }
        if (target.destination.type === "hdca") {
            count += leaves(target.elements ?? []);
            dynamic ||= Boolean(target.elements_from);
        } else if (target.elements_from) {
            dynamic = true;
        }
    }
    return count + (dynamic ? DEFAULT_SLOT_COUNT : 0);
}

async function buildUploadManifest(context: BuildContext): Promise<Manifest> {
    const { job, sign } = context;
    const outputIds = job.outputs.map((output) => output.id);
    const rewritten = rewriteFetchRequest(context, outputIds);
    const outputs: ManifestOutput[] = [];
    for (const association of job.outputs) {
        outputs.push(
            await outputRecord(context, association.name, association.id, {
                // Each output holds one upload: its own size decides whether it needs a multipart upload.
                inputBytes: rewritten.outputBytes.get(association.id) ?? 0,
                data: true,
                objectId: association.id,
            }),
        );
    }
    const files: NonNullable<Manifest["upload"]>["files"] = {};
    for (const upload of rewritten.uploads) {
        files[upload.id] = { request: await sign.get(upload.key), size: upload.size };
    }
    const slots = await slotTargets(context, uploadSlotCount(rewritten.request.targets as unknown[]));
    return {
        ...baseManifest("upload", context),
        upload: { request: rewritten.request, files },
        outputs,
        slots,
        job_files: await jobFiles(context, "upload"),
        limits: limitsFor(slots.length, "upload"),
    };
}
