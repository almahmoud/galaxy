// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, jobs, outbox, tools } from "@/planet/db";
import { TOOL_INSTALL_TOOL_ID } from "@/planet/install/source";
import type { InstalledToolView, InstallView } from "@/planet/install/views";
import { Router } from "@/planet/sw/router";

import { MAX_UNFINISHED_INSTALLS, register } from "../toolshed";

const ORIGIN = "https://planet.test";
const SOURCE = { type: "toolshed", owner: "iuc", name: "datamash_ops", changeset_revision: "aaafc0ac4dd2" };
const TOOL_ID = "toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/datamash_ops/1.9+galaxy0";
const VERSION = "1.9+galaxy0";

let router: Router;

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "Content-Type": "application/json" };
    }
    const response = await router.handle(new Request(`${ORIGIN}${path}`, init));
    return { status: response.status, body: (await response.json()) as T };
}

function installedTool(fields: Record<string, unknown> = {}) {
    return tools.put({
        tool_id: TOOL_ID,
        tool_version: VERSION,
        source: "installed",
        status: "ready",
        message: null,
        bundle: {
            id: TOOL_ID,
            version: VERSION,
            name: "Datamash",
            description: "(operations on tabular data)",
            tool_shed_repository: { owner: "iuc", name: "datamash_ops", changeset_revision: "aaafc0ac4dd2" },
            source: { repository: "https://toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops", commit: "aaafc0ac4dd2" },
        },
        bundle_url: null,
        panel_section_id: "planet_installed",
        panel_section_name: "Installed tools",
        hidden: false,
        ...fields,
    });
}

beforeEach(async () => {
    await closeDb();
    globalThis.indexedDB = new IDBFactory();
    router = new Router();
    register(router);
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await closeDb();
});

const GITHUB = { type: "github", repository: "galaxyproject/tools-iuc", ref: "a".repeat(40), path: "tools/datamash" };

/** GitHub's API for galaxyproject/tools-iuc, whose default branch holds `onMain` commits. */
function stubGitHub(onMain: string[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        const json = (body: unknown) => new Response(JSON.stringify(body));
        if (path === "/repos/galaxyproject/tools-iuc") {
            return json({ full_name: "galaxyproject/tools-iuc", default_branch: "main" });
        }
        const compare = /\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(path);
        if (compare) {
            return json({ status: onMain.includes(compare[1]!) ? "behind" : "diverged" });
        }
        if (path.endsWith("/branches") || path.endsWith("/tags")) {
            return json([]);
        }
        return json({ sha: "exists" });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

describe("POST /api/planet/tools/install", () => {
    it("creates a tool_install job and its dispatch entry", async () => {
        const { status, body } = await call<InstallView>("POST", "/api/planet/tools/install", { source: SOURCE });
        expect(status).toBe(200);
        expect(body).toMatchObject({
            phase: "queued",
            state: "new",
            label: "iuc/datamash_ops",
            requested_revision: "aaafc0ac4dd2",
            page_url: "https://toolshed.g2.bx.psu.edu/view/iuc/datamash_ops/aaafc0ac4dd2",
            tools: [],
        });
        const job = (await jobs.get(body.id))!;
        expect(job).toMatchObject({ tool_id: TOOL_INSTALL_TOOL_ID, history_id: null });
        expect(job.params.source).toEqual({ ...SOURCE, tool_shed_url: "https://toolshed.g2.bx.psu.edu" });
        expect((await outbox.listForJob(body.id)).map((entry) => entry.kind)).toEqual(["dispatch"]);
    });

    it("returns the unfinished installation of the same source", async () => {
        const first = await call<InstallView>("POST", "/api/planet/tools/install", { source: SOURCE });
        const second = await call<InstallView>("POST", "/api/planet/tools/install", {
            source: { ...SOURCE, changeset_revision: "AAAFC0AC4DD2" },
        });
        expect(second.body.id).toBe(first.body.id);
        const other = await call<InstallView>("POST", "/api/planet/tools/install", {
            source: { ...SOURCE, changeset_revision: "2f3c6f2dcf39" },
        });
        expect(other.body.id).not.toBe(first.body.id);
    });

    it("limits unfinished installations", async () => {
        for (let n = 0; n < MAX_UNFINISHED_INSTALLS; n++) {
            const revision = n.toString(16).padStart(12, "0");
            expect(
                (
                    await call("POST", "/api/planet/tools/install", {
                        source: { ...SOURCE, changeset_revision: revision },
                    })
                ).status,
            ).toBe(200);
        }
        const refused = await call<{ err_msg: string }>("POST", "/api/planet/tools/install", { source: SOURCE });
        expect(refused.status).toBe(429);
        expect(refused.body.err_msg).toMatch(/10 installations are waiting or running/);
    });

    it.each([
        [{ source: { ...SOURCE, tool_shed_url: "https://evil.example" } }, /only be installed from/],
        [{ source: { type: "github", repository: "a/b", ref: "main" } }, /commit SHA/],
        [{ source: SOURCE, force: true }, /Unknown install option force/],
        [[], /JSON object/],
    ])("refuses %j", async (body, message) => {
        const { status, body: error } = await call<{ err_msg: string }>("POST", "/api/planet/tools/install", body);
        expect(status).toBe(400);
        expect(error.err_msg).toMatch(message);
        expect(await jobs.listByState(["new"])).toEqual([]);
    });

    it("installs a GitHub commit only when it is on a branch or tag of the repository", async () => {
        const fetchMock = stubGitHub([GITHUB.ref]);
        const accepted = await call<InstallView>("POST", "/api/planet/tools/install", { source: GITHUB });
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({ label: "galaxyproject/tools-iuc", phase: "queued" });
        expect(String(fetchMock.mock.calls[1]![0])).toContain(
            `/repos/galaxyproject/tools-iuc/compare/main...${GITHUB.ref}`,
        );

        const fork = { ...GITHUB, ref: "b".repeat(40) };
        const refused = await call<{ err_msg: string }>("POST", "/api/planet/tools/install", { source: fork });
        expect(refused.status).toBe(400);
        expect(refused.body.err_msg).toMatch(/is not on a branch or tag of galaxyproject\/tools-iuc/);
        expect((await jobs.listByState(["new"])).map((job) => job.id)).toEqual([accepted.body.id]);
    });

    it("refuses GitHub installs while GitHub cannot be asked", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })),
        );
        const refused = await call<{ err_msg: string }>("POST", "/api/planet/tools/install", { source: GITHUB });
        expect(refused.status).toBe(502);
        expect(refused.body.err_msg).toMatch(/limit of API requests/);
        expect(await jobs.listByState(["new"])).toEqual([]);
    });

    it("requires a JSON request", async () => {
        const response = await router.handle(
            new Request(`${ORIGIN}/api/planet/tools/install`, {
                method: "POST",
                body: JSON.stringify({ source: SOURCE }),
            }),
        );
        expect(response.status).toBe(400);
    });
});

