/** Test doubles and seed data for the backup tests. */

import { IDBFactory } from "fake-indexeddb";

import {
    closeDb,
    getDb,
    hdas,
    histories,
    JOB_STORES,
    jobs,
    kv,
    outbox,
    type PlanetDB,
    setLeaderFence,
    settings,
    STORE_NAMES,
    tools,
    uploads,
    withTransaction,
} from "@/planet/db";
import { createS3Client, type S3Client, type S3Config, S3Error, type S3ListResult } from "@/planet/s3";
import { closeEvents } from "@/planet/util/events";

import { type BackupKey, createBackupKey } from "../keys";
import { writeKey } from "../state";

export const PASSPHRASE = "correct horse battery staple";
export const SECRET = "garage-secret-access-key-0123456789";
export const TOKEN = "eyJhbGciOiJSUzI1NiJ9.cluster-token-value";

export const STORAGE = {
    endpoint: "https://s3.planet.test",
    bucket: "planet-data",
    prefix: "planet",
    region: "auto",
    path_style: true,
    access_key_id: "AKIDBACKUPTEST",
};

/** An in-memory bucket with the S3 operations the backup module uses. Keys are relative to the prefix. */
export class MemoryBucket {
    readonly objects = new Map<string, Uint8Array>();
    readonly log: string[] = [];
    readonly configs: S3Config[] = [];

    readonly factory = (config: S3Config): S3Client => {
        this.configs.push(config);
        return this.client();
    };

