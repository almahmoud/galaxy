/**
 * Tool installation (Planet's own endpoints). Installing creates a `tool_install` job, which the leader tab dispatches
 * to an install pod; its ingest (`install/ingest.ts`) stores the tools the pod installed in the `tools` store, where
 * `api/tools.ts` lists them. The browser never reads the repository or its tool XML.
 *
 * - `POST /api/planet/tools/install` `{source}`: an {@link InstallView}; an unfinished installation of the same
 *   source is returned instead of a second one. A GitHub commit must be on a branch or tag of its repository
 *   (`install/github.ts`).
 * - `GET /api/planet/tools/installs`: installations, newest first, without dismissed ones.
 * - `DELETE /api/planet/tools/installs/{job_id}`: dismisses a finished installation from that list.
 * - `GET /api/planet/tools/installed`: {@link InstalledToolView}s, by name.
 * - `DELETE /api/planet/tools/{tool_id}/{version}`: uninstalls a tool version (the id percent-encoded); refused while
 *   jobs of it are unfinished, paused ones included. Its bucket objects are kept.
 *
 * The Tool Shed itself is searched by the page (`install/toolshed.ts`).
 */

import { type JobRecord, jobs, type JobState, outbox, readTx, tools, writeTx } from "@/planet/db";
import { GitHubCommitError, GitHubUnavailableError, verifyGitHubCommit } from "@/planet/install/github";
import {
    type GitHubSource,
    type InstallSource,
    InstallSourceError,
    parseInstallSource,
    TOOL_INSTALL_TOOL_ID,
    TOOL_INSTALL_TOOL_VERSION,
} from "@/planet/install/source";
import {
    type InstalledToolView,
    installedToolView,
    type InstallParams,
    type InstallView,
    installView,
    UNFINISHED_STATES,
} from "@/planet/install/views";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { isId } from "@/planet/util/ids";

/** Installations that may wait or run at the same time. */
export const MAX_UNFINISHED_INSTALLS = 10;
/** Installations `GET /api/planet/tools/installs` lists at most. */
export const MAX_LISTED_INSTALLS = 50;

function invalid(message: string): ApiError {
    return new ApiError(400, message, ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID);
}

/** The JSON body of a request from Planet's own pages (the router refuses navigations and other origins). */
async function pageJson(request: PlanetRequest): Promise<unknown> {
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
        throw ApiError.badRequest("Send this request with fetch and Content-Type: application/json.");
    }
    return request.json();
}

function sameSource(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function isUnfinished(job: JobRecord): boolean {
    return UNFINISHED_STATES.includes(job.state);
}

/** Jobs in these states may still be dispatched: unfinished ones, and paused ones once resumed. */
const DISPATCHABLE_STATES: readonly JobState[] = [...UNFINISHED_STATES, "paused"];

function installJobs(all: JobRecord[]): JobRecord[] {
    return all.sort((a, b) => (a.create_time < b.create_time ? 1 : a.create_time > b.create_time ? -1 : 0));
}

async function verifiedGitHubSource(source: GitHubSource): Promise<GitHubSource> {
    try {
        return await verifyGitHubCommit(source);
    } catch (error) {
        if (error instanceof GitHubCommitError) {
            throw invalid(error.message);
        }
        if (error instanceof GitHubUnavailableError) {
            throw new ApiError(502, error.message, ErrorCodes.UPSTREAM_PROXY_ERROR);
        }
        throw error;
    }
}

async function install(request: PlanetRequest): Promise<InstallView> {
    const body = await pageJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw invalid("The install request must be a JSON object with a source.");
    }
    const unknown = Object.keys(body).find((key) => key !== "source");
    if (unknown !== undefined) {
        throw invalid(`Unknown install option ${unknown}.`);
    }
    let source: InstallSource;
    try {
        source = parseInstallSource((body as { source?: unknown }).source);
    } catch (error) {
        throw invalid(error instanceof InstallSourceError ? error.message : String(error));
    }
    if (source.type === "github") {
        source = await verifiedGitHubSource(source);
    }
    const job = await writeTx(["jobs", "outbox"], async (tx) => {
        const existing = await tx.store("jobs").index("tool_id").getAll(TOOL_INSTALL_TOOL_ID);
        const unfinished = existing.filter(isUnfinished);
        const same = unfinished.find((item) => sameSource((item.params as Partial<InstallParams>).source, source));
        if (same) {
            return same;
        }
        if (unfinished.length >= MAX_UNFINISHED_INSTALLS) {
            throw new ApiError(
                429,
                `${unfinished.length} installations are waiting or running. Try again when one of them has finished.`,
                ErrorCodes.TOO_MANY_REQUESTS,
            );
        }
        const params: InstallParams = { source };
        const created = await jobs.create(
            {
                tool_id: TOOL_INSTALL_TOOL_ID,
                tool_version: TOOL_INSTALL_TOOL_VERSION,
                history_id: null,
                state: "new",
                params: params as unknown as Record<string, unknown>,
                request: { source },
            },
            tx,
        );
        await outbox.enqueue({ kind: "dispatch", job_id: created.id }, tx);
        return created;
    });
    return installView(job);
}

