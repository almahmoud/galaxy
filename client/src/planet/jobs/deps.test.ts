// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settings } from "@/planet/db";

import { resetDb, teardownDb } from "./__fixtures__/setup";
import { createJobDeps } from "./deps";

beforeEach(resetDb);
afterEach(teardownDb);

const STORAGE = {
    endpoint: "https://account.r2.cloudflarestorage.com",
    cluster_endpoint: "",
    bucket: "planet-data",
    prefix: "planet",
    region: "auto",
    path_style: true,
    access_key_id: "AKIDEXAMPLE",
};

describe("createJobDeps", () => {
    it("returns null while the bucket is not configured", async () => {
        expect(await createJobDeps()).toBeNull();
        await settings.update({ storage: STORAGE });
        expect(await createJobDeps()).toBeNull();
    });

    it("signs requests for pods with the cluster endpoint and reads secrets on demand", async () => {
        await settings.update({
            storage: {
                ...STORAGE,
                cluster_endpoint: "http://garage.planet-storage.svc:3900",
                secret_access_key: "secret",
            },
            cluster: { token: "cluster-token" },
        });
        const resolveContainer = vi.fn(async () => "busybox:1.36");
        const deps = await createJobDeps({ resolveContainer });
        expect(deps).not.toBeNull();
        expect(deps!.settings.storage).toMatchObject({ bucket: "planet-data", has_secret: true });
        expect(deps!.settings.storage).not.toHaveProperty("secret_access_key");
        expect(await deps!.readSecrets()).toEqual({
            cluster_token: "cluster-token",
            storage_secret_access_key: "secret",
        });
        expect(deps!.resolveContainer).toBe(resolveContainer);
        const url = new URL(await deps!.s3.presignGet("jobs/a/manifest.json", 3600, { endpoint: "cluster" }));
        expect(url.origin).toBe("http://garage.planet-storage.svc:3900");
        expect(url.pathname).toBe("/planet-data/planet/jobs/a/manifest.json");
        expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
        expect(url.href).not.toContain("secret");
    });
});
