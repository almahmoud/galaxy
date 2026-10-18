/**
 * Runs backup cycles in the leading tab: shortly after it starts leading, once a minute (a cycle does nothing
 * until a snapshot is due or requested, see `runBackup`), and when the Service Worker announces a request on
 * {@link BACKUP_CHANNEL}.
 */

import type { S3Client, S3Config } from "@/planet/s3";

import { type BackupOutcome, runBackup } from "./snapshot";
import { BACKUP_CHANNEL } from "./state";

/** Work the leader host runs while its tab leads. */
export interface LeaderTask {
    start(epoch: number): void;
    stop(): Promise<void>;
}

export const TICK_MS = 60_000;
export const FIRST_RUN_MS = 15_000;

interface NudgeChannel {
    onmessage: ((event: MessageEvent) => void) | null;
    close(): void;
}

export interface BackupSchedulerOptions {
    s3Client?: (config: S3Config) => S3Client;
    now?: () => number;
    /** Opens the request channel; null when the browser has no BroadcastChannel. */
    channel?: () => NudgeChannel | null;
    run?: typeof runBackup;
    onError?: (error: unknown) => void;
}

function defaultChannel(): NudgeChannel | null {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(BACKUP_CHANNEL) : null;
}

export class BackupScheduler implements LeaderTask {
    private epoch: number | null = null;
    private timers: ReturnType<typeof setTimeout>[] = [];
    private interval: ReturnType<typeof setInterval> | null = null;
    private channel: NudgeChannel | null = null;
    private controller: AbortController | null = null;
    private running: Promise<BackupOutcome | null> | null = null;
    private again = false;

    constructor(private readonly options: BackupSchedulerOptions = {}) {}

    start(epoch: number): void {
        if (this.epoch !== null) {
            return;
        }
        this.epoch = epoch;
        this.controller = new AbortController();
        this.timers.push(setTimeout(() => void this.tick(), FIRST_RUN_MS));
        this.interval = setInterval(() => void this.tick(), TICK_MS);
        this.channel = (this.options.channel ?? defaultChannel)();
        if (this.channel) {
            this.channel.onmessage = (event) => {
                if ((event.data as { type?: unknown } | null)?.type === "snapshot-requested") {
                    void this.tick();
                }
            };
        }
    }

    async stop(): Promise<void> {
        if (this.epoch === null) {
            return;
        }
        this.epoch = null;
        this.timers.forEach(clearTimeout);
        this.timers = [];
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.channel) {
            this.channel.onmessage = null;
            this.channel.close();
            this.channel = null;
        }
        this.controller?.abort();
        this.controller = null;
        await this.running;
    }

    /** Runs one cycle now, or right after the running one. Resolves with its outcome, null when stopped. */
    async tick(): Promise<BackupOutcome | null> {
        if (this.running) {
            this.again = true;
            return this.running;
        }
        const epoch = this.epoch;
        const signal = this.controller?.signal;
        if (epoch === null || !signal) {
            return null;
        }
        this.running = (this.options.run ?? runBackup)({
            epoch,
            signal,
            s3Client: this.options.s3Client,
            now: this.options.now,
        })
            .catch((error: unknown) => {
                (this.options.onError ?? ((reason) => console.warn("Planet backup failed", reason)))(error);
                return null;
            })
            .finally(() => {
                this.running = null;
                if (this.again && this.epoch !== null) {
                    this.again = false;
                    void this.tick();
                }
            });
        return this.running;
    }
}
