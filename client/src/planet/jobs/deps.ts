/**
 * Services the job protocol modules (`manifest.ts`, `ingest.ts`) use. The leader creates them once with
 * {@link createJobDeps}; tests build their own.
 */

import { type DatatypeInfo, getDatatype } from "@/planet/api/datatypes";
import { type PlanetSecrets, type PlanetSettings, readTx, settings } from "@/planet/db";
import { createS3Client, type S3Client } from "@/planet/s3";
import { readBundle } from "@/planet/tools/bundle";

import { resolveToolImage } from "./containers";
import type { ToolBundle } from "./schemas";

/**
 * IndexedDB writes of the job protocol run in transactions over `JOB_STORES`, so the leader fence of
 * `db/fence.ts` applies to them: in a fenced tab they fail with `LeaderFenceError` once another tab leads.
 */
export interface JobDeps {
    /** Client for the configured bucket. Its clock offset, learnt from responses, is used for presigning. */
    s3: S3Client;
    /** Settings as they were when the dependencies were created. */
    settings: PlanetSettings;
    /** Reads the stored credentials (the cluster token for the Kubernetes client). */
    readSecrets(): Promise<PlanetSecrets>;
    /** Local clock in epoch milliseconds. */
    now(): number;
    /** Fetches a same-origin static file, such as a tool archive under `/static/planet/toolrepos/`. */
    fetchStatic(path: string): Promise<Response>;
    /** Returns the bundle of a tool version: installed tools from IndexedDB, built-in ones from the build's data. */
    loadToolBundle(toolId: string, version: string): Promise<ToolBundle | undefined>;
    /** Returns the datatype registry's view of an extension. */
    datatype(extension: string): Promise<DatatypeInfo>;
    /**
     * Resolves the image a tool runs in. When absent, only an explicit docker container of the bundle is used and a
     * tool without one gets no image.
     */
    resolveContainer?(bundle: ToolBundle): Promise<string | null>;
    /** Aborts pending bucket requests. */
    signal?: AbortSignal;
}

export interface JobDepsOptions {
    /** Defaults to `resolveToolImage` of `jobs/containers.ts` with the configured runtime image. */
    resolveContainer?: JobDeps["resolveContainer"];
    signal?: AbortSignal;
}

/**
 * Creates the dependencies from the stored settings and credentials.
 *
 * @returns null when the bucket is not configured
 */
export async function createJobDeps(options: JobDepsOptions = {}): Promise<JobDeps | null> {
    const { current, secrets } = await readTx(["settings", "secrets"], async (tx) => ({
        current: await settings.get(tx),
        secrets: await settings.getSecrets(tx),
    }));
    const storage = current.storage;
    const secret = secrets.storage_secret_access_key;
    if (!storage.endpoint || !storage.bucket || !storage.access_key_id || !secret) {
        return null;
    }
    const s3 = createS3Client({
        endpoint: storage.endpoint,
        clusterEndpoint: storage.cluster_endpoint,
        bucket: storage.bucket,
        prefix: storage.prefix,
        region: storage.region,
        pathStyle: storage.path_style,
        accessKeyId: storage.access_key_id,
        secretAccessKey: secret,
    });
    return {
        s3,
        settings: current,
        readSecrets: () => settings.getSecrets(),
        now: () => Date.now(),
        fetchStatic: (path) =>
            globalThis.fetch(path, { credentials: "same-origin", cache: "no-cache", signal: options.signal }),
        loadToolBundle: async (toolId, version) => (await readBundle(toolId, version)) as ToolBundle | undefined,
        datatype: getDatatype,
        resolveContainer:
            options.resolveContainer ??
            ((bundle) => resolveToolImage(bundle, current.cluster.runtime_image, { signal: options.signal })),
        signal: options.signal,
    };
}
