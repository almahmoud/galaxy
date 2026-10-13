import { jobs, leader, settings } from "@/planet/db";
import { rebindsSecret, rebindsToken } from "@/planet/db/secretBindings";
import type { SettingsUpdate } from "@/planet/db/settings";
import { readTx } from "@/planet/db/tx";
import { DEFAULT_RUNTIME_IMAGE } from "@/planet/jobs/k8sJob";
import { STALE_MS } from "@/planet/jobs/leader";
import type { KubeClient, KubeClientConfig } from "@/planet/k8s";
import type { S3Client, S3Config } from "@/planet/s3";
import type { PlanetRequest, Router } from "@/planet/sw/router";
import type { CheckTarget, LeaderError, LeaderStatus, PlanetStatus } from "@/planet/ui/lib/api";
import { checkCluster, type CheckMode, type CheckReport, checkStorage } from "@/planet/ui/lib/checks";
import { validateSettingsChange } from "@/planet/ui/lib/rules";
import { effectiveRuntimeImage, isPinnedImage, loadBuildRuntimeImage } from "@/planet/ui/lib/runtime";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { isId } from "@/planet/util/ids";
import type { JobState } from "@/planet/util/states";

/** Clients and data sources the endpoints use; tests replace them. */
export interface PlanetClients {
    kubeClient?: (config: KubeClientConfig) => KubeClient;
    s3Client?: (config: S3Config) => S3Client;
    /** This build's runtime image (`loadBuildRuntimeImage`). */
    buildRuntimeImage?: () => Promise<string | null>;
    /** Milliseconds since the epoch. */
    now?: () => number;
}

/** Job states counted as waiting for the job runner, and as running. */
const QUEUED_STATES: readonly JobState[] = ["new", "resubmitted", "upload", "waiting", "queued"];
const RUNNING_STATES: readonly JobState[] = ["running", "finishing"];
const MAX_STATE_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 2000;

const CHECK_TARGETS: readonly CheckTarget[] = ["cluster", "storage"];
const CHECK_MODES: readonly CheckMode[] = ["quick", "full"];

function buildId(): string {
    return typeof __PLANET_BUILD_ID__ === "string" ? __PLANET_BUILD_ID__ : "dev";
}

function invalid(message: string, errData?: Record<string, string>): ApiError {
    return new ApiError(400, message, ErrorCodes.USER_OBJECT_ATTRIBUTE_INVALID, errData ? { err_data: errData } : {});
}

/**
 * Reads the JSON body of a request from Planet's own pages. The router refuses navigations and foreign
 * origins; requiring a JSON content type also keeps out bodies an HTML form can produce.
 */
async function pageJson(request: PlanetRequest): Promise<unknown> {
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
        throw ApiError.badRequest("Send this request with fetch and Content-Type: application/json.");
    }
    return request.json();
}

/** Parses and validates an untrusted settings change, returning it normalized. */
function parseChange(body: unknown): SettingsUpdate {
    const { change, errors } = validateSettingsChange(settings.parseSettingsUpdate(body));
    const messages = Object.values(errors);
    if (messages.length) {
        throw invalid(messages.join(" "), errors);
    }
    return change;
}

interface ParsedCheckRequest {
    targets: CheckTarget[];
    mode: CheckMode;
    settings?: SettingsUpdate;
}

function parseCheckRequest(body: unknown): ParsedCheckRequest {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw invalid("The check request must be a JSON object");
    }
    const request = body as Record<string, unknown>;
    for (const key of Object.keys(request)) {
        if (!["targets", "mode", "settings"].includes(key)) {
            throw invalid(`Unknown check option ${key}`);
        }
    }
    let targets: CheckTarget[] = [...CHECK_TARGETS];
    if (request.targets !== undefined) {
        if (
            !Array.isArray(request.targets) ||
            request.targets.length === 0 ||
            request.targets.some((target) => !CHECK_TARGETS.includes(target as CheckTarget))
        ) {
            throw invalid('targets must be a non-empty list of "cluster" and "storage"');
        }
        targets = [...new Set(request.targets as CheckTarget[])];
    }
    if (request.mode !== undefined && !CHECK_MODES.includes(request.mode as CheckMode)) {
        throw invalid('mode must be "quick" or "full"');
    }
    const parsed: ParsedCheckRequest = { targets, mode: (request.mode as CheckMode | undefined) ?? "full" };
    if (request.settings !== undefined) {
        parsed.settings = parseChange(request.settings);
    }
    return parsed;
}

