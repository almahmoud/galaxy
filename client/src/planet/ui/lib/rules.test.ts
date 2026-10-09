// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
    browserUrlError,
    bucketError,
    bytesError,
    clusterUrlError,
    cpuError,
    imageError,
    MAX_WALLTIME_SECONDS,
    namespaceError,
    normalizePrefix,
    normalizeUrl,
    prefixError,
    validateSettingsChange,
    walltimeError,
} from "./rules";

describe("browserUrlError", () => {
    it.each([
        "https://k8s.example.org",
        "https://k8s.example.org/prefix",
        "http://localhost:8001",
        "http://127.0.0.1:8001",
        "http://[::1]:8001",
    ])("accepts %s", (url: string) => expect(browserUrlError(url, "The URL")).toBeNull());

    it.each([
        ["http://k8s.example.org", /https/],
        ["http://192.168.1.5:8001", /https/],
        ["127.0.0.1:8001", /starting with/],
        ["k8s.example.org", /starting with/],
        ["https://user:secret@k8s.example.org", /user name or password/],
        ["https://k8s.example.org/?token=x", /query or fragment/],
        ["ws://localhost:8001", /starting with/],
    ])("rejects %s", (url: string, message: RegExp) => expect(browserUrlError(url, "The URL")).toMatch(message));

    it("allows http:// to in-cluster hosts for cluster URLs", () => {
        expect(clusterUrlError("http://garage.planet-storage.svc:3900", "The URL")).toBeNull();
    });
});

describe("normalization", () => {
    it("lowercases the origin and drops a trailing slash", () => {
        expect(normalizeUrl(" HTTPS://K8S.Example.org/Path/ ")).toBe("https://k8s.example.org/Path");
        expect(normalizeUrl("http://127.0.0.1:8001/")).toBe("http://127.0.0.1:8001");
        expect(normalizeUrl("not a url")).toBe("not a url");
    });

    it("trims slashes around the prefix", () => {
        expect(normalizePrefix("/planet/")).toBe("planet");
        expect(normalizePrefix("")).toBe("");
    });
});

describe("field rules", () => {
    it("checks namespaces as DNS labels", () => {
        expect(namespaceError("planet-jobs")).toBeNull();
        expect(namespaceError("Planet")).not.toBeNull();
        expect(namespaceError("-planet")).not.toBeNull();
        expect(namespaceError("a".repeat(64))).not.toBeNull();
    });

    it("follows S3 bucket naming rules", () => {
        for (const name of ["planet", "my.bucket-1", "abc"]) {
            expect(bucketError(name)).toBeNull();
        }
        for (const name of [
            "ab",
            "a".repeat(64),
            "Planet",
            "my..bucket",
            "-planet",
            "10.0.0.1",
            "xn--abc",
            "data-s3alias",
        ]) {
            expect(bucketError(name)).not.toBeNull();
        }
    });

    it("rejects prefixes with unsafe segments", () => {
        expect(prefixError("planet/data")).toBeNull();
        expect(prefixError("")).toBeNull();
        expect(prefixError("planet//data")).not.toBeNull();
        expect(prefixError("planet/../data")).not.toBeNull();
        expect(prefixError("planet data")).not.toBeNull();
    });

    it("checks Kubernetes quantities", () => {
        expect(cpuError("1")).toBeNull();
        expect(cpuError("0.5")).toBeNull();
        expect(cpuError("500m")).toBeNull();
        expect(cpuError("0")).not.toBeNull();
        expect(cpuError("1Gi")).not.toBeNull();
        expect(bytesError("4Gi", "Memory")).toBeNull();
        expect(bytesError("512Mi", "Memory")).toBeNull();
        expect(bytesError("4 GB", "Memory")).toMatch(/Memory/);
    });

    it("limits the walltime to what presigned URLs allow", () => {
        expect(walltimeError(86400)).toBeNull();
        expect(walltimeError(MAX_WALLTIME_SECONDS)).toBeNull();
        expect(walltimeError(MAX_WALLTIME_SECONDS + 1)).not.toBeNull();
        expect(walltimeError(30)).not.toBeNull();
        expect(walltimeError(1.5)).not.toBeNull();
    });

    it("checks image references", () => {
        for (const image of [
            "",
            "ghcr.io/almahmoud/planet-runtime:latest",
            "quay.io/biocontainers/samtools:1.21--h50ea8bc_0",
            `ghcr.io/almahmoud/planet-runtime@sha256:${"a".repeat(64)}`,
            "localhost:5000/runtime",
            "busybox",
        ]) {
            expect(imageError(image)).toBeNull();
        }
        for (const image of ["Not An Image", "ghcr.io/x/y:", "ghcr.io//y"]) {
            expect(imageError(image)).not.toBeNull();
        }
    });
});

describe("validateSettingsChange", () => {
    it("returns the change normalized and keyed errors", () => {
        const { change, errors } = validateSettingsChange({
            cluster: { gateway_url: "http://localhost:8001/", namespace: "Bad" },
            storage: { prefix: "/planet/", bucket: "" },
        });
        expect(change.cluster?.gateway_url).toBe("http://localhost:8001");
        expect(change.storage?.prefix).toBe("planet");
        expect(Object.keys(errors)).toEqual(["cluster.namespace"]);
    });

    it("allows clearing optional fields", () => {
        const { errors } = validateSettingsChange({
            cluster: { gateway_url: "", token: null, runtime_image: "" },
            storage: { endpoint: "", bucket: "", access_key_id: "", secret_access_key: "" },
        });
        expect(errors).toEqual({});
    });

    it("leaves sections that are not part of the change out", () => {
        expect(validateSettingsChange({ user: { email: "me@example.org" } }).change).toEqual({
            user: { email: "me@example.org" },
        });
    });
});
