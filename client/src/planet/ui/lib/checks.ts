/**
 * Connection checks for the Kubernetes gateway and the storage bucket. The setup page runs them in the
 * document with the values typed into the form; the settings API runs them in the Service Worker with
 * the stored secrets. Both produce the same report.
 */

import {
    createKubeClient,
    isKubeError,
    type KubeClient,
    type KubeClientConfig,
    missingPermissions,
    type RulesReviewResult,
} from "@/planet/k8s";
import {
    buildCorsPolicy,
    createS3Client,
    isS3Error,
    type S3Client,
    type S3Config,
    type S3CorsPolicy,
    type S3SetupCheck,
} from "@/planet/s3";

import { clusterCommands } from "./commands";
import { addressSpace } from "./network";
import {
    accessKeyError,
    browserUrlError,
    bucketError,
    clusterUrlError,
    namespaceError,
    prefixError,
    regionError,
    secretError,
} from "./rules";

export type CheckStatus = "ok" | "warning" | "error" | "skipped";
export type ComponentState = "ok" | "warning" | "error" | "not_configured";
/** Where a check runs: the setup page can trigger the local network permission prompt, the worker cannot. */
export type CheckContext = "page" | "worker";
/** "quick" uses read-only requests; "full" also writes, reads back and deletes a probe object. */
export type CheckMode = "quick" | "full";
export type Reachability = "reachable" | "unreachable";
export type LocalAccess = "granted" | "prompt" | "denied" | "unknown";

export interface CheckItem {
    id: string;
    status: CheckStatus;
    title: string;
    message: string;
    /** What to do about a warning or error. */
    fix?: string;
    code?: string;
}

export interface ClusterReport {
    state: ComponentState;
    checks: CheckItem[];
    /** Kubernetes version reported by the API server, when it was readable. */
    version: string | null;
    missing_permissions: string[];
}

export interface StorageReport {
    state: ComponentState;
    checks: CheckItem[];
    /** True when a failure points at a missing or incomplete bucket CORS policy. */
    cors_suspected: boolean;
    /** The CORS policy this site needs, in the formats of wrangler and the AWS CLI. */
    cors: S3CorsPolicy | null;
    clock_offset_ms: number | null;
}

export interface CheckReport {
    cluster?: ClusterReport;
    storage?: StorageReport;
}

export interface ClusterTarget {
    gatewayUrl: string;
    namespace: string;
    token: string;
}

export interface CheckOptions {
    context: CheckContext;
    mode?: CheckMode;
    /** Origin the gateway and the bucket must allow. Defaults to the current origin. */
    origin?: string;
    /** Limit for each cluster request and for the whole storage check. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Page only: requests a URL without CORS to tell an unreachable server from a CORS refusal. */
    probe?: (url: string) => Promise<Reachability>;
    /** Page only: the browser's local network permission for the target. */
    localAccess?: LocalAccess;
    kubeClient?: (config: KubeClientConfig) => KubeClient;
    s3Client?: (config: S3Config) => S3Client;
}

export interface ClusterCheckOptions extends CheckOptions {
    /** Only checks that the gateway answers, without a token. */
    anonymousOnly?: boolean;
}

export interface StorageCheckOptions extends CheckOptions {
    /**
     * Page only: checks the settings and that the endpoint answers, without credentials, so the browser
     * can ask for local network access before the Service Worker contacts the endpoint.
     */
    anonymousOnly?: boolean;
}

export const DEFAULT_CLUSTER_TIMEOUT_MS = 15000;
export const DEFAULT_STORAGE_TIMEOUT_MS = 60000;

/** Selects no Jobs; listing with it shows whether the gateway forwards requests for the namespace. */
const NO_JOBS_SELECTOR = "planet.galaxyproject.org/connection-check=none";

const STORAGE_TITLES: Record<string, string> = {
    config: "Settings",
    bucket: "Bucket",
    write: "Write",
    etag: "ETag header",
    read: "Read",
    range: "Range requests",
    multipart: "Multipart uploads",
    delete: "Delete",
    clock: "Clock",
};

