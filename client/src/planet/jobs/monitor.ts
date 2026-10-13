/**
 * Mirrors the Kubernetes Jobs and Pods of this Planet instance: one list, then one watch stream per kind (two
 * long-lived requests in all), resumed from the last resourceVersion and re-listed when it expired or the
 * stream failed. Network callbacks are not throttled in background tabs, so the streams keep working there;
 * {@link ClusterMonitor.resync} re-lists on demand (leadership, visibility, online, every minute).
 */

import { isExpired, type Job as KubeJob, type KubeClient, type Pod, type WatchEvent } from "@/planet/k8s";

import { instanceSelector, LABEL_JOB_ID } from "./k8sJob";

/** Server-side watch duration; below Cloudflare's 125 s response limit (see `WatchOptions`). */
export const WATCH_TIMEOUT_SECONDS = 55;
const MAX_BACKOFF_MS = 60_000;

type Kind = "jobs" | "pods";

export interface ClusterMonitorOptions {
    /** Called with the Planet job id of every Job or Pod that was added, changed or removed. */
    onChange: (jobId: string) => void;
    /** Called when a stream fails; the monitor retries on its own. */
    onError?: (error: unknown) => void;
    /** Waits `ms` or until the signal aborts (tests replace it). */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
    });
}

function planetJobId(object: { metadata?: { labels?: Record<string, string> } }): string | undefined {
    return object.metadata?.labels?.[LABEL_JOB_ID];
}

export class ClusterMonitor {
    private readonly jobs = new Map<string, KubeJob>();
    private readonly pods = new Map<string, Pod>();
    private readonly versions: Record<Kind, string> = { jobs: "", pods: "" };
    private readonly selector: string;
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    private controller: AbortController | null = null;
    private loops: Promise<void>[] = [];
    private listed = false;

    constructor(
        private readonly kube: KubeClient,
        instanceId: string,
        private readonly options: ClusterMonitorOptions,
    ) {
        this.selector = instanceSelector(instanceId);
        this.sleep = options.sleep ?? defaultSleep;
    }

    /** True once both kinds have been listed at least once. */
    get ready(): boolean {
        return this.listed;
    }

    /** Starts the two watch streams. Call {@link resync} first to have the caches filled. */
    start(): void {
        if (this.controller) {
            return;
        }
        this.controller = new AbortController();
        const signal = this.controller.signal;
        this.loops = (["jobs", "pods"] as const).map((kind) => this.watchLoop(kind, signal));
    }

    /** Stops the streams and waits for them to end. */
    async stop(): Promise<void> {
        this.controller?.abort();
        this.controller = null;
        await Promise.all(this.loops);
        this.loops = [];
    }

    /** Lists Jobs and Pods again, replacing the caches and reporting every job whose objects changed. */
    async resync(signal?: AbortSignal): Promise<void> {
        await Promise.all([this.list("jobs", signal), this.list("pods", signal)]);
        this.listed = true;
    }

    /** Kubernetes Jobs of a Planet job, every attempt. */
    jobsFor(jobId: string): KubeJob[] {
        return [...this.jobs.values()].filter((job) => planetJobId(job) === jobId);
    }

    /** A Kubernetes Job by name. */
    job(name: string): KubeJob | undefined {
        return this.jobs.get(name);
    }

    /** Records a Job this leader created or read, so it is known before its watch event arrives. */
    remember(job: KubeJob): void {
        const name = job.metadata.name;
        if (name) {
            this.jobs.set(name, job);
        }
    }

    /** Forgets a Job this leader deleted. */
    forget(name: string): void {
        this.jobs.delete(name);
    }

    /** The newest pod of a Kubernetes Job (the replacement after a disruption, if any). */
    podFor(jobName: string): Pod | undefined {
        let newest: Pod | undefined;
        for (const pod of this.pods.values()) {
            if (pod.metadata.labels?.["batch.kubernetes.io/job-name"] !== jobName && !ownedBy(pod, jobName)) {
                continue;
            }
            if (!newest || (pod.metadata.creationTimestamp ?? "") > (newest.metadata.creationTimestamp ?? "")) {
                newest = pod;
            }
        }
        return newest;
    }

