// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, type JobRecord, leader, settings } from "@/planet/db";
import { writeTx } from "@/planet/db/tx";
import { DEFAULT_RUNTIME_IMAGE } from "@/planet/jobs/k8sJob";
import { STALE_MS } from "@/planet/jobs/leader";
import { KubeError } from "@/planet/k8s";
import { S3Error } from "@/planet/s3";
import { Router } from "@/planet/sw/router";
import { fakeKube, fakeS3, review, setupCheck, setupReport } from "@/planet/ui/__tests__/fakes";
import type { PlanetStatus } from "@/planet/ui/lib/api";
import type { CheckReport } from "@/planet/ui/lib/checks";
import * as events from "@/planet/util/events";

import { leaderStatus, register } from "../planet";

const ORIGIN = "https://planet.test";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const PINNED = `ghcr.io/almahmoud/planet-runtime@sha256:${"0123456789abcdef".repeat(4)}`;
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.secret-token";
const SECRET = "garage-secret-access-key-0123456789";

let kube: ReturnType<typeof fakeKube>;
let s3: ReturnType<typeof fakeS3>;
let router: Router;
let buildRuntimeImage: () => Promise<string | null>;

function call(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers = { "Content-Type": "application/json" };
    }
    return router.handle(new Request(`${ORIGIN}${path}`, init));
}

async function put(body: unknown) {
    const response = await call("PUT", "/api/planet/settings", body);
    return { status: response.status, body: await response.json() };
}

async function check(body: unknown = {}): Promise<CheckReport> {
    const response = await call("POST", "/api/planet/settings/check", body);
    expect(response.status).toBe(200);
    return response.json();
}

const CONFIGURED = {
    cluster: { gateway_url: "http://127.0.0.1:8001", namespace: "planet", token: TOKEN },
    storage: {
        endpoint: "http://127.0.0.1:8002",
        cluster_endpoint: "http://garage.planet-storage.svc:3900",
        bucket: "planet",
        prefix: "planet",
        region: "garage",
        path_style: true,
        access_key_id: "GK0123456789abcdef01234567",
        secret_access_key: SECRET,
    },
};

beforeEach(async () => {
    await closeDb();
    globalThis.indexedDB = new IDBFactory();
    kube = fakeKube();
    s3 = fakeS3();
    router = new Router();
    buildRuntimeImage = vi.fn(async () => PINNED);
    register(router, {
        kubeClient: kube.factory,
        s3Client: s3.factory,
        buildRuntimeImage: () => buildRuntimeImage(),
        now: () => NOW,
    });
});

afterEach(async () => {
    await closeDb();
    vi.restoreAllMocks();
});

describe("GET /api/planet/build", () => {
    it("returns the build id", async () => {
        const response = await call("GET", "/api/planet/build");
        expect(await response.json()).toEqual({ build_id: "dev" });
    });
});

