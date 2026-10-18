/** Test doubles for the job orchestration: an in-memory Kubernetes API, the protocol module and IndexedDB data. */

import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

import {
    closeDb,
    datasets,
    hdas,
    histories,
    JOB_STORES,
    type JobRecord,
    jobs,
    outbox,
    setLeaderFence,
    withTransaction,
} from "@/planet/db";
import {
    type EventList,
    type Job as KubeJob,
    type JobList,
    type KubeClient,
    KubeError,
    type KubeEvent,
    type Pod,
    type PodList,
    type PodLogOptions,
    type PodStatus,
    type WatchEvent,
    type WatchHandler,
    type WatchResult,
} from "@/planet/k8s";
import { closeEvents } from "@/planet/util/events";

import type { JobDeps } from "../deps";
import type { IngestOutcome, JobFailure } from "../ingest";
import type { ChannelLike, LockManagerLike } from "../leader";
import type { JobProtocol } from "../manager";
import type { AdoptedDispatch, DispatchPlan } from "../manifest";
import { AttemptInUseError } from "../objects";

export const INSTANCE = "a1b2c3d4";

/** Resets IndexedDB and the event channel between tests. */
export async function resetDb(): Promise<void> {
    await closeDb();
    closeEvents();
    setLeaderFence(null);
    globalThis.indexedDB = new IDBFactory();
}

