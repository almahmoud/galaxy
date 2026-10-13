/**
 * The job manager run by the leader tab. It works through the outbox (dispatch, cancel, cleanup, purge) with
 * backoff, gates jobs on their inputs, creates Kubernetes Jobs, follows them through {@link ClusterMonitor}
 * and hands finished pods to the protocol module (results, prepare decisions, failures). Every Kubernetes write
 * is idempotent: Job names are deterministic and an existing Job is adopted only when its spec hash matches.
 *
 * Work on one job is serialized; job writes are fenced to the leader epoch (`db/fence.ts`).
 */

import {
    type CleanupPayload,
    datasets,
    type DispatchPayload,
    JOB_STORES,
    type JobKubernetesInfo,
    type JobMultipartUpload,
    type JobRecord,
    jobs,
    type JobState,
    leader,
    LeaderFenceError,
    outbox,
    type OutboxRecord,
    type PurgePayload,
    readTx,
    type StoredSettings,
    type WriteTx,
    writeTx,
} from "@/planet/db";
import { isKubeError, type Job as KubeJob, type KubeClient, type Pod } from "@/planet/k8s";
import { type PlanetEvent, subscribe } from "@/planet/util/events";
import { formatGalaxyTime, parseGalaxyTime } from "@/planet/util/time";

import { ConsoleTails } from "./console";
import type { JobDeps } from "./deps";
import {
    classifyFailure,
    containerStarted,
    containerTerminated,
    errorMessage,
    failedCreate,
    isPermanent,
    isTransient,
    jobOutcome,
    mainContainer,
    pendingFailure,
    podFinished,
} from "./failures";
import { checkInputs, GATING_READ_STORES, pauseDependents, pauseJob } from "./gating";
import { FAILURE_MESSAGES, type IngestOutcome, type JobFailure } from "./ingest";
import { buildJobSpec, parseQuantity, SPEC_HASH_ANNOTATION, STAGE_IN_CONTAINER, TOOL_CONTAINER } from "./k8sJob";
import type { DispatchPlan } from "./manifest";
import { ClusterMonitor } from "./monitor";
import { ProtocolError } from "./schemas";

/** The protocol module's entry points (`jobs/manifest.ts`, `jobs/ingest.ts`). */
export interface JobProtocol {
    prepareDispatch(job: JobRecord, deps: JobDeps, options: { attempt: number }): Promise<DispatchPlan>;
    ingestResults(job: JobRecord, deps: JobDeps): Promise<IngestOutcome | null>;
    readPrepare(job: JobRecord, deps: JobDeps): Promise<unknown>;
    ingestFailure(job: JobRecord, failure: JobFailure, deps: JobDeps): Promise<void>;
}

export interface JobManagerOptions {
    kube: KubeClient;
    deps: JobDeps;
    protocol: JobProtocol;
    settings: StoredSettings;
    /** Milliseconds since the epoch. */
    now?: () => number;
    /** Called when a write found that another tab leads now; the caller stops this manager. */
    onFenced?: () => void;
    /** Called for errors that are retried later. */
    onError?: (error: unknown, context: string) => void;
    /** Replaces the monitor's waits between failed watch streams (tests). */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const RECONCILE_INTERVAL_MS = 60_000;
export const CONSOLE_TICK_MS = 5000;
/** A dispatch whose inputs are not ready is checked again after this long, or when jobs change. */
export const INPUT_RECHECK_MS = 60_000;
/** A Job without a pod after this long has its events read for refused pod creations. */
export const NO_POD_GRACE_MS = 30_000;
/** A Job missing from the watch caches this long after its creation is looked up directly. */
export const MISSING_JOB_GRACE_MS = 60_000;
/** Stage-in failures without `prepare.json` (an expired manifest URL, an unreachable bucket) are retried. */
export const MAX_ATTEMPTS = 3;
/** Unclassified dispatch errors fail the job after this many attempts; transient ones are retried forever. */
export const MAX_UNKNOWN_DISPATCH_FAILURES = 5;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 10 * 60_000;
const EVENTS_RECHECK_MS = 30_000;
const WAKE_THROTTLE_MS = 1000;
const LOG_LIMIT_BYTES = 32 * 1024;
const LOG_TAIL_LINES = 1000;
const SPEC_CONFLICT_RETRIES = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Job states from which a job may be dispatched. */
const DISPATCHABLE: ReadonlySet<JobState> = new Set<JobState>(["new", "waiting", "queued"]);
/** Dispatched states the monitor follows. */
const ACTIVE: ReadonlySet<JobState> = new Set<JobState>(["queued", "running"]);
/** States after which a Kubernetes Job is no longer needed. */
const SETTLED: ReadonlySet<JobState> = new Set<JobState>(["ok", "error", "deleted", "paused", "skipped"]);

/** Delay before retrying an outbox entry that failed `attempts` times (exponential, capped, with jitter). */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 16));
    return Math.round(base * (0.8 + 0.4 * random()));
}

