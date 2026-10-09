// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { KubeError } from "@/planet/k8s";
import { type S3Config, S3Error } from "@/planet/s3";

import { fakeKube, fakeS3, review, setupCheck, setupReport } from "../__tests__/fakes";
import { checkCluster, checkStorage, type ClusterCheckOptions } from "./checks";

const ORIGIN = "https://planet.example.org";
const LOCAL = { gatewayUrl: "http://127.0.0.1:8001", namespace: "planet", token: "token" };
const REMOTE = { gatewayUrl: "https://k8s.example.org", namespace: "planet", token: "token" };

const BLOCKED = new KubeError(0, "network_blocked", "Could not reach the Kubernetes gateway.");

function page(extra: Partial<ClusterCheckOptions> = {}): ClusterCheckOptions {
    return { context: "page", origin: ORIGIN, ...extra };
}

function timeoutError(): Error {
    const error = new Error("The operation timed out.");
    error.name = "TimeoutError";
    return error;
}

describe("checkCluster", () => {
    it("passes for a reachable gateway, a valid token and the Planet role", async () => {
        const kube = fakeKube();
        const report = await checkCluster(LOCAL, page({ kubeClient: kube.factory }));
        expect(report.state).toBe("ok");
        expect(report.version).toBe("v1.33.1");
        expect(report.checks.map((check) => [check.id, check.status])).toEqual([
            ["gateway", "ok"],
            ["token", "ok"],
            ["permissions", "ok"],
            ["namespace", "ok"],
        ]);
        expect(kube.configs.map((config) => config.token)).toEqual(["", "token"]);
    });

    it("treats a version endpoint that needs authentication as reachable", async () => {
        const kube = fakeKube({
            version: async () => {
                throw new KubeError(401, "Unauthorized", "Unauthorized");
            },
        });
        const report = await checkCluster(LOCAL, page({ kubeClient: kube.factory }));
        expect(report.checks[0]).toMatchObject({ id: "gateway", status: "ok" });
        expect(report.version).toBeNull();
        expect(report.state).toBe("ok");
    });

    it("is not configured without a gateway URL", async () => {
        const kube = fakeKube();
        const report = await checkCluster({ ...LOCAL, gatewayUrl: "" }, page({ kubeClient: kube.factory }));
        expect(report.state).toBe("not_configured");
        expect(kube.factory).not.toHaveBeenCalled();
    });

    it("rejects invalid settings before any request", async () => {
        const kube = fakeKube();
        const report = await checkCluster(
            { ...LOCAL, gatewayUrl: "http://k8s.example.org" },
            page({ kubeClient: kube.factory }),
        );
        expect(report.checks).toEqual([
            expect.objectContaining({ id: "config", status: "error", code: "invalid_config" }),
        ]);
        expect(kube.factory).not.toHaveBeenCalled();
    });

    it("explains a CORS refusal when the gateway answers without CORS", async () => {
        const kube = fakeKube({ version: async () => Promise.reject(BLOCKED) });
        const probe = vi.fn(async () => "reachable" as const);
        const report = await checkCluster(LOCAL, page({ kubeClient: kube.factory, probe }));
        expect(probe).toHaveBeenCalledWith("http://127.0.0.1:8001/");
        expect(report.checks[0]).toMatchObject({ code: "cors", status: "error" });
        expect(report.checks[0]?.fix).toBe(
            `Add the line "${ORIGIN}" 1; to allowed-origins.map in your overlay and apply it again.`,
        );
        expect(kube.rulesReview).not.toHaveBeenCalled();
    });

    it("points at the port-forward when a local gateway does not answer", async () => {
        const kube = fakeKube({ version: async () => Promise.reject(BLOCKED) });
        const report = await checkCluster(
            LOCAL,
            page({ kubeClient: kube.factory, probe: async () => "unreachable", localAccess: "granted" }),
        );
        expect(report.checks[0]).toMatchObject({ code: "network_blocked" });
        expect(report.checks[0]?.fix).toMatch(/port-forward/);
        expect(report.checks[0]?.fix).toMatch(/Safari/);
    });

    it("explains a denied local network permission without probing", async () => {
        const kube = fakeKube({ version: async () => Promise.reject(BLOCKED) });
        const probe = vi.fn(async () => "unreachable" as const);
        const report = await checkCluster(LOCAL, page({ kubeClient: kube.factory, probe, localAccess: "denied" }));
        expect(report.checks[0]?.code).toBe("local_network_denied");
        expect(probe).not.toHaveBeenCalled();
    });

    it("sends the worker's failures to the setup page", async () => {
        const kube = fakeKube({ version: async () => Promise.reject(BLOCKED) });
        const local = await checkCluster(LOCAL, { context: "worker", kubeClient: kube.factory });
        expect(local.checks[0]?.fix).toBe(
            "Open the setup page and press Test connection so the browser can ask for local network permission.",
        );
        const remote = await checkCluster(REMOTE, { context: "worker", kubeClient: kube.factory });
        expect(remote.checks[0]?.fix).toBe("Open the setup page and press Test connection to find out why.");
    });

    it("reports timeouts", async () => {
        const kube = fakeKube({ version: async () => Promise.reject(timeoutError()) });
        const report = await checkCluster(LOCAL, page({ kubeClient: kube.factory, timeoutMs: 5000 }));
        expect(report.checks[0]).toMatchObject({
            code: "timeout",
            message: "The gateway did not answer within 5 seconds.",
        });
    });

    it("rethrows when the caller aborts", async () => {
        const controller = new AbortController();
        const kube = fakeKube({
            version: async () => {
                controller.abort(new Error("stopped"));
                throw new Error("aborted");
            },
        });
        await expect(
            checkCluster(LOCAL, page({ kubeClient: kube.factory, signal: controller.signal })),
        ).rejects.toThrow("stopped");
    });

    it("asks for the token when none is set", async () => {
        const kube = fakeKube();
        const report = await checkCluster({ ...LOCAL, token: "" }, page({ kubeClient: kube.factory }));
        expect(report.checks.at(-1)).toMatchObject({ id: "token", status: "error", code: "missing_token" });
        expect(report.checks.at(-1)?.fix).toContain("kubectl -n planet get secret planet-client-token");
    });

    it("stops after the gateway when only the anonymous check is wanted", async () => {
        const kube = fakeKube();
        const report = await checkCluster(
            { ...LOCAL, token: "" },
            page({ kubeClient: kube.factory, anonymousOnly: true }),
        );
        expect(report.state).toBe("ok");
        expect(report.checks.map((check) => check.id)).toEqual(["gateway"]);
    });

    it("reports a rejected token", async () => {
        const kube = fakeKube({
            rulesReview: async () => Promise.reject(new KubeError(401, "Unauthorized", "Unauthorized")),
        });
        const report = await checkCluster({ ...LOCAL, namespace: "jobs" }, page({ kubeClient: kube.factory }));
        expect(report.checks.at(-1)).toMatchObject({ id: "token", message: "The cluster rejected the token." });
        expect(report.checks.at(-1)?.fix).toContain("kubectl -n jobs get secret");
    });

    it("lists missing permissions, as a warning when the rules may be incomplete", async () => {
        const partial = [{ verbs: ["*"], apiGroups: ["batch"], resources: ["jobs"] }];
        const error = await checkCluster(
            LOCAL,
            page({ kubeClient: fakeKube({ rulesReview: async () => review(partial) }).factory }),
        );
        const permissions = error.checks.find((check) => check.id === "permissions");
        expect(permissions?.status).toBe("error");
        expect(error.missing_permissions).toEqual([
            "get pods",
            "list pods",
            "watch pods",
            "get pods/log",
            "list events",
            "watch events",
        ]);
        expect(permissions?.fix).toContain("kubectl apply -k planet/deploy/overlays/");

        const warning = await checkCluster(
            LOCAL,
            page({ kubeClient: fakeKube({ rulesReview: async () => review(partial, true) }).factory }),
        );
        expect(warning.checks.find((check) => check.id === "permissions")?.status).toBe("warning");
        expect(warning.state).toBe("warning");
    });

    it("explains a gateway that does not serve the namespace", async () => {
        const kube = fakeKube({
            listJobs: async () => Promise.reject(new KubeError(403, "Forbidden", "path not allowed")),
        });
        const report = await checkCluster(LOCAL, page({ kubeClient: kube.factory }));
        expect(report.checks.at(-1)).toMatchObject({ id: "namespace", status: "error" });
        expect(report.checks.at(-1)?.fix).toMatch(/namespace the gateway runs in/);
    });
});

