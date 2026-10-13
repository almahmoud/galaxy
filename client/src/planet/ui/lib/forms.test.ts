// @vitest-environment node
import { describe, expect, it } from "vitest";

import { R2_ACCOUNT, settingsFixture } from "../__tests__/fakes";
import {
    applyProvider,
    clusterChange,
    clusterDirty,
    clusterForm,
    clusterTarget,
    clusterTokenRebound,
    clusterTokenSource,
    secretSource,
    storageChange,
    storageConfig,
    storageDirty,
    storageForm,
    storageSecretRebound,
    storageSecretSource,
    storageValues,
    validateClusterForm,
    validateStorageForm,
} from "./forms";
import { GARAGE } from "./presets";

describe("secretSource", () => {
    it("prefers a typed secret, then a removal, then the saved one", () => {
        expect(secretSource(" new ", true, true)).toBe("typed");
        expect(secretSource("", true, true)).toBe("cleared");
        expect(secretSource("", false, true)).toBe("saved");
        expect(secretSource("", false, false)).toBe("missing");
    });
});

describe("cluster form", () => {
    const saved = settingsFixture({ cluster: { gateway_url: "http://127.0.0.1:8001", has_token: true } }).cluster;

    it("starts from the saved settings without the token", () => {
        const form = clusterForm(saved);
        expect(form).toMatchObject({
            gateway_url: "http://127.0.0.1:8001",
            token: "",
            default_walltime_seconds: "86400",
        });
        expect(clusterDirty(form, saved)).toBe(false);
    });

    it("sends the token only when typed or removed", () => {
        const form = clusterForm(saved);
        expect(clusterChange(form)).not.toHaveProperty("token");
        expect(clusterChange({ ...form, token: " abc \n" }).token).toBe("abc");
        expect(clusterChange({ ...form, clear_token: true }).token).toBeNull();
        expect(clusterDirty({ ...form, clear_token: true }, saved)).toBe(true);
        expect(clusterDirty({ ...form, token: "abc" }, saved)).toBe(true);
    });

    it("does not carry the saved token over to another gateway URL", () => {
        const form = clusterForm(saved);
        expect(clusterTokenRebound({ ...form, gateway_url: "HTTP://127.0.0.1:8001/" }, saved)).toBe(false);
        expect(clusterTokenSource({ ...form, namespace: "jobs" }, saved)).toBe("saved");
        const moved = { ...form, gateway_url: "https://gateway.example.org" };
        expect(clusterTokenRebound(moved, saved)).toBe(true);
        expect(clusterTokenSource(moved, saved)).toBe("cleared");
        expect(clusterTokenSource({ ...moved, token: "typed" }, saved)).toBe("typed");
        expect(clusterTokenRebound(moved, { ...saved, has_token: false })).toBe(false);
    });

    it("trims values and parses the walltime", () => {
        const change = clusterChange({
            ...clusterForm(saved),
            namespace: " jobs ",
            default_walltime_seconds: " 3600 ",
        });
        expect(change.namespace).toBe("jobs");
        expect(change.default_walltime_seconds).toBe(3600);
        expect(clusterDirty({ ...clusterForm(saved), namespace: "jobs" }, saved)).toBe(true);
    });

    it("reports errors with the API's field keys", () => {
        const errors = validateClusterForm({
            ...clusterForm(saved),
            gateway_url: "http://k8s.example.org",
            default_walltime_seconds: "1 day",
        });
        expect(Object.keys(errors).sort()).toEqual(["cluster.default_walltime_seconds", "cluster.gateway_url"]);
    });

    it("builds the check target", () => {
        expect(clusterTarget({ ...clusterForm(saved), token: " t " })).toEqual({
            gatewayUrl: "http://127.0.0.1:8001",
            namespace: "planet",
            token: "t",
        });
    });
});

