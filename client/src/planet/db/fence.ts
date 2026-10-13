/**
 * Leader fencing. The tab that leads job processing sets its epoch here; from then on every read-write
 * transaction in that context that touches the `jobs` store first checks that `leader_epoch` in `kv` still
 * holds that epoch, and aborts with {@link LeaderFenceError} when another tab has taken over since. Contexts
 * that never set a fence (the Service Worker, other tabs) are not affected.
 */

let epoch: number | null = null;

/** Raised when a fenced write runs after another tab became the leader. */
export class LeaderFenceError extends Error {
    constructor(
        readonly expected: number,
        readonly current: number | null,
    ) {
        super(`This tab no longer leads job processing (epoch ${expected}, current ${current ?? "none"})`);
        this.name = "LeaderFenceError";
    }
}

/** Fences job writes in this context to `value`, or removes the fence with null. */
export function setLeaderFence(value: number | null): void {
    epoch = value;
}

/** The epoch job writes in this context are fenced to, or null. */
export function leaderFence(): number | null {
    return epoch;
}

/** Throws {@link LeaderFenceError} when a fence is set and `stored` (the `leader_epoch` value) differs. */
export function checkLeaderFence(stored: unknown): void {
    if (epoch !== null && stored !== epoch) {
        throw new LeaderFenceError(epoch, typeof stored === "number" ? stored : null);
    }
}