describe("GET and PUT /api/planet/settings", () => {
    it("returns settings without secrets", async () => {
        const response = await call("GET", "/api/planet/settings");
        const body = await response.json();
        expect(body.instance_id).toMatch(/^[0-9a-f]{8}$/);
        expect(body.cluster).toMatchObject({ namespace: "planet", has_token: false });
        expect(body.storage).toMatchObject({ has_secret: false });
        expect(body.cluster).not.toHaveProperty("token");
        expect(body.storage).not.toHaveProperty("secret_access_key");
    });

    it("stores secrets write-only and reports them as flags", async () => {
        const { status, body } = await put(CONFIGURED);
        expect(status).toBe(200);
        expect(body.cluster.has_token).toBe(true);
        expect(body.storage.has_secret).toBe(true);
        const text = await (await call("GET", "/api/planet/settings")).text();
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(SECRET);
        expect(await settings.getSecrets()).toEqual({ cluster_token: TOKEN, storage_secret_access_key: SECRET });
    });

    it("keeps a secret when it is omitted and removes it when it is null", async () => {
        await put(CONFIGURED);
        expect((await put({ cluster: { namespace: "jobs" } })).body.cluster.has_token).toBe(true);
        expect((await put({ cluster: { token: null } })).body.cluster.has_token).toBe(false);
        expect((await settings.getSecrets()).cluster_token).toBeNull();
    });

    it("removes the token when the gateway URL changes without a new one", async () => {
        await put(CONFIGURED);
        expect((await put({ cluster: { gateway_url: "http://127.0.0.1:8001/" } })).body.cluster.has_token).toBe(true);
        const moved = await put({ cluster: { gateway_url: "https://gateway.example.org" } });
        expect(moved.body.cluster.has_token).toBe(false);
        expect((await settings.getSecrets()).cluster_token).toBeNull();
        const retyped = await put({ cluster: { gateway_url: "https://k8s.example.org", token: "new-token" } });
        expect(retyped.body.cluster.has_token).toBe(true);
        expect((await settings.getSecrets()).cluster_token).toBe("new-token");
    });

    it.each([
        ["endpoint", "https://s3.example.org"],
        ["cluster_endpoint", "http://minio.storage.svc:9000"],
        ["bucket", "other-bucket"],
        ["access_key_id", "AKIAOTHERKEY"],
    ])("removes the secret access key when %s changes without a new one", async (field, value) => {
        await put(CONFIGURED);
        expect((await put({ storage: { [field]: value } })).body.storage.has_secret).toBe(false);
        expect((await settings.getSecrets()).storage_secret_access_key).toBeNull();
        expect((await settings.getSecrets()).cluster_token).toBe(TOKEN);
    });

    it("keeps the secret access key for other storage changes or when the change supplies one", async () => {
        await put(CONFIGURED);
        expect((await put({ storage: { prefix: "other", region: "us-east-1" } })).body.storage.has_secret).toBe(true);
        await put({ storage: { bucket: "other-bucket", secret_access_key: "other-secret" } });
        expect((await settings.getSecrets()).storage_secret_access_key).toBe("other-secret");
    });

    it("normalizes URLs and the key prefix", async () => {
        const { body } = await put({
            cluster: { gateway_url: "HTTP://LOCALHOST:8001/" },
            storage: { endpoint: "https://ACCOUNT.r2.cloudflarestorage.com/", prefix: "/planet/data/" },
        });
        expect(body.cluster.gateway_url).toBe("http://localhost:8001");
        expect(body.storage.endpoint).toBe("https://account.r2.cloudflarestorage.com");
        expect(body.storage.prefix).toBe("planet/data");
    });

    it("accepts https anywhere and http only on localhost and 127.0.0.1", async () => {
        for (const url of ["https://k8s.example.org", "http://127.0.0.1:8001", "http://localhost"]) {
            expect((await put({ cluster: { gateway_url: url } })).status).toBe(200);
        }
        for (const url of ["http://192.168.1.10:8001", "http://[::1]:8001"]) {
            const { status, body } = await put({ cluster: { gateway_url: url } });
            expect(status).toBe(400);
            expect(body.err_code).toBe(400004);
            expect(body.err_data["cluster.gateway_url"]).toMatch(/https/);
        }
    });

    it("allows in-cluster http addresses for the cluster endpoint only", async () => {
        expect((await put({ storage: { cluster_endpoint: "http://garage.planet-storage.svc:3900" } })).status).toBe(
            200,
        );
        expect((await put({ storage: { endpoint: "http://garage.planet-storage.svc:3900" } })).status).toBe(400);
    });

    it.each([
        [{ cluster: { gateway_url: "https://user:pass@k8s.example.org" } }, "cluster.gateway_url"],
        [{ cluster: { gateway_url: "ftp://k8s.example.org" } }, "cluster.gateway_url"],
        [{ cluster: { namespace: "Planet_Jobs" } }, "cluster.namespace"],
        [{ cluster: { namespace: "" } }, "cluster.namespace"],
        [{ cluster: { default_cpu: "lots" } }, "cluster.default_cpu"],
        [{ cluster: { default_memory: "4 GB" } }, "cluster.default_memory"],
        [{ cluster: { default_walltime_seconds: 700000 } }, "cluster.default_walltime_seconds"],
        [{ cluster: { runtime_image: "not an image" } }, "cluster.runtime_image"],
        [{ cluster: { token: "two words" } }, "cluster.token"],
        [{ storage: { bucket: "My_Bucket" } }, "storage.bucket"],
        [{ storage: { bucket: "ab" } }, "storage.bucket"],
        [{ storage: { bucket: "192.168.1.1" } }, "storage.bucket"],
        [{ storage: { prefix: "planet/../other" } }, "storage.prefix"],
        [{ storage: { region: "US East" } }, "storage.region"],
    ])("rejects %j", async (body: unknown, field: string) => {
        const response = await put(body);
        expect(response.status).toBe(400);
        expect(Object.keys(response.body.err_data)).toEqual([field]);
        expect((await call("GET", "/api/planet/settings").then((r) => r.json())).cluster.namespace).toBe("planet");
    });

    it("accepts changes only as JSON", async () => {
        const response = await router.handle(
            new Request(`${ORIGIN}/api/planet/settings`, {
                method: "PUT",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "cluster=1",
            }),
        );
        expect(response.status).toBe(400);
    });

    it("rejects unknown fields and wrong types", async () => {
        expect((await put({ cluster: { gatewayUrl: "https://x.org" } })).status).toBe(400);
        expect((await put({ storage: { path_style: "yes" } })).status).toBe(400);
        expect((await put("[1]")).status).toBe(400);
        expect((await call("PUT", "/api/planet/settings", "{")).status).toBe(400);
    });

    it("publishes settings-changed after a change", async () => {
        const listener = vi.fn();
        const unsubscribe = events.subscribeTo("settings-changed", listener);
        await put({ cluster: { namespace: "jobs" } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        unsubscribe();
        expect(listener).toHaveBeenCalledWith({ type: "settings-changed" });
    });
});

describe("GET /api/planet/status", () => {
    it("reports which components are configured", async () => {
        const before = await (await call("GET", "/api/planet/status")).json();
        expect(before).toMatchObject({ configured: { cluster: false, storage: false }, build_id: "dev" });
        await put(CONFIGURED);
        const after = await (await call("GET", "/api/planet/status")).json();
        expect(after.configured).toEqual({ cluster: true, storage: true });
        expect(after.instance_id).toMatch(/^[0-9a-f]{8}$/);
    });

    it("needs the secret before a component counts as configured", async () => {
        await put({ ...CONFIGURED, storage: { ...CONFIGURED.storage, secret_access_key: null } });
        const status = await (await call("GET", "/api/planet/status")).json();
        expect(status.configured).toEqual({ cluster: true, storage: false });
    });
});

async function getStatus(): Promise<PlanetStatus> {
    const response = await call("GET", "/api/planet/status");
    expect(response.status).toBe(200);
    return response.json();
}

async function putJob(id: string, state: string): Promise<void> {
    await writeTx(["jobs"], async (tx) => {
        const job = { id, state, history_id: "h1", tool_id: "cat1", update_time: "2026-10-13T12:00:00" };
        await tx.store("jobs").put(job as unknown as JobRecord);
    });
}

describe("GET /api/planet/status: job runner", () => {
    it("reports no job runner before any tab led", async () => {
        const status = await getStatus();
        expect(status.leader).toEqual({
            active: false,
            epoch: null,
            heartbeat_age_seconds: null,
            state: null,
            blocked_reason: null,
            last_error: null,
        });
        expect(status.jobs).toEqual({ queued: 0, running: 0 });
    });

    it("reports the leader's heartbeat, state and last error", async () => {
        const epoch = await leader.claimEpoch();
        await leader.heartbeat({ epoch, tab_id: "tab1", heartbeat: NOW - 12_400, visible: true });
        await leader.writeStatus({
            epoch,
            tab_id: "tab1",
            heartbeat: NOW - 12_400,
            state: "blocked",
            blocked_reason: "The cluster could not be listed: 401 Unauthorized",
            last_error: {
                message: "Could not create the Kubernetes Job.",
                job_id: "0123456789abcdef",
                time: NOW - 60_000,
            },
            counts: { queued: 9, running: 9 },
        });
        const status = await getStatus();
        expect(status.leader).toEqual({
            active: true,
            epoch,
            heartbeat_age_seconds: 12,
            state: "blocked",
            blocked_reason: "The cluster could not be listed: 401 Unauthorized",
            last_error: {
                message: "Could not create the Kubernetes Job.",
                job_id: "0123456789abcdef",
                time: "2026-10-13T11:59:00.000Z",
            },
        });
    });

    it("keeps only the last error once the leader stopped or another tab leads", async () => {
        const epoch = await leader.claimEpoch();
        const report = {
            epoch,
            tab_id: "tab1",
            heartbeat: NOW - STALE_MS,
            state: "active" as const,
            blocked_reason: null,
            last_error: { message: "Lost the watch.", job_id: null, time: NOW - STALE_MS },
            counts: { queued: 0, running: 1 },
        };
        await leader.writeStatus(report);
        await leader.heartbeat({ epoch, tab_id: "tab1", heartbeat: NOW - STALE_MS, visible: false });
        let status = await getStatus();
        expect(status.leader).toMatchObject({ active: false, epoch, heartbeat_age_seconds: 90, state: null });
        expect(status.leader.last_error?.message).toBe("Lost the watch.");

        await leader.resign(epoch);
        status = await getStatus();
        expect(status.leader).toMatchObject({ active: false, epoch, heartbeat_age_seconds: null, state: null });
        expect(status.leader.last_error?.message).toBe("Lost the watch.");

        const next = await leader.claimEpoch();
        await leader.heartbeat({ epoch: next, tab_id: "tab2", heartbeat: NOW, visible: true });
        status = await getStatus();
        expect(status.leader).toMatchObject({ active: true, epoch: next, state: null, blocked_reason: null });
    });

    it("treats malformed record fields as absent", () => {
        const beat = { epoch: 7, heartbeat: NOW + 5000 };
        const report = {
            epoch: 7,
            state: 42,
            blocked_reason: "   ",
            last_error: { message: "x".repeat(5000), job_id: "../../admin", time: "yesterday" },
        };
        const status = leaderStatus(beat, report, 7, NOW);
        expect(status).toMatchObject({
            active: true,
            epoch: 7,
            heartbeat_age_seconds: 0,
            state: null,
            blocked_reason: null,
        });
        expect(status.last_error?.job_id).toBeNull();
        expect(status.last_error?.time).toBeNull();
        expect(status.last_error?.message).toHaveLength(2000);
        expect(leaderStatus(beat, { last_error: { job_id: "0123456789abcdef" } }, 7, NOW).last_error).toBeNull();
        expect(leaderStatus(beat, { epoch: "7", state: "active" }, 7, NOW).state).toBeNull();
        expect(leaderStatus("not a record", null, 0, NOW).active).toBe(false);
        expect(leaderStatus({ epoch: 3, heartbeat: Number.NaN }, null, 3, NOW)).toMatchObject({
            active: false,
            epoch: 3,
        });
    });

    it("counts unfinished jobs from the jobs store", async () => {
        const states = [
            "new",
            "upload",
            "waiting",
            "queued",
            "running",
            "finishing",
            "ok",
            "error",
            "paused",
            "deleting",
        ];
        for (const [index, state] of states.entries()) {
            await putJob(index.toString(16).padStart(16, "0"), state);
        }
        expect((await getStatus()).jobs).toEqual({ queued: 4, running: 2 });
    });
});

describe("GET /api/planet/status: runtime image", () => {
    it("uses the build's image while the setting is empty", async () => {
        expect((await getStatus()).runtime).toEqual({
            image: PINNED,
            source: "build",
            default_image: PINNED,
            build_image: PINNED,
            pinned: true,
        });
    });

    it("reports a tag set in the settings as not pinned", async () => {
        await put({ cluster: { runtime_image: "ghcr.io/example/planet-runtime:main" } });
        expect((await getStatus()).runtime).toEqual({
            image: "ghcr.io/example/planet-runtime:main",
            source: "settings",
            default_image: PINNED,
            build_image: PINNED,
            pinned: false,
        });
    });

    it("falls back to Planet's default tag when the build names no image or cannot be read", async () => {
        buildRuntimeImage = vi.fn(async () => null);
        expect((await getStatus()).runtime).toMatchObject({
            image: DEFAULT_RUNTIME_IMAGE,
            source: "fallback",
            build_image: null,
            pinned: false,
        });
        buildRuntimeImage = vi.fn(async () => Promise.reject(new Error("another build")));
        const response = await call("GET", "/api/planet/status");
        expect(response.status).toBe(200);
        expect((await response.json()).runtime.source).toBe("fallback");
    });
});

describe("POST /api/planet/settings/check", () => {
    it("reports components that are not configured without contacting them", async () => {
        const report = await check();
        expect(report.cluster?.state).toBe("not_configured");
        expect(report.storage?.state).toBe("not_configured");
        expect(kube.factory).not.toHaveBeenCalled();
        expect(s3.factory).not.toHaveBeenCalled();
    });

    it("checks with the stored secrets and never returns them", async () => {
        await put(CONFIGURED);
        const response = await call("POST", "/api/planet/settings/check", {});
        const text = await response.text();
        const report = JSON.parse(text) as CheckReport;
        expect(report.cluster?.state).toBe("ok");
        expect(report.cluster?.version).toBe("v1.33.1");
        expect(report.storage?.state).toBe("ok");
        expect(kube.configs.map((config) => config.token)).toEqual(["", TOKEN]);
        expect(s3.configs[0]).toMatchObject({
            secretAccessKey: SECRET,
            clusterEndpoint: CONFIGURED.storage.cluster_endpoint,
        });
        expect(s3.checkSetup).toHaveBeenCalledTimes(1);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(SECRET);
    });

    it("runs only the requested targets in quick mode without writing to the bucket", async () => {
        await put(CONFIGURED);
        const report = await check({ targets: ["storage"], mode: "quick" });
        expect(report.cluster).toBeUndefined();
        expect(report.storage?.checks.map((item) => item.id)).toEqual(["bucket"]);
        expect(s3.headBucket).toHaveBeenCalledTimes(1);
        expect(s3.checkSetup).not.toHaveBeenCalled();
    });

    it("uses settings from the request for this check only", async () => {
        await put(CONFIGURED);
        await check({ targets: ["cluster"], settings: { cluster: { namespace: "jobs" } } });
        expect(kube.configs[0]).toEqual({ gatewayUrl: "http://127.0.0.1:8001", namespace: "jobs", token: "" });
        expect(kube.configs[1]?.token).toBe(TOKEN);
        const stored = await (await call("GET", "/api/planet/settings")).json();
        expect(stored.cluster.namespace).toBe("planet");
    });

    it("never sends the stored token to another gateway or the stored secret to other storage", async () => {
        await put(CONFIGURED);
        const report = await check({
            settings: {
                cluster: { gateway_url: "https://k8s.example.org/" },
                storage: { endpoint: "https://s3.example.org" },
            },
        });
        expect(kube.configs).toEqual([{ gatewayUrl: "https://k8s.example.org", namespace: "planet", token: "" }]);
        expect(report.cluster?.checks.find((item) => item.id === "token")?.code).toBe("missing_token");
        expect(s3.configs.map((config) => config.secretAccessKey)).not.toContain(SECRET);
        await check({
            targets: ["cluster"],
            settings: { cluster: { gateway_url: "https://k8s.example.org", token: "typed" } },
        });
        expect(kube.configs.at(-1)?.token).toBe("typed");
    });

    it("asks for a test from the setup page when the worker cannot reach a local gateway", async () => {
        kube = fakeKube({
            version: async () => {
                throw new KubeError(0, "network_blocked", "Could not reach the Kubernetes gateway.");
            },
        });
        router = new Router();
        register(router, { kubeClient: kube.factory, s3Client: s3.factory });
        await put(CONFIGURED);
        const report = await check({ targets: ["cluster"] });
        expect(report.cluster?.state).toBe("error");
        expect(report.cluster?.checks[0]).toMatchObject({ id: "gateway", code: "network_blocked" });
        expect(report.cluster?.checks[0]?.fix).toBe(
            "Open the setup page and press Test connection so the browser can ask for local network permission.",
        );
        expect(kube.rulesReview).not.toHaveBeenCalled();
    });

    it("lists the permissions the token is missing", async () => {
        kube = fakeKube({
            rulesReview: async () => review([{ verbs: ["get", "list"], apiGroups: ["batch"], resources: ["jobs"] }]),
        });
        router = new Router();
        register(router, { kubeClient: kube.factory });
        await put(CONFIGURED);
        const report = await check({ targets: ["cluster"] });
        expect(report.cluster?.missing_permissions).toContain("create jobs.batch");
        expect(report.cluster?.missing_permissions).toContain("get pods/log");
        expect(report.cluster?.checks.find((item) => item.id === "permissions")?.status).toBe("error");
    });

    it("maps storage failures and suggests the CORS policy", async () => {
        s3 = fakeS3({
            checkSetup: async () =>
                setupReport(
                    [
                        setupCheck("config"),
                        setupCheck("bucket"),
                        setupCheck("write"),
                        setupCheck("etag", "error", "cors_expose_etag"),
                        setupCheck("delete"),
                        setupCheck("clock", "warning", "cors_expose_date"),
                    ],
                    true,
                ),
        });
        router = new Router();
        register(router, { kubeClient: kube.factory, s3Client: s3.factory });
        await put(CONFIGURED);
        const report = await check({ targets: ["storage"] });
        expect(report.storage?.state).toBe("error");
        expect(report.storage?.cors_suspected).toBe(true);
        expect(report.storage?.cors?.awsPutBucketCors.CORSRules[0]?.ExposeHeaders).toContain("ETag");
        expect(report.storage?.checks.find((item) => item.id === "etag")?.fix).toMatch(/CORS policy/);
    });

    it("reports S3 errors with a fix", async () => {
        s3 = fakeS3({
            headBucket: async () => {
                throw new S3Error(403, "SignatureDoesNotMatch", "The request signature does not match.");
            },
        });
        router = new Router();
        register(router, { kubeClient: kube.factory, s3Client: s3.factory });
        await put(CONFIGURED);
        const report = await check({ targets: ["storage"], mode: "quick" });
        expect(report.storage?.checks[0]).toMatchObject({ status: "error", code: "SignatureDoesNotMatch" });
        expect(report.storage?.checks[0]?.fix).toMatch(/secret access key/);
    });

    it("refuses requests another site could send as a form submission", async () => {
        await put(CONFIGURED);
        const form = new Request(`${ORIGIN}/api/planet/settings/check`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ settings: { cluster: { gateway_url: "https://attacker.example" } } }),
        });
        expect((await router.handle(form)).status).toBe(400);
        const navigation = new Request(`${ORIGIN}/api/planet/settings/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
        Object.defineProperty(navigation, "mode", { value: "navigate" });
        expect((await router.handle(navigation)).status).toBe(403);
        expect(kube.factory).not.toHaveBeenCalled();
    });

    it.each([
        [{ targets: [] }],
        [{ targets: ["database"] }],
        [{ mode: "deep" }],
        [{ verbose: true }],
        [{ settings: { cluster: { gateway_url: "http://example.org" } } }],
        [[]],
    ])("rejects %j", async (body: unknown) => {
        const response = await call("POST", "/api/planet/settings/check", body);
        expect(response.status).toBe(400);
    });
});
