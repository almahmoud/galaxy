import { S3Error } from "./errors";

export interface S3Config {
    /** S3 endpoint as reached from the browser, e.g. `https://<account>.r2.cloudflarestorage.com`. */
    endpoint: string;
    /** S3 endpoint as reached from cluster pods; empty means the browser endpoint. */
    clusterEndpoint: string;
    bucket: string;
    /** Key prefix all keys are relative to; empty for the bucket root. */
    prefix: string;
    /** Signing region; empty selects `auto` for R2 endpoints and `us-east-1` otherwise. */
    region: string;
    pathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
}

export interface ResolvedS3Config {
    endpoint: URL;
    clusterEndpoint: URL;
    bucket: string;
    prefix: string;
    region: string;
    pathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const CREDENTIAL_PATTERN = /^[\x21-\x7e]+$/;
const MAX_KEY_BYTES = 1024;
const encoder = new TextEncoder();

export function configError(message: string): S3Error {
    return new S3Error(0, "invalid_config", message);
}

export function isIpHost(hostname: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

export function isLoopbackHost(hostname: string): boolean {
    return (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
        hostname === "[::1]"
    );
}

function parseEndpoint(value: string, label: string): URL {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw configError(`The ${label} is not a valid URL.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw configError(`The ${label} must use https:// or http://.`);
    }
    if (url.username || url.password) {
        throw configError(`The ${label} must not contain credentials.`);
    }
    if (url.search || url.hash) {
        throw configError(`The ${label} must not contain a query or fragment.`);
    }
    return url;
}

function checkSegments(path: string, label: string): void {
    for (const segment of path.split("/")) {
        if (segment === "." || segment === "..") {
            throw configError(`The ${label} must not contain '.' or '..' path segments.`);
        }
    }
}

export function normalizePrefix(prefix: string): string {
    const normalized = prefix.trim().replace(/^\/+|\/+$/g, "");
    checkSegments(normalized, "key prefix");
    return normalized;
}

export function resolveConfig(config: S3Config): ResolvedS3Config {
    const endpoint = parseEndpoint(config.endpoint, "storage endpoint");
    const clusterEndpoint = config.clusterEndpoint.trim()
        ? parseEndpoint(config.clusterEndpoint, "cluster storage endpoint")
        : endpoint;
    const bucket = config.bucket.trim();
    if (!BUCKET_PATTERN.test(bucket) || bucket.includes("..")) {
        throw configError("The bucket name must be 3-63 lowercase letters, digits, dots or hyphens.");
    }
    if (!config.pathStyle) {
        for (const url of [endpoint, clusterEndpoint]) {
            if (isIpHost(url.hostname) || isLoopbackHost(url.hostname)) {
                throw configError(`Virtual-hosted style needs a DNS endpoint; use path-style for ${url.host}.`);
            }
        }
    }
    if (!CREDENTIAL_PATTERN.test(config.accessKeyId) || !CREDENTIAL_PATTERN.test(config.secretAccessKey)) {
        throw configError("The access key ID and secret access key are required and must not contain spaces.");
    }
    const region =
        config.region.trim() || (endpoint.hostname.endsWith(".r2.cloudflarestorage.com") ? "auto" : "us-east-1");
    if (!/^[a-z0-9-]+$/.test(region)) {
        throw configError("The region must contain only lowercase letters, digits and hyphens.");
    }
    return {
        endpoint,
        clusterEndpoint,
        bucket,
        prefix: normalizePrefix(config.prefix),
        region,
        pathStyle: config.pathStyle,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
    };
}

/** Percent-encodes per RFC 3986, as SigV4 canonicalisation does. */
export function encodeRfc3986(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeKeyPath(key: string): string {
    return key.split("/").map(encodeRfc3986).join("/");
}

/** Joins the configured prefix and a relative key, validating the result. */
export function fullKey(prefix: string, key: string): string {
    if (!key || key.startsWith("/")) {
        throw configError("Object keys must be non-empty and relative to the configured prefix.");
    }
    checkSegments(key, "object key");
    const joined = prefix ? `${prefix}/${key}` : key;
    if (encoder.encode(joined).length > MAX_KEY_BYTES) {
        throw configError("Object keys must not exceed 1024 bytes including the prefix.");
    }
    return joined;
}

/** Strips the configured prefix from a full key, or returns null when the key lies outside it. */
export function relativeKey(prefix: string, key: string): string | null {
    if (!prefix) {
        return key;
    }
    return key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : null;
}

/** Joins the configured prefix and a relative listing prefix (which may be empty or end in '/'). */
export function fullListPrefix(prefix: string, listPrefix: string): string {
    if (listPrefix.startsWith("/")) {
        throw configError("Listing prefixes must be relative to the configured prefix.");
    }
    checkSegments(listPrefix, "listing prefix");
    return prefix ? `${prefix}/${listPrefix}` : listPrefix;
}

export type QueryParams = [string, string][];

export function encodeQuery(params: QueryParams): string {
    return params
        .map(([name, value]) => (value === "" ? encodeRfc3986(name) : `${encodeRfc3986(name)}=${encodeRfc3986(value)}`))
        .join("&");
}

/**
 * Builds the URL of the bucket (key undefined) or of an object, in path-style
 * (`<endpoint>/<bucket>/<key>`) or virtual-hosted style (`<bucket>.<endpoint host>/<key>`).
 */
export function buildUrl(
    endpoint: URL,
    bucket: string,
    pathStyle: boolean,
    key?: string,
    query: QueryParams = [],
): URL {
    const url = new URL(endpoint.href);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    const keyPath = key === undefined ? "" : `/${encodeKeyPath(key)}`;
    if (pathStyle) {
        url.pathname = `${basePath}/${bucket}${keyPath}`;
    } else {
        url.hostname = `${bucket}.${endpoint.hostname}`;
        url.pathname = `${basePath}${keyPath}` || "/";
    }
    url.search = encodeQuery(query);
    return url;
}