function galaxyTime(ms: number): string {
    return formatGalaxyTime(ms * 1000);
}

export class JobManager {
    readonly monitor: ClusterMonitor;
    readonly consoles: ConsoleTails;
    private readonly kube: KubeClient;
    private readonly deps: JobDeps;
    private readonly protocol: JobProtocol;
    private readonly settings: StoredSettings;
    private readonly now: () => number;
    private readonly locks = new Map<string, Promise<void>>();
    private readonly scheduled = new Set<string>();
    private readonly inFlight = new Set<Promise<unknown>>();
    private readonly firstSeen = new Map<string, number>();
    private readonly eventChecks = new Map<string, number>();
    private intervals: ReturnType<typeof setInterval>[] = [];
    private outboxTimer: ReturnType<typeof setTimeout> | null = null;
    private wakeTimer: ReturnType<typeof setTimeout> | null = null;
    private lastWake = 0;
    private draining: Promise<void> | null = null;
    private drainAgain = false;
    private drainWaiting = false;
    private synced = false;
    private running = false;
    private unsubscribe: (() => void) | null = null;
    private controller = new AbortController();

    constructor(private readonly options: JobManagerOptions) {
        this.kube = options.kube;
        this.deps = options.deps;
        this.protocol = options.protocol;
        this.settings = options.settings;
        this.now = options.now ?? Date.now;
        this.monitor = new ClusterMonitor(this.kube, this.settings.instance_id, {
            onChange: (jobId) => this.schedule(jobId),
            onError: (error) => this.report(error, "watch"),
            sleep: options.sleep,
        });
        this.consoles = new ConsoleTails(this.kube, this.now);
    }

    get active(): boolean {
        return this.running;
    }

