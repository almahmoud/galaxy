/**
 * Kubernetes Job specs for Planet job pods (planet/docs/job-protocol.md). Tool jobs run an init container
 * `stage-in`, then the tool and `stage-out` side by side; upload and set-metadata jobs run one stager container.
 * Specs satisfy Pod Security `restricted` and the `planet-job-template` admission policy
 * (planet/deploy/base/job-policy.yaml).
 */

import type { StoredSettings } from "@/planet/db";
import type {
    Container,
    EnvVar,
    Job,
    PodSecurityContext,
    ResourceRequirements,
    SecurityContext,
    VolumeMount,
} from "@/planet/k8s";
import { sha256Hex } from "@/planet/util/digest";

import { MAX_DEADLINE_SECONDS } from "./keys";
import type { DispatchPlan } from "./manifest";

type ClusterSettings = StoredSettings["cluster"];

/** Runtime image used when the cluster settings name none. Tags without a digest are pulled IfNotPresent. */
export const DEFAULT_RUNTIME_IMAGE = "ghcr.io/almahmoud/planet-runtime:latest";

/** uid, gid and fsGroup of every container. */
export const PLANET_UID = 10001;

export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const LABEL_INSTANCE = "planet.dev/instance";
export const LABEL_JOB_ID = "planet.dev/job-id";
export const LABEL_ATTEMPT = "planet.dev/attempt";
export const LABEL_KIND = "planet.dev/kind";
export const SPEC_HASH_ANNOTATION = "planet.dev/spec-sha256";

export const STAGE_IN_CONTAINER = "stage-in";
export const TOOL_CONTAINER = "tool";
export const STAGE_OUT_CONTAINER = "stage-out";
/** Container of upload and set-metadata jobs. */
export const STAGER_CONTAINER = "stager";

/** Finished Jobs the browser has not deleted are removed after 3 days. */
export const TTL_SECONDS_AFTER_FINISHED = 259200;

const MANIFEST_URL_ENV = "PLANET_MANIFEST_URL";
const STAGER_VOLUME_SIZE = "1Gi";
const TOOL_EPHEMERAL_HEADROOM = 2 * 1024 ** 3;
const STAGER_EPHEMERAL_HEADROOM = 1024 ** 3;
const INSTANCE_PATTERN = /^[a-z0-9]([-a-z0-9]{0,14}[a-z0-9])?$/;
const JOB_ID_PATTERN = /^[0-9a-f]{16}$/;
const MAX_NAME_LENGTH = 63;

export type DispatchKind = DispatchPlan["kind"];

/** Raised for specs that cannot be built from the plan or the settings; retrying does not help. */
export class JobSpecError extends Error {
    readonly permanent = true;

    constructor(message: string) {
        super(message);
        this.name = "JobSpecError";
    }
}

/** Kubernetes Job name of one attempt of a Planet job. */
export function jobName(instanceId: string, jobId: string, attempt: number): string {
    if (!INSTANCE_PATTERN.test(instanceId)) {
        throw new JobSpecError(`Instance id '${instanceId}' cannot be used in Kubernetes names.`);
    }
    if (!JOB_ID_PATTERN.test(jobId)) {
        throw new JobSpecError(`Job id '${jobId}' cannot be used in Kubernetes names.`);
    }
    if (!Number.isInteger(attempt) || attempt < 1) {
        throw new JobSpecError(`Invalid attempt number ${attempt}.`);
    }
    const name = `planet-${instanceId}-${jobId}-a${attempt}`;
    if (name.length > MAX_NAME_LENGTH) {
        throw new JobSpecError(`Kubernetes Job name ${name} is longer than ${MAX_NAME_LENGTH} characters.`);
    }
    return name;
}

/** Label selector matching every Job and Pod of a Planet instance. */
export function instanceSelector(instanceId: string): string {
    return `${LABEL_INSTANCE}=${instanceId}`;
}

/** The planet-runtime image the settings name, or {@link DEFAULT_RUNTIME_IMAGE}. */
export function runtimeImage(cluster: Pick<ClusterSettings, "runtime_image">): string {
    return cluster.runtime_image.trim() || DEFAULT_RUNTIME_IMAGE;
}

// ---------------------------------------------------------------------------------------------------------
// Quantities

const BINARY_SUFFIXES: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
};
const DECIMAL_SUFFIXES: Record<string, number> = {
    "": 1,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
};
const QUANTITY_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?(Ki|Mi|Gi|Ti|Pi|Ei|m|k|M|G|T|P|E)?$/;

/** Parses a Kubernetes resource quantity ("500m", "4Gi", "1.5", "2e3"). Returns NaN when it is not one. */
export function parseQuantity(value: string): number {
    const match = QUANTITY_PATTERN.exec(value.trim());
    if (!match) {
        return Number.NaN;
    }
    const [, number = "", exponent, suffix = ""] = match;
    if (exponent !== undefined && suffix) {
        return Number.NaN;
    }
    const base = Number(number) * (exponent !== undefined ? 10 ** Number(exponent) : 1);
    return base * (BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix] ?? Number.NaN);
}

