/**
 * Records stored in the `planet` IndexedDB database. Field names follow Galaxy's model
 * (`lib/galaxy/model/__init__.py`). Ids are 16-hex strings from `newId()`; timestamps are Galaxy
 * timestamps (`util/time.ts`); object keys are S3 keys relative to the configured prefix.
 */

import type { DatasetState, JobState, PopulatedState, ValidatedState } from "@/planet/util/states";

export type { DatasetState, JobState, PopulatedState, ValidatedState };

/** Public Planet settings (`GET/PUT /api/planet/settings`). Secrets are write-only. */
export interface PlanetSettings {
    instance_id: string;
    cluster: {
        gateway_url: string;
        namespace: string;
        /** Write-only: set on update, never returned. */
        token?: string;
        has_token: boolean;
        runtime_image: string;
        job_service_account: string;
        default_cpu: string;
        default_memory: string;
        default_walltime_seconds: number;
        scratch_default: string;
        arch_policy: "amd64-only" | "any";
        user_namespaces: boolean;
    };
    storage: {
        endpoint: string;
        cluster_endpoint: string;
        bucket: string;
        prefix: string;
        region: string;
        path_style: boolean;
        access_key_id: string;
        /** Write-only: set on update, never returned. */
        secret_access_key?: string;
        has_secret: boolean;
    };
    user: { email: string; username: string };
}

/** Settings as stored: {@link PlanetSettings} without secrets or derived flags. */
export interface StoredSettings {
    instance_id: string;
    cluster: Omit<PlanetSettings["cluster"], "token" | "has_token">;
    storage: Omit<PlanetSettings["storage"], "secret_access_key" | "has_secret">;
    user: PlanetSettings["user"];
}

/** Credentials, kept in their own store and never returned by the API. */
export interface PlanetSecrets {
    cluster_token: string | null;
    storage_secret_access_key: string | null;
}

export interface HistoryRecord {
    id: string;
    name: string;
    create_time: string;
    /** Latest change to the history or any of its items. */
    update_time: string;
    deleted: boolean;
    purged: boolean;
    archived: boolean;
    published: boolean;
    importable: boolean;
    slug: string | null;
    genome_build: string | null;
    annotation: string | null;
    tags: string[];
    /** The next hid to allocate (Galaxy's `History.hid_counter`, starts at 1). */
    hid_counter: number;
    preferred_object_store_id: string | null;
}

export interface DatasetSourceRecord {
    source_uri: string;
    transform: unknown[] | null;
    extra_files_path: string | null;
    hashes: DatasetHashRecord[];
}

export interface DatasetHashRecord {
    hash_function: string;
    hash_value: string;
    extra_files_path: string | null;
}

export interface MetadataFileRecord {
    key: string;
    file_size: number | null;
}

/** Galaxy's `Dataset`: the bytes and their state, shared by every HDA copy. */
export interface DatasetRecord {
    id: string;
    uuid: string;
    state: DatasetState;
    create_time: string;
    update_time: string;
    deleted: boolean;
    purged: boolean;
    file_size: number | null;
    /** `file_size` plus extra files. */
    total_size: number | null;
    /** Key of the primary file (`datasets/<uuid>/data`). */
    object_key: string;
    /** Key of the metadata sidecar written by the cluster (`datasets/<uuid>/meta.json`). */
    meta_key: string;
    /** Composite extra files: one tar plus a JSON index of its members. */
    extra_files: { key: string; index_key: string } | null;
    /** Metadata files by metadata element name (`datasets/<uuid>/meta/<name>`). */
    metadata_files: Record<string, MetadataFileRecord>;
    created_from_basename: string | null;
    sources: DatasetSourceRecord[];
    hashes: DatasetHashRecord[];
    /** The job that created the dataset. */
    job_id: string | null;
}

/** Galaxy's `HistoryDatasetAssociation`: a dataset placed in a history. */
export interface HdaRecord {
    id: string;
    history_id: string;
    hid: number;
    dataset_id: string;
    name: string;
    extension: string;
    dbkey: string;
    info: string | null;
    blurb: string | null;
    peek: string | null;
    /** Galaxy metadata in its JSON form (`MetadataCollection.to_JSON_dict()`). */
    metadata: Record<string, unknown>;
    visible: boolean;
    deleted: boolean;
    purged: boolean;
    /** Per-copy state override; only `setting_metadata` and `failed_metadata` are used. */
    _state: "setting_metadata" | "failed_metadata" | null;
    tags: string[];
    annotation: string | null;
    create_time: string;
    update_time: string;
    copied_from: { src: "hda" | "ldda"; id: string } | null;
    creating_job_id: string | null;
    validated_state: ValidatedState;
    validated_state_message: string | null;
}

/** Galaxy's `DatasetCollection`. */
export interface CollectionRecord {
    id: string;
    collection_type: string;
    populated_state: PopulatedState;
    populated_state_message: string | null;
    element_count: number | null;
    create_time: string;
    update_time: string;
    /** Record collection field definitions. */
    fields: unknown[] | null;
    /** Sample sheet column definitions. */
    column_definitions: unknown[] | null;
}

