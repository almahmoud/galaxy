/**
 * Leader fencing. The tab that leads job processing sets its epoch here; from then on every read-write
 * transaction in that context that touches the `jobs` store first checks that `leader_epoch` in `kv` still
 * holds that epoch, and aborts with {@link LeaderFenceError} when another tab has taken over since. A tab that
 * stops leading revokes its fence, which matches no epoch, until it leads again. Contexts that never set a fence
 * (the Service Worker, tabs that never led) are not affected.
 */

/** Fence of a tab that led and stopped: epochs start at 1, so no stored epoch matches it. */
const REVOKED = -1;

let epoch: number | null = null;

/** Raised when a fenced write runs after another tab became the leader. */
export class LeaderFenceError extends Error {
    constructor(
        readonly expected: number,
        readonly current: number | null,
    ) {
        super(
            expected === REVOKED
                ? "This tab no longer leads job processing"
                : `This tab no longer leads job processing (epoch ${expected}, current ${current ?? "none"})`,
        );
        this.name = "LeaderFenceError";
    }
}

/**
 * Raised for a bucket or Kubernetes write of a job manager whose device does not hold, or could not lately confirm,
 * its instance's lease (`backup/lease.ts`). Handled like {@link LeaderFenceError}: the write is dropped, nothing fails.
 */
export class LeaseFenceError extends LeaderFenceError {
    constructor(message: string) {
        super(REVOKED, null);
        this.message = message;
        this.name = "LeaseFenceError";
    }
}

/** Fences job writes in this context to `value`, or removes the fence with null. */
export function setLeaderFence(value: number | null): void {
    epoch = value;
}

/** Fences off every job write in this context until {@link setLeaderFence} installs a new epoch. */
export function revokeLeaderFence(): void {
    epoch = REVOKED;
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