/**
 * Runs the connection checks with the stored settings and secrets, overridden by `request.settings`. A stored
 * secret is used only with the settings it was saved for, as saving would keep it.
 */
async function runChecks(request: ParsedCheckRequest, clients: PlanetClients): Promise<CheckReport> {
    const [stored, secrets] = await Promise.all([settings.getStored(), settings.getSecrets()]);
    const { token, ...clusterOverride } = request.settings?.cluster ?? {};
    const { secret_access_key: secretOverride, ...storageOverride } = request.settings?.storage ?? {};
    const cluster = { ...stored.cluster, ...clusterOverride };
    const storage = { ...stored.storage, ...storageOverride };
    const storedToken = rebindsToken(clusterOverride, stored.cluster) ? null : secrets.cluster_token;
    const storedSecret = rebindsSecret(storageOverride, stored.storage) ? null : secrets.storage_secret_access_key;
    const options = { context: "worker" as const, mode: request.mode, ...clients };
    const { targets } = request;
    const [clusterReport, storageReport] = await Promise.all([
        targets.includes("cluster")
            ? checkCluster(
                  {
                      gatewayUrl: cluster.gateway_url,
                      namespace: cluster.namespace,
                      token: (token === undefined ? storedToken : token) ?? "",
                  },
                  options,
              )
            : undefined,
        targets.includes("storage")
            ? checkStorage(
                  {
                      endpoint: storage.endpoint,
                      clusterEndpoint: storage.cluster_endpoint,
                      bucket: storage.bucket,
                      prefix: storage.prefix,
                      region: storage.region,
                      pathStyle: storage.path_style,
                      accessKeyId: storage.access_key_id,
                      secretAccessKey: (secretOverride === undefined ? storedSecret : secretOverride) ?? "",
                  },
                  options,
              )
            : undefined,
    ]);
    const report: CheckReport = {};
    if (clusterReport) {
        report.cluster = clusterReport;
    }
    if (storageReport) {
        report.storage = storageReport;
    }
    return report;
}