function requireQuantity(value: string, what: string): number {
    const parsed = parseQuantity(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new JobSpecError(`The ${what} '${value}' is not a positive Kubernetes quantity.`);
    }
    return parsed;
}

/** Formats bytes as a whole number of mebibytes, rounded up. */
export function formatMebibytes(bytes: number): string {
    return `${Math.ceil(bytes / 1024 ** 2)}Mi`;
}

/**
 * `GALAXY_SLOTS` (the CPU request rounded up, at least 1, as Galaxy's Kubernetes runner) and `GALAXY_MEMORY_MB`
 * (mebibytes) for a job's resources.
 */
export function slotsAndMemory(resources: Pick<DispatchPlan["resources"], "cpu" | "memory">): {
    slots: number;
    memoryMb: number;
} {
    const cores = requireQuantity(resources.cpu, "CPU request");
    const memory = requireQuantity(resources.memory, "memory request");
    return { slots: Math.max(1, Math.ceil(cores)), memoryMb: Math.floor(memory / 1024 ** 2) };
}

// ---------------------------------------------------------------------------------------------------------
// Spec

/** What a Job spec is built from. */
export interface JobSpecInput {
    instanceId: string;
    jobId: string;
    attempt: number;
    plan: Pick<
        DispatchPlan,
        "kind" | "manifestKey" | "manifestUrl" | "deadlineSeconds" | "walltimeSeconds" | "toolImage" | "resources"
    >;
    cluster: ClusterSettings;
}

function env(name: string, value: string | number): EnvVar {
    return { name, value: String(value) };
}

function stagerEnv(): EnvVar[] {
    return [
        env("HOME", "/planet-stager/home"),
        env("TMPDIR", "/planet/tmp"),
        env("XDG_CACHE_HOME", "/planet-stager/cache"),
    ];
}

const SHARED_MOUNT: VolumeMount = { name: "planet", mountPath: "/planet" };
const STAGER_MOUNT: VolumeMount = { name: "planet-stager", mountPath: "/planet-stager" };

function checkImage(image: string, what: string): string {
    if (!image || image.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/.test(image)) {
        throw new JobSpecError(`The ${what} '${image}' is not a valid image reference.`);
    }
    return image;
}

/**
 * Builds the Kubernetes Job for one attempt of a job, with labels, the spec-hash annotation (see
 * {@link specHash}) and the presigned manifest URL in the environment of the container that reads it.
 */
