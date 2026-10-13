/**
 * Leader election between Planet tabs. The Web Lock `planet:leader` picks one tab; on acquiring it the tab claims a
 * new epoch in `kv` and fences its job writes to it (`db/fence.ts`), so a tab that lost the lock without noticing
 * (frozen, throttled) cannot overwrite the new leader's work.
 *
 * - The leader writes a heartbeat every {@link HEARTBEAT_MS}; a tab that finds it older than {@link STALE_MS}
 *   steals the lock (frozen tabs keep holding Web Locks).
 * - Hidden tabs are throttled, so a hidden leader hands over to a visible tab: the visible tab asks on the
 *   `planet:leader` BroadcastChannel and the leader names it, after which it steals the lock.
 */

import { leader as leaderStore, revokeLeaderFence, setLeaderFence } from "@/planet/db";
import { randomHex } from "@/planet/util/ids";

export const LOCK_NAME = "planet:leader";
export const CHANNEL_NAME = "planet:leader";
export const HEARTBEAT_MS = 20_000;
/** Background tabs run timers once a minute at most; a live leader always beats within this. */
export const STALE_MS = 90_000;
/** How often followers check the heartbeat. */
export const FOLLOWER_CHECK_MS = 30_000;

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

type HandoverMessage = { type: "claim"; tab: string } | { type: "handover"; to: string; epoch: number };

export interface LeaderElectionOptions {
    locks: LockManagerLike;
    channel: ChannelLike;
    /** Whether this tab's document is visible. */
    visible: () => boolean;
    /** Called once this tab leads, with its epoch. Not awaited. */
    onLead: (epoch: number) => void | Promise<void>;
    /** Called when this tab stops leading; its job writes are already fenced off. Not awaited. */
    onDemote: () => void | Promise<void>;
    /** Called after each heartbeat this tab wrote as the leader, with its epoch. Not awaited. */
    onHeartbeat?: (epoch: number) => void | Promise<void>;
    /** Milliseconds since the epoch. */
    now?: () => number;
    tabId?: string;
    onError?: (error: unknown) => void;
}

function isHandoverMessage(value: unknown): value is HandoverMessage {
    const message = value as Partial<{ type: string; tab: string; to: string; epoch: number }> | null;
    return (
        typeof message === "object" &&
        message !== null &&
        ((message.type === "claim" && typeof message.tab === "string") ||
            (message.type === "handover" && typeof message.to === "string" && typeof message.epoch === "number"))
    );
}

export class LeaderElection {
    readonly tabId: string;
    private readonly now: () => number;
    private currentEpoch: number | null = null;
    private running = false;
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
        this.now = options.now ?? Date.now;
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
        this.generation += 1;
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
     * Checks the leader's heartbeat: steals the lock when it is stale, and asks a hidden leader to hand over
     * when this tab is visible.
     */
    async checkLeader(): Promise<void> {
        if (!this.running || this.isLeader) {
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
            if (now - record.heartbeat > STALE_MS) {
                this.request(true);
            } else if (!record.visible && this.options.visible()) {
                this.options.channel.postMessage({ type: "claim", tab: this.tabId } satisfies HandoverMessage);
            }
        } catch (error) {
            this.report(error);
        }
    }

    private message(data: unknown): void {
        if (!this.running || !isHandoverMessage(data)) {
            return;
        }
        if (data.type === "claim" && this.isLeader && !this.options.visible() && data.tab !== this.tabId) {
            this.options.channel.postMessage({
                type: "handover",
                to: data.tab,
                epoch: this.currentEpoch!,
            } satisfies HandoverMessage);
            // Keep leading until the visible tab steals the lock; if it never does, nothing is lost.
        } else if (data.type === "handover" && data.to === this.tabId && !this.isLeader) {
            this.request(true);
        }
    }

    /** Requests the lock: queued behind the holder, or stolen from it. */
    private request(steal: boolean): void {
        if (!this.running) {
            return;
        }
        this.queued?.abort();
        const generation = ++this.generation;
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
        let epoch: number;
        try {
            epoch = await leaderStore.claimEpoch();
        } catch (error) {
            this.report(error);
            release();
            if (generation === this.generation) {
                this.release = null;
                this.request(false);
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
        this.notify(() => this.options.onLead(epoch));
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
            });
            if (!current && this.currentEpoch === epoch) {
                await this.lost();
            } else if (current && this.options.onHeartbeat) {
                const onHeartbeat = this.options.onHeartbeat;
                this.notify(() => onHeartbeat(epoch));
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
            this.notify(() => this.options.onDemote());
            this.release?.();
            this.release = null;
        });
    }

    /** Calls a host callback without waiting for it: starting or stopping job processing can take a while. */
    private notify(callback: () => void | Promise<void>): void {
        try {
            void Promise.resolve(callback()).catch((error: unknown) => this.report(error));
        } catch (error) {
            this.report(error);
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