describe("storage form", () => {
    it("recognizes R2, AWS, Garage and other endpoints", () => {
        const r2 = storageForm(
            settingsFixture({ storage: { endpoint: `https://${R2_ACCOUNT}.eu.r2.cloudflarestorage.com` } }).storage,
        );
        expect(r2).toMatchObject({ provider: "r2", account_id: R2_ACCOUNT, jurisdiction: "eu" });
        const aws = storageForm(
            settingsFixture({
                storage: { endpoint: "https://s3.eu-west-1.amazonaws.com", region: "", path_style: false },
            }).storage,
        );
        expect(aws).toMatchObject({ provider: "aws", region: "eu-west-1" });
        expect(storageForm(settingsFixture({ storage: { endpoint: GARAGE.endpoint } }).storage).provider).toBe(
            "garage",
        );
        expect(
            storageForm(settingsFixture({ storage: { endpoint: "https://minio.example.org" } }).storage).provider,
        ).toBe("custom");
        expect(storageForm(settingsFixture().storage).provider).toBe("r2");
    });

    it("derives the provider's fixed settings", () => {
        const base = storageForm(settingsFixture().storage);
        expect(storageValues({ ...base, account_id: R2_ACCOUNT.toUpperCase() })).toMatchObject({
            endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
            region: "auto",
            path_style: true,
        });
        expect(storageValues({ ...base, provider: "aws", region: "us-west-2" })).toMatchObject({
            endpoint: "https://s3.us-west-2.amazonaws.com",
            region: "us-west-2",
            path_style: false,
        });
        expect(
            storageValues({
                ...base,
                provider: "custom",
                endpoint: "https://minio.example.org",
                region: "",
                path_style: false,
            }),
        ).toMatchObject({
            endpoint: "https://minio.example.org",
            path_style: false,
        });
    });

    it("fills in Garage's settings and keeps what was typed", () => {
        const form = applyProvider({ ...storageForm(settingsFixture().storage), access_key_id: "GKabc" }, "garage");
        expect(form).toMatchObject({
            provider: "garage",
            endpoint: GARAGE.endpoint,
            region: "garage",
            cluster_endpoint: GARAGE.clusterEndpoint,
            bucket: "planet",
            access_key_id: "GKabc",
        });
        const back = applyProvider(form, "r2");
        expect(back.cluster_endpoint).toBe("");
    });

    it("starts a custom endpoint from the previous provider's endpoint", () => {
        const r2 = { ...storageForm(settingsFixture().storage), account_id: R2_ACCOUNT };
        expect(applyProvider(r2, "custom")).toMatchObject({
            endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
            region: "auto",
            path_style: true,
        });
    });

    it("validates the account ID and region once the form is started", () => {
        const empty = storageForm(settingsFixture().storage);
        expect(validateStorageForm(empty)).toEqual({});
        expect(validateStorageForm({ ...empty, bucket: "planet" })).toHaveProperty("storage.account_id");
        expect(validateStorageForm({ ...empty, account_id: "xyz" })["storage.account_id"]).toMatch(/32 characters/);
        expect(validateStorageForm({ ...empty, provider: "aws", region: "Frankfurt" })).toHaveProperty(
            "storage.region",
        );
        expect(validateStorageForm({ ...empty, account_id: R2_ACCOUNT, bucket: "Bad_Bucket" })).toEqual({
            "storage.bucket": expect.any(String),
        });
    });

    it("sends the secret only when typed or removed and tracks changes", () => {
        const saved = settingsFixture({
            storage: {
                endpoint: GARAGE.endpoint,
                region: "garage",
                bucket: "planet",
                access_key_id: "GK1",
                has_secret: true,
            },
        }).storage;
        const form = storageForm(saved);
        expect(storageDirty(form, saved)).toBe(false);
        expect(storageChange(form)).not.toHaveProperty("secret_access_key");
        expect(storageChange({ ...form, clear_secret: true }).secret_access_key).toBeNull();
        expect(storageDirty({ ...form, bucket: "other" }, saved)).toBe(true);
        for (const change of [
            { bucket: "other" },
            { access_key_id: "GK2" },
            { cluster_endpoint: "http://garage.planet.svc:3900" },
            { provider: "custom" as const, endpoint: "https://s3.example.org" },
        ]) {
            expect(storageSecretRebound({ ...form, ...change }, saved), JSON.stringify(change)).toBe(true);
            expect(storageSecretSource({ ...form, ...change }, saved)).toBe("cleared");
        }
        expect(storageSecretRebound({ ...form, prefix: "other" }, saved)).toBe(false);
        expect(storageSecretSource({ ...form, prefix: "other" }, saved)).toBe("saved");
        expect(storageConfig({ ...form, secret_access_key: " s " })).toEqual({
            endpoint: GARAGE.endpoint,
            clusterEndpoint: "",
            bucket: "planet",
            prefix: "planet",
            region: "garage",
            pathStyle: true,
            accessKeyId: "GK1",
            secretAccessKey: "s",
        });
    });
});