describe("installations", () => {
    it("lists them newest first and dismisses finished ones", async () => {
        stubGitHub([GITHUB.ref]);
        const first = (await call<InstallView>("POST", "/api/planet/tools/install", { source: SOURCE })).body;
        const second = (await call<InstallView>("POST", "/api/planet/tools/install", { source: GITHUB })).body;
        const listed = await call<InstallView[]>("GET", "/api/planet/tools/installs");
        expect(listed.body.map((view) => view.id)).toEqual([second.id, first.id]);
        expect(listed.body[0]).toMatchObject({ label: "galaxyproject/tools-iuc", phase: "queued" });

        expect((await call("DELETE", `/api/planet/tools/installs/${first.id}`)).status).toBe(409);
        await jobs.update(first.id, { state: "error", job_messages: [{ type: "internal", desc: "Cloning failed." }] });
        const failed = await call<InstallView[]>("GET", "/api/planet/tools/installs");
        expect(failed.body[1]).toMatchObject({ phase: "failed", message: "Cloning failed." });
        const dismissed = await call<InstallView>("DELETE", `/api/planet/tools/installs/${first.id}`);
        expect(dismissed.status).toBe(200);
        expect((await call<InstallView[]>("GET", "/api/planet/tools/installs")).body.map((view) => view.id)).toEqual([
            second.id,
        ]);
        expect((await call("DELETE", "/api/planet/tools/installs/0123456789abcdef")).status).toBe(404);
    });
});

describe("installed tools", () => {
    it("lists installed tools only", async () => {
        await installedTool();
        await installedTool({ tool_id: "cat1", tool_version: "1.0", source: "curated" });
        const { body } = await call<InstalledToolView[]>("GET", "/api/planet/tools/installed");
        expect(body).toEqual([
            {
                id: TOOL_ID,
                version: VERSION,
                name: "Datamash",
                description: "(operations on tabular data)",
                repository: "iuc/datamash_ops",
                revision: "aaafc0ac4dd2",
                page_url: "https://toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops",
                install_time: expect.any(String),
            },
        ]);
    });

    it("uninstalls a tool version once its jobs finished", async () => {
        await installedTool();
        const path = `/api/planet/tools/${encodeURIComponent(TOOL_ID)}/${encodeURIComponent(VERSION)}`;
        const job = await jobs.create({ tool_id: TOOL_ID, tool_version: VERSION, state: "running" });
        const busy = await call<{ err_msg: string }>("DELETE", path);
        expect(busy.status).toBe(409);
        expect(busy.body.err_msg).toMatch(/A job of this tool has not finished/);
        await jobs.update(job.id, { state: "ok" });
        expect((await call("DELETE", path)).status).toBe(200);
        expect(await tools.get(TOOL_ID, VERSION)).toBeUndefined();
        expect((await call("DELETE", path)).status).toBe(404);
    });

    it("keeps a tool version that paused jobs may still run once resumed", async () => {
        await installedTool();
        const path = `/api/planet/tools/${encodeURIComponent(TOOL_ID)}/${encodeURIComponent(VERSION)}`;
        const job = await jobs.create({ tool_id: TOOL_ID, tool_version: VERSION, state: "paused" });
        const busy = await call<{ err_msg: string }>("DELETE", path);
        expect(busy.status).toBe(409);
        expect(await tools.get(TOOL_ID, VERSION)).toBeDefined();
        await jobs.update(job.id, { state: "deleted" });
        expect((await call("DELETE", path)).status).toBe(200);
    });

    it("does not uninstall built-in tools", async () => {
        await installedTool({ tool_id: "cat1", tool_version: "1.0", source: "curated" });
        expect((await call("DELETE", "/api/planet/tools/cat1/1.0")).status).toBe(404);
        expect(await tools.get("cat1", "1.0")).toBeDefined();
    });
});