export async function buildJobSpec(input: JobSpecInput): Promise<Job> {
    const { instanceId, jobId, attempt, plan, cluster } = input;
    const name = jobName(instanceId, jobId, attempt);
    const { deadlineSeconds, walltimeSeconds } = plan;
    if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > MAX_DEADLINE_SECONDS) {
        throw new JobSpecError(
            `Invalid job deadline ${deadlineSeconds}; it must be at most ${MAX_DEADLINE_SECONDS} s.`,
        );
    }
    if (!Number.isInteger(walltimeSeconds) || walltimeSeconds < 1 || walltimeSeconds > deadlineSeconds) {
        throw new JobSpecError(`Invalid walltime ${walltimeSeconds}; it must be at most the deadline.`);
    }
    if (!plan.manifestUrl) {
        throw new JobSpecError("The dispatch plan has no manifest URL.");
    }
    const runtime = checkImage(runtimeImage(cluster), "runtime image setting");
    const scratch = requireQuantity(plan.resources.scratch, "scratch size");
    const userNamespaces = cluster.user_namespaces;

    const labels: Record<string, string> = {
        [LABEL_MANAGED_BY]: "planet",
        [LABEL_INSTANCE]: instanceId,
        [LABEL_JOB_ID]: jobId,
        [LABEL_ATTEMPT]: String(attempt),
        [LABEL_KIND]: plan.kind.replace("_", "-"),
    };
    const asPlanetUser = { runAsNonRoot: true, runAsUser: PLANET_UID, runAsGroup: PLANET_UID };
    const podSecurity: PodSecurityContext = {
        // With user namespaces, tool images run as their own (namespaced) user; Pod Security skips the
        // runAsNonRoot and runAsUser checks for such pods.
        ...(userNamespaces ? {} : asPlanetUser),
        fsGroup: PLANET_UID,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
    };
    const stagerSecurity: SecurityContext = {
        ...(userNamespaces ? asPlanetUser : {}),
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
    };
    const stager = (
        containerName: string,
        command: string,
        resources: ResourceRequirements,
        manifestUrl: boolean,
    ): Container => ({
        name: containerName,
        image: runtime,
        imagePullPolicy: "IfNotPresent",
        command: ["planet-stager", command],
        env: [...(manifestUrl ? [env(MANIFEST_URL_ENV, plan.manifestUrl)] : []), ...stagerEnv()],
        resources,
        securityContext: stagerSecurity,
        terminationMessagePolicy: "FallbackToLogsOnError",
        volumeMounts: [SHARED_MOUNT, STAGER_MOUNT],
    });

    let initContainers: Container[] | undefined;
    let containers: Container[];
    let nodeSelector: Record<string, string> | undefined;
    if (plan.kind === "tool") {
        const image = checkImage(plan.toolImage ?? "", "tool image");
        const { slots, memoryMb } = slotsAndMemory(plan.resources);
        initContainers = [
            stager(
                STAGE_IN_CONTAINER,
                "in",
                {
                    requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "256Mi" },
                    limits: { memory: "1Gi", "ephemeral-storage": "1Gi" },
                },
                true,
            ),
        ];
        const tool: Container = {
            name: TOOL_CONTAINER,
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["/bin/sh", "/planet/bin/run-tool"],
            workingDir: "/planet/job/working",
            env: [
                env("HOME", "/planet/job/home"),
                env("TMPDIR", "/planet/job/tmp"),
                env("TMP", "/planet/job/tmp"),
                env("TEMP", "/planet/job/tmp"),
                env("GALAXY_SLOTS", slots),
                env("GALAXY_MEMORY_MB", memoryMb),
                env("GALAXY_MEMORY_MB_PER_SLOT", Math.floor(memoryMb / slots)),
                env("PLANET_WALLTIME_SECONDS", walltimeSeconds),
            ],
            // No CPU limit: requests share CPU between pods and a limit throttles tools.
            resources: {
                requests: {
                    cpu: plan.resources.cpu,
                    memory: plan.resources.memory,
                    "ephemeral-storage": plan.resources.scratch,
                },
                limits: {
                    memory: plan.resources.memory,
                    "ephemeral-storage": formatMebibytes(scratch + TOOL_EPHEMERAL_HEADROOM),
                },
            },
            // The root filesystem stays writable: tools write next to their binaries.
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            volumeMounts: [SHARED_MOUNT, { name: "planet", mountPath: "/tmp", subPath: "tmp" }],
        };
        containers = [
            tool,
            stager(
                STAGE_OUT_CONTAINER,
                "out",
                {
                    requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "256Mi" },
                    limits: { memory: "2Gi", "ephemeral-storage": "1Gi" },
                },
                false,
            ),
        ];
        // Biocontainers are single-architecture amd64 images; planet-runtime is multi-architecture.
        if (cluster.arch_policy === "amd64-only" && image !== runtime) {
            nodeSelector = { "kubernetes.io/arch": "amd64" };
        }
    } else {
        containers = [
            stager(
                STAGER_CONTAINER,
                plan.kind === "upload" ? "upload" : "set-metadata",
                {
                    requests: {
                        cpu: plan.resources.cpu,
                        memory: plan.resources.memory,
                        "ephemeral-storage": plan.resources.scratch,
                    },
                    limits: {
                        memory: plan.resources.memory,
                        "ephemeral-storage": formatMebibytes(scratch + STAGER_EPHEMERAL_HEADROOM),
                    },
                },
                true,
            ),
        ];
    }

    const job: Job = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, labels, annotations: {} },
        spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: deadlineSeconds,
            ttlSecondsAfterFinished: TTL_SECONDS_AFTER_FINISHED,
            // A replacement pod only starts once the previous one has failed, so two pods never write the
            // same objects at once.
            podReplacementPolicy: "Failed",
            podFailurePolicy: {
                rules: [
                    { action: "Ignore", onPodConditions: [{ type: "DisruptionTarget", status: "True" }] },
                    { action: "FailJob", onExitCodes: { operator: "NotIn", values: [0] } },
                ],
            },
            template: {
                metadata: { labels: { ...labels } },
                spec: {
                    restartPolicy: "Never",
                    serviceAccountName: cluster.job_service_account,
                    automountServiceAccountToken: false,
                    enableServiceLinks: false,
                    terminationGracePeriodSeconds: 30,
                    ...(userNamespaces ? { hostUsers: false } : {}),
                    securityContext: podSecurity,
                    ...(nodeSelector ? { nodeSelector } : {}),
                    volumes: [
                        { name: "planet", emptyDir: { sizeLimit: plan.resources.scratch } },
                        { name: "planet-stager", emptyDir: { sizeLimit: STAGER_VOLUME_SIZE } },
                    ],
                    ...(initContainers ? { initContainers } : {}),
                    containers,
                },
            },
        },
    };
    job.metadata.annotations = { [SPEC_HASH_ANNOTATION]: await specHash(job, plan.manifestKey) };
    return job;
}

/** JSON with object keys in sorted order. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/**
 * SHA-256 of a Job spec without its spec-hash annotation and with the presigned manifest URL replaced by the
 * manifest's key: two dispatches of the same attempt with the same settings hash alike although their URLs differ.
 */
export async function specHash(job: Job, manifestKey: string): Promise<string> {
    const copy = JSON.parse(JSON.stringify(job)) as Job;
    delete copy.metadata.annotations?.[SPEC_HASH_ANNOTATION];
    const pod = copy.spec?.template.spec;
    for (const container of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) {
        for (const variable of container.env ?? []) {
            if (variable.name === MANIFEST_URL_ENV) {
                variable.value = manifestKey;
            }
        }
    }
    return sha256Hex(canonicalJson(copy));
}
