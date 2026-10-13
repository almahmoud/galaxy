import { errorFromResponse, errorFromStatus, KubeError, networkBlockedError } from "./errors";
import type {
    EventList,
    Job,
    JobList,
    KubeVersion,
    ListMeta,
    ObjectMeta,
    Pod,
    PodList,
    ResourceRule,
    SelfSubjectRulesReview,
    WatchEvent,
} from "./types";
import { LineDecoder, parseWatchEvent } from "./watch";

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface KubeClientConfig {
    /** Gateway base URL, e.g. `http://localhost:8080` or `https://k8s.example.org`. */
    gatewayUrl: string;
    namespace: string;
    /** ServiceAccount bearer token. */
    token: string;
}

export interface KubeClientOptions {
    /** Defaults to the global fetch. */
    fetch?: FetchFunction;
    /** Receives the messages of Warning response headers, such as Pod Security warnings. */
    onWarning?: (warnings: string[]) => void;
    /** Page size for list calls. Defaults to 500. */
    pageSize?: number;
}

export interface KubeRequestOptions {
    signal?: AbortSignal;
}

export interface PodLogOptions extends KubeRequestOptions {
    container: string;
    limitBytes?: number;
    /** RFC 3339 timestamp. */
    sinceTime?: string;
    sinceSeconds?: number;
    tailLines?: number;
    previous?: boolean;
    timestamps?: boolean;
}

export interface EventListOptions extends KubeRequestOptions {
    fieldSelector?: string;
    labelSelector?: string;
}

export interface WatchOptions {
    /**
     * Server-side watch duration in seconds. Defaults to 55. The gateway allows streams of up to 3700 s,
     * but through Cloudflare Tunnel a watch response is buffered until it ends and Cloudflare fails a
     * request with HTTP 524 after 125 s without a response, so keep it well below 125.
     */
    timeoutSeconds?: number;
}

export interface WatchResult {
    /** Last resourceVersion seen (from events or bookmarks), to resume the next watch from. */
    resourceVersion: string;
    /** "closed": the server ended the watch; "aborted": the signal fired; "interrupted": the connection dropped. */
    end: "closed" | "aborted" | "interrupted";
}

export type WatchHandler<T> = (event: WatchEvent<T>) => void | Promise<void>;

export interface RulesReviewResult {
    incomplete: boolean;
    evaluationError: string | null;
    rules: ResourceRule[];
    /** Verbs allowed on all objects of a resource, keyed `resource` (core) or `resource.group`. */
    allowed: Record<string, string[]>;
}

export interface KubeClient {
    readonly namespace: string;
    version(options?: KubeRequestOptions): Promise<KubeVersion>;
    rulesReview(options?: KubeRequestOptions): Promise<RulesReviewResult>;
    createJob(spec: Job, options?: KubeRequestOptions): Promise<Job>;
    getJob(name: string, options?: KubeRequestOptions): Promise<Job>;
    /** Lists all pages; the result's resourceVersion is the one to start a watch from. */
    listJobs(labelSelector: string, options?: KubeRequestOptions): Promise<JobList>;
    /**
     * Deletes the Job and, with propagationPolicy=Background, its pods. Sends no body: the gateway refuses
     * DELETE bodies, because the API server ignores the query string when one is present. Resolves false
     * when the Job does not exist.
     */
    deleteJob(name: string, options?: KubeRequestOptions): Promise<boolean>;
    getPod(name: string, options?: KubeRequestOptions): Promise<Pod>;
    listPods(labelSelector: string, options?: KubeRequestOptions): Promise<PodList>;
    getPodLog(name: string, options: PodLogOptions): Promise<string>;
    listEvents(options?: EventListOptions): Promise<EventList>;
    /**
     * Watches Jobs from `resourceVersion` until the server closes the stream, the signal aborts or the
     * connection drops; resolves in all three cases. Rejects with KubeError on API errors, including
     * ERROR events (which are passed to `onEvent` first); an expired resourceVersion rejects with status 410.
     */
    watchJobs(
        labelSelector: string,
        resourceVersion: string,
        onEvent: WatchHandler<Job>,
        signal?: AbortSignal,
        options?: WatchOptions,
    ): Promise<WatchResult>;
    /** Watches Pods; same contract as watchJobs. */
    watchPods(
        labelSelector: string,
        resourceVersion: string,
        onEvent: WatchHandler<Pod>,
        signal?: AbortSignal,
        options?: WatchOptions,
    ): Promise<WatchResult>;
}

/** Permissions the planet-client Role grants and Planet needs. */
export const REQUIRED_PERMISSIONS: { group: string; resource: string; verbs: string[] }[] = [
    { group: "batch", resource: "jobs", verbs: ["create", "get", "list", "watch", "delete"] },
    { group: "", resource: "pods", verbs: ["get", "list", "watch"] },
    { group: "", resource: "pods/log", verbs: ["get"] },
    { group: "", resource: "events", verbs: ["list", "watch"] },
];