async function listInstalls(): Promise<InstallView[]> {
    const all = await readTx(["jobs"], (tx) => tx.store("jobs").index("tool_id").getAll(TOOL_INSTALL_TOOL_ID));
    return installJobs(all)
        .filter((job) => !(job.params as Partial<InstallParams>).dismissed)
        .slice(0, MAX_LISTED_INSTALLS)
        .map(installView);
}

async function dismissInstall(jobId: string): Promise<InstallView> {
    if (!isId(jobId)) {
        throw ApiError.notFound("No such installation.");
    }
    const job = await writeTx(["jobs"], async (tx) => {
        const current = await jobs.get(jobId, tx);
        if (!current || current.tool_id !== TOOL_INSTALL_TOOL_ID) {
            throw ApiError.notFound("No such installation.");
        }
        if (isUnfinished(current)) {
            throw ApiError.conflict("The installation has not finished. Cancel it first.");
        }
        const params = { ...(current.params as unknown as InstallParams), dismissed: true };
        return jobs.update(jobId, { params: params as unknown as Record<string, unknown> }, tx);
    });
    return installView(job);
}

async function listInstalled(): Promise<InstalledToolView[]> {
    const views = (await tools.list()).map(installedToolView).filter((view) => view !== null);
    return views.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

async function uninstall(toolId: string, version: string): Promise<{ id: string; version: string }> {
    await writeTx(["tools", "jobs"], async (tx) => {
        const record = await tools.get(toolId, version, tx);
        if (!record || record.source !== "installed") {
            throw ApiError.notFound(`Tool ${toolId} ${version} is not installed.`);
        }
        const running = (await tx.store("jobs").index("tool_id").getAll(toolId)).filter(
            (job) => job.tool_version === version && DISPATCHABLE_STATES.includes(job.state),
        );
        if (running.length) {
            throw ApiError.conflict(
                running.length === 1
                    ? "A job of this tool has not finished. Wait for it or cancel it, then uninstall the tool."
                    : `${running.length} jobs of this tool have not finished. Wait for them or cancel them, then uninstall the tool.`,
            );
        }
        await tools.remove(toolId, version, tx);
    });
    return { id: toolId, version };
}

export function register(router: Router): void {
    router.untyped("/api/planet/tools/install", "post", install);
    router.untyped("/api/planet/tools/installs", "get", () => listInstalls());
    router.untyped("/api/planet/tools/installs/{job_id}", "delete", ({ params }) =>
        dismissInstall(params.job_id ?? ""),
    );
    router.untyped("/api/planet/tools/installed", "get", () => listInstalled());
    router.untyped("/api/planet/tools/{tool_id}/{version}", "delete", ({ params }) =>
        uninstall(params.tool_id ?? "", params.version ?? ""),
    );
}