    /** Starts processing: subscribes to Planet events, reconciles, then watches the cluster. */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.controller = new AbortController();
        this.unsubscribe = subscribe((event) => this.onEvent(event));
        this.intervals = [
            setInterval(() => this.track(this.reconcile()), RECONCILE_INTERVAL_MS),
            setInterval(() => this.track(this.consoleTick()), CONSOLE_TICK_MS),
        ];
        this.track(
            this.reconcile().then(() => {
                if (this.running) {
                    this.monitor.start();
                }
            }),
        );
    }

    /** Stops processing and waits for work in progress to end. */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        this.running = false;
        this.controller.abort();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.intervals.forEach(clearInterval);
        this.intervals = [];
        for (const timer of [this.outboxTimer, this.wakeTimer]) {
            if (timer) {
                clearTimeout(timer);
            }
        }
        this.outboxTimer = null;
        this.wakeTimer = null;
        await this.monitor.stop();
        await this.idle();
    }

    /** Resolves once no work is in progress. */
    async idle(): Promise<void> {
        while (this.inFlight.size || this.draining) {
            await Promise.allSettled([...this.inFlight, this.draining]);
        }
    }

    /**
     * Re-lists the cluster, makes sure every undispatched job has a dispatch entry, checks every active job and
     * works through the outbox. Runs at start, every minute and when the leader asks (visibility, online).
     */
    async reconcile(): Promise<void> {
        if (!this.running) {
            return;
        }
        try {
            await this.monitor.resync(this.controller.signal);
            this.synced = true;
        } catch (error) {
            this.synced = false;
            this.report(error, "list");
        }
        try {
            const current = await jobs.listByState(["new", "waiting", "queued", "running", "deleting"]);
            const entries = await outbox.list();
            const withDispatch = new Set(entries.filter((e) => e.kind === "dispatch").map((e) => e.job_id));
            const seen = new Set<string>();
            for (const job of current) {
                seen.add(job.id);
                if (job.state !== "deleting" && !job.k8s) {
                    if (!withDispatch.has(job.id)) {
                        await outbox.enqueue({ kind: "dispatch", job_id: job.id });
                    }
                } else {
                    this.schedule(job.id);
                }
            }
            // Kubernetes Jobs of jobs that settled while no leader watched are deleted.
            for (const jobId of this.monitor.knownJobIds()) {
                if (!seen.has(jobId)) {
                    this.schedule(jobId);
                }
            }
        } catch (error) {
            this.handle(error, "reconcile");
        }
        await this.drainOutbox(true);
    }

    /** Asks for the job to be checked against the cluster; repeated requests before it runs coalesce. */
    schedule(jobId: string): void {
        if (!this.running || this.scheduled.has(jobId)) {
            return;
        }
        this.scheduled.add(jobId);
        this.track(
            this.withJob(jobId, async () => {
                this.scheduled.delete(jobId);
                if (this.running) {
                    await this.evaluate(jobId);
                }
            }).catch((error: unknown) => this.handle(error, `job ${jobId}`)),
        );
    }

    /**
     * Processes the due outbox entries in order. With `includeWaiting`, dispatches waiting for their inputs are
     * checked as well. Concurrent calls coalesce into one more pass.
     */
    drainOutbox(includeWaiting = false): Promise<void> {
        this.drainWaiting ||= includeWaiting;
        if (this.draining) {
            this.drainAgain = true;
            return this.draining;
        }
        this.draining = (async () => {
            try {
                do {
                    this.drainAgain = false;
                    const waiting = this.drainWaiting;
                    this.drainWaiting = false;
                    await this.drainOnce(waiting);
                } while (this.drainAgain && this.running);
            } finally {
                this.draining = null;
            }
        })();
        return this.draining;
    }

    private async drainOnce(includeWaiting: boolean): Promise<void> {
        if (!this.running) {
            return;
        }
        const now = galaxyTime(this.now());
        let entries: OutboxRecord[];
        try {
            entries = (await outbox.list()).filter(
                (entry) =>
                    entry.not_before <= now || (includeWaiting && entry.kind === "dispatch" && entry.attempts === 0),
            );
        } catch (error) {
            this.handle(error, "outbox");
            return;
        }
        for (const entry of entries) {
            if (!this.running) {
                return;
            }
            await this.process(entry);
        }
        await this.armOutboxTimer();
    }

    private async armOutboxTimer(): Promise<void> {
        if (!this.running) {
            return;
        }
        const next = (await outbox.list())[0];
        if (this.outboxTimer) {
            clearTimeout(this.outboxTimer);
            this.outboxTimer = null;
        }
        if (!next) {
            return;
        }
        const delay = Math.max(0, parseGalaxyTime(next.not_before) / 1000 - this.now());
        // Reconciliation covers later entries.
        if (delay < RECONCILE_INTERVAL_MS) {
            this.outboxTimer = setTimeout(() => {
                this.outboxTimer = null;
                void this.drainOutbox();
            }, delay + 10);
        }
    }

    private async process(entry: OutboxRecord): Promise<void> {
        try {
            switch (entry.kind) {
                case "dispatch":
                    await this.withJob(entry.job_id ?? "", () => this.dispatch(entry));
                    return;
                case "cancel":
                    if (entry.job_id) {
                        await this.withJob(entry.job_id, () => this.cancelById(entry.job_id!));
                    }
                    break;
                case "cleanup":
                    await this.cleanup((entry.payload ?? {}) as CleanupPayload);
                    break;
                case "purge":
                    await this.purge((entry.payload ?? {}) as PurgePayload);
                    break;
                default:
                    this.report(new Error(`Unknown outbox entry kind '${entry.kind}'`), "outbox");
            }
            await outbox.remove(entry.id);
        } catch (error) {
            if (error instanceof LeaderFenceError) {
                this.handle(error, "outbox");
                return;
            }
            this.report(error, `outbox ${entry.kind}`);
            try {
                await outbox.reschedule(
                    entry.id,
                    galaxyTime(this.now() + backoffMs(entry.attempts)),
                    errorMessage(error),
                );
            } catch (rescheduleError) {
                this.report(rescheduleError, "outbox");
            }
        }
    }

    // -----------------------------------------------------------------------------------------------------
    // Dispatch

    private async dispatch(entry: OutboxRecord): Promise<void> {
        const jobId = entry.job_id;
        const job = jobId ? await jobs.get(jobId) : undefined;
        if (!job) {
            await outbox.remove(entry.id);
            return;
        }
        if (job.state === "deleting") {
            await this.cancel(job);
            await outbox.remove(entry.id);
            return;
        }
        if (!DISPATCHABLE.has(job.state) || job.k8s) {
            await outbox.remove(entry.id);
            return;
        }
        const readiness = await readTx(GATING_READ_STORES, (t) => checkInputs(job, t));
        if (readiness.status === "wait") {
            await outbox.postpone(entry.id, galaxyTime(this.now() + INPUT_RECHECK_MS));
            return;
        }
        if (readiness.status === "pause") {
            await writeTx(JOB_STORES, (t) => pauseJob(job.id, readiness.message, t));
            await outbox.remove(entry.id);
            return;
        }
        if (readiness.status === "fail") {
            await this.failUndispatched(job, { reason: "unknown", message: readiness.message });
            await outbox.remove(entry.id);
            return;
        }
        const first = (entry.payload as DispatchPayload | null)?.attempt ?? 1;
        let plan: DispatchPlan | undefined;
        try {
            for (let attempt = first; attempt < first + SPEC_CONFLICT_RETRIES; attempt++) {
                plan = await this.protocol.prepareDispatch(job, this.deps, { attempt });
                const kubeJob = await this.createKubeJob(job, plan, attempt);
                if (kubeJob) {
                    await this.recordDispatch(job.id, kubeJob, plan, attempt, entry.id);
                    return;
                }
            }
            throw new Error(`Kubernetes Jobs of earlier dispatches of job ${job.id} are in the way.`);
        } catch (error) {
            if (plan?.multipart.length) {
                await this.abortUploads(plan.multipart.map(({ key, uploadId }) => ({ key, upload_id: uploadId })));
            }
            const giveUp =
                isPermanent(error) || (!isTransient(error) && entry.attempts + 1 >= MAX_UNKNOWN_DISPATCH_FAILURES);
            if (!giveUp || error instanceof LeaderFenceError) {
                throw error;
            }
            await this.failUndispatched(job, {
                reason: "rejected",
                message: `The job could not be submitted to the cluster: ${errorMessage(error)}`,
            });
            await outbox.remove(entry.id);
        }
    }

    /**
     * Creates the Kubernetes Job of one attempt. An existing Job of the same name is adopted when its spec hash
     * matches (an earlier dispatch created it but was not recorded); otherwise it is deleted and null returned, so
     * the caller moves on to the next attempt.
     */
    private async createKubeJob(job: JobRecord, plan: DispatchPlan, attempt: number): Promise<KubeJob | null> {
        const spec = await buildJobSpec({
            instanceId: this.settings.instance_id,
            jobId: job.id,
            attempt,
            plan,
            cluster: this.settings.cluster,
        });
        const name = spec.metadata.name!;
        await leader.assertCurrent();
        try {
            return await this.kube.createJob(spec, { signal: this.controller.signal });
        } catch (error) {
            if (!isKubeError(error) || error.status !== 409) {
                throw error;
            }
        }
        const existing = await this.kube.getJob(name, { signal: this.controller.signal });
        const hash = spec.metadata.annotations?.[SPEC_HASH_ANNOTATION];
        if (existing.metadata.annotations?.[SPEC_HASH_ANNOTATION] === hash && !existing.metadata.deletionTimestamp) {
            return existing;
        }
        // Left by an earlier dispatch with other settings: it must not write this job's outputs.
        await this.deleteKubeJob(name);
        return null;
    }

    private async recordDispatch(
        jobId: string,
        kubeJob: KubeJob,
        plan: DispatchPlan,
        attempt: number,
        entryId: string,
    ): Promise<void> {
        const k8s: JobKubernetesInfo = {
            namespace: this.kube.namespace,
            name: kubeJob.metadata.name!,
            uid: kubeJob.metadata.uid ?? null,
            attempt,
            spec_hash: kubeJob.metadata.annotations?.[SPEC_HASH_ANNOTATION] ?? null,
            pod_name: null,
            node_name: null,
            image: plan.kind === "tool" ? plan.toolImage : null,
            kind: plan.kind,
            created: kubeJob.metadata.creationTimestamp ?? null,
            prepared: false,
            tool_termination: null,
            multipart: plan.multipart.map(({ key, uploadId }) => ({ key, upload_id: uploadId })),
        };
        const deleting = await writeTx(JOB_STORES, async (t) => {
            const current = await jobs.get(jobId, t);
            await outbox.remove(entryId, t);
            if (!current) {
                return false;
            }
            if (current.state === "deleting") {
                await jobs.update(jobId, { k8s }, t);
                return true;
            }
            await this.transition(jobId, "queued", { k8s }, t);
            return false;
        });
        this.monitor.remember(kubeJob);
        if (deleting) {
            const job = await jobs.get(jobId);
            if (job) {
                await this.cancel(job);
            }
        }
    }

    /** Fails a job that never reached the cluster, as Galaxy's `JobWrapper.fail`, and pauses its dependents. */
    private async failUndispatched(job: JobRecord, failure: JobFailure): Promise<void> {
        await this.protocol.ingestFailure(job, failure, this.deps);
        await writeTx(JOB_STORES, (t) => pauseDependents(job.id, t));
    }

    /**
     * Galaxy's `JobWrapper.change_state`: sets the job state and moves the job's datasets along. Unfinished jobs
     * only; returns the job.
     */
    private async transition(
        jobId: string,
        state: "queued" | "running",
        patch: Partial<JobRecord>,
        tx: WriteTx,
    ): Promise<JobRecord | undefined> {
        const job = await jobs.get(jobId, tx);
        if (!job || SETTLED.has(job.state) || job.state === "deleting") {
            return job;
        }
        const next = await jobs.update(jobId, { ...patch, state }, tx);
        if (job.state !== state) {
            for (const dataset of await datasets.listForJob(jobId, tx)) {
                if (dataset.state !== state && dataset.state !== "discarded" && !dataset.deleted) {
                    await datasets.update(dataset.id, { state }, tx);
                }
            }
        }
        return next;
    }

    // -----------------------------------------------------------------------------------------------------
    // Monitoring

    /** Brings one job in line with the cluster. Runs under the job's lock. */
    private async evaluate(jobId: string): Promise<void> {
        const job = await jobs.get(jobId);
        const kubeJobs = this.monitor.jobsFor(jobId);
        if (!job) {
            return;
        }
        if (job.state === "deleting") {
            await this.cancel(job);
            return;
        }
        if (!job.k8s && DISPATCHABLE.has(job.state)) {
            // Its dispatch adopts or replaces a Job left by an unrecorded earlier dispatch.
            return;
        }
        if (!job.k8s || !ACTIVE.has(job.state)) {
            // The job settled while no leader watched, or was paused before dispatch.
            for (const kubeJob of kubeJobs) {
                await this.removeKubeJob(kubeJob.metadata.name!);
            }
            this.forgetConsole(job.id, !ACTIVE.has(job.state));
            return;
        }
        const { name, kind } = job.k8s;
        for (const other of kubeJobs) {
            if (other.metadata.name !== name) {
                await this.removeKubeJob(other.metadata.name!);
            }
        }
        const kubeJob = this.monitor.job(name);
        if (!kubeJob) {
            await this.missing(job);
            return;
        }
        const pod = this.monitor.podFor(name);
        const observed = await this.observe(job, pod);
        if (!observed) {
            return;
        }
        if (
            kind === "tool" &&
            !observed.k8s?.prepared &&
            containerTerminated(pod, STAGE_IN_CONTAINER)?.exitCode === 0
        ) {
            await this.applyPrepare(observed);
        }
        if (jobOutcome(kubeJob) || podFinished(kind, pod)) {
            await this.finish(jobId, kubeJob, pod);
            return;
        }
        const pending = pendingFailure(pod, this.now(), (key) => this.firstSeenAt(key));
        if (pending) {
            await this.fail(jobId, kubeJob, pod, pending);
            return;
        }
        if (!pod && this.age(job) >= NO_POD_GRACE_MS) {
            const failure = await this.creationProblem(name);
            if (failure) {
                await this.fail(jobId, kubeJob, undefined, failure);
                return;
            }
        }
        if (observed.state === "running" && pod?.metadata.name && (await this.consoles.wanted(jobId))) {
            await this.consoles.poll(jobId, pod.metadata.name, mainContainer(kind));
        }
    }

    /** Applies `prepare.json` once stage-in succeeded; a failed read is retried at the next check. */
    private async applyPrepare(job: JobRecord): Promise<void> {
        try {
            if ((await this.protocol.readPrepare(job, this.deps)) === null) {
                return;
            }
        } catch (error) {
            if (error instanceof LeaderFenceError) {
                throw error;
            }
            this.report(error, `prepare.json of job ${job.id}`);
            return;
        }
        await writeTx(JOB_STORES, async (t) => {
            const current = await jobs.get(job.id, t);
            if (current?.k8s) {
                await jobs.update(job.id, { k8s: { ...current.k8s, prepared: true } }, t);
            }
        });
    }

    /**
     * Records the pod, the node, how the tool container ended and whether the job runs (its main container
     * started; Galaxy's runners mark a job running when the tool does, not while inputs are staged).
     */
    private async observe(job: JobRecord, pod: Pod | undefined): Promise<JobRecord | undefined> {
        const k8s = job.k8s!;
        const patch: Partial<JobKubernetesInfo> = {};
        if (pod?.metadata.name && pod.metadata.name !== k8s.pod_name) {
            patch.pod_name = pod.metadata.name;
        }
        if (pod?.status?.nodeName && pod.status.nodeName !== k8s.node_name) {
            patch.node_name = pod.status.nodeName;
        }
        const toolEnd = k8s.kind === "tool" ? containerTerminated(pod, TOOL_CONTAINER) : undefined;
        // A replacement pod (after a disruption) starts over: only the current pod's tool counts.
        if (patch.pod_name && k8s.tool_termination) {
            patch.tool_termination = null;
        }
        if (toolEnd && (patch.pod_name || !k8s.tool_termination)) {
            patch.tool_termination = {
                reason: toolEnd.reason ?? null,
                exit_code: toolEnd.exitCode,
                message: toolEnd.message ?? null,
            };
        }
        const running = job.state === "queued" && containerStarted(pod, mainContainer(k8s.kind));
        if (!running && !Object.keys(patch).length) {
            return job;
        }
        return writeTx(JOB_STORES, async (t) => {
            const current = await jobs.get(job.id, t);
            if (!current?.k8s || current.k8s.name !== k8s.name) {
                return undefined;
            }
            const next = { k8s: { ...current.k8s, ...patch } };
            return running ? this.transition(job.id, "running", next, t) : jobs.update(job.id, next, t);
        });
    }

    /** The pod has done all it will do: ingest its results, or classify the failure. */
    private async finish(jobId: string, kubeJob: KubeJob | undefined, pod: Pod | undefined): Promise<void> {
        const job = await jobs.get(jobId);
        if (!job?.k8s) {
            return;
        }
        let outcome: IngestOutcome | null;
        try {
            outcome = await this.protocol.ingestResults(job, this.deps);
        } catch (error) {
            if (!(error instanceof ProtocolError)) {
                throw error;
            }
            // Reading the results again cannot help.
            await this.fail(jobId, kubeJob, pod, {
                reason: "stage_out",
                message: `The job's results could not be read: ${errorMessage(error)}`,
            });
            return;
        }
        if (outcome) {
            await this.settled(job, outcome.state === "error");
            return;
        }
        const failure = classifyFailure(job.k8s.kind, kubeJob, pod);
        if (failure.reason === "stage_in" && job.k8s.attempt < MAX_ATTEMPTS) {
            const prepared = job.k8s.prepared || (await this.protocol.readPrepare(job, this.deps)) !== null;
            if (!prepared) {
                await this.retry(job);
                return;
            }
        }
        await this.fail(jobId, kubeJob, pod, failure);
    }

    /** Starts a new attempt of a job whose stage-in could not read its manifest or inputs. */
    private async retry(job: JobRecord): Promise<void> {
        const k8s = job.k8s!;
        // The next attempt's dispatch aborts this attempt's multipart uploads.
        await this.deleteKubeJob(k8s.name);
        const payload: DispatchPayload = { attempt: k8s.attempt + 1 };
        await writeTx(JOB_STORES, async (t) => {
            const current = await jobs.get(job.id, t);
            if (current?.k8s?.name === k8s.name && ACTIVE.has(current.state)) {
                await jobs.update(job.id, { k8s: null }, t);
                await outbox.enqueue({ kind: "dispatch", job_id: job.id, payload }, t);
            }
        });
    }

    /**
     * Fails a dispatched job: keeps the tool container's log (fetched before the pod goes), hands the failure to
     * the protocol module (which also aborts the attempt's multipart uploads), pauses dependent jobs and deletes
     * the Job.
     */
    private async fail(
        jobId: string,
        kubeJob: KubeJob | undefined,
        pod: Pod | undefined,
        failure: JobFailure,
    ): Promise<void> {
        const job = await jobs.get(jobId);
        if (!job?.k8s) {
            return;
        }
        const main = mainContainer(job.k8s.kind);
        const podName = pod?.metadata.name;
        if (podName && failure.toolStdout === undefined && containerStarted(pod, main)) {
            try {
                failure.toolStdout = await this.kube.getPodLog(podName, {
                    container: main,
                    limitBytes: LOG_LIMIT_BYTES,
                    tailLines: LOG_TAIL_LINES,
                    signal: this.controller.signal,
                });
            } catch (error) {
                this.report(error, `log of job ${jobId}`);
            }
        }
        await this.protocol.ingestFailure(job, failure, this.deps);
        await this.settled(job, true, kubeJob === undefined);
    }

    /** After results or a failure were recorded: pause dependents of failed jobs and delete the Kubernetes Job. */
    private async settled(job: JobRecord, failed: boolean, gone = false): Promise<void> {
        if (failed) {
            await writeTx(JOB_STORES, (t) => pauseDependents(job.id, t));
        }
        if (!gone && job.k8s) {
            await this.removeKubeJob(job.k8s.name);
        }
        this.forgetConsole(job.id, true);
    }

    /** The job's Kubernetes Job is not in the caches: look it up, then recover its results or fail the job. */
    private async missing(job: JobRecord): Promise<void> {
        if (!this.synced || this.age(job) < MISSING_JOB_GRACE_MS) {
            return;
        }
        const name = job.k8s!.name;
        let kubeJob: KubeJob | undefined;
        try {
            kubeJob = await this.kube.getJob(name, { signal: this.controller.signal });
        } catch (error) {
            if (!isKubeError(error) || error.status !== 404) {
                throw error;
            }
        }
        if (kubeJob) {
            this.monitor.remember(kubeJob);
            this.scheduled.delete(job.id);
            this.schedule(job.id);
            return;
        }
        // Deleted by the TTL controller after it finished, or by someone else.
        const outcome = await this.protocol.ingestResults(job, this.deps);
        if (outcome) {
            await this.settled(job, outcome.state === "error", true);
            return;
        }
        await this.fail(job.id, undefined, undefined, { reason: "deleted", message: FAILURE_MESSAGES.deleted });
    }

    /** Reads the Job's events when it has no pod: a pod creation the API server keeps refusing fails the job. */
    private async creationProblem(name: string): Promise<JobFailure | null> {
        const last = this.eventChecks.get(name) ?? 0;
        if (this.now() - last < EVENTS_RECHECK_MS) {
            return null;
        }
        this.eventChecks.set(name, this.now());
        const events = await this.kube.listEvents({
            fieldSelector: `involvedObject.kind=Job,involvedObject.name=${name}`,
            signal: this.controller.signal,
        });
        const result = failedCreate(events.items, parseQuantity);
        return result === "wait" ? null : result;
    }

    /** Milliseconds since the job's Kubernetes Job was created (or the job last changed). */
    private age(job: JobRecord): number {
        const created = job.k8s?.created ? Date.parse(job.k8s.created) : Number.NaN;
        const since = Number.isFinite(created) ? created : parseGalaxyTime(job.update_time) / 1000;
        return this.now() - since;
    }

    private firstSeenAt(key: string): number {
        let time = this.firstSeen.get(key);
        if (time === undefined) {
            time = this.now();
            this.firstSeen.set(key, time);
        }
        return time;
    }

    // -----------------------------------------------------------------------------------------------------
    // Cancel, cleanup, purge

    private async cancelById(jobId: string): Promise<void> {
        const job = await jobs.get(jobId);
        if (job?.state === "deleting") {
            await this.cancel(job);
        }
    }

    /** Galaxy's job stop: deletes the Kubernetes Jobs, aborts uploads and marks the job `deleted`. */
    private async cancel(job: JobRecord): Promise<void> {
        const names = new Set(this.monitor.jobsFor(job.id).map((kubeJob) => kubeJob.metadata.name!));
        if (job.k8s) {
            names.add(job.k8s.name);
        }
        for (const name of names) {
            await this.deleteKubeJob(name);
        }
        await this.abortUploads(job.k8s?.multipart ?? []);
        await writeTx(JOB_STORES, async (t) => {
            const current = await jobs.get(job.id, t);
            if (current?.state === "deleting") {
                await jobs.update(job.id, { state: "deleted" }, t);
            }
            await outbox.removeForJob(job.id, "dispatch", t);
            await outbox.removeForJob(job.id, "cancel", t);
        });
        this.forgetConsole(job.id, true);
    }

    private async cleanup(payload: CleanupPayload): Promise<void> {
        const prefix = `planet-${this.settings.instance_id}-`;
        // Only this instance's Jobs: other Jobs in the namespace are not Planet's to delete.
        for (const name of (payload.k8s_jobs ?? []).filter((each) => each.startsWith(prefix))) {
            await this.deleteKubeJob(name);
        }
        for (const upload of payload.multipart ?? []) {
            await this.deps.s3.abortMultipartUpload(upload.key, upload.upload_id);
        }
    }

    /** Deletes the bucket objects of purged datasets (`datasets/<uuid>/`). */
    private async purge(payload: PurgePayload): Promise<void> {
        const uuids = new Set(payload.uuids ?? []);
        for (const id of payload.dataset_ids ?? []) {
            const dataset = await datasets.get(id);
            // Datasets that are not purged (an undelete, another copy) keep their objects.
            if (dataset?.purged) {
                uuids.add(dataset.uuid);
            }
        }
        for (const uuid of uuids) {
            if (!UUID_PATTERN.test(uuid)) {
                continue;
            }
            let token: string | undefined;
            do {
                const page = await this.deps.s3.listObjects(`datasets/${uuid}/`, { continuationToken: token });
                for (const object of page.objects) {
                    await this.deps.s3.deleteObject(object.key);
                }
                token = page.isTruncated ? (page.nextContinuationToken ?? undefined) : undefined;
            } while (token);
        }
    }

    /** Deletes a Kubernetes Job and its pods. Throws when the API cannot be reached. */
    private async deleteKubeJob(name: string): Promise<void> {
        await leader.assertCurrent();
        await this.kube.deleteJob(name, { signal: this.controller.signal });
        this.monitor.forget(name);
        this.eventChecks.delete(name);
    }

    /** Deletes a Kubernetes Job that is no longer needed; on failure a cleanup entry retries it. */
    private async removeKubeJob(name: string): Promise<void> {
        try {
            await this.deleteKubeJob(name);
        } catch (error) {
            this.report(error, `delete ${name}`);
            await outbox.enqueue({ kind: "cleanup", payload: { k8s_jobs: [name] } satisfies CleanupPayload });
        }
    }

    private async abortUploads(uploads: readonly JobMultipartUpload[]): Promise<void> {
        const failed: JobMultipartUpload[] = [];
        for (const upload of uploads) {
            try {
                await this.deps.s3.abortMultipartUpload(upload.key, upload.upload_id);
            } catch (error) {
                this.report(error, "abort upload");
                failed.push(upload);
            }
        }
        if (failed.length) {
            await outbox.enqueue({ kind: "cleanup", payload: { multipart: failed } satisfies CleanupPayload });
        }
    }

    // -----------------------------------------------------------------------------------------------------
    // Console, events, bookkeeping

    private async consoleTick(): Promise<void> {
        if (!this.running) {
            return;
        }
        try {
            for (const job of await jobs.listByState(["running"])) {
                if (job.k8s?.pod_name && (await this.consoles.wanted(job.id))) {
                    const pod = job.k8s.pod_name;
                    const container = mainContainer(job.k8s.kind);
                    await this.withJob(job.id, () => this.consoles.poll(job.id, pod, container));
                }
            }
        } catch (error) {
            this.handle(error, "console");
        }
    }

    private forgetConsole(jobId: string, finished: boolean): void {
        this.consoles.forget(jobId);
        if (finished) {
            void jobs.clearConsoleRequest(jobId).catch((error: unknown) => this.report(error, "console"));
        }
    }

    private onEvent(event: PlanetEvent): void {
        switch (event.type) {
            case "outbox-changed":
                void this.drainOutbox();
                break;
            case "job-created":
                this.track(this.ensureDispatch(event.jobId).then(() => this.drainOutbox(true)));
                break;
            case "job-changed":
                if (event.state === "deleting") {
                    this.schedule(event.jobId);
                } else {
                    this.wake();
                }
                break;
            case "history-changed":
                this.wake();
                break;
            default:
                break;
        }
    }

    /** Gives dispatches waiting for their inputs another look soon (inputs changed). */
    private wake(): void {
        if (!this.running || this.wakeTimer) {
            return;
        }
        const delay = Math.max(0, this.lastWake + WAKE_THROTTLE_MS - this.now());
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = null;
            this.lastWake = this.now();
            void this.drainOutbox(true);
        }, delay);
    }

    /** Makes sure an undispatched job (for example one resumed from `paused`) has a dispatch entry. */
    private async ensureDispatch(jobId: string): Promise<void> {
        try {
            const job = await jobs.get(jobId);
            if (!job || job.k8s || !DISPATCHABLE.has(job.state)) {
                return;
            }
            const entries = await outbox.listForJob(jobId);
            if (!entries.some((entry) => entry.kind === "dispatch")) {
                await outbox.enqueue({ kind: "dispatch", job_id: jobId });
            }
        } catch (error) {
            this.handle(error, `job ${jobId}`);
        }
    }

    /** Runs `fn` after every earlier call for the same job has finished. */
    private async withJob<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(jobId) ?? Promise.resolve();
        let release!: () => void;
        const current = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
        this.locks.set(jobId, current);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this.locks.get(jobId) === current) {
                this.locks.delete(jobId);
            }
        }
    }

    private track(promise: Promise<unknown>): void {
        const tracked = promise.catch((error: unknown) => this.handle(error, "task"));
        this.inFlight.add(tracked);
        void tracked.finally(() => this.inFlight.delete(tracked));
    }

    private handle(error: unknown, context: string): void {
        if (error instanceof LeaderFenceError) {
            if (this.running) {
                this.options.onFenced?.();
            }
            return;
        }
        this.report(error, context);
    }

    private report(error: unknown, context: string): void {
        if (this.controller.signal.aborted && !this.running) {
            return;
        }
        if (this.options.onError) {
            this.options.onError(error, context);
        } else {
            console.warn(`Planet job manager (${context}): ${errorMessage(error)}`);
        }
    }
}
