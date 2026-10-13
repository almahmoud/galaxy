import { describe, expect, it } from "vitest";

import { settingsFixture } from "../__tests__/fakes";
import { ACTIVE_LEADER, NO_LEADER, statusFor } from "../__tests__/services";
import type { PlanetStatus } from "./api";
import { RUNNER_STATES, runnerView, timeAgo } from "./runner";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const CONFIGURED = settingsFixture({
    cluster: { gateway_url: "http://127.0.0.1:8001", has_token: true },
    storage: { endpoint: "http://127.0.0.1:8002", has_secret: true },
});

function status(extra: Partial<PlanetStatus> = {}): PlanetStatus {
    return statusFor(CONFIGURED, extra);
}

const standalone = { framed: false, now: NOW };
const framed = { framed: true, now: NOW };

describe("runnerView", () => {
    it("shows a loading state until the status is known", () => {
        expect(runnerView(null, standalone)).toMatchObject({ state: "checking", action: null });
        expect(RUNNER_STATES.checking.spin).toBe(true);
    });

    it("asks to set up the first component that is not configured", () => {
        const view = runnerView(statusFor(settingsFixture(), { leader: ACTIVE_LEADER }), standalone);
        expect(view.state).toBe("not_configured");
        expect(view.action).toEqual({ kind: "setup", target: "cluster", label: "Set up" });
        const storageOnly = statusFor(settingsFixture({ cluster: CONFIGURED.cluster }));
        expect(runnerView(storageOnly, standalone).action).toMatchObject({ target: "storage" });
    });

    it("waits for a Planet tab and links to one from a standalone page", () => {
        const view = runnerView(status({ jobs: { queued: 2, running: 1 } }), standalone);
        expect(view.state).toBe("waiting");
        expect(view.detail).toBe("Jobs run only while Planet is open in a tab of this browser. 3 jobs are unfinished.");
        expect(view.action).toEqual({ kind: "link", href: "/", label: "Open Planet" });
        expect(runnerView(status({ jobs: { queued: 1, running: 0 } }), standalone).detail).toContain("1 job is");
    });

    it("explains inside Galaxy that this tab takes over", () => {
        const view = runnerView(status(), framed);
        expect(view.state).toBe("waiting");
        expect(view.detail).toContain("this tab takes over");
        expect(view.action).toBeNull();
    });

    it("reports a running job runner with the job counts", () => {
        const view = runnerView(status({ leader: ACTIVE_LEADER, jobs: { queued: 3, running: 2 } }), standalone);
        expect(view).toMatchObject({ state: "active", action: null, error: null });
        expect(view.detail).toContain("2 running, 3 waiting.");
        expect(runnerView(status({ leader: ACTIVE_LEADER }), standalone).detail).toContain(
            "No jobs are waiting or running.",
        );
    });

    it("shows why the job runner is blocked and where to fix it", () => {
        const leader = { ...ACTIVE_LEADER, state: "blocked", blocked_reason: "The gateway refused the token." };
        const view = runnerView(status({ leader }), standalone);
        expect(view).toMatchObject({ state: "blocked", detail: "The gateway refused the token." });
        expect(view.action).toEqual({ kind: "setup", target: "cluster", label: "Review settings" });
        expect(runnerView(status({ leader: { ...leader, blocked_reason: null } }), standalone).detail).toBe(
            "The job runner cannot start.",
        );
    });

    it("shows the last error with its age and a link to the job", () => {
        const last_error = {
            message: "Could not create the Kubernetes Job.",
            job_id: "0123456789abcdef",
            time: new Date(NOW - 5 * 60_000).toISOString(),
        };
        const view = runnerView(status({ leader: { ...ACTIVE_LEADER, last_error } }), standalone);
        expect(view.state).toBe("failing");
        expect(view.error).toEqual({
            message: "Could not create the Kubernetes Job.",
            when: "5 minutes ago",
            jobHref: "/jobs/0123456789abcdef/view",
        });
        const waiting = runnerView(
            status({ leader: { ...NO_LEADER, last_error: { ...last_error, job_id: null, time: null } } }),
            standalone,
        );
        expect(waiting.state).toBe("waiting");
        expect(waiting.error).toEqual({ message: last_error.message, when: null, jobHref: null });
    });
});

describe("timeAgo", () => {
    it("describes recent times in words", () => {
        const at = (ms: number) => new Date(NOW - ms).toISOString();
        expect(timeAgo(at(20_000), NOW)).toBe("just now");
        expect(timeAgo(at(-5000), NOW)).toBe("just now");
        expect(timeAgo(at(60_000), NOW)).toBe("1 minute ago");
        expect(timeAgo(at(3 * 3600_000), NOW)).toBe("3 hours ago");
        expect(timeAgo(at(26 * 3600_000), NOW)).toBe("yesterday");
        expect(timeAgo("not a time", NOW)).toBeNull();
    });
});
