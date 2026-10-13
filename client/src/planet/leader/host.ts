/**
 * Runs job processing in a Planet tab: joins the leader election and, while this tab leads and the cluster and
 * storage settings are complete, runs a {@link JobManager}. Settings changes restart it; visibility and network
 * changes trigger a reconciliation. The leader keeps the status record (`kv` `leader_status`) current.
 */

import { settings } from "@/planet/db";
import { resolveToolImage } from "@/planet/jobs/containers";
import { createJobDeps, type JobDeps, type JobDepsOptions } from "@/planet/jobs/deps";
import { errorMessage } from "@/planet/jobs/failures";
import { runtimeImage } from "@/planet/jobs/k8sJob";
import { type ChannelLike, LeaderElection, type LockManagerLike } from "@/planet/jobs/leader";
import { JobManager, type JobManagerOptions, type JobProtocol } from "@/planet/jobs/manager";
import { LeaderStatus } from "@/planet/jobs/status";
import { createKubeClient, type KubeClient, type KubeClientConfig } from "@/planet/k8s";
import { loadBuildRuntimeImage } from "@/planet/ui/lib/runtime";
import { subscribeTo } from "@/planet/util/events";

/** The page events the host listens to. */
export interface HostWindow {
    addEventListener(type: "online" | "pagehide" | "pageshow", listener: (event: Event) => void): void;
    removeEventListener(type: "online" | "pagehide" | "pageshow", listener: (event: Event) => void): void;
    document: {
        visibilityState: DocumentVisibilityState;
        addEventListener(type: "visibilitychange", listener: () => void): void;
        removeEventListener(type: "visibilitychange", listener: () => void): void;
    };
}

export interface LeaderHostOptions {
    window: HostWindow;
    locks: LockManagerLike;
    channel: ChannelLike;
    protocol: JobProtocol;
    createKube?: (config: KubeClientConfig) => KubeClient;
    createDeps?: (options: JobDepsOptions) => Promise<JobDeps | null>;
    /** Reads this build's runtime image; defaults to `loadBuildRuntimeImage`. */
    loadBuildImage?: () => Promise<string | null>;
    /** Extra manager options (tests). */
    manager?: Partial<Pick<JobManagerOptions, "now" | "sleep" | "onError">>;
}

export class LeaderHost {
    readonly election: LeaderElection;
    private current: JobManager | null = null;
    private status: LeaderStatus | null = null;
    private controller: AbortController | null = null;
    private queue: Promise<void> = Promise.resolve();
    private unsubscribe: (() => void) | null = null;
    private started = false;

    private readonly onVisibility = () => {
        this.election.visibilityChanged();
        if (this.options.window.document.visibilityState === "visible") {
            void this.current?.reconcile();
        }
    };
    private readonly onOnline = () => void this.current?.reconcile();
    private readonly onPageHide = () => void this.stop();
    private readonly onPageShow = (event: Event) => {
        if ((event as PageTransitionEvent).persisted) {
            this.start();
        }
    };

    constructor(private readonly options: LeaderHostOptions) {
        this.election = new LeaderElection({
            locks: options.locks,
            channel: options.channel,
            visible: () => options.window.document.visibilityState === "visible",
            onLead: (epoch) => {
                this.status = new LeaderStatus(epoch, this.election.tabId, Date.now, (error) =>
                    console.warn(`Planet job status: ${errorMessage(error)}`),
                );
                return this.enqueue(() => this.startManager());
            },
            onDemote: () => {
                this.status = null;
                return this.enqueue(() => this.stopManager());
            },
            onHeartbeat: (epoch) => {
                if (this.status?.epoch === epoch) {
                    return this.status.write().then(() => undefined);
                }
            },
        });
    }

    /** The status reporter of the current leadership, if this tab leads. */
    get leaderStatus(): LeaderStatus | null {
        return this.status;
    }

