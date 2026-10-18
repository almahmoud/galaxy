/**
 * Leader election between Planet tabs. The Web Lock `planet:leader` picks one tab; on acquiring it the tab claims a
 * new epoch in `kv` and fences its job writes to it (`db/fence.ts`), so a tab that lost the lock without noticing
 * (frozen, throttled) cannot overwrite the new leader's work.
 *
 * - The leader writes a heartbeat every {@link HEARTBEAT_MS}; a tab that finds it older than {@link STALE_MS}
 *   steals the lock (frozen tabs keep holding Web Locks).
 * - Hidden tabs are throttled, so a hidden leader hands over to a visible tab: the visible tab asks on the
 *   `planet:leader` BroadcastChannel and the leader names it, after which it steals the lock.
 * - Heartbeats, claims and handovers carry the tab's {@link LEADER_PROTOCOL}. A tab never hands over to a tab of an
 *   older version and takes the lock from a leader of one; a tab of an older version than one that led stops taking
 *   part (`claimEpoch` refuses it) until it is reloaded. Builds from before versions ignore all this; they are shut
 *   out by the database version instead (`db/schema.ts`).
 * - A tab that leads again installs its new fence only once the job processing of its previous leadership stopped
 *   (the promise `onDemote` returned settled), or after {@link STOP_WAIT_MS}.
 */

import { leader as leaderStore, LeaderProtocolError, revokeLeaderFence, setLeaderFence } from "@/planet/db";
import { randomHex } from "@/planet/util/ids";

export const LOCK_NAME = "planet:leader";
export const CHANNEL_NAME = "planet:leader";
export const HEARTBEAT_MS = 20_000;
/** Background tabs run timers once a minute at most; a live leader always beats within this. */
export const STALE_MS = 90_000;
/** How often followers check the heartbeat. */
export const FOLLOWER_CHECK_MS = 30_000;
/** A tab that holds the lock but could not claim an epoch asks again after this long. */
export const CLAIM_RETRY_MS = 5000;
/** How long a tab that leads again waits for the job processing of its previous leadership to stop. */
export const STOP_WAIT_MS = 60_000;
/**
 * Version of what a leader reads and writes: the job bucket layout, the job protocol and the job records. Bump it
 * with every change an older leader would misread. Tabs of builds without it count as version 0.
 */
export const LEADER_PROTOCOL = 1;

/** The parts of `LockManager` the election uses. */
export interface LockManagerLike {
    request(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>): Promise<void>;
}

/** The parts of `BroadcastChannel` the election uses. */
export interface ChannelLike {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    close(): void;
}

type HandoverMessage =
    | { type: "claim"; tab: string; protocol?: number }
    | { type: "handover"; to: string; epoch: number; protocol?: number };

export interface LeaderElectionOptions {
    locks: LockManagerLike;
    channel: ChannelLike;
    /** Whether this tab's document is visible. */
    visible: () => boolean;
    /** Called once this tab leads, with its epoch. Not awaited. */
    onLead: (epoch: number) => void | Promise<void>;
    /**
     * Called when this tab stops leading; its job writes are already fenced off. Not awaited, but this tab leads
     * again only after the returned promise settled (or {@link STOP_WAIT_MS} passed): it should resolve once job
     * processing stopped.
     */
    onDemote: () => void | Promise<void>;
    /** Called once when this tab stops taking part because a tab of a newer leader protocol version led. */
    onOutdated?: (error: LeaderProtocolError) => void;
    /** This tab's leader protocol version; {@link LEADER_PROTOCOL} by default. */
    protocol?: number;
    /** Called after each heartbeat this tab wrote as the leader, with its epoch. Not awaited. */
    onHeartbeat?: (epoch: number) => void | Promise<void>;
    /** Milliseconds since the epoch. */
    now?: () => number;
    /** Replaces {@link STOP_WAIT_MS} (tests). */
    stopWaitMs?: number;
    tabId?: string;
    onError?: (error: unknown) => void;
}

/** Settles when `promise` does, or after `ms`. */
function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isHandoverMessage(value: unknown): value is HandoverMessage {
    const message = value as Partial<{
        type: string;
        tab: string;
        to: string;
        epoch: number;
        protocol: unknown;
    }> | null;
    return (
        typeof message === "object" &&
        message !== null &&
        (message.protocol === undefined || Number.isSafeInteger(message.protocol)) &&
        ((message.type === "claim" && typeof message.tab === "string") ||
            (message.type === "handover" && typeof message.to === "string" && typeof message.epoch === "number"))
    );
}

/** The leader protocol version a heartbeat or message names; 0 when it names none (builds before versions). */
function protocolOf(value: { protocol?: unknown }): number {
    return typeof value.protocol === "number" && Number.isSafeInteger(value.protocol) ? value.protocol : 0;
}

