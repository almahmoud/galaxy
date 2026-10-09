/** Form models of the setup page and their conversion to settings changes and connection-check targets. */

import type { SettingsUpdate } from "@/planet/db/settings";
import type { PlanetSettings } from "@/planet/db/types";
import type { S3Config } from "@/planet/s3";

import type { ClusterTarget } from "./checks";
import {
    awsEndpoint,
    awsRegionError,
    detectProvider,
    GARAGE,
    parseAwsEndpoint,
    parseR2Endpoint,
    r2AccountError,
    r2Endpoint,
    type R2Jurisdiction,
    type StorageProvider,
} from "./presets";
import { type FieldErrors, validateSettingsChange } from "./rules";

type ClusterSettings = PlanetSettings["cluster"];
type StorageSettings = PlanetSettings["storage"];
type ClusterChange = NonNullable<SettingsUpdate["cluster"]>;
type StorageChange = NonNullable<SettingsUpdate["storage"]>;

/**
 * Where a write-only secret comes from: typed into the form, kept from the saved settings, removed on
 * save, or not set at all.
 */
export type SecretSource = "typed" | "saved" | "cleared" | "missing";

export function secretSource(typed: string, clear: boolean, saved: boolean): SecretSource {
    if (typed.trim()) {
        return "typed";
    }
    if (clear) {
        return "cleared";
    }
    return saved ? "saved" : "missing";
}

export interface ClusterForm {
    gateway_url: string;
    namespace: string;
    token: string;
    clear_token: boolean;
    runtime_image: string;
    job_service_account: string;
    default_cpu: string;
    default_memory: string;
    default_walltime_seconds: string;
    scratch_default: string;
    arch_policy: ClusterSettings["arch_policy"];
    user_namespaces: boolean;
}

export function clusterForm(saved: ClusterSettings): ClusterForm {
    return {
        gateway_url: saved.gateway_url,
        namespace: saved.namespace,
        token: "",
        clear_token: false,
        runtime_image: saved.runtime_image,
        job_service_account: saved.job_service_account,
        default_cpu: saved.default_cpu,
        default_memory: saved.default_memory,
        default_walltime_seconds: String(saved.default_walltime_seconds),
        scratch_default: saved.scratch_default,
        arch_policy: saved.arch_policy,
        user_namespaces: saved.user_namespaces,
    };
}

/** Non-secret cluster settings described by the form. */
export function clusterValues(form: ClusterForm): Omit<ClusterChange, "token"> {
    const walltime = form.default_walltime_seconds.trim();
    return {
        gateway_url: form.gateway_url.trim(),
        namespace: form.namespace.trim(),
        runtime_image: form.runtime_image.trim(),
        job_service_account: form.job_service_account.trim(),
        default_cpu: form.default_cpu.trim(),
        default_memory: form.default_memory.trim(),
        default_walltime_seconds: /^\d+$/.test(walltime) ? Number(walltime) : NaN,
        scratch_default: form.scratch_default.trim(),
        arch_policy: form.arch_policy,
        user_namespaces: form.user_namespaces,
    };
}

/** The change to save. The token is included only when one was typed or the saved one is removed. */
export function clusterChange(form: ClusterForm): ClusterChange {
    const change: ClusterChange = clusterValues(form);
    const token = form.token.trim();
    if (token) {
        change.token = token;
    } else if (form.clear_token) {
        change.token = null;
    }
    return change;
}

export function validateClusterForm(form: ClusterForm): FieldErrors {
    return validateSettingsChange({ cluster: clusterChange(form) }).errors;
}

function differs(values: Record<string, unknown>, saved: Record<string, unknown>): boolean {
    return Object.entries(values).some(([key, value]) => !Object.is(value, saved[key]));
}

export function clusterDirty(form: ClusterForm, saved: ClusterSettings): boolean {
    const source = secretSource(form.token, form.clear_token, saved.has_token);
    return (
        source === "typed" ||
        source === "cleared" ||
        differs(clusterValues(form), saved as unknown as Record<string, unknown>)
    );
}

export function clusterTarget(form: ClusterForm, token = form.token.trim()): ClusterTarget {
    const values = clusterValues(form);
    return { gatewayUrl: values.gateway_url ?? "", namespace: values.namespace ?? "", token };
}

export interface StorageForm {
    provider: StorageProvider;
    /** Cloudflare R2 account ID; the endpoint is derived from it. */
    account_id: string;
    jurisdiction: R2Jurisdiction;
    /** Endpoint for Local Garage and other services. */
    endpoint: string;
    /** AWS region, or the signing region of other services. */
    region: string;
    /** Path-style addressing for other services. */
    path_style: boolean;
    cluster_endpoint: string;
    bucket: string;
    prefix: string;
    access_key_id: string;
    secret_access_key: string;
    clear_secret: boolean;
}

