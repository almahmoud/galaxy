/** Builders that fill Galaxy's defaults into new records. They do not touch the database. */

import { newId, newUuid } from "@/planet/util/ids";

import type {
    CollectionRecord,
    DatasetRecord,
    DceRecord,
    HdaRecord,
    HdcaRecord,
    HistoryRecord,
    JobRecord,
    OutboxRecord,
    StoredSettings,
    UploadRecord,
} from "./types";

/** Galaxy's default history name. */
export const DEFAULT_HISTORY_NAME = "Unnamed history";

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type NewHistory = Partial<Omit<HistoryRecord, "create_time" | "update_time">>;
export type NewDataset = Partial<Omit<DatasetRecord, "create_time" | "update_time">>;
export type NewHda = Optional<
    Omit<HdaRecord, "create_time" | "update_time">,
    Exclude<keyof HdaRecord, "history_id" | "dataset_id" | "name" | "create_time" | "update_time">
>;
export type NewCollection = Optional<
    Omit<CollectionRecord, "create_time" | "update_time">,
    Exclude<keyof CollectionRecord, "collection_type" | "create_time" | "update_time">
>;
export type NewHdca = Optional<
    Omit<HdcaRecord, "create_time" | "update_time">,
    Exclude<keyof HdcaRecord, "history_id" | "collection_id" | "name" | "create_time" | "update_time">
>;
export type NewDce = Optional<
    DceRecord,
    Exclude<keyof DceRecord, "collection_id" | "element_index" | "element_identifier">
>;
export type NewJob = Optional<
    Omit<JobRecord, "create_time" | "update_time" | "state_history">,
    Exclude<keyof JobRecord, "tool_id" | "tool_version" | "create_time" | "update_time" | "state_history">
>;
export type NewOutboxEntry = Optional<
    Omit<OutboxRecord, "create_time">,
    Exclude<keyof OutboxRecord, "kind" | "create_time">
>;
export type NewUpload = Optional<
    Omit<UploadRecord, "create_time" | "update_time">,
    Exclude<keyof UploadRecord, "name" | "size" | "part_size" | "create_time" | "update_time">
>;

/** Returns `input` without properties whose value is `undefined`, so they do not override defaults. */
function defined<T extends object>(input: T): T {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

/** S3 keys of a dataset's objects, relative to the configured prefix. */
export function datasetKeys(uuid: string): { object_key: string; meta_key: string } {
    return { object_key: `datasets/${uuid}/data`, meta_key: `datasets/${uuid}/meta.json` };
}

export function buildHistory(input: NewHistory, now: string): HistoryRecord {
    return {
        id: newId(),
        name: DEFAULT_HISTORY_NAME,
        deleted: false,
        purged: false,
        archived: false,
        published: false,
        importable: false,
        slug: null,
        genome_build: null,
        annotation: null,
        tags: [],
        hid_counter: 1,
        preferred_object_store_id: null,
        ...defined(input),
        create_time: now,
        update_time: now,
    };
}

export function buildDataset(input: NewDataset, now: string): DatasetRecord {
    const uuid = input.uuid ?? newUuid();
    return {
        id: newId(),
        state: "new",
        deleted: false,
        purged: false,
        file_size: null,
        total_size: null,
        extra_files: null,
        metadata_files: {},
        created_from_basename: null,
        sources: [],
        hashes: [],
        job_id: null,
        ...datasetKeys(uuid),
        ...defined(input),
        uuid,
        create_time: now,
        update_time: now,
    };
}

/** Builds an HDA. `hid` defaults to 0; repository inserts allocate it from the history. */
export function buildHda(input: NewHda, now: string): HdaRecord {
    return {
        id: newId(),
        hid: 0,
        extension: "data",
        dbkey: "?",
        info: null,
        blurb: null,
        peek: null,
        metadata: {},
        visible: true,
        deleted: false,
        purged: false,
        _state: null,
        tags: [],
        annotation: null,
        copied_from: null,
        creating_job_id: null,
        validated_state: "unknown",
        validated_state_message: null,
        ...defined(input),
        create_time: now,
        update_time: now,
    };
}

export function buildCollection(input: NewCollection, now: string): CollectionRecord {
    return {
        id: newId(),
        populated_state: "new",
        populated_state_message: null,
        element_count: null,
        fields: null,
        column_definitions: null,
        ...defined(input),
        create_time: now,
        update_time: now,
    };
}

/** Builds an HDCA. `hid` defaults to 0; repository inserts allocate it from the history. */
export function buildHdca(input: NewHdca, now: string): HdcaRecord {
    return {
        id: newId(),
        hid: 0,
        visible: true,
        deleted: false,
        tags: [],
        annotation: null,
        implicit_output_name: null,
        job_source_id: null,
        job_source_type: null,
        copied_from_hdca_id: null,
        ...defined(input),
        create_time: now,
        update_time: now,
    };
}

export function buildDce(input: NewDce): DceRecord {
    return {
        id: newId(),
        element_type: "hda",
        hda_id: null,
        child_collection_id: null,
        columns: null,
        ...defined(input),
    };
}

export function buildJob(input: NewJob, now: string): JobRecord {
    const state = input.state ?? "new";
    return {
        id: newId(),
        history_id: null,
        tool_uuid: null,
        info: null,
        params: {},
        request: null,
        inputs: [],
        outputs: [],
        output_collections: [],
        command_line: null,
        command_version: null,
        exit_code: null,
        job_stdout: null,
        job_stderr: null,
        tool_stdout: null,
        tool_stderr: null,
        job_messages: [],
        dependencies: [],
        metrics: [],
        copied_from_job_id: null,
        implicit_collection_jobs_id: null,
        k8s: null,
        ...defined(input),
        state,
        create_time: now,
        update_time: now,
        state_history: [{ state, time: now }],
    };
}

export function buildOutboxEntry(input: NewOutboxEntry, now: string): OutboxRecord {
    return {
        id: newId(),
        job_id: null,
        payload: null,
        not_before: now,
        attempts: 0,
        last_error: null,
        ...defined(input),
        create_time: now,
    };
}

export function buildUpload(input: NewUpload, now: string): UploadRecord {
    const id = input.id ?? newId();
    return {
        history_id: null,
        content_type: null,
        key: `uploads/${id}`,
        upload_id: null,
        parts: [],
        state: "pending",
        message: null,
        fingerprint: null,
        ...defined(input),
        id,
        create_time: now,
        update_time: now,
    };
}

/** Settings written on first run. */
export function defaultSettings(instanceId: string): StoredSettings {
    return {
        instance_id: instanceId,
        cluster: {
            gateway_url: "",
            namespace: "planet",
            runtime_image: "",
            job_service_account: "planet-job",
            default_cpu: "1",
            default_memory: "4Gi",
            default_walltime_seconds: 86400,
            scratch_default: "20Gi",
            arch_policy: "amd64-only",
            user_namespaces: false,
        },
        storage: {
            endpoint: "",
            cluster_endpoint: "",
            bucket: "",
            prefix: "planet",
            region: "auto",
            path_style: true,
            access_key_id: "",
        },
        user: { email: "planet@localhost", username: "planet" },
    };
}