const CORS_CODES = new Set(["cors", "cors_expose_etag", "cors_expose_date", "cors_expose_content_range"]);

function currentOrigin(): string | undefined {
    const location = (globalThis as { location?: { origin?: string } }).location;
    return location?.origin && location.origin !== "null" ? location.origin : undefined;
}

function stateOf(checks: CheckItem[]): ComponentState {
    if (checks.some((check) => check.status === "error")) {
        return "error";
    }
    return checks.some((check) => check.status === "warning") ? "warning" : "ok";
}

function requestSignal(options: CheckOptions, fallbackMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? fallbackMs);
    return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function isTimeout(error: unknown): boolean {
    return (error as { name?: unknown } | null)?.name === "TimeoutError";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function rethrowAbort(options: CheckOptions): void {
    if (options.signal?.aborted) {
        throw options.signal.reason;
    }
}

type Component = "cluster" | "storage";

const TARGET_NAMES: Record<Component, string> = { cluster: "the gateway", storage: "the storage endpoint" };

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Describes a request the browser could not complete, with advice that depends on where it ran. */
async function networkFailure(
    id: string,
    title: string,
    component: Component,
    url: URL,
    options: CheckOptions,
    known?: Reachability,
): Promise<CheckItem> {
    const target = TARGET_NAMES[component];
    const origin = options.origin ?? currentOrigin() ?? "this site";
    const local = addressSpace(url.href) !== "public";
    if (options.context === "worker") {
        return {
            id,
            title,
            status: "error",
            code: "network_blocked",
            message: `Planet's service worker could not reach ${target} at ${url.origin}.`,
            fix: local
                ? "Open the setup page and press Test connection so the browser can ask for local network permission."
                : "Open the setup page and press Test connection to find out why.",
        };
    }
    if (local && options.localAccess === "denied") {
        return {
            id,
            title,
            status: "error",
            code: "local_network_denied",
            message: `The browser does not allow this site to connect to ${url.host} on this computer or network.`,
            fix: "Allow local network access for this site in the browser's site settings, then test again.",
        };
    }
    const reachability =
        known ?? (options.probe ? await options.probe(url.href).catch(() => "unreachable" as const) : null);
    if (reachability === "reachable") {
        const allowOrigin = `add the line "${origin}" 1; to allowed-origins.map in your overlay and apply it again.`;
        let fix: string;
        if (component === "cluster") {
            fix = capitalize(allowOrigin);
        } else if (local) {
            fix = `If this is Garage behind the Planet gateway, ${allowOrigin} Otherwise apply the CORS policy below to the bucket.`;
        } else {
            fix = "Apply the CORS policy below to the bucket.";
        }
        return {
            id,
            title,
            status: "error",
            code: "cors",
            message: `${capitalize(target)} at ${url.origin} answered, but its CORS policy does not allow ${origin}.`,
            fix,
        };
    }
    let fix: string;
    if (component === "cluster" && local) {
        fix =
            "Check that the port-forward is running and allow local network access if the browser asks. " +
            "Safari connects only to https:// gateways.";
    } else if (local) {
        fix = "Check that the endpoint is running and allow local network access if the browser asks.";
    } else {
        fix = `Check the URL and that ${target} is running. If it is, its CORS policy may not allow ${origin}.`;
    }
    return {
        id,
        title,
        status: "error",
        code: "network_blocked",
        message: `Could not reach ${target} at ${url.origin}.`,
        fix,
    };
}

function timeoutFailure(
    id: string,
    title: string,
    component: Component,
    options: CheckOptions,
    fallbackMs: number,
): CheckItem {
    const seconds = Math.round((options.timeoutMs ?? fallbackMs) / 1000);
    return {
        id,
        title,
        status: "error",
        code: "timeout",
        message: `${capitalize(TARGET_NAMES[component])} did not answer within ${seconds} seconds.`,
        fix: "Check that it is running and reachable from this computer, then test again.",
    };
}

function commandFor(namespace: string, id: string): string {
    return clusterCommands({ namespace }).find((command) => command.id === id)?.command ?? "";
}

async function kubeFailure(
    id: string,
    title: string,
    error: unknown,
    url: URL,
    target: ClusterTarget,
    options: CheckOptions,
): Promise<CheckItem> {
    rethrowAbort(options);
    if (isTimeout(error)) {
        return timeoutFailure(id, title, "cluster", options, DEFAULT_CLUSTER_TIMEOUT_MS);
    }
    if (isKubeError(error, "network_blocked")) {
        return networkFailure(id, title, "cluster", url, options);
    }
    if (isKubeError(error)) {
        const item: CheckItem = { id, title, status: "error", message: error.message, code: error.reason };
        if (error.status === 401) {
            item.message = "The cluster rejected the token.";
            item.fix = `Copy the planet-client token again: ${commandFor(target.namespace, "token")}`;
        } else if (error.status === 502 || error.status === 503 || error.status === 504) {
            item.fix = "The gateway could not reach the Kubernetes API server. Check the gateway pod's logs.";
        } else if (error.reason === "Redirect" || error.status === 404) {
            item.fix = "Check that the URL points at the Planet gateway.";
        }
        return item;
    }
    return { id, title, status: "error", message: errorMessage(error) };
}

function notConfigured(message: string): CheckItem {
    return { id: "config", title: "Settings", status: "skipped", message, code: "not_configured" };
}

/** Checks that the gateway answers, that the token is valid and that it has the permissions Planet needs. */
export async function checkCluster(target: ClusterTarget, options: ClusterCheckOptions): Promise<ClusterReport> {
    const checks: CheckItem[] = [];
    let version: string | null = null;
    let missing: string[] = [];
    const finish = (state?: ComponentState): ClusterReport => ({
        state: state ?? stateOf(checks),
        checks,
        version,
        missing_permissions: missing,
    });

    if (!target.gatewayUrl) {
        checks.push(notConfigured("Enter the gateway URL to connect a cluster."));
        return finish("not_configured");
    }
    const configError =
        browserUrlError(target.gatewayUrl, "The gateway URL") ??
        namespaceError(target.namespace) ??
        (target.token ? secretError(target.token, "The token") : null);
    if (configError) {
        checks.push({ id: "config", title: "Settings", status: "error", message: configError, code: "invalid_config" });
        return finish();
    }
    const url = new URL(target.gatewayUrl);
    const makeClient = options.kubeClient ?? ((config: KubeClientConfig) => createKubeClient(config));

    const anonymous = makeClient({ gatewayUrl: target.gatewayUrl, namespace: target.namespace, token: "" });
    try {
        const info = await anonymous.version({ signal: requestSignal(options, DEFAULT_CLUSTER_TIMEOUT_MS) });
        version = info.gitVersion || null;
        checks.push({
            id: "gateway",
            title: "Gateway",
            status: "ok",
            message: version ? `Reached the gateway. The cluster runs Kubernetes ${version}.` : "Reached the gateway.",
        });
    } catch (error) {
        if (isKubeError(error) && (error.status === 401 || error.status === 403)) {
            checks.push({
                id: "gateway",
                title: "Gateway",
                status: "ok",
                message: "Reached the gateway. The cluster shows its version only to signed-in clients.",
            });
        } else {
            checks.push(await kubeFailure("gateway", "Gateway", error, url, target, options));
            return finish();
        }
    }
    if (options.anonymousOnly) {
        return finish();
    }
    if (!target.token) {
        checks.push({
            id: "token",
            title: "Token",
            status: "error",
            code: "missing_token",
            message: "No token is set.",
            fix: `Paste the planet-client token. Read it with: ${commandFor(target.namespace, "token")}`,
        });
        return finish();
    }

    const client = makeClient(target);
    let rules: RulesReviewResult;
    try {
        rules = await client.rulesReview({ signal: requestSignal(options, DEFAULT_CLUSTER_TIMEOUT_MS) });
        checks.push({ id: "token", title: "Token", status: "ok", message: "The cluster accepted the token." });
    } catch (error) {
        checks.push(await kubeFailure("token", "Token", error, url, target, options));
        return finish();
    }

    missing = missingPermissions(rules.rules);
    if (missing.length === 0) {
        checks.push({
            id: "permissions",
            title: "Permissions",
            status: "ok",
            message: `The token can run and watch Jobs and read pods, logs and events in namespace ${target.namespace}.`,
        });
    } else {
        checks.push({
            id: "permissions",
            title: "Permissions",
            status: rules.incomplete ? "warning" : "error",
            code: "missing_permissions",
            message:
                `In namespace ${target.namespace} the token cannot: ${missing.join(", ")}.` +
                (rules.incomplete ? " The cluster could not list every rule, so some of these may be allowed." : ""),
            fix:
                "Check that the namespace is the one Planet's manifests were applied to, then apply them again: " +
                commandFor(target.namespace, "apply"),
        });
    }

    try {
        await client.listJobs(NO_JOBS_SELECTOR, { signal: requestSignal(options, DEFAULT_CLUSTER_TIMEOUT_MS) });
        checks.push({
            id: "namespace",
            title: "Namespace",
            status: "ok",
            message: `The gateway forwards requests for namespace ${target.namespace}.`,
        });
    } catch (error) {
        const item = await kubeFailure("namespace", "Namespace", error, url, target, options);
        if (isKubeError(error) && error.status === 403) {
            item.fix = "Use the namespace the gateway runs in; it forwards requests for that namespace only.";
        }
        checks.push(item);
    }
    return finish();
}

const S3_FIXES: Record<string, string> = {
    NoSuchBucket: "Create the bucket or correct its name.",
    InvalidAccessKeyId: "Copy the access key ID again.",
    SignatureDoesNotMatch: "Paste the secret access key again; it does not match the access key ID.",
    AccessDenied: "Give the access key read and write permission on the bucket.",
    Unauthorized: "Give the access key read and write permission on the bucket.",
    cors_expose_etag: "Apply the CORS policy below; it exposes the ETag header.",
    cors_expose_date: "Apply the CORS policy below; it exposes the Date header.",
    cors_expose_content_range: "Apply the CORS policy below; it exposes the Content-Range header.",
    mixed_content: "Use an https:// endpoint.",
    clock_skew: "Set this computer's clock automatically from the network.",
};

async function storageFailure(id: string, error: unknown, url: URL, options: CheckOptions): Promise<CheckItem> {
    rethrowAbort(options);
    const title = STORAGE_TITLES[id] ?? id;
    if (isTimeout(error)) {
        return timeoutFailure(id, title, "storage", options, DEFAULT_STORAGE_TIMEOUT_MS);
    }
    if (isS3Error(error, "network_blocked")) {
        return networkFailure(id, title, "storage", url, options);
    }
    if (isS3Error(error)) {
        const item: CheckItem = { id, title, status: "error", message: error.message, code: error.code };
        if (S3_FIXES[error.code]) {
            item.fix = S3_FIXES[error.code];
        }
        return item;
    }
    return { id, title, status: "error", message: errorMessage(error) };
}

async function fromSetupCheck(check: S3SetupCheck, url: URL, options: CheckOptions): Promise<CheckItem> {
    if (check.code === "network_blocked" && check.status === "error") {
        return networkFailure(check.id, STORAGE_TITLES[check.id] ?? check.id, "storage", url, options);
    }
    const item: CheckItem = {
        id: check.id,
        title: STORAGE_TITLES[check.id] ?? check.id,
        status: check.status,
        message: check.message,
    };
    if (check.code) {
        item.code = check.code;
        if (check.status !== "ok" && S3_FIXES[check.code]) {
            item.fix = S3_FIXES[check.code];
        }
    }
    return item;
}

/** Validates the storage settings without contacting the endpoint. Returns null when they are usable. */
function storageConfigProblem(config: S3Config, requireSecret: boolean): CheckItem | null {
    const missing = [
        !config.endpoint && "endpoint",
        !config.bucket && "bucket",
        !config.accessKeyId && "access key ID",
    ].filter(Boolean);
    if (missing.length) {
        return notConfigured(`Enter the ${missing.join(", ")} to connect a bucket.`);
    }
    const error =
        browserUrlError(config.endpoint, "The endpoint") ??
        (config.clusterEndpoint ? clusterUrlError(config.clusterEndpoint, "The cluster endpoint") : null) ??
        bucketError(config.bucket) ??
        prefixError(config.prefix) ??
        regionError(config.region) ??
        accessKeyError(config.accessKeyId) ??
        (config.secretAccessKey ? secretError(config.secretAccessKey, "The secret access key") : null);
    if (error) {
        return { id: "config", title: "Settings", status: "error", message: error, code: "invalid_config" };
    }
    if (requireSecret && !config.secretAccessKey) {
        return {
            id: "config",
            title: "Settings",
            status: "error",
            message: "No secret access key is set.",
            fix: "Paste the secret access key that belongs to the access key ID.",
            code: "missing_secret",
        };
    }
    return null;
}

/**
 * Checks the bucket. The quick mode only confirms that the bucket answers to the credentials; the full
 * mode runs the S3 client's setup check, which also verifies CORS headers, range requests and multipart
 * uploads with a probe object it deletes afterwards.
 */
export async function checkStorage(config: S3Config, options: StorageCheckOptions): Promise<StorageReport> {
    const origin = options.origin ?? currentOrigin();
    const report: StorageReport = {
        state: "ok",
        checks: [],
        cors_suspected: false,
        cors: null,
        clock_offset_ms: null,
    };
    const problem = storageConfigProblem(config, !options.anonymousOnly);
    if (problem) {
        report.checks.push(problem);
        report.state = problem.code === "not_configured" ? "not_configured" : "error";
        return report;
    }
    const url = new URL(config.endpoint);
    if (options.anonymousOnly) {
        const reachability =
            options.localAccess === "denied" || !options.probe
                ? undefined
                : await options.probe(`${url.origin}/`).catch(() => "unreachable" as const);
        report.checks.push(
            reachability === "reachable"
                ? { id: "endpoint", title: "Endpoint", status: "ok", message: `${url.origin} answers.` }
                : await networkFailure("endpoint", "Endpoint", "storage", url, options, reachability ?? "unreachable"),
        );
        report.state = stateOf(report.checks);
        return report;
    }
    const client = (options.s3Client ?? ((c: S3Config) => createS3Client(c)))(config);
    const signal = requestSignal(options, DEFAULT_STORAGE_TIMEOUT_MS);

    if (options.mode === "quick") {
        try {
            await client.headBucket({ signal });
            report.checks.push({
                id: "bucket",
                title: "Bucket",
                status: "ok",
                message: `Bucket ${config.bucket} answers.`,
            });
        } catch (error) {
            // Keys scoped to objects, such as R2 object tokens, may be refused HeadBucket but allowed to list.
            if (isS3Error(error) && error.status === 403 && error.code === "AccessDenied") {
                try {
                    await client.listObjects("", { maxKeys: 1, signal });
                    report.checks.push({
                        id: "bucket",
                        title: "Bucket",
                        status: "ok",
                        message: `Bucket ${config.bucket} answers.`,
                    });
                } catch (listError) {
                    report.checks.push(await storageFailure("bucket", listError, url, options));
                }
            } else {
                report.checks.push(await storageFailure("bucket", error, url, options));
            }
        }
    } else {
        try {
            const setup = await client.checkSetup({ origin, signal });
            report.checks = await Promise.all(setup.checks.map((check) => fromSetupCheck(check, url, options)));
            report.cors = setup.cors;
            report.clock_offset_ms = setup.clockOffsetMs;
        } catch (error) {
            report.checks.push(await storageFailure("bucket", error, url, options));
        }
    }

    // From the worker an unreachable public endpoint usually means a missing CORS rule; on this computer
    // it more often means a missing local network permission.
    const blockedRemote = options.context === "worker" && addressSpace(url.href) === "public";
    report.cors_suspected = report.checks.some(
        (check) => check.code && (CORS_CODES.has(check.code) || (blockedRemote && check.code === "network_blocked")),
    );
    if (report.cors_suspected && !report.cors && origin) {
        report.cors = buildCorsPolicy(origin, config.bucket, url);
    }
    report.state = stateOf(report.checks);
    return report;
}
