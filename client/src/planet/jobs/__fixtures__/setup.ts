/** Shared setup of the job protocol tests: an in-memory database, an in-memory bucket and record builders. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

import type { DatatypeInfo } from "@/planet/api/datatypes";
import {
    closeDb,
    collections,
    type DatasetRecord,
    type HdaRecord,
    hdas,
    type HdcaRecord,
    histories,
    type JobRecord,
    jobs,
    type PlanetSettings,
    type UploadRecord,
    uploads,
} from "@/planet/db";
import type { NewHda } from "@/planet/db/hdas";
import type { NewJob } from "@/planet/db/jobs";
import type { NewDataset, NewUpload } from "@/planet/db/records";
import { sha256Hex } from "@/planet/util/digest";

import type { JobDeps } from "../deps";
import type { DispatchPlan } from "../manifest";
import type { ToolBundle } from "../schemas";
import { FakeS3 } from "./fakeS3";
import { SchemaValidator } from "./jsonSchema";

export { FakeS3 };

const SCHEMAS = "../../../../../planet/runtime/schemas/";

/** A schema of planet/runtime/schemas (`manifest`, `prepare` or `results`). */
export function protocolSchema(name: "manifest" | "prepare" | "results"): Record<string, unknown> {
    return JSON.parse(readFileSync(fileURLToPath(new URL(`${SCHEMAS}${name}.schema.json`, import.meta.url)), "utf8"));
}

/** Errors of `document` against a protocol schema; empty when it is valid. */
export function schemaErrors(document: unknown, name: "manifest" | "prepare" | "results"): string[] {
    return new SchemaValidator(protocolSchema(name)).validate(document);
}

/** The bundle the generator wrote for `datamash_ops` 1.9+galaxy0 (planet/build/generated). */
export function datamashBundle(): ToolBundle {
    return JSON.parse(readFileSync(fileURLToPath(new URL("./datamash_ops.bundle.json", import.meta.url)), "utf8"));
}

export const DATAMASH_IMAGE = "quay.io/biocontainers/datamash:1.9--h5b5514e_0";

/** A tool archive and a copy of `bundle` whose `source.repo_tar` describes it. */
export async function withArchive(
    bundle: ToolBundle,
    content = "tool directory",
): Promise<{ bundle: ToolBundle; tar: Uint8Array }> {
    const tar = new TextEncoder().encode(content);
    const path = bundle.source!.repo_tar!.path;
    return {
        bundle: {
            ...bundle,
            source: { ...bundle.source, repo_tar: { path, sha256: await sha256Hex(tar), size: tar.byteLength } },
        },
        tar,
    };
}

export async function resetDb(): Promise<void> {
    await closeDb();
    globalThis.indexedDB = new IDBFactory();
}

export async function teardownDb(): Promise<void> {
    await closeDb();
    vi.restoreAllMocks();
}

export function testSettings(): PlanetSettings {
    return {
        instance_id: "a1b2c3d4",
        cluster: {
            gateway_url: "https://gateway.test",
            namespace: "planet",
            has_token: true,
            runtime_image: "ghcr.io/almahmoud/planet-runtime@sha256:0000",
            job_service_account: "planet-job",
            default_cpu: "1",
            default_memory: "4Gi",
            default_walltime_seconds: 86400,
            scratch_default: "20Gi",
            arch_policy: "amd64-only",
            user_namespaces: false,
        },
        storage: {
            endpoint: "https://browser.s3.test",
            cluster_endpoint: "https://cluster.s3.test",
            bucket: "planet",
            prefix: "planet",
            region: "auto",
            path_style: true,
            access_key_id: "test-key",
            has_secret: true,
        },
        user: { email: "user@example.org", username: "user" },
    };
}

const HTML = "galaxy.datatypes.text.Html";

/** The registry's view of the few extensions the tests use. */
export function testDatatype(extension: string): DatatypeInfo {
    const className = extension === "html" ? HTML : "galaxy.datatypes.data.Data";
    const composite = extension === "velvet" ? [{ name: "Sequences" }] : [];
    return {
        extension,
        className,
        details: {
            extension,
            description: null,
            display_in_upload: true,
            mimetype: null,
            is_binary: false,
            display_behavior: null,
            composite_files: composite,
        },
        isA: (cls) => cls === className || cls === "galaxy.datatypes.data.Data",
    };
}