    /** The running job manager, if this tab leads and the settings are complete. */
    get manager(): JobManager | null {
        return this.current;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        const { window } = this.options;
        window.document.addEventListener("visibilitychange", this.onVisibility);
        window.addEventListener("online", this.onOnline);
        window.addEventListener("pagehide", this.onPageHide);
        window.addEventListener("pageshow", this.onPageShow);
        this.unsubscribe = subscribeTo("settings-changed", () => {
            if (this.election.isLeader) {
                void this.enqueue(async () => {
                    await this.stopManager();
                    await this.startManager();
                });
            }
        });
        this.election.start();
    }

    /** Leaves the election and stops job processing (on page hide; `pageshow` from the back/forward cache rejoins). */
    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.started = false;
        const { window } = this.options;
        window.document.removeEventListener("visibilitychange", this.onVisibility);
        window.removeEventListener("online", this.onOnline);
        window.removeEventListener("pagehide", this.onPageHide);
        // pageshow stays registered so a page restored from the back/forward cache rejoins.
        this.unsubscribe?.();
        this.unsubscribe = null;
        await this.election.stop();
        await this.enqueue(() => this.stopManager());
    }

    /** Resolves once pending starts and stops have run. */
    settled(): Promise<void> {
        return this.queue;
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        this.queue = this.queue
            .then(task)
            .catch((error: unknown) => console.warn(`Planet job processing: ${errorMessage(error)}`));
        return this.queue;
    }

    private async startManager(): Promise<void> {
        if (this.current || !this.election.isLeader) {
            return;
        }
        const status = this.status;
        const current = await settings.get();
        const configured = settings.configured(current);
        if (!configured.cluster || !configured.storage) {
            await status?.setBlocked(
                configured.cluster ? "The storage settings are incomplete." : "The cluster settings are incomplete.",
            );
            return;
        }
        const [stored, secrets] = await Promise.all([settings.getStored(), settings.getSecrets()]);
        const token = secrets.cluster_token;
        if (!token) {
            await status?.setBlocked("No cluster token is stored.");
            return;
        }
        let buildImage: string | null;
        try {
            buildImage = await (this.options.loadBuildImage ?? loadBuildRuntimeImage)();
        } catch (error) {
            // Only a page of another build fails here; it is offered a reload.
            await status?.setBlocked(`This tab cannot read its build's runtime image: ${errorMessage(error)}`);
            return;
        }
        const controller = new AbortController();
        const runtime = runtimeImage(stored.cluster, buildImage);
        const deps = await (this.options.createDeps ?? createJobDeps)({
            resolveContainer: (bundle) => resolveToolImage(bundle, runtime, { signal: controller.signal }),
            signal: controller.signal,
        });
        if (!deps) {
            await status?.setBlocked("The storage settings are incomplete.");
            return;
        }
        if (!this.election.isLeader) {
            return;
        }
        const kube = (this.options.createKube ?? defaultKubeClient)({
            gatewayUrl: stored.cluster.gateway_url,
            namespace: stored.cluster.namespace,
            token,
        });
        this.controller = controller;
        const onError = this.options.manager?.onError;
        this.current = new JobManager({
            ...this.options.manager,
            kube,
            deps,
            protocol: this.options.protocol,
            settings: stored,
            buildRuntimeImage: buildImage,
            onFenced: () => void this.enqueue(() => this.stopManager()),
            onError: (error, context, jobId) => {
                if (onError) {
                    onError(error, context, jobId);
                } else {
                    console.warn(`Planet job manager (${context}): ${errorMessage(error)}`);
                }
                void status?.recordError(error, jobId ?? null);
            },
            onClusterStatus: (problem) => void status?.setClusterProblem(problem),
        });
        this.current.start();
        void status?.setBlocked(null);
    }

    private async stopManager(): Promise<void> {
        const manager = this.current;
        this.current = null;
        this.controller?.abort();
        this.controller = null;
        await manager?.stop();
    }
}

function defaultKubeClient(config: KubeClientConfig): KubeClient {
    return createKubeClient(config, {
        onWarning: (warnings) => warnings.forEach((warning) => console.warn(`Kubernetes: ${warning}`)),
    });
}