    keys(prefix = ""): string[] {
        return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    json(key: string): unknown {
        const bytes = this.objects.get(key);
        if (!bytes) {
            throw new Error(`${key} was not written`);
        }
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    putJson(key: string, value: unknown): void {
        this.objects.set(key, new TextEncoder().encode(JSON.stringify(value)));
    }

    client(): S3Client {
        const unused = async () => {
            throw new Error("not used by backups");
        };
        return {
            clockOffsetMs: 0,
            getObject: async (key: string) => {
                this.log.push(`GET ${key}`);
                const bytes = this.objects.get(key);
                if (!bytes) {
                    throw new S3Error(404, "NoSuchKey", `${key} does not exist`);
                }
                return new Response(bytes.slice(0));
            },
            putObject: async (key: string, body: unknown) => {
                this.log.push(`PUT ${key}`);
                const bytes =
                    typeof body === "string"
                        ? new TextEncoder().encode(body)
                        : new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
                this.objects.set(key, bytes);
                return { etag: null, versionId: null };
            },
            deleteObject: async (key: string) => {
                this.log.push(`DELETE ${key}`);
                this.objects.delete(key);
            },
            listObjects: async (prefix: string, options: { delimiter?: string; continuationToken?: string } = {}) => {
                const all = this.keys(prefix);
                const start = options.continuationToken ? Number(options.continuationToken) : 0;
                const page = all.slice(start, start + 3);
                const result: S3ListResult = {
                    objects: [],
                    commonPrefixes: [],
                    isTruncated: start + 3 < all.length,
                    nextContinuationToken: start + 3 < all.length ? String(start + 3) : null,
                };
                for (const key of page) {
                    const rest = key.slice(prefix.length);
                    const cut = options.delimiter ? rest.indexOf(options.delimiter) : -1;
                    if (cut >= 0) {
                        const common = prefix + rest.slice(0, cut + 1);
                        if (!result.commonPrefixes.includes(common)) {
                            result.commonPrefixes.push(common);
                        }
                    } else {
                        result.objects.push({
                            key,
                            size: this.objects.get(key)!.byteLength,
                            etag: '"etag"',
                            lastModified: "",
                        });
                    }
                }
                return result;
            },
            presignGet: async (key: string, expires: number) => {
                return `https://s3.planet.test/planet-data/planet/${key}?expires=${expires}`;
            },
            headBucket: unused,
            headObject: unused,
            presignPut: unused,
            createMultipartUpload: unused,
            uploadPart: unused,
            presignUploadPart: unused,
            completeMultipartUpload: unused,
            abortMultipartUpload: unused,
            listParts: unused,
            checkSetup: unused,
        } as unknown as S3Client;
    }
}

/** A fresh, empty IndexedDB, as on a new device or after eviction. */
export async function resetDb(): Promise<void> {
    await closeDb();
    closeEvents();
    setLeaderFence(null);
    globalThis.indexedDB = new IDBFactory();
}

/** Stores the bucket settings and secret, as the setup page does. */
export async function configureStorage(withCluster = false): Promise<void> {
    await settings.update({
        storage: { ...STORAGE, secret_access_key: SECRET },
        ...(withCluster ? { cluster: { gateway_url: "https://k8s.planet.test", token: TOKEN } } : {}),
    });
}

let cachedKey: BackupKey | null = null;

/** Sets the test passphrase on this device (the derived key is reused between tests to save PBKDF2 time). */
export async function setPassphrase(): Promise<BackupKey> {
    cachedKey ??= await createBackupKey(PASSPHRASE);
    await writeKey(cachedKey);
    return cachedKey;
}

export interface Seeded {
    historyId: string;
    finishedJobId: string;
    runningJobId: string;
    runningOutputDatasetId: string;
}

/** Histories, datasets, a finished and a running job, an outbox entry, an upload, a tool and preferences. */
export async function seed(): Promise<Seeded> {
    const history = await histories.create({ name: "RNA-seq" });
    await histories.create({ name: "Scratch", tags: ["name:tmp"] });
    const { hda: input } = await hdas.createWithDataset(
        { history_id: history.id, name: "reads.fastq", extension: "fastqsanger" },
        { state: "ok", file_size: 1234 },
    );
    const ids = await withTransaction(JOB_STORES, "readwrite", async (tx) => {
        const finished = await jobs.create(
            {
                tool_id: "cat1",
                tool_version: "1.0.0",
                history_id: history.id,
                state: "ok",
                inputs: [{ name: "input1", src: "hda", id: input.id }],
                tool_stdout: "done\n",
            },
            tx,
        );
        const running = await jobs.create(
            {
                tool_id: "sort1",
                tool_version: "1.0.1",
                history_id: history.id,
                state: "running",
                inputs: [{ name: "input", src: "hda", id: input.id }],
                k8s: {
                    namespace: "planet",
                    name: "planet-a1b2c3d4-job-a1",
                    uid: "uid-1",
                    attempt: 1,
                    spec_hash: "hash",
                    pod_name: "planet-a1b2c3d4-job-a1-xyz",
                    node_name: "node-7",
                    image: "quay.io/biocontainers/coreutils:9.5",
                    kind: "tool",
                    created: "2026-10-13T11:00:00Z",
                    prepared: true,
                    tool_termination: null,
                    multipart: [],
                },
            },
            tx,
        );
        const { hda, dataset } = await hdas.createWithDataset(
            { history_id: history.id, name: "sorted", creating_job_id: running.id },
            { state: "running", job_id: running.id },
            tx,
        );
        await jobs.update(running.id, { outputs: [{ name: "out_file1", src: "hda", id: hda.id }] }, tx);
        await outbox.enqueue({ kind: "purge", payload: { uuids: [dataset.uuid] } }, tx);
        return { finished: finished.id, running: running.id, output: dataset.id };
    });
    await uploads.create({ name: "big.bam", size: 10, part_size: 8 * 1024 * 1024, history_id: history.id });
    await tools.put({
        tool_id: "toolshed.example.org/repos/me/tool/tool/1.0",
        tool_version: "1.0",
        source: "installed",
        status: "ready",
        message: null,
        bundle: { id: "tool", inputs: [] },
        bundle_url: null,
        panel_section_id: "custom",
        panel_section_name: "Custom",
        hidden: false,
    });
    await kv.set("preferences", { theme: "dark" });
    await kv.set("current_history_id", history.id);
    return {
        historyId: history.id,
        finishedJobId: ids.finished,
        runningJobId: ids.running,
        runningOutputDatasetId: ids.output,
    };
}

/** Every record of every store, keyed for comparison. */
export async function dump(): Promise<Record<string, unknown[]>> {
    const db: PlanetDB = await getDb();
    const tx = db.transaction([...STORE_NAMES], "readonly");
    const out: Record<string, unknown[]> = {};
    for (const name of STORE_NAMES) {
        const store = tx.objectStore(name);
        const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
        out[name] = keys.map((key, index) => [key, values[index]]);
    }
    await tx.done;
    return out;
}

/** An S3 client factory that fails like an unreachable endpoint. */
export function unreachable(): (config: S3Config) => S3Client {
    return (config) =>
        createS3Client(config, {
            fetch: async () => {
                throw new TypeError("Failed to fetch");
            },
            retries: 0,
        });
}