/** Galaxy's `HistoryDatasetCollectionAssociation`. */
export interface HdcaRecord {
    id: string;
    history_id: string;
    hid: number;
    collection_id: string;
    name: string;
    visible: boolean;
    deleted: boolean;
    tags: string[];
    annotation: string | null;
    create_time: string;
    update_time: string;
    implicit_output_name: string | null;
    /** `Job` id, or the id shared by the jobs of a map-over (`ImplicitCollectionJobs`). */
    job_source_id: string | null;
    job_source_type: "Job" | "ImplicitCollectionJobs" | null;
    copied_from_hdca_id: string | null;
}

/** Galaxy's `DatasetCollectionElement`. */
export interface DceRecord {
    id: string;
    /** The collection that contains this element. */
    collection_id: string;
    element_index: number;
    element_identifier: string;
    element_type: "hda" | "dataset_collection";
    hda_id: string | null;
    child_collection_id: string | null;
    /** Sample sheet row values. */
    columns: unknown[] | null;
}

export interface JobInputAssociation {
    name: string;
    src: "hda" | "hdca" | "dce";
    id: string;
}

export interface JobOutputAssociation {
    name: string;
    src: "hda";
    id: string;
}

export interface JobOutputCollectionAssociation {
    name: string;
    /** `hdca` for explicit collection outputs, `dataset_collection` for implicit ones. */
    src: "hdca" | "dataset_collection";
    id: string;
}

export interface JobMetricRecord {
    plugin: string;
    name: string;
    title: string;
    value: string;
    raw_value: string;
}

/** How a container of the job's pod ended, as Kubernetes reported it (`containerStatuses[].state.terminated`). */
export interface ContainerTermination {
    /** `OOMKilled`, `Error`, `Completed`, `StartError`, ... */
    reason: string | null;
    exit_code: number | null;
    message: string | null;
}

/** A multipart upload the browser created for one of the job's outputs. */
export interface JobMultipartUpload {
    key: string;
    upload_id: string;
}

/** Kubernetes bookkeeping for a dispatched job. */
export interface JobKubernetesInfo {
    namespace: string;
    /** Kubernetes Job name (`planet-<instance>-<job>-a<attempt>`). */
    name: string;
    uid: string | null;
    attempt: number;
    spec_hash: string | null;
    pod_name: string | null;
    node_name: string | null;
    /** The tool container's image; null for upload and set-metadata jobs. */
    image: string | null;
    /** Pod layout: a tool pod (stage-in, tool, stage-out) or one stager container. */
    kind: "tool" | "upload" | "set_metadata" | "tool_install";
    /** `metadata.creationTimestamp` of the Kubernetes Job. */
    created: string | null;
    /** Whether the decisions in `prepare.json` were applied to the job's outputs. */
    prepared: boolean;
    /** How the tool container ended, recorded before results are ingested (`OOMKilled` marks a memory kill). */
    tool_termination: ContainerTermination | null;
    /** Multipart uploads created at dispatch, completed at ingest and aborted on failure or cancel. */
    multipart: JobMultipartUpload[];
    /** Stage-in runs of earlier attempts that failed before `prepare.json`; absent in older records. */
    stage_in_retries?: number;
}

/** Galaxy's `Job`. */
export interface JobRecord {
    id: string;
    history_id: string | null;
    tool_id: string;
    tool_version: string;
    tool_uuid: string | null;
    state: JobState;
    info: string | null;
    create_time: string;
    update_time: string;
    /**
     * Tool state in Galaxy's basic form, keyed by top-level input name: conditionals carry `__current_case__`,
     * repeats `__index__`, data values are `{src, id}` (lists for multiple inputs, null when empty); `dbkey` and
     * `__input_ext` are included. Upload jobs keep the fetch request in `request` instead.
     */
    params: Record<string, unknown>;
    /** The original submit payload, kept for rerun. */
    request: unknown;
    inputs: JobInputAssociation[];
    outputs: JobOutputAssociation[];
    output_collections: JobOutputCollectionAssociation[];
    command_line: string | null;
    command_version: string | null;
    exit_code: number | null;
    job_stdout: string | null;
    job_stderr: string | null;
    tool_stdout: string | null;
    tool_stderr: string | null;
    job_messages: unknown[];
    dependencies: unknown[];
    metrics: JobMetricRecord[];
    copied_from_job_id: string | null;
    implicit_collection_jobs_id: string | null;
    k8s: JobKubernetesInfo | null;
    /** Every state the job entered, oldest first. */
    state_history: { state: JobState; time: string }[];
}

/** Kinds of outbox entries the leader tab processes. */
export type OutboxKind = "dispatch" | "cancel" | "cleanup" | "purge";

