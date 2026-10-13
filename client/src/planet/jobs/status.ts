/**
 * The leader's status record (`kv` key `leader_status`, {@link LeaderStatusRecord}) for status pages: whether job
 * processing runs, is idle or is blocked and why, the last error and the number of queued and running jobs. One
 * reporter lives for one leadership epoch; its writes are dropped once another tab claimed a newer epoch.
 */

import { jobs, leader, type LeaderStatusRecord, outbox } from "@/planet/db";

import { errorMessage } from "./failures";

export class LeaderStatus {
    private blockedReason: string | null = null;
    private clusterProblem: string | null = null;
    private lastError: LeaderStatusRecord["last_error"] = null;
    private writing: Promise<boolean> | null = null;
    private again = false;

    constructor(
        readonly epoch: number,
        readonly tabId: string,
        private readonly now: () => number = Date.now,
        private readonly onError: (error: unknown) => void = () => undefined,
    ) {}

    /** Sets why job processing cannot start (incomplete settings), or null once it runs; writes the record. */
    setBlocked(reason: string | null): Promise<boolean> {
        this.blockedReason = reason;
        if (reason !== null) {
            this.clusterProblem = null;
        }
        return this.write();
    }

    /** Records whether the cluster answered the last listing; writes the record when that changed. */
    setClusterProblem(problem: string | null): Promise<boolean> {
        if (problem === this.clusterProblem) {
            return Promise.resolve(true);
        }
        this.clusterProblem = problem;
        return this.write();
    }

    /** Records an error of job processing as `last_error` and writes the record. */
    recordError(error: unknown, jobId: string | null = null): Promise<boolean> {
        this.lastError = { message: errorMessage(error), job_id: jobId, time: this.now() };
        return this.write();
    }

    /** Writes the record with fresh counts; concurrent calls coalesce into one more write. */
    write(): Promise<boolean> {
        if (this.writing) {
            this.again = true;
            return this.writing;
        }
        this.writing = (async () => {
            let written = false;
            try {
                do {
                    this.again = false;
                    written = await leader.writeStatus(await this.record());
                } while (this.again);
            } catch (error) {
                this.onError(error);
            } finally {
                this.writing = null;
            }
            return written;
        })();
        return this.writing;
    }

    private async record(): Promise<LeaderStatusRecord> {
        const counts = await jobs.countByState(["queued", "running"] as const);
        const blocked = this.blockedReason ?? this.clusterProblem;
        const busy = counts.queued + counts.running > 0 || (await outbox.list()).length > 0;
        return {
            epoch: this.epoch,
            tab_id: this.tabId,
            heartbeat: this.now(),
            state: blocked ? "blocked" : busy ? "active" : "idle",
            blocked_reason: blocked,
            last_error: this.lastError,
            counts: { queued: counts.queued, running: counts.running },
        };
    }
}
