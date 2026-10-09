/** Test doubles for the Kubernetes and S3 clients and for Planet settings. */

import { vi } from "vitest";

import type { PlanetSettings } from "@/planet/db/types";
import type { KubeClient, KubeClientConfig, ResourceRule, RulesReviewResult } from "@/planet/k8s";
import { buildCorsPolicy, type S3Client, type S3Config, type S3SetupCheck, type S3SetupReport } from "@/planet/s3";

export const PLANET_RULES: ResourceRule[] = [
    { verbs: ["create", "get", "list", "watch", "delete"], apiGroups: ["batch"], resources: ["jobs"] },
    { verbs: ["get", "list", "watch"], apiGroups: [""], resources: ["pods"] },
    { verbs: ["get"], apiGroups: [""], resources: ["pods/log"] },
    { verbs: ["list", "watch"], apiGroups: [""], resources: ["events"] },
];

export function review(rules: ResourceRule[] = PLANET_RULES, incomplete = false): RulesReviewResult {
    return { incomplete, evaluationError: null, rules, allowed: {} };
}

type KubeMethods = Pick<KubeClient, "version" | "rulesReview" | "listJobs">;

/** A client factory whose clients answer like a correctly set up cluster unless overridden. */
export function fakeKube(overrides: Partial<KubeMethods> = {}) {
    const methods = {
        version: vi.fn(overrides.version ?? (async () => ({ major: "1", minor: "33", gitVersion: "v1.33.1" }))),
        rulesReview: vi.fn(overrides.rulesReview ?? (async () => review())),
        listJobs: vi.fn(overrides.listJobs ?? (async () => ({ metadata: {}, items: [] }))),
    };
    const configs: KubeClientConfig[] = [];
    const factory = vi.fn((config: KubeClientConfig) => {
        configs.push(config);
        return { namespace: config.namespace, ...methods } as unknown as KubeClient;
    });
    return { factory, configs, ...methods };
}

export function setupCheck(id: S3SetupCheck["id"], status: S3SetupCheck["status"] = "ok", code?: string): S3SetupCheck {
    const check: S3SetupCheck = { id, status, message: `${id} ${status}` };
    if (code) {
        check.code = code;
    }
    return check;
}

export function setupReport(checks: S3SetupCheck[], corsSuspected = false): S3SetupReport {
    return {
        ok: checks.every((check) => check.status !== "error"),
        checks,
        corsSuspected,
        clockOffsetMs: 0,
        cors: buildCorsPolicy("https://planet.test", "bucket"),
    };
}

export const PASSING_SETUP = setupReport(
    (["config", "bucket", "write", "etag", "read", "range", "multipart", "delete", "clock"] as const).map((id) =>
        setupCheck(id),
    ),
);

type S3Methods = Pick<S3Client, "headBucket" | "listObjects" | "checkSetup">;

/** An S3 client factory whose clients answer like a correctly set up bucket unless overridden. */
export function fakeS3(overrides: Partial<S3Methods> = {}) {
    const methods = {
        headBucket: vi.fn(overrides.headBucket ?? (async () => ({ region: null }))),
        listObjects: vi.fn(
            overrides.listObjects ??
                (async () => ({ objects: [], commonPrefixes: [], isTruncated: false, nextContinuationToken: null })),
        ),
        checkSetup: vi.fn(overrides.checkSetup ?? (async () => PASSING_SETUP)),
    };
    const configs: S3Config[] = [];
    const factory = vi.fn((config: S3Config) => {
        configs.push(config);
        return { ...methods } as unknown as S3Client;
    });
    return { factory, configs, ...methods };
}

export function settingsFixture(
    overrides: {
        cluster?: Partial<PlanetSettings["cluster"]>;
        storage?: Partial<PlanetSettings["storage"]>;
    } = {},
): PlanetSettings {
    return {
        instance_id: "0a1b2c3d",
        cluster: {
            gateway_url: "",
            namespace: "planet",
            has_token: false,
            runtime_image: "",
            job_service_account: "planet-job",
            default_cpu: "1",
            default_memory: "4Gi",
            default_walltime_seconds: 86400,
            scratch_default: "20Gi",
            arch_policy: "amd64-only",
            user_namespaces: false,
            ...overrides.cluster,
        },
        storage: {
            endpoint: "",
            cluster_endpoint: "",
            bucket: "",
            prefix: "planet",
            region: "auto",
            path_style: true,
            access_key_id: "",
            has_secret: false,
            ...overrides.storage,
        },
        user: { email: "planet@localhost", username: "planet" },
    };
}

export const R2_ACCOUNT = "0123456789abcdef0123456789abcdef";