export function waitFor(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function notFound(kind: string, name: string): KubeError {
    return new KubeError(404, "NotFound", `${kind} "${name}" not found`);
}

interface Watcher {
    handler: WatchHandler<KubeJob | Pod>;
    resolve: (result: WatchResult) => void;
}

/** An in-memory Kubernetes API with Jobs, Pods, events, logs and watch streams. */
export class FakeKube implements KubeClient {
    readonly namespace = "planet";
    readonly jobs = new Map<string, KubeJob>();
    readonly pods = new Map<string, Pod>();
    readonly events: KubeEvent[] = [];
    readonly logs = new Map<string, string>();
    readonly logRequests: { pod: string; options: PodLogOptions }[] = [];
    readonly created: KubeJob[] = [];
    readonly deleted: string[] = [];
    /** Throws this from the next createJob call. */
    createError: Error | null = null;
    /** Throws this from the next deleteJob call. */
    deleteError: Error | null = null;
    /** Runs before each createJob call creates the Job (a request in flight). */
    beforeCreate: ((spec: KubeJob) => Promise<void>) | null = null;
    private revision = 100;
    private readonly watchers: Record<"jobs" | "pods", Set<Watcher>> = { jobs: new Set(), pods: new Set() };

    private nextVersion(): string {
        this.revision += 1;
        return String(this.revision);
    }

    private emit(kind: "jobs" | "pods", type: "ADDED" | "MODIFIED" | "DELETED", object: KubeJob | Pod): void {
        for (const watcher of this.watchers[kind]) {
            void watcher.handler({ type, object: clone(object) } as WatchEvent<KubeJob | Pod>);
        }
    }

    async version(): Promise<never> {
        throw new Error("not implemented");
    }

    async rulesReview(): Promise<never> {
        throw new Error("not implemented");
    }

    async createJob(spec: KubeJob): Promise<KubeJob> {
        if (this.createError) {
            const error = this.createError;
            this.createError = null;
            throw error;
        }
        await this.beforeCreate?.(spec);
        const name = spec.metadata.name!;
        if (this.jobs.has(name)) {
            throw new KubeError(409, "AlreadyExists", `jobs.batch "${name}" already exists`);
        }
        const job: KubeJob = clone({
            ...spec,
            metadata: {
                ...spec.metadata,
                namespace: this.namespace,
                uid: `uid-${name}`,
                resourceVersion: this.nextVersion(),
                creationTimestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
            },
            status: {},
        });
        this.jobs.set(name, job);
        this.created.push(clone(job));
        this.emit("jobs", "ADDED", job);
        return clone(job);
    }

    async getJob(name: string): Promise<KubeJob> {
        const job = this.jobs.get(name);
        if (!job) {
            throw notFound("jobs.batch", name);
        }
        return clone(job);
    }

    async listJobs(): Promise<JobList> {
        return { metadata: { resourceVersion: String(this.revision) }, items: [...this.jobs.values()].map(clone) };
    }

    async deleteJob(name: string): Promise<boolean> {
        if (this.deleteError) {
            const error = this.deleteError;
            this.deleteError = null;
            throw error;
        }
        const job = this.jobs.get(name);
        this.deleted.push(name);
        if (!job) {
            return false;
        }
        this.jobs.delete(name);
        this.emit("jobs", "DELETED", job);
        for (const [podName, pod] of this.pods) {
            if (pod.metadata.labels?.["batch.kubernetes.io/job-name"] === name) {
                this.pods.delete(podName);
                this.emit("pods", "DELETED", pod);
            }
        }
        return true;
    }

    async getPod(name: string): Promise<Pod> {
        const pod = this.pods.get(name);
        if (!pod) {
            throw notFound("pods", name);
        }
        return clone(pod);
    }

    async listPods(): Promise<PodList> {
        return { metadata: { resourceVersion: String(this.revision) }, items: [...this.pods.values()].map(clone) };
    }

    async getPodLog(name: string, options: PodLogOptions): Promise<string> {
        this.logRequests.push({ pod: name, options });
        if (!this.pods.has(name)) {
            throw notFound("pods", name);
        }
        return this.logs.get(`${name}/${options.container}`) ?? "";
    }

    async listEvents(options: { fieldSelector?: string } = {}): Promise<EventList> {
        const name = /involvedObject\.name=([^,]+)/.exec(options.fieldSelector ?? "")?.[1];
        return {
            metadata: {},
            items: this.events.filter((event) => !name || event.involvedObject.name === name).map(clone),
        };
    }

    watchJobs(
        _selector: string,
        resourceVersion: string,
        onEvent: WatchHandler<KubeJob>,
        signal?: AbortSignal,
    ): Promise<WatchResult> {
        return this.watch("jobs", resourceVersion, onEvent as WatchHandler<KubeJob | Pod>, signal);
    }

    watchPods(
        _selector: string,
        resourceVersion: string,
        onEvent: WatchHandler<Pod>,
        signal?: AbortSignal,
    ): Promise<WatchResult> {
        return this.watch("pods", resourceVersion, onEvent as WatchHandler<KubeJob | Pod>, signal);
    }

    private watch(
        kind: "jobs" | "pods",
        resourceVersion: string,
        handler: WatchHandler<KubeJob | Pod>,
        signal?: AbortSignal,
    ): Promise<WatchResult> {
        return new Promise((resolve) => {
            const watcher: Watcher = { handler, resolve };
            this.watchers[kind].add(watcher);
            signal?.addEventListener("abort", () => {
                this.watchers[kind].delete(watcher);
                resolve({ resourceVersion, end: "aborted" });
            });
        });
    }

    /** Number of open watch streams. */
    openWatches(): number {
        return this.watchers.jobs.size + this.watchers.pods.size;
    }

    /** Creates or updates the pod of a Job (named `<job>-pod`) with `status`. */
    setPod(jobName: string, status: PodStatus, podName = `${jobName}-pod`): Pod {
        const job = this.jobs.get(jobName);
        const labels = { ...(job?.spec?.template.metadata?.labels ?? {}), "batch.kubernetes.io/job-name": jobName };
        const existing = this.pods.get(podName);
        const pod: Pod = {
            metadata: {
                name: podName,
                namespace: this.namespace,
                uid: `uid-${podName}`,
                labels,
                creationTimestamp: existing?.metadata.creationTimestamp ?? new Date().toISOString(),
                resourceVersion: this.nextVersion(),
            },
            spec: job?.spec?.template.spec,
            status: { nodeName: "node-1", ...status },
        };
        this.pods.set(podName, pod);
        this.emit("pods", existing ? "MODIFIED" : "ADDED", pod);
        return pod;
    }

    /** Sets the status of a Job. */
    setJobStatus(name: string, status: KubeJob["status"]): void {
        const job = this.jobs.get(name);
        if (!job) {
            throw new Error(`no job ${name}`);
        }
        job.status = status;
        job.metadata.resourceVersion = this.nextVersion();
        this.emit("jobs", "MODIFIED", job);
    }

    /** Marks a Job finished with a condition. */
    finishJob(name: string, type: "Complete" | "Failed", reason?: string, message?: string): void {
        this.setJobStatus(name, {
            conditions: [{ type, status: "True", reason, message }],
            ...(type === "Complete" ? { succeeded: 1 } : { failed: 1 }),
        });
    }

    /** Removes a Job without the leader's involvement (TTL controller, a user). */
    dropJob(name: string): void {
        const job = this.jobs.get(name);
        this.jobs.delete(name);
        if (job) {
            this.emit("jobs", "DELETED", job);
        }
    }
}

/** Pod status helpers. */
export const podStatus = {
    pending(): PodStatus {
        return { phase: "Pending", conditions: [{ type: "PodScheduled", status: "True" }] };
    },
    unscheduled(): PodStatus {
        return {
            phase: "Pending",
            conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes" }],
        };
    },
    stagingIn(): PodStatus {
        return {
            phase: "Pending",
            conditions: [{ type: "PodScheduled", status: "True" }],
            initContainerStatuses: [container("stage-in", { running: {} })],
        };
    },
    running(): PodStatus {
        return {
            phase: "Running",
            conditions: [{ type: "PodScheduled", status: "True" }],
            initContainerStatuses: [container("stage-in", { terminated: { exitCode: 0, reason: "Completed" } })],
            containerStatuses: [container("tool", { running: {} }), container("stage-out", { running: {} })],
        };
    },
    finished(tool: { exitCode: number; reason?: string }, stageOut = { exitCode: 0 }): PodStatus {
        return {
            phase: tool.exitCode === 0 && stageOut.exitCode === 0 ? "Succeeded" : "Failed",
            conditions: [{ type: "PodScheduled", status: "True" }],
            initContainerStatuses: [container("stage-in", { terminated: { exitCode: 0, reason: "Completed" } })],
            containerStatuses: [
                container("tool", { terminated: { reason: tool.exitCode ? "Error" : "Completed", ...tool } }),
                container("stage-out", {
                    terminated: { reason: stageOut.exitCode ? "Error" : "Completed", ...stageOut },
                }),
            ],
        };
    },
    waiting(name: string, reason: string, message: string, image = "quay.io/biocontainers/missing:1.0--0"): PodStatus {
        return {
            phase: "Pending",
            conditions: [{ type: "PodScheduled", status: "True" }],
            initContainerStatuses: [container("stage-in", { terminated: { exitCode: 0, reason: "Completed" } })],
            containerStatuses: [
                container(name, { waiting: { reason, message } }, image),
                container("stage-out", { running: {} }),
            ],
        };
    },
};

export function container(
    name: string,
    state: NonNullable<PodStatus["containerStatuses"]>[number]["state"],
    image = "image",
): NonNullable<PodStatus["containerStatuses"]>[number] {
    return { name, ready: false, restartCount: 0, image, imageID: "", state };
}

/** A protocol module double that records calls and writes the job state the real one would write. */
export class FakeProtocol implements JobProtocol {
    readonly results = new Map<string, "ok" | "error">();
    readonly prepared = new Set<string>();
    readonly failures: { jobId: string; failure: JobFailure; state: string }[] = [];
    readonly dispatched: { jobId: string; attempt: number }[] = [];
    /** Dispatch ids of the dispatch records written, by `<job>/a<attempt>`. */
    readonly records = new Map<string, string>();
    planOverrides: Partial<DispatchPlan> = {};
    prepareError: Error | null = null;
    private dispatches = 0;

    prepareDispatch = vi.fn(
        async (job: JobRecord, _deps: JobDeps, options: { attempt: number }): Promise<DispatchPlan> => {
            if (this.prepareError) {
                throw this.prepareError;
            }
            // Like the protocol module: an attempt whose objects exist is never prepared again.
            if (this.records.has(`${job.id}/a${options.attempt}`)) {
                throw new AttemptInUseError(job.id, options.attempt);
            }
            this.dispatched.push({ jobId: job.id, attempt: options.attempt });
            const dispatchId = (++this.dispatches).toString(16).padStart(16, "0");
            this.records.set(`${job.id}/a${options.attempt}`, dispatchId);
            const manifestKey = `jobs/${job.id}/a${options.attempt}/manifest.json`;
            return {
                kind: job.tool_id === "__DATA_FETCH__" ? "upload" : "tool",
                attempt: options.attempt,
                dispatchId,
                manifestKey,
                manifestUrl: `https://bucket.example.org/planet/${manifestKey}?X-Amz-Signature=${options.attempt}${Math.random()}`,
                deadlineSeconds: 10800,
                walltimeSeconds: 3600,
                toolImage: job.tool_id === "__DATA_FETCH__" ? null : "quay.io/biocontainers/samtools:1.21--h50ea8bc_0",
                resources: { cpu: "1", memory: "4Gi", scratch: "20Gi" },
                multipart: [],
                ...this.planOverrides,
            } as DispatchPlan;
        },
    );

    adoptDispatch = vi.fn(
        async (
            job: JobRecord,
            _deps: JobDeps,
            options: { attempt: number; dispatchId: string | null },
        ): Promise<AdoptedDispatch | null> => {
            const recorded = this.records.get(`${job.id}/a${options.attempt}`);
            if (!recorded || recorded !== options.dispatchId) {
                return null;
            }
            const kind = job.tool_id === "__DATA_FETCH__" ? "upload" : "tool";
            return { kind, attempt: options.attempt, dispatchId: recorded, multipart: [] };
        },
    );

    abortDispatch = vi.fn(async (): Promise<void> => undefined);

    ingestResults = vi.fn(async (job: JobRecord): Promise<IngestOutcome | null> => {
        const state = this.results.get(job.id);
        if (!state) {
            return null;
        }
        await settleJob(job.id, state);
        return { state, datasetIds: [], hdaIds: [] };
    });

    readPrepare = vi.fn(
        async (job: JobRecord): Promise<unknown> => (this.prepared.has(job.id) ? { state: "ok" } : null),
    );

    ingestFailure = vi.fn(async (job: JobRecord, failure: JobFailure): Promise<void> => {
        const current = await jobs.get(job.id);
        this.failures.push({ jobId: job.id, failure, state: current?.state ?? "missing" });
        await settleJob(job.id, "error", failure.message);
    });
}

/** Sets a job and its outputs to a final state, as ingest does. */
export async function settleJob(jobId: string, state: "ok" | "error", info?: string): Promise<void> {
    await withTransaction(JOB_STORES, "readwrite", async (t) => {
        const job = await jobs.get(jobId, t);
        if (!job || ["ok", "error", "deleted", "deleting"].includes(job.state)) {
            return;
        }
        for (const output of job.outputs) {
            const hda = await hdas.get(output.id, t);
            if (hda) {
                await datasets.update(hda.dataset_id, { state }, t);
            }
        }
        await jobs.update(jobId, { state, info: info ?? null }, t);
    });
}

/** A JobDeps double; only `s3` is used by the orchestration. */
export function fakeDeps() {
    const s3 = {
        abortMultipartUpload: vi.fn(async () => undefined),
        listObjects: vi.fn(async () => ({
            objects: [],
            commonPrefixes: [],
            isTruncated: false,
            nextContinuationToken: null,
        })),
        deleteObject: vi.fn(async (_key: string) => undefined),
    };
    return { deps: { s3, now: () => Date.now() } as unknown as JobDeps, s3 };
}

/** Creates a history with an `ok` input dataset. */
export async function seedHistory(state: "ok" | "queued" = "ok") {
    const history = await histories.create({ name: "test" });
    const { hda, dataset } = await hdas.createWithDataset({ history_id: history.id, name: "input.bed" }, { state });
    return { history, input: hda, inputDataset: dataset };
}

/** Creates a tool job reading `inputHdaIds` with one output and a dispatch entry, as `POST /api/tools` does. */
export async function seedJob(
    historyId: string,
    inputHdaIds: string[],
    options: { toolId?: string; enqueue?: boolean } = {},
): Promise<{ job: JobRecord; outputHdaId: string; outputDatasetId: string }> {
    return withTransaction(JOB_STORES, "readwrite", async (t) => {
        const job = await jobs.create(
            {
                tool_id: options.toolId ?? "cat1",
                tool_version: "1.0.0",
                history_id: historyId,
                inputs: inputHdaIds.map((id, index) => ({ name: `input${index + 1}`, src: "hda" as const, id })),
            },
            t,
        );
        const { hda, dataset } = await hdas.createWithDataset(
            { history_id: historyId, name: "out_file1", creating_job_id: job.id },
            { state: "new", job_id: job.id },
            t,
        );
        const updated = await jobs.update(job.id, { outputs: [{ name: "out_file1", src: "hda", id: hda.id }] }, t);
        if (options.enqueue !== false) {
            await outbox.enqueue({ kind: "dispatch", job_id: job.id }, t);
        }
        return { job: updated, outputHdaId: hda.id, outputDatasetId: dataset.id };
    });
}

/** The dataset state of an HDA. */
export async function hdaState(hdaId: string): Promise<string | undefined> {
    const hda = await hdas.get(hdaId);
    return hda ? (await datasets.get(hda.dataset_id))?.state : undefined;
}

interface Request {
    callback: (lock: Lock | null) => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
}

/** The Web Locks API for one lock name: FIFO queue, `steal` and `signal`. */
export class FakeLocks implements LockManagerLike {
    holder: Request | null = null;
    queue: Request[] = [];

    request(_name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>): Promise<void> {
        return new Promise((resolve, reject) => {
            const request: Request = { callback, resolve, reject };
            const signal = options.signal;
            if (signal) {
                signal.addEventListener("abort", () => {
                    if (this.queue.includes(request)) {
                        this.queue = this.queue.filter((item) => item !== request);
                        reject(new DOMException("The request was aborted.", "AbortError"));
                    }
                });
            }
            if (options.steal) {
                const previous = this.holder;
                this.holder = null;
                previous?.reject(new DOMException("The lock was stolen.", "AbortError"));
                this.grant(request);
            } else {
                this.queue.push(request);
                this.pump();
            }
        });
    }

    private grant(request: Request): void {
        this.holder = request;
        void request.callback({ name: "planet:leader", mode: "exclusive" } as Lock).then(() => {
            if (this.holder === request) {
                this.holder = null;
                request.resolve();
                this.pump();
            }
        });
    }

    private pump(): void {
        const next = this.holder ? undefined : this.queue.shift();
        if (next) {
            this.grant(next);
        }
    }
}

/** BroadcastChannel instances of one name, delivering to every other instance. */
export class Bus {
    private readonly members = new Set<Set<(event: MessageEvent) => void>>();

    channel(): ChannelLike {
        const listeners = new Set<(event: MessageEvent) => void>();
        this.members.add(listeners);
        return {
            postMessage: (data) => {
                for (const member of this.members) {
                    if (member !== listeners) {
                        member.forEach((listener) => queueMicrotask(() => listener({ data } as MessageEvent)));
                    }
                }
            },
            addEventListener: (_type, listener) => listeners.add(listener),
            removeEventListener: (_type, listener) => listeners.delete(listener),
            close: () => this.members.delete(listeners),
        };
    }
}
