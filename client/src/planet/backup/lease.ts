/**
 * The instance lease (`state/<instance>/lease.json`): the one device that runs an instance's jobs and writes its
 * snapshots. Two devices hold the same instance only after a restore that continues it; a device takes a missing
 * lease, and another device's only when the user chooses to continue the instance there.
 *
 * {@link InstanceLease} runs in the leading tab. It reads the lease every {@link LEASE_CHECK_MS} and tells the leader
 * host whether this device may run jobs: only while it holds the lease and read it within {@link LEASE_VALID_MS}, and,
 * after taking it from another device, only {@link TAKE_OVER_GRACE_MS} later, when that device has stopped too. It
 * also writes the marker of a fork the origin instance has not been told of (`forks.ts`).
 */

import { assertCurrent as assertLeader } from "@/planet/db/leader";
import * as settings from "@/planet/db/settings";
import type { StoredSettings } from "@/planet/db/types";
import type { S3Client, S3Config } from "@/planet/s3";
import { subscribeTo } from "@/planet/util/events";

import { backupClient, bucketRef, LEASE_FORMAT, type LeaseRecord, readLease, writeLease } from "./bucket";
import { registerFork } from "./forks";
import { BACKUP_CHANNEL, deviceId, type LeaseInfo, readState, updateState } from "./state";

/** How often the leading tab reads the lease. Background tabs run timers about once a minute. */
export const LEASE_CHECK_MS = 60_000;
/** How long a confirmed lease lets jobs run without another successful read. */
export const LEASE_VALID_MS = 3 * 60_000;
/** How long a device that took the lease from another device waits before running jobs. */
export const TAKE_OVER_GRACE_MS = LEASE_VALID_MS + 30_000;
/** How old the lease may get before the holder renews it. */
export const LEASE_RENEW_MS = 60 * 60 * 1000;

export const LEASE_CONFLICT_MESSAGE = "Another device runs jobs for this instance.";

/**
 * Reads the lease and takes it when it is free, ours, or `takeOver` is set. A lease taken from another device names
 * that device, so every reader of the lease knows when this device took it over (`taken_over`).
 */
export async function acquireLease(
    s3: S3Client,
    instanceId: string,
    device: string,
    options: { takeOver: boolean; now: number; assertCurrent: () => Promise<void>; signal?: AbortSignal },
): Promise<LeaseInfo> {
    const { takeOver, now, assertCurrent, signal } = options;
    const current = await readLease(s3, instanceId, signal);
    const conflict = (lease: LeaseRecord): LeaseInfo => ({
        state: "conflict",
        device_id: lease.device_id,
        renewed: lease.renewed,
        checked: now,
        taken_over: null,
    });
    const held = (lease: LeaseRecord): LeaseInfo => ({
        state: "held",
        device_id: device,
        renewed: lease.renewed,
        checked: now,
        taken_over: lease.taken_from ? Date.parse(lease.acquired) : null,
    });
    if (current && current.device_id !== device && !takeOver) {
        return conflict(current);
    }
    const ours = current?.device_id === device;
    if (ours && now - Date.parse(current.renewed) < LEASE_RENEW_MS) {
        return held(current);
    }
    const time = new Date(now).toISOString();
    const lease: LeaseRecord = {
        format: LEASE_FORMAT,
        version: 1,
        instance_id: instanceId,
        device_id: device,
        acquired: ours ? current.acquired : time,
        renewed: time,
        taken_from: ours ? (current.taken_from ?? null) : (current?.device_id ?? null),
    };
    await assertCurrent();
    await writeLease(s3, lease, signal);
    const written = await readLease(s3, instanceId, signal);
    if (written && written.device_id !== device) {
        return conflict(written);
    }
    return held(lease);
}

/** The lease as the leading tab last read it, for the instance and bucket in `key`. */
export type LeaseView =
    | { state: "checking"; key: string | null }
    | { state: "unconfigured"; key: string | null }
    | { state: "held"; key: string; confirmed: number; ready: number }
    | { state: "conflict"; key: string; device_id: string; renewed: string | null }
    | { state: "failed"; key: string; message: string; confirmed: number | null; ready: number };

interface NudgeChannel {
    onmessage: ((event: MessageEvent) => void) | null;
    close(): void;
}

export interface InstanceLeaseOptions {
    s3Client?: (config: S3Config) => S3Client;
    /** Milliseconds since the epoch. */
    now?: () => number;
    /** Opens the channel the Service Worker announces take-overs and snapshot requests on. */
    channel?: () => NudgeChannel | null;
    /** Throws once this tab no longer leads; defaults to `leader.assertCurrent`. */
    assertCurrent?: () => Promise<void>;
    onError?: (error: unknown) => void;
}

function leaseKeyOf(stored: StoredSettings): string {
    return `${stored.instance_id}|${bucketRef(stored.storage)}`;
}

function errorText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}

function minutes(ms: number): string {
    const count = Math.max(1, Math.ceil(ms / 60_000));
    return count === 1 ? "a minute" : `${count} minutes`;
}

function defaultChannel(): NudgeChannel | null {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(BACKUP_CHANNEL) : null;
}

/** Keeps track of the instance lease while this tab leads. See the module comment. */
export class InstanceLease {
    private current: LeaseView = { state: "checking", key: null };
    private epoch: number | null = null;
    private interval: ReturnType<typeof setInterval> | null = null;
    private readyTimer: ReturnType<typeof setTimeout> | null = null;
    private channel: NudgeChannel | null = null;
    private unsubscribe: (() => void) | null = null;
    private controller: AbortController | null = null;
    private checking: Promise<void> | null = null;
    private again = false;
    private readonly listeners = new Set<() => void>();
    private readonly now: () => number;

