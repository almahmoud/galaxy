// @vitest-environment node
import { describe, expect, it } from "vitest";

import { S3Error } from "./errors";
import { buildUrl, fullKey, normalizePrefix, relativeKey, resolveConfig, type S3Config } from "./url";

const BASE: S3Config = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    clusterEndpoint: "",
    bucket: "planet-data",
    prefix: "",
    region: "",
    pathStyle: true,
    accessKeyId: "AKID",
    secretAccessKey: "SECRET",
};

function configError(config: Partial<S3Config>): S3Error {
    try {
        resolveConfig({ ...BASE, ...config });
    } catch (error) {
        if (error instanceof S3Error) {
            return error;
        }
        throw error;
    }
    throw new Error("expected a configuration error");
}

describe("resolveConfig", () => {
    it("defaults the region to auto for R2 and us-east-1 elsewhere", () => {
        expect(resolveConfig(BASE).region).toBe("auto");
        expect(resolveConfig({ ...BASE, endpoint: "http://localhost:3900" }).region).toBe("us-east-1");
        expect(resolveConfig({ ...BASE, region: "eu-west-1" }).region).toBe("eu-west-1");
    });

    it("uses the browser endpoint when no cluster endpoint is set", () => {
        const resolved = resolveConfig({ ...BASE, prefix: "/planet/" });
        expect(resolved.clusterEndpoint.href).toBe(resolved.endpoint.href);
        expect(resolved.prefix).toBe("planet");
    });

    it.each([
        [{ endpoint: "not a url" }, "not a valid URL"],
        [{ endpoint: "ftp://example.org" }, "https:// or http://"],
        [{ endpoint: "https://user:pass@example.org" }, "credentials"],
        [{ endpoint: "https://example.org/?x=1" }, "query"],
        [{ bucket: "Planet_Data" }, "bucket name"],
        [{ pathStyle: false, endpoint: "http://localhost:3900" }, "path-style"],
        [{ pathStyle: false, endpoint: "http://10.0.0.5:3900" }, "path-style"],
        [{ secretAccessKey: "" }, "secret access key"],
        [{ accessKeyId: "AK ID" }, "spaces"],
        [{ prefix: "a/../b" }, "'..'"],
    ])("rejects %j", (config, message) => {
        const error = configError(config as Partial<S3Config>);
        expect(error.code).toBe("invalid_config");
        expect(error.message).toContain(message);
    });
});

describe("buildUrl", () => {
    const endpoint = new URL("https://acct.r2.cloudflarestorage.com");

    it("builds path-style and virtual-hosted URLs", () => {
        expect(buildUrl(endpoint, "planet-data", true, "a/b c").href).toBe(
            "https://acct.r2.cloudflarestorage.com/planet-data/a/b%20c",
        );
        expect(buildUrl(endpoint, "planet-data", false, "a/b c").href).toBe(
            "https://planet-data.acct.r2.cloudflarestorage.com/a/b%20c",
        );
        expect(buildUrl(endpoint, "planet-data", true).href).toBe("https://acct.r2.cloudflarestorage.com/planet-data");
        expect(buildUrl(endpoint, "planet-data", false).href).toBe(
            "https://planet-data.acct.r2.cloudflarestorage.com/",
        );
    });

    it("keeps an endpoint base path and the port", () => {
        expect(buildUrl(new URL("http://localhost:8081/s3/"), "b", true, "k").href).toBe(
            "http://localhost:8081/s3/b/k",
        );
    });

    it("encodes keys and query values per RFC 3986", () => {
        const url = buildUrl(endpoint, "b", true, "x/a+b*(c)~é", [
            ["uploads", ""],
            ["prefix", "a b+c"],
        ]);
        expect(url.pathname).toBe("/b/x/a%2Bb%2A%28c%29~%C3%A9");
        expect(url.search).toBe("?uploads&prefix=a%20b%2Bc");
    });
});

describe("keys", () => {
    it("joins and strips the prefix", () => {
        expect(fullKey("planet", "datasets/u/data")).toBe("planet/datasets/u/data");
        expect(fullKey("", "datasets/u/data")).toBe("datasets/u/data");
        expect(relativeKey("planet", "planet/datasets/u/data")).toBe("datasets/u/data");
        expect(relativeKey("planet", "planetx/a")).toBeNull();
        expect(normalizePrefix(" /a/b/ ")).toBe("a/b");
    });

    it.each(["", "/abs", "a/./b", "a/..", "..", "x".repeat(1025)])("rejects key %j", (key) => {
        expect(() => fullKey("", key)).toThrow(S3Error);
    });
});