    /** Planet job ids with Kubernetes objects. */
    knownJobIds(): Set<string> {
        const ids = new Set<string>();
        for (const object of [...this.jobs.values(), ...this.pods.values()]) {
            const id = planetJobId(object);
            if (id) {
                ids.add(id);
            }
        }
        return ids;
    }

    private cache(kind: Kind): Map<string, KubeJob | Pod> {
        return kind === "jobs" ? this.jobs : this.pods;
    }

    private async list(kind: Kind, signal?: AbortSignal): Promise<void> {
        const list =
            kind === "jobs"
                ? await this.kube.listJobs(this.selector, { signal })
                : await this.kube.listPods(this.selector, { signal });
        const cache = this.cache(kind);
        const changed = new Set<string>();
        const seen = new Set<string>();
        for (const item of list.items) {
            const name = item.metadata.name;
            if (!name) {
                continue;
            }
            seen.add(name);
            const cached = cache.get(name);
            if (!cached || isNewer(item.metadata.resourceVersion, cached.metadata.resourceVersion)) {
                cache.set(name, item);
                addId(changed, item);
            }
        }
        for (const [name, item] of cache) {
            if (!seen.has(name)) {
                cache.delete(name);
                addId(changed, item);
            }
        }
        this.versions[kind] = list.metadata.resourceVersion ?? "";
        changed.forEach((id) => this.options.onChange(id));
    }

    private apply(kind: Kind, event: WatchEvent<KubeJob | Pod>): void {
        if (event.type === "BOOKMARK" || event.type === "ERROR") {
            return;
        }
        const name = event.object.metadata.name;
        if (!name) {
            return;
        }
        const cache = this.cache(kind);
        if (event.type === "DELETED") {
            cache.delete(name);
        } else {
            cache.set(name, event.object);
        }
        const id = planetJobId(event.object);
        if (id) {
            this.options.onChange(id);
        }
    }

    private async watchLoop(kind: Kind, signal: AbortSignal): Promise<void> {
        let failures = 0;
        while (!signal.aborted) {
            try {
                if (!this.versions[kind]) {
                    await this.list(kind, signal);
                }
                const handler = (event: WatchEvent<KubeJob | Pod>) => this.apply(kind, event);
                const options = { timeoutSeconds: WATCH_TIMEOUT_SECONDS };
                const result =
                    kind === "jobs"
                        ? await this.kube.watchJobs(this.selector, this.versions.jobs, handler, signal, options)
                        : await this.kube.watchPods(this.selector, this.versions.pods, handler, signal, options);
                this.versions[kind] = result.resourceVersion;
                if (result.end === "interrupted") {
                    // Changes may have been missed while the connection was down.
                    this.versions[kind] = "";
                    failures += 1;
                    await this.sleep(backoff(failures), signal);
                } else {
                    failures = 0;
                }
            } catch (error) {
                if (signal.aborted) {
                    break;
                }
                this.versions[kind] = "";
                if (!isExpired(error)) {
                    failures += 1;
                    this.options.onError?.(error);
                    await this.sleep(backoff(failures), signal);
                }
            }
        }
    }
}

/**
 * True when `candidate` is a later version than `current`. Resource versions are opaque, but where both are
 * integers (etcd revisions) a list result older than a watch event already applied must not replace it.
 */
function isNewer(candidate: string | undefined, current: string | undefined): boolean {
    if (candidate === current) {
        return false;
    }
    if (candidate && current && /^\d+$/.test(candidate) && /^\d+$/.test(current)) {
        return BigInt(candidate) > BigInt(current);
    }
    return true;
}

function backoff(failures: number): number {
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 6));
}

function ownedBy(pod: Pod, jobName: string): boolean {
    return Boolean(pod.metadata.ownerReferences?.some((owner) => owner.kind === "Job" && owner.name === jobName));
}

function addId(ids: Set<string>, object: KubeJob | Pod): void {
    const id = planetJobId(object);
    if (id) {
        ids.add(id);
    }
}