export class LeaderElection {
    readonly tabId: string;
    readonly protocol: number;
    private readonly now: () => number;
    private currentEpoch: number | null = null;
    private running = false;
    private outdatedBy: LeaderProtocolError | null = null;
    /**
     * Settles once the job processing of the last leadership stopped (what `onDemote` returned), or
     * {@link STOP_WAIT_MS} after it was asked to: a manager that never stops must not keep this tab from leading,
     * and its Kubernetes and bucket writes check its own epoch.
     */
    private stopped: Promise<void> = Promise.resolve();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** Ends the wait of a lock grant for the previous leadership's stop, once that grant is superseded. */
    private wakeLead: (() => void) | null = null;
    /** Aborts the queued (not yet granted) lock request. */
    private queued: AbortController | null = null;
    /** Identifies the lock request that holds or waits for the lock; older ones are ignored. */
    private generation = 0;
    /** Ends the lock callback, which releases the lock. */
    private release: (() => void) | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private followerTimer: ReturnType<typeof setInterval> | null = null;
    private missingSince: number | null = null;
    private transition: Promise<void> = Promise.resolve();
    private readonly onMessage = (event: MessageEvent) => this.message(event.data);

    constructor(private readonly options: LeaderElectionOptions) {
        this.tabId = options.tabId ?? randomHex(8);
        this.protocol = options.protocol ?? LEADER_PROTOCOL;
        this.now = options.now ?? Date.now;
    }

    /** True once this tab found that a tab of a newer leader protocol version led; it no longer takes part. */
    get outdated(): boolean {
        return this.outdatedBy !== null;
    }

    /** The epoch this tab leads with, or null. */
    get epoch(): number | null {
        return this.currentEpoch;
    }

    get isLeader(): boolean {
        return this.currentEpoch !== null;
    }