function text(value: unknown, limit: number): string | null {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

/** An ISO 8601 UTC time from milliseconds since the epoch or a date string, or null. */
function isoTime(value: unknown): string | null {
    if (typeof value !== "number" && typeof value !== "string") {
        return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function leaderError(value: unknown): LeaderError | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const error = value as { message?: unknown; job_id?: unknown; time?: unknown };
    const message = text(error.message, MAX_MESSAGE_LENGTH);
    if (!message) {
        return null;
    }
    return { message, job_id: isId(error.job_id) ? error.job_id : null, time: isoTime(error.time) };
}

function fieldsOf(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function integer(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * The job runner's status from two `kv` records of `db/leader.ts`, both read as untrusted data (fields of the wrong
 * type count as absent):
 *
 * - `leader`, the election heartbeat, which the leading tab removes when it stops: whether a tab leads now.
 * - `leader_status`, the leader's report: its state and blocked reason, taken only from the current leader's
 *   report, and its last error, kept after the leader stopped.
 */
export function leaderStatus(
    heartbeatRecord: unknown,
    statusRecord: unknown,
    epoch: number,
    now: number,
): LeaderStatus {
    const beat = fieldsOf(heartbeatRecord);
    const report = fieldsOf(statusRecord);
    const heartbeat = typeof beat.heartbeat === "number" && Number.isFinite(beat.heartbeat) ? beat.heartbeat : null;
    const age = heartbeat === null ? null : Math.max(0, now - heartbeat);
    const active = age !== null && age < STALE_MS;
    const leaderEpoch = heartbeat === null ? null : integer(beat.epoch);
    const current = active && leaderEpoch !== null && integer(report.epoch) === leaderEpoch;
    return {
        active,
        epoch: leaderEpoch ?? (epoch > 0 ? epoch : null),
        heartbeat_age_seconds: age === null ? null : Math.round(age / 1000),
        state: current ? text(report.state, MAX_STATE_LENGTH) : null,
        blocked_reason: current ? text(report.blocked_reason, MAX_MESSAGE_LENGTH) : null,
        last_error: leaderError(report.last_error),
    };
}

async function buildImage(clients: PlanetClients): Promise<string | null> {
    try {
        return await (clients.buildRuntimeImage ?? loadBuildRuntimeImage)();
    } catch {
        // A site of another build is deployed; the page offers a reload elsewhere.
        return null;
    }
}

async function status(clients: PlanetClients): Promise<PlanetStatus> {
    const [current, build, runner] = await Promise.all([
        settings.get(),
        buildImage(clients),
        readTx(["jobs", "kv"], async (tx) => {
            const [heartbeat, report, epoch, counts] = await Promise.all([
                leader.read(tx),
                leader.readStatus(tx),
                leader.currentEpoch(tx),
                jobs.countByState([...QUEUED_STATES, ...RUNNING_STATES], tx),
            ]);
            const total = (states: readonly JobState[]) => states.reduce((sum, state) => sum + counts[state], 0);
            return {
                heartbeat: heartbeat as unknown,
                report: report as unknown,
                epoch,
                queued: total(QUEUED_STATES),
                running: total(RUNNING_STATES),
            };
        }),
    ]);
    const { cluster, storage } = current;
    const runtime = effectiveRuntimeImage(cluster.runtime_image, build, DEFAULT_RUNTIME_IMAGE);
    return {
        configured: {
            cluster: Boolean(cluster.gateway_url && cluster.namespace && cluster.has_token),
            storage: Boolean(storage.endpoint && storage.bucket && storage.access_key_id && storage.has_secret),
        },
        build_id: buildId(),
        instance_id: current.instance_id,
        leader: leaderStatus(runner.heartbeat, runner.report, runner.epoch, (clients.now ?? Date.now)()),
        jobs: { queued: runner.queued, running: runner.running },
        runtime: { ...runtime, build_image: build, pinned: isPinnedImage(runtime.image) },
    };
}

/**
 * Planet's own endpoints:
 *
 * - `GET /api/planet/build`: `{build_id}` of this Service Worker, read by the boot gate.
 * - `GET /api/planet/settings`: settings without secrets; `has_token` and `has_secret` tell whether they are set.
 * - `PUT /api/planet/settings`: partial update. Secrets are write-only; an empty string or null removes one, and
 *   so does a change to the gateway URL (token) or to the storage endpoints, bucket or access key ID (secret
 *   access key) that does not supply a new one.
 * - `POST /api/planet/settings/check`: connection checks with the stored secrets. The body is a `CheckRequest`
 *   (`@/planet/ui/lib/api`); its `settings` replace stored values for this check only.
 * - `GET /api/planet/status`: which components are configured, the job runner (leader tab) from its heartbeat and
 *   report, the number of unfinished jobs, and the runtime image jobs use (`PlanetStatus` in `@/planet/ui/lib/api`).
 */
export function register(router: Router, clients: PlanetClients = {}): void {
    router.untyped("/api/planet/build", "get", () => ({ build_id: buildId() }));

    router.untyped("/api/planet/settings", "get", () => settings.get());

    router.untyped("/api/planet/settings", "put", async (request) =>
        settings.update(parseChange(await pageJson(request))),
    );

    router.untyped("/api/planet/settings/check", "post", async (request) =>
        runChecks(parseCheckRequest(await pageJson(request)), clients),
    );

    router.untyped("/api/planet/status", "get", () => status(clients));
}
