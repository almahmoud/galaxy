// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { KubeError } from "@/planet/k8s";

import { fakeKube, fakeS3, R2_ACCOUNT, settingsFixture } from "../__tests__/fakes";
import { PlanetApiError } from "./api";
import type { CheckReport } from "./checks";
import { type ConnectionDeps, testCluster, testStorage } from "./connection";
import { clusterForm, storageForm } from "./forms";
import { GARAGE } from "./presets";

function deps(overrides: Partial<ConnectionDeps> = {}): ConnectionDeps & { runChecks: ReturnType<typeof vi.fn> } {
    return {
        runChecks: vi.fn(async (): Promise<CheckReport> => ({})),
        localNetworkAccess: vi.fn(async () => "granted" as const),
        probe: vi.fn(async () => "reachable" as const),
        origin: "https://planet.example.org",
        ...overrides,
    } as ConnectionDeps & { runChecks: ReturnType<typeof vi.fn> };
}

const workerReport: CheckReport = {
    cluster: { state: "ok", checks: [], version: "v1.33.1", missing_permissions: [] },
    storage: { state: "ok", checks: [], cors_suspected: false, cors: null, clock_offset_ms: 0 },
};

describe("testCluster", () => {
    const saved = settingsFixture({ cluster: { gateway_url: "http://127.0.0.1:8001", has_token: true } }).cluster;

    it("checks a typed token in the page only", async () => {
        const kube = fakeKube();
        const services = deps({ kubeClient: kube.factory });
        const report = await testCluster({ ...clusterForm(saved), token: "typed" }, saved, services);
        expect(report.state).toBe("ok");
        expect(kube.configs.map((config) => config.token)).toEqual(["", "typed"]);
        expect(services.runChecks).not.toHaveBeenCalled();
        expect(services.localNetworkAccess).toHaveBeenCalledWith("http://127.0.0.1:8001");
    });

    it("reaches the gateway from the page, then checks the saved token in the worker", async () => {
        const kube = fakeKube();
        const services = deps({ kubeClient: kube.factory, runChecks: vi.fn(async () => workerReport) });
        const form = { ...clusterForm(saved), namespace: "jobs" };
        const report = await testCluster(form, saved, services);
        expect(report).toBe(workerReport.cluster);
        expect(kube.configs).toEqual([{ gatewayUrl: "http://127.0.0.1:8001", namespace: "jobs", token: "" }]);
        expect(services.runChecks).toHaveBeenCalledWith({
            targets: ["cluster"],
            mode: "full",
            settings: { cluster: { gateway_url: "http://127.0.0.1:8001", namespace: "jobs" } },
        });
    });

    it("does not ask the worker when the page cannot reach the gateway", async () => {
        const kube = fakeKube({ version: async () => Promise.reject(new KubeError(0, "network_blocked", "blocked")) });
        const services = deps({ kubeClient: kube.factory, probe: vi.fn(async () => "unreachable" as const) });
        const report = await testCluster(clusterForm(saved), saved, services);
        expect(report.state).toBe("error");
        expect(services.runChecks).not.toHaveBeenCalled();
    });

    it("reports a worker that cannot run the check", async () => {
        const services = deps({
            kubeClient: fakeKube().factory,
            runChecks: vi.fn(async () => Promise.reject(new PlanetApiError(500, "Internal server error"))),
        });
        const report = await testCluster(clusterForm(saved), saved, services);
        expect(report.state).toBe("error");
        expect(report.checks.at(-1)?.message).toBe(
            "Planet could not run the check with the saved secret. Internal server error",
        );
    });

    it("never uses the saved token for another gateway URL", async () => {
        const kube = fakeKube();
        const services = deps({ kubeClient: kube.factory });
        const form = { ...clusterForm(saved), gateway_url: "https://gateway.example.org" };
        const report = await testCluster(form, saved, services);
        expect(report.checks.at(-1)?.code).toBe("missing_token");
        expect(kube.configs.map((config) => config.token)).toEqual([""]);
        expect(services.runChecks).not.toHaveBeenCalled();
    });

    it("asks for a token once the saved one is being removed", async () => {
        const services = deps({ kubeClient: fakeKube().factory });
        const report = await testCluster({ ...clusterForm(saved), clear_token: true }, saved, services);
        expect(report.checks.at(-1)?.code).toBe("missing_token");
        expect(services.runChecks).not.toHaveBeenCalled();
    });
});

describe("testStorage", () => {
    const saved = settingsFixture({
        storage: {
            endpoint: GARAGE.endpoint,
            region: "garage",
            bucket: "planet",
            access_key_id: "GK0123456789abcdef01234567",
            has_secret: true,
        },
    }).storage;

    it("checks a typed secret in the page only", async () => {
        const s3 = fakeS3();
        const services = deps({ s3Client: s3.factory });
        const report = await testStorage({ ...storageForm(saved), secret_access_key: "typed" }, saved, services);
        expect(report.state).toBe("ok");
        expect(s3.configs[0]?.secretAccessKey).toBe("typed");
        expect(s3.checkSetup).toHaveBeenCalledWith(expect.objectContaining({ origin: "https://planet.example.org" }));
        expect(services.runChecks).not.toHaveBeenCalled();
    });

    it("contacts a local endpoint from the page, then checks the saved secret in the worker", async () => {
        const s3 = fakeS3();
        const services = deps({ s3Client: s3.factory, runChecks: vi.fn(async () => workerReport) });
        const report = await testStorage(storageForm(saved), saved, services);
        expect(report).toBe(workerReport.storage);
        expect(services.probe).toHaveBeenCalledWith("http://127.0.0.1:8002/");
        expect(s3.factory).not.toHaveBeenCalled();
        const request = services.runChecks.mock.calls[0]![0];
        expect(request.settings.storage).toMatchObject({ endpoint: GARAGE.endpoint, bucket: "planet" });
        expect(request.settings.storage).not.toHaveProperty("secret_access_key");
    });

    it("never uses the saved secret for another bucket", async () => {
        const s3 = fakeS3();
        const services = deps({ s3Client: s3.factory });
        const report = await testStorage({ ...storageForm(saved), bucket: "other-bucket" }, saved, services);
        expect(report.checks.some((check) => check.code === "missing_secret")).toBe(true);
        expect(services.runChecks).not.toHaveBeenCalled();
        expect(s3.factory).not.toHaveBeenCalled();
    });

    it("stops when a local endpoint does not answer", async () => {
        const services = deps({ probe: vi.fn(async () => "unreachable" as const) });
        const report = await testStorage(storageForm(saved), saved, services);
        expect(report.checks[0]).toMatchObject({ id: "endpoint", code: "network_blocked" });
        expect(services.runChecks).not.toHaveBeenCalled();
    });

    it("reports invalid settings before contacting anything", async () => {
        const services = deps();
        const form = { ...storageForm(saved), provider: "r2" as const, account_id: R2_ACCOUNT, bucket: "ab" };
        const report = await testStorage(form, saved, services);
        expect(report.checks[0]?.code).toBe("invalid_config");
        expect(services.probe).not.toHaveBeenCalled();
    });
});