const GARAGE: S3Config = {
    endpoint: "http://127.0.0.1:8002",
    clusterEndpoint: "http://garage.planet-storage.svc:3900",
    bucket: "planet",
    prefix: "planet",
    region: "garage",
    pathStyle: true,
    accessKeyId: "GK0123456789abcdef01234567",
    secretAccessKey: "secret",
};
const R2: S3Config = {
    ...GARAGE,
    endpoint: "https://acct.r2.cloudflarestorage.com",
    clusterEndpoint: "",
    region: "auto",
};

describe("checkStorage", () => {
    it("is not configured until endpoint, bucket and access key are set", async () => {
        const s3 = fakeS3();
        const report = await checkStorage({ ...R2, bucket: "", accessKeyId: "" }, page({ s3Client: s3.factory }));
        expect(report.state).toBe("not_configured");
        expect(report.checks[0]?.message).toBe("Enter the bucket, access key ID to connect a bucket.");
        expect(s3.factory).not.toHaveBeenCalled();
    });

    it("requires the secret unless only the endpoint is checked", async () => {
        const s3 = fakeS3();
        const missing = await checkStorage({ ...R2, secretAccessKey: "" }, page({ s3Client: s3.factory }));
        expect(missing.checks[0]).toMatchObject({ code: "missing_secret", status: "error" });
        const anonymous = await checkStorage(
            { ...R2, secretAccessKey: "" },
            page({ s3Client: s3.factory, anonymousOnly: true, probe: async () => "reachable" }),
        );
        expect(anonymous.checks).toEqual([expect.objectContaining({ id: "endpoint", status: "ok" })]);
        expect(s3.factory).not.toHaveBeenCalled();
    });

    it("runs the full setup check and keeps its results", async () => {
        const s3 = fakeS3();
        const report = await checkStorage(R2, page({ s3Client: s3.factory }));
        expect(report.state).toBe("ok");
        expect(report.checks).toHaveLength(9);
        expect(report.cors_suspected).toBe(false);
        expect(s3.checkSetup).toHaveBeenCalledWith(expect.objectContaining({ origin: ORIGIN }));
    });

    it("marks CORS failures and provides the policy", async () => {
        const s3 = fakeS3({
            checkSetup: async () =>
                setupReport([
                    setupCheck("config"),
                    setupCheck("write"),
                    setupCheck("etag", "error", "cors_expose_etag"),
                ]),
        });
        const report = await checkStorage(R2, page({ s3Client: s3.factory }));
        expect(report.state).toBe("error");
        expect(report.cors_suspected).toBe(true);
        expect(report.cors).not.toBeNull();
        expect(report.checks.find((check) => check.id === "etag")?.title).toBe("ETag header");
    });

    it("tells a CORS refusal from an unreachable endpoint on the page", async () => {
        const blocked = new S3Error(0, "network_blocked", "Could not reach the storage endpoint.");
        const s3 = fakeS3({
            checkSetup: async () =>
                setupReport([setupCheck("config"), { ...setupCheck("bucket", "error", "network_blocked") }]),
        });
        const reachable = await checkStorage(GARAGE, page({ s3Client: s3.factory, probe: async () => "reachable" }));
        expect(reachable.checks[1]).toMatchObject({ code: "cors" });
        expect(reachable.checks[1]?.fix).toContain("Garage behind the Planet gateway");
        expect(reachable.cors_suspected).toBe(true);
        expect(reachable.cors).not.toBeNull();

        const quick = fakeS3({ headBucket: async () => Promise.reject(blocked) });
        const unreachable = await checkStorage(
            GARAGE,
            page({ s3Client: quick.factory, mode: "quick", probe: async () => "unreachable" }),
        );
        expect(unreachable.checks[0]).toMatchObject({ code: "network_blocked" });
        expect(unreachable.cors_suspected).toBe(false);
    });

    it("suspects CORS when the worker cannot reach a public endpoint", async () => {
        const blocked = new S3Error(0, "network_blocked", "Could not reach the storage endpoint.");
        const s3 = fakeS3({ headBucket: async () => Promise.reject(blocked) });
        const report = await checkStorage(R2, {
            context: "worker",
            origin: ORIGIN,
            mode: "quick",
            s3Client: s3.factory,
        });
        expect(report.cors_suspected).toBe(true);
        expect(report.cors?.r2WranglerCommand).toContain("wrangler r2 bucket cors set planet");
    });

    it("falls back to listing when HeadBucket is denied in quick mode", async () => {
        const s3 = fakeS3({
            headBucket: async () => Promise.reject(new S3Error(403, "AccessDenied", "Access Denied")),
        });
        const report = await checkStorage(R2, page({ s3Client: s3.factory, mode: "quick" }));
        expect(report.state).toBe("ok");
        expect(s3.listObjects).toHaveBeenCalledWith("", expect.objectContaining({ maxKeys: 1 }));
    });

    it("explains unreachable endpoints in anonymous mode", async () => {
        const report = await checkStorage(
            GARAGE,
            page({ anonymousOnly: true, probe: async () => "unreachable", localAccess: "granted" }),
        );
        expect(report.checks[0]).toMatchObject({ id: "endpoint", code: "network_blocked" });
        expect(report.checks[0]?.fix).toMatch(/local network access/);
    });
});
