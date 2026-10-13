/**
 * Validation and normalization of Planet settings. Shared by the settings API in the Service Worker and the
 * setup page, so both report the same messages.
 */

import type { SettingsUpdate } from "@/planet/db/settings";

/** Field errors keyed by setting path, for example `cluster.gateway_url`. */
export type FieldErrors = Record<string, string>;

/** Longest walltime whose presigned URLs (deadline + 1 h) stay within the 7-day SigV4 limit. */
export const MAX_WALLTIME_SECONDS = 7 * 24 * 3600 - 3600;
export const MIN_WALLTIME_SECONDS = 60;

// Only these loopback names can be allowed in a Content-Security-Policy; Chrome rejects IPv6 sources.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const PRINTABLE = /^[\x21-\x7e]*$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9!_.*'()-]+$/;
const REGION = /^[a-z0-9-]*$/;
const CPU = /^(\d+(\.\d{1,3})?|\.\d{1,3}|\d+m)$/;
const BYTES = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;
const IMAGE =
    /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?\/)?[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(\/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*(:\w[\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const USERNAME = /^[a-z0-9._-]+$/;

/** True for the hosts an https:// page may reach over plain http://. */
export function isLoopbackHost(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function urlShapeError(url: URL | null, label: string): string | null {
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
        return `${label} must be a URL starting with https:// or http://.`;
    }
    if (url.username || url.password) {
        return `${label} must not contain a user name or password.`;
    }
    if (url.search || url.hash) {
        return `${label} must not contain a query or fragment.`;
    }
    return null;
}

/**
 * Checks a URL the browser connects to: https://, or http:// on this computer (localhost or 127.0.0.1),
 * since browsers block other http:// requests from an https:// page.
 */
export function browserUrlError(value: string, label: string): string | null {
    const url = parseUrl(value);
    const shape = urlShapeError(url, label);
    if (shape) {
        return shape;
    }
    if (url!.protocol === "http:" && !isLoopbackHost(url!.hostname)) {
        return `${label} must use https://. Plain http:// works only for localhost and 127.0.0.1.`;
    }
    return null;
}

/** Checks a URL that job pods connect to; in-cluster http:// addresses are allowed. */
export function clusterUrlError(value: string, label: string): string | null {
    return urlShapeError(parseUrl(value), label);
}

/** Lowercases the scheme and host and removes a trailing slash. Returns the input when it is not a URL. */
export function normalizeUrl(value: string): string {
    const url = parseUrl(value.trim());
    if (!url) {
        return value.trim();
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Removes leading and trailing slashes from a key prefix. */
export function normalizePrefix(value: string): string {
    return value.trim().replace(/^\/+|\/+$/g, "");
}

export function namespaceError(value: string): string | null {
    if (!value) {
        return "Enter the namespace Planet's manifests were applied to.";
    }
    return DNS_LABEL.test(value)
        ? null
        : "A namespace has at most 63 lowercase letters, digits and hyphens, and starts and ends with a letter or digit.";
}

export function serviceAccountError(value: string): string | null {
    if (!value) {
        return "Enter the service account job pods run as.";
    }
    return value.length <= 253 && DNS_SUBDOMAIN.test(value)
        ? null
        : "A service account name uses lowercase letters, digits, hyphens and dots.";
}

/** Bucket naming rules of S3 general purpose buckets, which R2 and Garage names also satisfy. */
export function bucketError(value: string): string | null {
    if (value.length < 3 || value.length > 63) {
        return "A bucket name has 3 to 63 characters.";
    }
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
        return "A bucket name uses lowercase letters, digits, dots and hyphens, and starts and ends with a letter or digit.";
    }
    if (value.includes("..")) {
        return "A bucket name cannot contain two dots in a row.";
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
        return "A bucket name cannot have the form of an IP address.";
    }
    if (/^(xn--|sthree-|amzn-s3-demo-)/.test(value) || /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(value)) {
        return "This bucket name uses a prefix or suffix that S3 reserves.";
    }
    return null;
}

export function prefixError(value: string): string | null {
    const prefix = normalizePrefix(value);
    if (!prefix) {
        return null;
    }
    if (prefix.length > 256) {
        return "The key prefix has at most 256 characters.";
    }
    for (const segment of prefix.split("/")) {
        if (segment === "" || segment === "." || segment === "..") {
            return "The key prefix cannot contain empty, '.' or '..' path segments.";
        }
        if (!PREFIX_SEGMENT.test(segment)) {
            return "The key prefix uses letters, digits, slashes and the characters ! _ . * ' ( ) -.";
        }
    }
    return null;
}

export function regionError(value: string): string | null {
    return value.length <= 32 && REGION.test(value) ? null : "A region uses lowercase letters, digits and hyphens.";
}

export function accessKeyError(value: string): string | null {
    return value.length <= 128 && PRINTABLE.test(value) ? null : "The access key ID cannot contain spaces.";
}

export function secretError(value: string, label: string): string | null {
    return value.length <= 16384 && PRINTABLE.test(value) ? null : `${label} cannot contain spaces or line breaks.`;
}

export function imageError(value: string): string | null {
    if (!value) {
        return null;
    }
    return value.length <= 512 && IMAGE.test(value)
        ? null
        : "Enter an image reference such as ghcr.io/owner/image:tag or ghcr.io/owner/image@sha256:<digest>.";
}

export function cpuError(value: string): string | null {
    if (!CPU.test(value) || parseFloat(value) <= 0) {
        return "Enter a CPU amount such as 1, 0.5 or 500m.";
    }
    return null;
}

export function bytesError(value: string, label: string): string | null {
    if (!BYTES.test(value) || parseFloat(value) <= 0) {
        return `${label} must be a Kubernetes quantity such as 4Gi or 512Mi.`;
    }
    return null;
}

export function walltimeError(value: number): string | null {
    if (!Number.isInteger(value) || value < MIN_WALLTIME_SECONDS || value > MAX_WALLTIME_SECONDS) {
        return `The walltime is a whole number of seconds from ${MIN_WALLTIME_SECONDS} to ${MAX_WALLTIME_SECONDS} (7 days minus 1 hour).`;
    }
    return null;
}

function check(errors: FieldErrors, path: string, message: string | null): void {
    if (message) {
        errors[path] = message;
    }
}

/**
 * Validates a parsed settings change and returns it normalized (URLs without a trailing slash, prefix
 * without surrounding slashes). Empty strings clear optional fields; required fields cannot be empty.
 */
export function validateSettingsChange(change: SettingsUpdate): { change: SettingsUpdate; errors: FieldErrors } {
    const errors: FieldErrors = {};
    const cluster = change.cluster ? { ...change.cluster } : undefined;
    const storage = change.storage ? { ...change.storage } : undefined;
    const user = change.user ? { ...change.user } : undefined;

    if (cluster) {
        if (cluster.gateway_url) {
            check(errors, "cluster.gateway_url", browserUrlError(cluster.gateway_url, "The gateway URL"));
            cluster.gateway_url = normalizeUrl(cluster.gateway_url);
        }
        if (cluster.namespace !== undefined) {
            check(errors, "cluster.namespace", namespaceError(cluster.namespace));
        }
        if (cluster.token) {
            check(errors, "cluster.token", secretError(cluster.token, "The token"));
        }
        if (cluster.runtime_image !== undefined) {
            check(errors, "cluster.runtime_image", imageError(cluster.runtime_image));
        }
        if (cluster.job_service_account !== undefined) {
            check(errors, "cluster.job_service_account", serviceAccountError(cluster.job_service_account));
        }
        if (cluster.default_cpu !== undefined) {
            check(errors, "cluster.default_cpu", cpuError(cluster.default_cpu));
        }
        if (cluster.default_memory !== undefined) {
            check(errors, "cluster.default_memory", bytesError(cluster.default_memory, "The memory"));
        }
        if (cluster.scratch_default !== undefined) {
            check(errors, "cluster.scratch_default", bytesError(cluster.scratch_default, "The scratch space"));
        }
        if (cluster.default_walltime_seconds !== undefined) {
            check(errors, "cluster.default_walltime_seconds", walltimeError(cluster.default_walltime_seconds));
        }
    }

    if (storage) {
        if (storage.endpoint) {
            check(errors, "storage.endpoint", browserUrlError(storage.endpoint, "The endpoint"));
            storage.endpoint = normalizeUrl(storage.endpoint);
        }
        if (storage.cluster_endpoint) {
            check(
                errors,
                "storage.cluster_endpoint",
                clusterUrlError(storage.cluster_endpoint, "The cluster endpoint"),
            );
            storage.cluster_endpoint = normalizeUrl(storage.cluster_endpoint);
        }
        if (storage.bucket) {
            check(errors, "storage.bucket", bucketError(storage.bucket));
        }
        if (storage.prefix !== undefined) {
            check(errors, "storage.prefix", prefixError(storage.prefix));
            storage.prefix = normalizePrefix(storage.prefix);
        }
        if (storage.region !== undefined) {
            check(errors, "storage.region", regionError(storage.region));
        }
        if (storage.access_key_id !== undefined) {
            check(errors, "storage.access_key_id", accessKeyError(storage.access_key_id));
        }
        if (storage.secret_access_key) {
            check(errors, "storage.secret_access_key", secretError(storage.secret_access_key, "The secret access key"));
        }
    }

    if (user) {
        if (user.email !== undefined) {
            check(
                errors,
                "user.email",
                user.email.length <= 254 && EMAIL.test(user.email) ? null : "Enter an email address.",
            );
        }
        if (user.username !== undefined) {
            check(
                errors,
                "user.username",
                user.username.length <= 255 && USERNAME.test(user.username)
                    ? null
                    : "A user name uses lowercase letters, digits, dots, hyphens and underscores.",
            );
        }
    }

    const normalized: SettingsUpdate = {};
    if (cluster) {
        normalized.cluster = cluster;
    }
    if (storage) {
        normalized.storage = storage;
    }
    if (user) {
        normalized.user = user;
    }
    return { change: normalized, errors };
}