export function storageForm(saved: StorageSettings): StorageForm {
    const provider = detectProvider(saved.endpoint);
    const r2 = parseR2Endpoint(saved.endpoint);
    return {
        provider,
        account_id: r2?.accountId ?? "",
        jurisdiction: r2?.jurisdiction ?? "default",
        endpoint: saved.endpoint,
        region: provider === "aws" ? saved.region || parseAwsEndpoint(saved.endpoint) || "" : saved.region,
        path_style: saved.path_style,
        cluster_endpoint: saved.cluster_endpoint,
        bucket: saved.bucket,
        prefix: saved.prefix,
        access_key_id: saved.access_key_id,
        secret_access_key: "",
        clear_secret: false,
    };
}

/** Non-secret storage settings described by the form, with the provider's fixed values applied. */
export function storageValues(form: StorageForm): Omit<StorageChange, "secret_access_key"> {
    const accountId = form.account_id.trim().toLowerCase();
    const region = form.region.trim();
    const common = {
        cluster_endpoint: form.cluster_endpoint.trim(),
        bucket: form.bucket.trim(),
        prefix: form.prefix.trim(),
        access_key_id: form.access_key_id.trim(),
    };
    switch (form.provider) {
        case "r2":
            return {
                ...common,
                endpoint: accountId ? r2Endpoint(accountId, form.jurisdiction) : "",
                region: "auto",
                path_style: true,
            };
        case "aws":
            return { ...common, endpoint: region ? awsEndpoint(region) : "", region, path_style: false };
        case "garage":
            return {
                ...common,
                endpoint: form.endpoint.trim() || GARAGE.endpoint,
                region: region || GARAGE.region,
                path_style: true,
            };
        default:
            return { ...common, endpoint: form.endpoint.trim(), region, path_style: form.path_style };
    }
}

export function storageChange(form: StorageForm): StorageChange {
    const change: StorageChange = storageValues(form);
    const secret = form.secret_access_key.trim();
    if (secret) {
        change.secret_access_key = secret;
    } else if (form.clear_secret) {
        change.secret_access_key = null;
    }
    return change;
}

/** Switches the provider and fills in the settings it implies, keeping what the user typed elsewhere. */
export function applyProvider(form: StorageForm, provider: StorageProvider): StorageForm {
    const current = storageValues(form);
    const next: StorageForm = { ...form, provider };
    if (form.cluster_endpoint === GARAGE.clusterEndpoint && provider !== "garage") {
        next.cluster_endpoint = "";
    }
    switch (provider) {
        case "aws":
            next.region = /^[a-z]{2}-/.test(form.region) ? form.region : "";
            break;
        case "garage":
            next.endpoint = GARAGE.endpoint;
            next.region = GARAGE.region;
            next.cluster_endpoint = form.cluster_endpoint || GARAGE.clusterEndpoint;
            next.bucket = form.bucket || GARAGE.bucket;
            break;
        case "custom":
            next.endpoint = current.endpoint ?? "";
            next.region = current.region ?? "";
            next.path_style = current.path_style ?? true;
            break;
    }
    return next;
}

export function validateStorageForm(form: StorageForm): FieldErrors {
    const errors: FieldErrors = {};
    const started = Boolean(form.bucket.trim() || form.access_key_id.trim() || form.secret_access_key.trim());
    if (form.provider === "r2" && (form.account_id.trim() || started)) {
        const error = r2AccountError(form.account_id.trim().toLowerCase());
        if (error) {
            errors["storage.account_id"] = error;
        }
    }
    if (form.provider === "aws" && (form.region.trim() || started)) {
        const error = awsRegionError(form.region.trim());
        if (error) {
            errors["storage.region"] = error;
        }
    }
    const { errors: settingErrors } = validateSettingsChange({ storage: storageChange(form) });
    for (const [key, message] of Object.entries(settingErrors)) {
        if (form.provider === "r2" && key === "storage.endpoint") {
            continue;
        }
        errors[key] ??= message;
    }
    return errors;
}

export function storageDirty(form: StorageForm, saved: StorageSettings): boolean {
    const source = secretSource(form.secret_access_key, form.clear_secret, saved.has_secret);
    return (
        source === "typed" ||
        source === "cleared" ||
        differs(storageValues(form), saved as unknown as Record<string, unknown>)
    );
}

export function storageConfig(form: StorageForm, secret = form.secret_access_key.trim()): S3Config {
    const values = storageValues(form);
    return {
        endpoint: values.endpoint ?? "",
        clusterEndpoint: values.cluster_endpoint ?? "",
        bucket: values.bucket ?? "",
        prefix: values.prefix ?? "",
        region: values.region ?? "",
        pathStyle: values.path_style ?? true,
        accessKeyId: values.access_key_id ?? "",
        secretAccessKey: secret,
    };
}