/** Payload of a `dispatch` entry; `attempt` requests a new attempt of an already dispatched job. */
export interface DispatchPayload {
    attempt?: number;
    /** Stage-in runs that failed before `prepare.json` in earlier attempts. */
    stage_in_retries?: number;
    /** Kubernetes Jobs of earlier attempts to delete before this attempt is prepared. */
    replace?: string[];
}

/** Payload of a `cleanup` entry: Kubernetes Jobs to delete and multipart uploads to abort. */
export interface CleanupPayload {
    k8s_jobs?: string[];
    multipart?: JobMultipartUpload[];
}

/** Payload of a `purge` entry: datasets whose bucket objects are deleted. */
export interface PurgePayload {
    dataset_ids?: string[];
    uuids?: string[];
}

/** Work for the leader tab (dispatch, cancel, cleanup, purge). */
export interface OutboxRecord {
    id: string;
    /** An {@link OutboxKind}. */
    kind: string;
    job_id: string | null;
    payload: unknown;
    create_time: string;
    /** Do not process before this time. */
    not_before: string;
    attempts: number;
    last_error: string | null;
}

/** An installed or curated tool version. */
export interface ToolRecord {
    tool_id: string;
    tool_version: string;
    source: "curated" | "installed";
    status: "ready" | "installing" | "failed";
    message: string | null;
    /** Planet tool bundle, or null when it is fetched from `bundle_url`. */
    bundle: unknown;
    bundle_url: string | null;
    panel_section_id: string | null;
    panel_section_name: string | null;
    hidden: boolean;
    create_time: string;
    update_time: string;
}

/** A tool panel view (`/api/tool_panels/{view}` payload). */
export interface ToolPanelRecord {
    view_id: string;
    panel: unknown;
    update_time: string;
}

export interface UploadPartRecord {
    part_number: number;
    etag: string;
    size: number;
}

/** A page-to-S3 multipart upload; `id` is the session id passed to `/api/tools/fetch`. */
export interface UploadRecord {
    id: string;
    history_id: string | null;
    name: string;
    size: number;
    content_type: string | null;
    /** Key of the uploaded object (`uploads/<id>`). */
    key: string;
    upload_id: string | null;
    part_size: number;
    parts: UploadPartRecord[];
    state: "pending" | "uploading" | "uploaded" | "failed" | "aborted";
    message: string | null;
    /** Identifies the source file for resuming (name, size, lastModified). */
    fingerprint: string | null;
    create_time: string;
    update_time: string;
}

/** The job leader's heartbeat (`kv` key `leader`). */
export interface LeaderRecord {
    epoch: number;
    /** Random id of the leading tab. */
    tab_id: string;
    /** Last heartbeat, in milliseconds since the epoch. */
    heartbeat: number;
    /** Whether the leading tab's document was visible at the last heartbeat. */
    visible: boolean;
    /** The leading tab's leader protocol version (`LEADER_PROTOCOL` of `jobs/leader.ts`); absent before versions. */
    protocol?: number;
}

/**
 * What the leading tab reports about job processing (`kv` key `leader_status`), for status pages. Written by the
 * leader with each heartbeat and when its state or last error changes, and only while its epoch is current.
 */
export interface LeaderStatusRecord {
    epoch: number;
    /** Random id of the leading tab. */
    tab_id: string;
    /** When the leader last wrote this record, in milliseconds since the epoch. */
    heartbeat: number;
    /**
     * `blocked`: jobs cannot be processed (settings incomplete, cluster unreachable), see `blocked_reason`;
     * `active`: jobs are queued or running or work is pending in the outbox; `idle`: nothing to do.
     */
    state: "idle" | "active" | "blocked";
    blocked_reason: string | null;
    /** The last error job processing ran into; `time` in milliseconds since the epoch. */
    last_error: { message: string; job_id: string | null; time: number } | null;
    counts: { queued: number; running: number };
}

/** A resolved tool container, cached by its requirements (`kv` keys `container:<requirements>`). */
export interface ContainerCacheEntry {
    image: string;
    /** When it was resolved, in milliseconds since the epoch. */
    resolved: number;
}

/** Typed values of the `kv` store. */
export interface KvValues {
    /** Last timestamp issued by a write transaction, in microseconds since the epoch. */
    clock: number;
    current_history_id: string;
    /** Incremented by each tab that becomes job leader. */
    leader_epoch: number;
    /** The newest leader protocol version a tab led with; tabs of older versions no longer lead. */
    leader_protocol: number;
    leader: LeaderRecord;
    leader_status: LeaderStatusRecord;
    /** The user's preferences (Galaxy's `User.preferences`): string values, JSON-encoded where Galaxy encodes them. */
    preferences: Record<string, string>;
    [counter: `counter:${string}`]: number;
    /** When a client last read the job's live console output, in milliseconds since the epoch. */
    [console: `console:${string}`]: number;
    [container: `container:${string}`]: ContainerCacheEntry;
}

export type KvKey = keyof KvValues & string;
