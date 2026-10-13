import { AwsV4Signer } from "aws4fetch";

import { sha256Hex } from "@/planet/util/digest";

import { encodeQuery } from "./url";

export const MAX_PRESIGN_EXPIRES_SECONDS = 604800;

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** Offsets smaller than this are treated as noise from the Date header's one-second resolution. */
const OFFSET_UPDATE_THRESHOLD_MS = 2000;

/** Header-signed requests fail once the clocks differ by more than 15 minutes; this leaves margin. */
export const SKEW_RETRY_THRESHOLD_MS = 5 * 60 * 1000;

export interface Credentials {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
}

function amzDate(epochMs: number): string {
    return new Date(epochMs).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export { sha256Hex };

/**
 * SigV4 signing with a clock corrected from the server's Date header. The signing key cache is shared
 * between requests so a key is derived once per day, region and secret.
 */
export class S3Signer {
    private offsetMs = 0;
    private readonly cache = new Map<string, ArrayBuffer>();

    constructor(
        private readonly credentials: Credentials,
        private readonly clock: () => number,
    ) {}

    /** Current server-time estimate in epoch milliseconds. */
    now(): number {
        return this.clock() + this.offsetMs;
    }

    get clockOffsetMs(): number {
        return this.offsetMs;
    }

    localNow(): number {
        return this.clock();
    }

    /**
     * Updates the clock offset from a response Date header. `sentAt` and `receivedAt` are local times
     * around the request. Returns the offset change in milliseconds, or null when no usable header was read.
     */
    observeDate(dateHeader: string | null, sentAt: number, receivedAt: number): number | null {
        if (!dateHeader) {
            return null;
        }
        const serverMs = Date.parse(dateHeader);
        if (!Number.isFinite(serverMs)) {
            return null;
        }
        // Date is truncated to whole seconds; take the middle of that second and of the round trip.
        const offset = Math.round(serverMs + 500 - (sentAt + receivedAt) / 2);
        return this.setOffset(offset);
    }

    /** Sets the offset from an absolute server time, such as RequestTimeTooSkewed's ServerTime. */
    observeServerTime(serverMs: number, receivedAt: number): number {
        return this.setOffset(Math.round(serverMs - receivedAt));
    }

    private setOffset(offset: number): number {
        const change = offset - this.offsetMs;
        if (Math.abs(change) < OFFSET_UPDATE_THRESHOLD_MS) {
            return 0;
        }
        this.offsetMs = offset;
        return change;
    }

    /** Signs a request in the Authorization header. `contentSha256` defaults to UNSIGNED-PAYLOAD. */
    async signHeaders(method: string, url: URL, headers: Headers, contentSha256 = UNSIGNED_PAYLOAD): Promise<Headers> {
        headers.set("x-amz-content-sha256", contentSha256);
        const signer = new AwsV4Signer({
            method,
            url: url.href,
            headers,
            accessKeyId: this.credentials.accessKeyId,
            secretAccessKey: this.credentials.secretAccessKey,
            service: "s3",
            region: this.credentials.region,
            cache: this.cache,
            datetime: amzDate(this.now()),
        });
        const signed = await signer.sign();
        return signed.headers;
    }

    /** Returns a query-signed URL valid for `expiresSeconds` (1 to 604800) from the corrected current time. */
    async presign(method: string, url: URL, expiresSeconds: number): Promise<string> {
        const target = new URL(url.href);
        const params: [string, string][] = [...target.searchParams];
        params.push(["X-Amz-Expires", String(clampExpires(expiresSeconds))]);
        target.search = encodeQuery(params);
        const signer = new AwsV4Signer({
            method,
            url: target.href,
            accessKeyId: this.credentials.accessKeyId,
            secretAccessKey: this.credentials.secretAccessKey,
            service: "s3",
            region: this.credentials.region,
            cache: this.cache,
            datetime: amzDate(this.now()),
            signQuery: true,
        });
        const signed = await signer.sign();
        // aws4fetch adds its parameters through URLSearchParams, which encodes spaces as '+'. Re-encode the
        // query per RFC 3986 so every S3 implementation decodes the values that were signed.
        signed.url.search = encodeQuery([...signed.url.searchParams]);
        return signed.url.href;
    }
}

export function clampExpires(expiresSeconds: number): number {
    if (!Number.isFinite(expiresSeconds)) {
        throw new RangeError("Presign expiry must be a finite number of seconds.");
    }
    return Math.min(MAX_PRESIGN_EXPIRES_SECONDS, Math.max(1, Math.floor(expiresSeconds)));
}
