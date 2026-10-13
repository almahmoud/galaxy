/**
 * Live console output. While a job runs and a client reads `/api/jobs/{id}/console_output`, the leader polls
 * the tool container's log incrementally (`sinceTime`, at most every {@link CONSOLE_POLL_INTERVAL_MS}, at most
 * {@link CONSOLE_CHUNK_BYTES} a request) and appends it to the job's `tool_stdout`. The Galaxy client asks for
 * the text after what it has shown (`stdout_position`), so the text only grows, up to {@link CONSOLE_MAX_CHARS}.
 * The container log interleaves stdout and stderr; the separate streams replace it when the results arrive.
 */

import { JOB_STORES, jobs, withTransaction } from "@/planet/db";
import type { KubeClient } from "@/planet/k8s";

export const CONSOLE_POLL_INTERVAL_MS = 5000;
/** A console request keeps the output current for this long. */
export const CONSOLE_REQUEST_TTL_MS = 30_000;
/** Log bytes read per request. */
export const CONSOLE_CHUNK_BYTES = 32 * 1024;
/** Live output kept in the job record; later output is shown when the job finishes. */
export const CONSOLE_MAX_CHARS = 1024 * 1024;
export const CONSOLE_TRUNCATED_NOTE = "\n[Live output stops here; the job's output is complete once it finishes.]\n";

const FIRST_TAIL_LINES = 1000;
const TIMESTAMPED_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z (.*)$/s;

interface Tail {
    pod: string;
    /** Normalized timestamp of the last line read. */
    last: string | null;
    text: string;
    polled: number;
}

/** A log timestamp with nanoseconds padded to nine digits, so timestamps compare as strings. */
function normalize(seconds: string, fraction: string | undefined): string {
    return `${seconds}.${(fraction ?? "").padEnd(9, "0")}Z`;
}

/** Appends `addition` to `text`, stopping with {@link CONSOLE_TRUNCATED_NOTE} at `limit` characters. */
export function appendOutput(text: string, addition: string, limit = CONSOLE_MAX_CHARS): string {
    if (text.endsWith(CONSOLE_TRUNCATED_NOTE)) {
        return text;
    }
    const room = limit - text.length;
    return addition.length <= room
        ? text + addition
        : text + addition.slice(0, Math.max(0, room)) + CONSOLE_TRUNCATED_NOTE;
}

/** Splits a `timestamps=true` log into lines after `after` (exclusive) and the newest timestamp. */
export function newLines(log: string, after: string | null): { lines: string[]; last: string | null } {
    const lines: string[] = [];
    let last = after;
    for (const line of log.split("\n")) {
        const match = TIMESTAMPED_LINE.exec(line);
        if (!match) {
            continue;
        }
        const stamp = normalize(match[1]!, match[2]);
        if (after && stamp <= after) {
            continue;
        }
        lines.push(match[3] ?? "");
        if (!last || stamp > last) {
            last = stamp;
        }
    }
    return { lines, last };
}

export class ConsoleTails {
    private readonly tails = new Map<string, Tail>();

    constructor(
        private readonly kube: KubeClient,
        private readonly now: () => number = Date.now,
    ) {}

    /** True when a client asked for the job's console recently. */
    async wanted(jobId: string): Promise<boolean> {
        const requested = await jobs.consoleRequestedAt(jobId);
        return requested !== null && this.now() - requested < CONSOLE_REQUEST_TTL_MS;
    }

    /**
     * Fetches new log lines of the job's tool container and appends them to its output, unless it was polled less than
     * {@link CONSOLE_POLL_INTERVAL_MS} ago. `container` is the job's main container.
     */
    async poll(jobId: string, pod: string, container: string): Promise<void> {
        let tail = this.tails.get(jobId);
        if (!tail || tail.pod !== pod) {
            tail = { pod, last: null, text: "", polled: 0 };
            this.tails.set(jobId, tail);
        }
        if (this.now() - tail.polled < CONSOLE_POLL_INTERVAL_MS || tail.text.endsWith(CONSOLE_TRUNCATED_NOTE)) {
            return;
        }
        tail.polled = this.now();
        const log = await this.kube.getPodLog(pod, {
            container,
            timestamps: true,
            limitBytes: CONSOLE_CHUNK_BYTES,
            ...(tail.last ? { sinceTime: `${tail.last.slice(0, 19)}Z` } : { tailLines: FIRST_TAIL_LINES }),
        });
        const { lines, last } = newLines(log, tail.last);
        if (!lines.length) {
            return;
        }
        tail.last = last;
        tail.text = appendOutput(tail.text, `${lines.join("\n")}\n`);
        const text = tail.text;
        // The final streams written at ingest must not be replaced by live output.
        await withTransaction(JOB_STORES, "readwrite", async (t) => {
            if ((await jobs.get(jobId, t))?.state === "running") {
                await jobs.update(jobId, { tool_stdout: text }, t);
            }
        });
    }

    /** Forgets the live output of a job that is no longer running. */
    forget(jobId: string): void {
        this.tails.delete(jobId);
    }

    /** Jobs with live output. */
    tracked(): string[] {
        return [...this.tails.keys()];
    }
}
