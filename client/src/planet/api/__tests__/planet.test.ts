// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, settings } from "@/planet/db";
import { KubeError } from "@/planet/k8s";
import { S3Error } from "@/planet/s3";
import { Router } from "@/planet/sw/router";
import { fakeKube, fakeS3, review, setupCheck, setupReport } from "@/planet/ui/__tests__/fakes";
import type { CheckReport } from "@/planet/ui/lib/checks";
import * as events from "@/planet/util/events";

import { register } from "../planet";

const ORIGIN = "https://planet.test";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.secret-token";
const SECRET = "garage-secret-access-key-0123456789";

let kube: ReturnType<typeof fakeKube>;
let s3: ReturnType<typeof fakeS3>;
let router: Router;

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
    register(router, { kubeClient: kube.factory, s3Client: s3.factory });
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
        expect(before).toMatchObject({
            configured: { cluster: false, storage: false },
            build_id: "dev",
            leader: false,
        });
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
        await check({ targets: ["cluster"], settings: { cluster: { gateway_url: "https://k8s.example.org/" } } });
        expect(kube.configs[0]).toEqual({ gatewayUrl: "https://k8s.example.org", namespace: "planet", token: "" });
        expect(kube.configs[1]?.token).toBe(TOKEN);
        const stored = await (await call("GET", "/api/planet/settings")).json();
        expect(stored.cluster.gateway_url).toBe("http://127.0.0.1:8001");
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