const NAMESPACE_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const TOKEN_PATTERN = /^[\x21-\x7e]*$/;
const QUERY_NAME_PATTERN = /^[A-Za-z]+$/;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_WATCH_TIMEOUT_SECONDS = 55;
const MAX_PAGES = 1000;

function configError(message: string): KubeError {
    return new KubeError(0, "invalid_config", message);
}

function parseGatewayUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw configError("The gateway URL is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw configError("The gateway URL must use https:// or http://.");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw configError("The gateway URL must not contain credentials, a query or a fragment.");
    }
    return url;
}

/** Encodes values only: the gateway refuses percent-encoded parameter names. */
function queryString(query: Record<string, string | undefined>): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === "") {
            continue;
        }
        if (!QUERY_NAME_PATTERN.test(name)) {
            throw new RangeError(`Invalid query parameter name '${name}'.`);
        }
        parts.push(`${name}=${encodeURIComponent(value)}`);
    }
    return parts.join("&");
}

function checkName(name: string, kind: string): string {
    if (!NAME_PATTERN.test(name)) {
        throw new KubeError(0, "Invalid", `'${name}' is not a valid ${kind} name.`);
    }
    return name;
}

/** Splits a Warning header into its messages (RFC 9111 warn-text values). */
export function parseWarningHeader(header: string): string[] {
    const messages: string[] = [];
    const pattern = /\d{3} \S+ "((?:[^"\\]|\\.)*)"/g;
    for (let match = pattern.exec(header); match !== null; match = pattern.exec(header)) {
        messages.push((match[1] ?? "").replace(/\\(.)/g, "$1"));
    }
    return messages;
}

function resourceMatches(ruleResource: string, resource: string): boolean {
    if (ruleResource === "*" || ruleResource === resource) {
        return true;
    }
    const slash = resource.indexOf("/");
    return slash !== -1 && ruleResource === `*${resource.slice(slash)}`;
}

/** True when the rules allow `verb` on all objects of `resource` in API group `group` ("" for core). */
export function rulesAllow(rules: ResourceRule[], verb: string, resource: string, group = ""): boolean {
    return rules.some(
        (rule) =>
            !rule.resourceNames?.length &&
            (rule.verbs.includes("*") || rule.verbs.includes(verb)) &&
            (rule.apiGroups ?? [""]).some((ruleGroup) => ruleGroup === "*" || ruleGroup === group) &&
            (rule.resources ?? []).some((ruleResource) => resourceMatches(ruleResource, resource)),
    );
}

/** Returns the REQUIRED_PERMISSIONS the rules do not grant, as "verb resource[.group]" strings. */
export function missingPermissions(rules: ResourceRule[]): string[] {
    const missing: string[] = [];
    for (const { group, resource, verbs } of REQUIRED_PERMISSIONS) {
        for (const verb of verbs) {
            if (!rulesAllow(rules, verb, resource, group)) {
                missing.push(`${verb} ${group ? `${resource}.${group}` : resource}`);
            }
        }
    }
    return missing;
}

function summarizeRules(rules: ResourceRule[]): Record<string, string[]> {
    const allowed = new Map<string, Set<string>>();
    for (const rule of rules) {
        if (rule.resourceNames?.length) {
            continue;
        }
        for (const group of rule.apiGroups ?? [""]) {
            for (const resource of rule.resources ?? []) {
                const key = group ? `${resource}.${group}` : resource;
                const verbs = allowed.get(key) ?? new Set<string>();
                rule.verbs.forEach((verb) => verbs.add(verb));
                allowed.set(key, verbs);
            }
        }
    }
    return Object.fromEntries([...allowed.entries()].sort().map(([key, verbs]) => [key, [...verbs].sort()]));
}

class KubeClientImpl implements KubeClient {
    readonly namespace: string;
    private readonly gateway: URL | null;
    private readonly token: string;
    private readonly configError: KubeError | null;
    private readonly fetchImpl: FetchFunction;
    private readonly onWarning?: (warnings: string[]) => void;
    private readonly pageSize: number;

    constructor(config: KubeClientConfig, options: KubeClientOptions) {
        let gateway: URL | null = null;
        let error: KubeError | null = null;
        try {
            gateway = parseGatewayUrl(config.gatewayUrl);
            if (!NAMESPACE_PATTERN.test(config.namespace)) {
                throw configError("The namespace must be a DNS label (lowercase letters, digits and hyphens).");
            }
            if (!TOKEN_PATTERN.test(config.token)) {
                throw configError("The token must not contain spaces or line breaks.");
            }
        } catch (e) {
            if (!(e instanceof KubeError)) {
                throw e;
            }
            error = e;
        }
        this.gateway = error ? null : gateway;
        this.configError = error;
        this.namespace = config.namespace;
        this.token = config.token;
        this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.onWarning = options.onWarning;
        this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    }