    constructor(private readonly options: InstanceLeaseOptions = {}) {
        this.now = options.now ?? Date.now;
    }

    get view(): LeaseView {
        return this.current;
    }

    /** Calls `listener` after each check of the lease and when a take-over's wait ends. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    start(epoch: number): void {
        if (this.epoch !== null) {
            return;
        }
        this.epoch = epoch;
        this.controller = new AbortController();
        this.interval = setInterval(() => void this.refresh(), LEASE_CHECK_MS);
        this.channel = (this.options.channel ?? defaultChannel)();
        if (this.channel) {
            this.channel.onmessage = () => void this.refresh();
        }
        this.unsubscribe = subscribeTo("settings-changed", () => void this.refresh());
        void this.refresh();
    }

    async stop(): Promise<void> {
        if (this.epoch === null) {
            return;
        }
        this.epoch = null;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.clearReadyTimer();
        if (this.channel) {
            this.channel.onmessage = null;
            this.channel.close();
            this.channel = null;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.controller?.abort();
        this.controller = null;
        await this.checking;
        this.current = { state: "checking", key: null };
    }

    /**
     * Why this device may not run the jobs of `stored`'s instance now, or null when it may: it holds the lease, read
     * it within {@link LEASE_VALID_MS}, and a take-over's wait is over.
     */
    problem(stored: StoredSettings, now: number = this.now()): string | null {
        const view = this.current;
        if (view.key !== leaseKeyOf(stored) || view.state === "checking" || view.state === "unconfigured") {
            return "Checking which device runs this instance's jobs…";
        }
        if (view.state === "conflict") {
            return `${LEASE_CONFLICT_MESSAGE} To run them on this device, choose Continue here under Backups.`;
        }
        const confirmed = view.confirmed;
        if (confirmed === null || now - confirmed >= LEASE_VALID_MS) {
            const reason = view.state === "failed" ? `: ${view.message}` : ".";
            return `The bucket could not be read to confirm that this device runs this instance's jobs${reason}`;
        }
        if (now < view.ready) {
            return `This device took the instance over from another device; its jobs start here in ${minutes(view.ready - now)}, once that device has stopped.`;
        }
        return null;
    }

    /** Reads the lease now; calls made while a read runs share one more read. */
    refresh(): Promise<void> {
        if (this.checking) {
            this.again = true;
            return this.checking;
        }
        this.checking = (async () => {
            try {
                do {
                    this.again = false;
                    await this.check().catch((error: unknown) => this.report(error));
                } while (this.again && this.epoch !== null);
            } finally {
                this.checking = null;
            }
        })();
        return this.checking;
    }

    private async check(): Promise<void> {
        const epoch = this.epoch;
        const signal = this.controller?.signal;
        if (epoch === null || !signal) {
            return;
        }
        const now = this.now();
        const [stored, secrets] = await Promise.all([settings.getStored(), settings.getSecrets()]);
        const key = leaseKeyOf(stored);
        const s3 = backupClient(stored, secrets, this.options.s3Client);
        if (!s3) {
            this.publish({ state: "unconfigured", key });
            return;
        }
        const previous = this.current.key === key ? this.current : null;
        const instanceId = stored.instance_id;
        const bucket = bucketRef(stored.storage);
        try {
            const saved = await readState();
            const state = saved?.instance_id === instanceId && saved.bucket === bucket ? saved : null;
            const lease = await acquireLease(s3, instanceId, await deviceId(), {
                takeOver: state?.take_over === true,
                now,
                assertCurrent: this.options.assertCurrent ?? (() => assertLeader()),
                signal,
            });
            await updateState(
                instanceId,
                bucket,
                (current) => ({
                    ...current,
                    lease,
                    take_over: lease.state === "held" ? false : current.take_over,
                }),
                epoch,
            );
            if (this.epoch !== epoch) {
                return;
            }
            if (lease.state === "conflict") {
                this.publish({ state: "conflict", key, device_id: lease.device_id, renewed: lease.renewed });
            } else {
                const ready = lease.taken_over ? lease.taken_over + TAKE_OVER_GRACE_MS : 0;
                this.publish({ state: "held", key, confirmed: now, ready });
                await registerFork(s3, signal).catch((error: unknown) => this.report(error));
            }
        } catch (error) {
            if (signal.aborted || this.epoch !== epoch) {
                return;
            }
            const confirmed = previous?.state === "held" || previous?.state === "failed" ? previous.confirmed : null;
            const ready = previous?.state === "held" || previous?.state === "failed" ? previous.ready : 0;
            this.publish({ state: "failed", key, message: errorText(error), confirmed, ready });
            this.report(error);
        }
    }

    private report(error: unknown): void {
        if (this.epoch !== null) {
            (this.options.onError ?? ((reason) => console.warn("Planet instance lease", reason)))(error);
        }
    }

    private publish(view: LeaseView): void {
        this.current = view;
        this.clearReadyTimer();
        if ((view.state === "held" || view.state === "failed") && view.ready > this.now()) {
            this.readyTimer = setTimeout(
                () => {
                    this.readyTimer = null;
                    this.notify();
                },
                view.ready - this.now() + 10,
            );
        }
        this.notify();
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                console.warn("Planet instance lease listener failed", error);
            }
        }
    }

    private clearReadyTimer(): void {
        if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = null;
        }
    }
}