export interface TestDeps extends JobDeps {
    s3: FakeS3;
    fetchStatic: ReturnType<typeof vi.fn<(path: string) => Promise<Response>>>;
}

export function testDeps(
    bundles: ToolBundle[] = [],
    overrides: Partial<JobDeps> = {},
    archives: Record<string, Uint8Array> = {},
): TestDeps {
    const fetchStatic = vi.fn(async (path: string) => {
        const archive = Object.hasOwn(archives, path) ? archives[path] : undefined;
        return archive ? new Response(archive.slice(0)) : new Response("not found", { status: 404 });
    });
    return {
        s3: new FakeS3(),
        settings: testSettings(),
        readSecrets: async () => ({ cluster_token: "token", storage_secret_access_key: "secret" }),
        now: () => Date.now(),
        fetchStatic,
        loadToolBundle: async (toolId, version) =>
            bundles.find((bundle) => bundle.id === toolId && bundle.version === version),
        datatype: async (extension) => testDatatype(extension),
        resolveContainer: async () => DATAMASH_IMAGE,
        ...overrides,
    } as TestDeps;
}

export async function newHistory(): Promise<string> {
    return (await histories.create({ name: "Jobs" })).id;
}

export interface DatasetFixture {
    hda: HdaRecord;
    dataset: DatasetRecord;
}

export function addDataset(
    historyId: string,
    hda: Partial<Omit<NewHda, "history_id" | "dataset_id">> = {},
    dataset: Partial<NewDataset> = {},
): Promise<DatasetFixture> {
    return hdas.createWithDataset(
        { name: "data.tsv", extension: "tabular", dbkey: "hg38", ...hda, history_id: historyId },
        { state: "ok", file_size: 120, total_size: 120, ...dataset },
    );
}

/** An output created at submit: state `new`, as Galaxy creates tool outputs. */
export function addOutput(
    historyId: string,
    hda: Partial<Omit<NewHda, "history_id" | "dataset_id">> = {},
    dataset: Partial<NewDataset> = {},
): Promise<DatasetFixture> {
    return addDataset(
        historyId,
        { name: "output", ...hda },
        { state: "new", file_size: null, total_size: null, ...dataset },
    );
}

export async function addList(historyId: string, hdaIds: string[], name = "list"): Promise<HdcaRecord> {
    const created = await collections.createHdca({
        hdca: { name, history_id: historyId },
        collection: {
            collection_type: "list",
            elements: hdaIds.map((id, index) => ({ identifier: `e${index}`, hda_id: id })),
        },
    });
    return created.hdca;
}

/** An output collection created at submit and filled by discovery. */
export async function addPendingCollection(
    historyId: string,
    name: string,
    collectionType = "list",
): Promise<HdcaRecord> {
    const created = await collections.createHdca({
        hdca: { name, history_id: historyId },
        collection: { collection_type: collectionType, populated_state: "new", elements: [] },
    });
    return created.hdca;
}

export function addJob(historyId: string, fields: Partial<NewJob> & Pick<NewJob, "tool_id">): Promise<JobRecord> {
    return jobs.create({ tool_version: "1.0", state: "queued", ...fields, history_id: historyId });
}

export function addUpload(fields: Partial<NewUpload> & Pick<NewUpload, "name" | "size">): Promise<UploadRecord> {
    return uploads.create({ part_size: 8 * 1024 * 1024, state: "uploaded", ...fields });
}

/** Records a dispatch as the job manager does once the attempt's Kubernetes Job exists; returns the job. */
export function markDispatched(
    jobId: string,
    plan: Pick<DispatchPlan, "kind" | "attempt" | "multipart">,
    termination: NonNullable<JobRecord["k8s"]>["tool_termination"] = null,
): Promise<JobRecord> {
    return jobs.update(jobId, {
        k8s: {
            namespace: "planet",
            name: `planet-a1b2c3d4-${jobId}-a${plan.attempt}`,
            uid: null,
            attempt: plan.attempt,
            spec_hash: null,
            pod_name: null,
            node_name: null,
            image: null,
            kind: plan.kind,
            created: null,
            prepared: false,
            tool_termination: termination,
            multipart: plan.multipart.map(({ key, uploadId }) => ({ key, upload_id: uploadId })),
        },
    });
}