    private get coreBase(): string {
        return `/api/v1/namespaces/${this.namespace}`;
    }

    private get jobsBase(): string {
        return `/apis/batch/v1/namespaces/${this.namespace}/jobs`;
    }

    private async request(
        method: "GET" | "POST" | "DELETE",
        path: string,
        options: {
            query?: Record<string, string | undefined>;
            body?: unknown;
            signal?: AbortSignal;
            accept?: string;
        } = {},
    ): Promise<Response> {
        if (!this.gateway) {
            throw this.configError ?? configError("The cluster settings are invalid.");
        }
        options.signal?.throwIfAborted();
        const search = queryString(options.query ?? {});
        const base = `${this.gateway.origin}${this.gateway.pathname.replace(/\/+$/, "")}`;
        const url = `${base}${path}${search ? `?${search}` : ""}`;
        const headers: Record<string, string> = { Accept: options.accept ?? "application/json" };
        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        let body: string | undefined;
        if (options.body !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.body);
        }
        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers,
                body,
                signal: options.signal,
                cache: "no-store",
                credentials: "omit",
                redirect: "manual",
                referrerPolicy: "no-referrer",
            });
        } catch (error) {
            if (options.signal?.aborted) {
                throw options.signal.reason ?? error;
            }
            if (error instanceof TypeError) {
                throw networkBlockedError(this.gateway, error);
            }
            throw error;
        }
        const warning = response.headers.get("warning");
        if (warning && this.onWarning) {
            const messages = parseWarningHeader(warning);
            if (messages.length) {
                this.onWarning(messages);
            }
        }
        if (response.type === "opaqueredirect") {
            throw new KubeError(0, "Redirect", "The gateway answered with a redirect; check the gateway URL.");
        }
        if (!response.ok) {
            throw await errorFromResponse(response);
        }
        return response;
    }

    private async json<T>(
        method: "GET" | "POST" | "DELETE",
        path: string,
        options: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {},
    ): Promise<T> {
        const response = await this.request(method, path, options);
        try {
            return (await response.json()) as T;
        } catch (error) {
            if (options.signal?.aborted) {
                throw options.signal.reason ?? error;
            }
            throw new KubeError(response.status, "InvalidResponse", "The API returned invalid JSON.", null, error);
        }
    }

    private async list<T extends { metadata: ListMeta; items: unknown[] }>(
        path: string,
        query: Record<string, string | undefined>,
        signal?: AbortSignal,
    ): Promise<T> {
        let result: T | null = null;
        let token: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const response: T = await this.json<T>("GET", path, {
                query: { ...query, limit: String(this.pageSize), continue: token },
                signal,
            });
            response.items = response.items ?? [];
            response.metadata = response.metadata ?? {};
            if (result) {
                result.items.push(...response.items);
            } else {
                result = response;
            }
            token = response.metadata.continue || undefined;
            if (!token) {
                break;
            }
        }
        if (!result) {
            throw new KubeError(0, "InvalidResponse", "The list returned no pages.");
        }
        delete result.metadata.continue;
        return result;
    }

    private async watch<T extends { metadata?: ObjectMeta }>(
        path: string,
        labelSelector: string,
        resourceVersion: string,
        onEvent: WatchHandler<T>,
        signal: AbortSignal | undefined,
        options: WatchOptions,
    ): Promise<WatchResult> {
        let lastVersion = resourceVersion;
        const result = (end: WatchResult["end"]): WatchResult => ({ resourceVersion: lastVersion, end });
        const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_WATCH_TIMEOUT_SECONDS;
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
            throw new RangeError("timeoutSeconds must be a positive integer.");
        }
        let response: Response;
        try {
            response = await this.request("GET", path, {
                query: {
                    watch: "true",
                    allowWatchBookmarks: "true",
                    timeoutSeconds: String(timeoutSeconds),
                    labelSelector,
                    resourceVersion,
                },
                signal,
            });
        } catch (error) {
            if (signal?.aborted) {
                return result("aborted");
            }
            throw error;
        }
        if (!response.body) {
            return result("closed");
        }
        const reader = response.body.getReader();
        const lines = new LineDecoder();
        const handle = async (line: string) => {
            const event = parseWatchEvent<T>(line);
            if (event.type === "ERROR") {
                const error = errorFromStatus(event.object);
                await onEvent(event);
                throw error;
            }
            const version = event.object.metadata?.resourceVersion;
            if (version) {
                lastVersion = version;
            }
            await onEvent(event);
        };
        try {
            for (;;) {
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                    chunk = await reader.read();
                } catch (error) {
                    if (signal?.aborted) {
                        return result("aborted");
                    }
                    if (error instanceof TypeError) {
                        return result("interrupted");
                    }
                    throw error;
                }
                const pending = chunk.done ? lines.flush() : lines.push(chunk.value);
                for (const line of pending) {
                    await handle(line);
                }
                if (chunk.done) {
                    return result("closed");
                }
            }
        } finally {
            reader.cancel().catch(() => undefined);
        }
    }

    async version(options: KubeRequestOptions = {}): Promise<KubeVersion> {
        return this.json<KubeVersion>("GET", "/version", options);
    }

    async rulesReview(options: KubeRequestOptions = {}): Promise<RulesReviewResult> {
        const request: SelfSubjectRulesReview = {
            apiVersion: "authorization.k8s.io/v1",
            kind: "SelfSubjectRulesReview",
            spec: { namespace: this.namespace },
        };
        const review = await this.json<SelfSubjectRulesReview>(
            "POST",
            "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
            { body: request, signal: options.signal },
        );
        const rules = review.status?.resourceRules ?? [];
        return {
            incomplete: review.status?.incomplete ?? false,
            evaluationError: review.status?.evaluationError || null,
            rules,
            allowed: summarizeRules(rules),
        };
    }

    async createJob(spec: Job, options: KubeRequestOptions = {}): Promise<Job> {
        if (spec.metadata.namespace && spec.metadata.namespace !== this.namespace) {
            throw new KubeError(0, "Invalid", `The Job namespace must be ${this.namespace}.`);
        }
        const body: Job = {
            ...spec,
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: { ...spec.metadata, namespace: this.namespace },
        };
        return this.json<Job>("POST", this.jobsBase, { body, signal: options.signal });
    }

    async getJob(name: string, options: KubeRequestOptions = {}): Promise<Job> {
        return this.json<Job>("GET", `${this.jobsBase}/${checkName(name, "Job")}`, options);
    }

    async listJobs(labelSelector: string, options: KubeRequestOptions = {}): Promise<JobList> {
        return this.list<JobList>(this.jobsBase, { labelSelector }, options.signal);
    }

    async deleteJob(name: string, options: KubeRequestOptions = {}): Promise<boolean> {
        try {
            const response = await this.request("DELETE", `${this.jobsBase}/${checkName(name, "Job")}`, {
                query: { propagationPolicy: "Background" },
                signal: options.signal,
            });
            await response.body?.cancel();
            return true;
        } catch (error) {
            if (error instanceof KubeError && error.status === 404) {
                return false;
            }
            throw error;
        }
    }

    async getPod(name: string, options: KubeRequestOptions = {}): Promise<Pod> {
        return this.json<Pod>("GET", `${this.coreBase}/pods/${checkName(name, "Pod")}`, options);
    }

    async listPods(labelSelector: string, options: KubeRequestOptions = {}): Promise<PodList> {
        return this.list<PodList>(`${this.coreBase}/pods`, { labelSelector }, options.signal);
    }

    async getPodLog(name: string, options: PodLogOptions): Promise<string> {
        const optional = (value: number | undefined) => (value === undefined ? undefined : String(value));
        const response = await this.request("GET", `${this.coreBase}/pods/${checkName(name, "Pod")}/log`, {
            query: {
                container: options.container,
                limitBytes: optional(options.limitBytes),
                sinceTime: options.sinceTime,
                sinceSeconds: optional(options.sinceSeconds),
                tailLines: optional(options.tailLines),
                previous: options.previous ? "true" : undefined,
                timestamps: options.timestamps ? "true" : undefined,
            },
            signal: options.signal,
            accept: "text/plain, */*",
        });
        return response.text();
    }

    async listEvents(options: EventListOptions = {}): Promise<EventList> {
        return this.list<EventList>(
            `${this.coreBase}/events`,
            { fieldSelector: options.fieldSelector, labelSelector: options.labelSelector },
            options.signal,
        );
    }

    async watchJobs(
        labelSelector: string,
        resourceVersion: string,
        onEvent: WatchHandler<Job>,
        signal?: AbortSignal,
        options: WatchOptions = {},
    ): Promise<WatchResult> {
        return this.watch<Job>(this.jobsBase, labelSelector, resourceVersion, onEvent, signal, options);
    }

    async watchPods(
        labelSelector: string,
        resourceVersion: string,
        onEvent: WatchHandler<Pod>,
        signal?: AbortSignal,
        options: WatchOptions = {},
    ): Promise<WatchResult> {
        return this.watch<Pod>(`${this.coreBase}/pods`, labelSelector, resourceVersion, onEvent, signal, options);
    }
}

export function createKubeClient(config: KubeClientConfig, options: KubeClientOptions = {}): KubeClient {
    return new KubeClientImpl(config, options);
}
