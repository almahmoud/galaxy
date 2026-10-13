import { describe, expect, it } from "vitest";

import { redactSignedUrls } from "./redact";

const SIGNATURE = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("redactSignedUrls", () => {
    it("removes the query of presigned URLs and keeps other URLs", () => {
        const signed =
            "https://acct.r2.cloudflarestorage.com/bucket/planet/datasets/u/data?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
            `&X-Amz-Credential=AKIAEXAMPLE%2F20261013&X-Amz-Expires=3600&X-Amz-Signature=${SIGNATURE}`;
        expect(redactSignedUrls(`GET ${signed} failed`)).toBe(
            "GET https://acct.r2.cloudflarestorage.com/bucket/planet/datasets/u/data?[redacted] failed",
        );
        expect(redactSignedUrls("see https://example.org/a?page=2")).toBe("see https://example.org/a?page=2");
        expect(redactSignedUrls("legacy https://s3.test/k?AWSAccessKeyId=AKIA&Signature=abc")).toBe(
            "legacy https://s3.test/k?[redacted]",
        );
    });

    it("removes SigV4 parameters and signatures outside a URL", () => {
        expect(redactSignedUrls(`...data?X-Amz-Date=20261013T000000Z\nX-Amz-Signature=${SIGNATURE}`)).toBe(
            "...data?X-Amz-Date=[redacted]\nX-Amz-Signature=[redacted]",
        );
        expect(redactSignedUrls(`x-amz-signature%3D${SIGNATURE}`)).toBe("x-amz-signature%3D[redacted]");
        expect(redactSignedUrls(`Credential=AKIA/x, SignedHeaders=host, Signature=${SIGNATURE}`)).toBe(
            "Credential=AKIA/x, SignedHeaders=host, Signature=[redacted]",
        );
    });

    it("passes empty text through", () => {
        expect(redactSignedUrls("")).toBe("");
        expect(redactSignedUrls(null)).toBeNull();
    });
});