    /** Joins the election. */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.options.channel.addEventListener("message", this.onMessage);
        this.followerTimer = setInterval(() => void this.checkLeader(), FOLLOWER_CHECK_MS);
        this.request(false);
    }

    /** Leaves the election, giving up leadership if this tab leads. */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }
        this.running = false;
        this.options.channel.removeEventListener("message", this.onMessage);
        if (this.followerTimer) {
            clearInterval(this.followerTimer);
            this.followerTimer = null;
        }
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.generation += 1;
        this.wakeLead?.();
        this.queued?.abort();
        this.queued = null;
        const epoch = this.currentEpoch;
        await this.demote();
        if (epoch !== null) {
            await leaderStore.resign(epoch).catch((error: unknown) => this.report(error));
        }
    }

    /** Tells the election that this tab's visibility changed. */
    visibilityChanged(): void {
        if (!this.running) {
            return;
        }
        if (this.isLeader) {
            void this.beat();
        } else if (this.options.visible()) {
            void this.checkLeader();
        }
    }

    /**
     * Checks the leader's heartbeat: steals the lock when it is stale or of an older leader protocol version, and
     * asks a hidden leader to hand over when this tab is visible. A leader of a newer version is left alone.
     */
    async checkLeader(): Promise<void> {
        if (!this.running || this.isLeader || this.outdated) {
            return;
        }
        try {
            const record = await leaderStore.read();
            const now = this.now();
            if (!record) {
                this.missingSince ??= now;
                if (now - this.missingSince > STALE_MS) {
                    this.missingSince = null;
                    this.request(true);
                }
                return;
            }
            this.missingSince = null;
            const protocol = protocolOf(record);
            if (protocol > this.protocol) {
                // The next claim of this tab is refused; nothing to ask for until then.
                return;
            }
            if (protocol < this.protocol || now - record.heartbeat > STALE_MS) {
                this.request(true);
            } else if (!record.visible && this.options.visible()) {
                this.options.channel.postMessage({
                    type: "claim",
                    tab: this.tabId,
                    protocol: this.protocol,
                } satisfies HandoverMessage);
            }
        } catch (error) {
            this.report(error);
        }
    }

    private message(data: unknown): void {
        if (!this.running || this.outdated || !isHandoverMessage(data)) {
            return;
        }
        const protocol = protocolOf(data);
        if (
            data.type === "claim" &&
            this.isLeader &&
            !this.options.visible() &&
            data.tab !== this.tabId &&
            protocol >= this.protocol
        ) {
            this.options.channel.postMessage({
                type: "handover",
                to: data.tab,
                epoch: this.currentEpoch!,
                protocol: this.protocol,
            } satisfies HandoverMessage);
            // Keep leading until the visible tab steals the lock; if it never does, nothing is lost.
        } else if (data.type === "handover" && data.to === this.tabId && !this.isLeader && protocol <= this.protocol) {
            this.request(true);
        }
    }

    /** Requests the lock: queued behind the holder, or stolen from it. */
    private request(steal: boolean): void {
        if (!this.running || this.outdated) {
            return;
        }
        this.queued?.abort();
        const generation = ++this.generation;
        this.wakeLead?.();
        const controller = new AbortController();
        this.queued = steal ? null : controller;
        const options: LockOptions = steal ? { steal: true } : { signal: controller.signal };
        this.options.locks
            .request(LOCK_NAME, options, (lock) => this.hold(lock, generation))
            .catch((error: unknown) => {
                // AbortError: our queued request was replaced, or the lock was stolen from us.
                if (generation !== this.generation || !this.running) {
                    return;
                }
                if (!(error instanceof DOMException && error.name === "AbortError")) {
                    this.report(error);
                }
                void this.lost();
            });
    }

    /** Runs while this tab holds the lock; resolving releases it. */
    private hold(lock: Lock | null, generation: number): Promise<void> {
        if (!lock || generation !== this.generation || !this.running) {
            return Promise.resolve();
        }
        this.queued = null;
        return new Promise<void>((resolve) => {
            this.release = resolve;
            void this.serially(() => this.lead(generation, resolve));
        });
    }

    private async lead(generation: number, release: () => void): Promise<void> {
        // Job writes of the previous leadership must have ended before a new epoch lets them through again.
        await this.previousStopped();
        if (generation !== this.generation || !this.running) {
            release();
            return;
        }
        let epoch: number;
        try {
            epoch = await leaderStore.claimEpoch({ protocol: this.protocol });
        } catch (error) {
            release();
            if (generation === this.generation) {
                this.release = null;
            }
            if (error instanceof LeaderProtocolError) {
                this.retire(error);
                return;
            }
            this.report(error);
            if (generation === this.generation) {
                // Not at once: a database this build cannot open fails every claim.
                this.retryTimer = setTimeout(() => {
                    this.retryTimer = null;
                    if (generation === this.generation) {
                        this.request(false);
                    }
                }, CLAIM_RETRY_MS);
            }
            return;
        }
        if (generation !== this.generation || !this.running) {
            // A newer request replaced this one while the epoch was claimed.
            release();
            return;
        }
        this.currentEpoch = epoch;
        setLeaderFence(epoch);
        await this.beat();
        this.heartbeatTimer = setInterval(() => void this.beat(), HEARTBEAT_MS);
        void this.notify(() => this.options.onLead(epoch));
    }

    /** Writes the heartbeat; finding a newer epoch means another tab leads now. */
    private async beat(): Promise<void> {
        const epoch = this.currentEpoch;
        if (epoch === null) {
            return;
        }
        try {
            const current = await leaderStore.heartbeat({
                epoch,
                tab_id: this.tabId,
                heartbeat: this.now(),
                visible: this.options.visible(),
                protocol: this.protocol,
            });
            if (!current && this.currentEpoch === epoch) {
                await this.lost();
            } else if (current && this.options.onHeartbeat) {
                const onHeartbeat = this.options.onHeartbeat;
                void this.notify(() => onHeartbeat(epoch));
            }
        } catch (error) {
            this.report(error);
        }
    }

    /** Leadership ended without this tab choosing to (stolen, superseded): demote and queue again. */
    private async lost(): Promise<void> {
        await this.demote();
        this.release?.();
        this.release = null;
        this.request(false);
    }

    private demote(): Promise<void> {
        return this.serially(async () => {
            if (this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
            if (this.currentEpoch === null) {
                this.release?.();
                this.release = null;
                return;
            }
            this.currentEpoch = null;
            // A demoted tab's job manager may still be finishing work: none of its job writes may commit now.
            revokeLeaderFence();
            this.stopped = settledWithin(
                this.notify(() => this.options.onDemote()),
                this.options.stopWaitMs ?? STOP_WAIT_MS,
            );
            this.release?.();
            this.release = null;
        });
    }

    /** Settles with {@link stopped}, or once a newer lock request superseded the grant that waits. */
    private previousStopped(): Promise<void> {
        let wake!: () => void;
        const superseded = new Promise<void>((resolve) => (wake = resolve));
        this.wakeLead = wake;
        return Promise.race([this.stopped, superseded]).finally(() => {
            if (this.wakeLead === wake) {
                this.wakeLead = null;
            }
        });
    }

    /** Stops taking part: a tab of a newer leader protocol version led. */
    private retire(error: LeaderProtocolError): void {
        if (this.outdatedBy) {
            return;
        }
        this.outdatedBy = error;
        this.queued?.abort();
        this.queued = null;
        this.generation += 1;
        const onOutdated = this.options.onOutdated;
        if (onOutdated) {
            void this.notify(() => onOutdated(error));
        } else {
            this.report(error);
        }
    }

    /**
     * Calls a host callback without waiting for it: starting or stopping job processing can take a while. Returns a
     * promise that settles (never rejects) when the callback's promise does.
     */
    private notify(callback: () => void | Promise<void>): Promise<void> {
        try {
            return Promise.resolve(callback()).catch((error: unknown) => this.report(error));
        } catch (error) {
            this.report(error);
            return Promise.resolve();
        }
    }

    /** Runs leadership changes one after another. */
    private serially(fn: () => Promise<void>): Promise<void> {
        this.transition = this.transition.then(fn, fn);
        return this.transition;
    }

    private report(error: unknown): void {
        if (this.options.onError) {
            this.options.onError(error);
        } else {
            console.warn(`Planet leader election: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
