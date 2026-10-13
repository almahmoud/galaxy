// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type Job as KubeJob, KubeError, type Pod } from "@/planet/k8s";
import { S3Error } from "@/planet/s3";

import { ContainerResolutionError } from "../containers";
import {
    classifyFailure,
    CREATE_CONTAINER_GRACE_MS,
    errorMessage,
    failedCreate,
    IMAGE_PULL_GRACE_MS,
    isPermanent,
    isTransient,
    pendingFailure,
    podFinished,
    quotaCanClear,
} from "../failures";
import { FAILURE_MESSAGES } from "../ingest";
import { parseQuantity } from "../k8sJob";
import { container, podStatus } from "./fakes";

function pod(status: Pod["status"]): Pod {
    return { metadata: { name: "p", uid: "u" }, status };
}

function failedJob(reason: string, message = ""): KubeJob {
    return { metadata: { name: "j" }, status: { conditions: [{ type: "Failed", status: "True", reason, message }] } };
}

describe("classifying pods that ended without results", () => {
    it("uses Galaxy's messages for memory kills and deadlines", () => {
        expect(
            classifyFailure(
                "tool",
                failedJob("PodFailurePolicy"),
                pod(podStatus.finished({ exitCode: 137, reason: "OOMKilled" })),
            ),
        ).toMatchObject({
            reason: "oom",
            message: FAILURE_MESSAGES.oom,
        });
        expect(classifyFailure("tool", failedJob("DeadlineExceeded"), pod(podStatus.running()))).toMatchObject({
            reason: "walltime",
            message: FAILURE_MESSAGES.walltime,
        });
        expect(classifyFailure("tool", failedJob("DeadlineExceeded"), pod(podStatus.unscheduled()))).toMatchObject({
            reason: "unschedulable",
            message: FAILURE_MESSAGES.unschedulable,
        });
    });

    it("explains stager failures with their termination messages, without URLs", () => {
        const failure = classifyFailure(
            "tool",
            failedJob("PodFailurePolicy"),
            pod({
                phase: "Failed",
                initContainerStatuses: [
                    container("stage-in", {
                        terminated: {
                            exitCode: 1,
                            reason: "Error",
                            message: JSON.stringify({
                                stage: "in",
                                state: "error",
                                error: "GET https://bucket.example.org/x?X-Amz-Signature=secret failed: HTTP 403",
                            }),
                        },
                    }),
                ],
            }),
        );
        expect(failure.reason).toBe("stage_in");
        expect(failure.message).toBe("Preparing the job failed: GET <url> failed: HTTP 403");
        expect(failure.detail).not.toContain("secret");

        const upload = classifyFailure(
            "upload",
            failedJob("PodFailurePolicy"),
            pod({
                phase: "Failed",
                containerStatuses: [container("stager", { terminated: { exitCode: 1, message: "boom" } })],
            }),
        );
        expect(upload).toMatchObject({ reason: "stage_out", message: "The upload job failed: boom" });
    });

    it("recognizes evictions, wrong architectures and unknown failures", () => {
        expect(
            classifyFailure(
                "tool",
                undefined,
                pod({ ...podStatus.running(), phase: "Failed", reason: "Evicted", message: "low disk" }),
            ),
        ).toMatchObject({ reason: "evicted", message: "Kubernetes evicted the job's pod: low disk" });
        const arm = pod({
            ...podStatus.running(),
            containerStatuses: [
                container("tool", {
                    terminated: { exitCode: 128, reason: "StartError", message: "exec format error" },
                }),
            ],
        });
        expect(classifyFailure("tool", undefined, arm).reason).toBe("wrong_architecture");
        expect(
            classifyFailure(
                "tool",
                failedJob("BackoffLimitExceeded", "Job has reached the specified backoff limit"),
                undefined,
            ),
        ).toMatchObject({
            reason: "unknown",
            message: `${FAILURE_MESSAGES.unknown} (Job has reached the specified backoff limit)`,
        });
    });

    it("knows when a pod has done all it will do", () => {
        expect(podFinished("tool", pod(podStatus.running()))).toBe(false);
        expect(
            podFinished(
                "tool",
                pod({
                    ...podStatus.running(),
                    containerStatuses: [container("stage-out", { terminated: { exitCode: 0 } })],
                }),
            ),
        ).toBe(true);
        expect(
            podFinished(
                "tool",
                pod({ initContainerStatuses: [container("stage-in", { terminated: { exitCode: 2 } })] }),
            ),
        ).toBe(true);
        expect(podFinished("upload", pod({ phase: "Succeeded" }))).toBe(true);
        expect(podFinished("tool", undefined)).toBe(false);
        const disrupted = pod({
            ...podStatus.finished({ exitCode: 137 }),
            conditions: [{ type: "DisruptionTarget", status: "True" }],
        });
        expect(podFinished("tool", disrupted)).toBe(false);
    });
});

describe("pending pods", () => {
    const seen = new Map<string, number>();
    const firstSeen = (start: number) => (key: string) => {
        if (!seen.has(key)) {
            seen.set(key, start);
        }
        return seen.get(key)!;
    };

    it("fail fast on missing or invalid images and give other pull errors five minutes", () => {
        const missing = pod(podStatus.waiting("tool", "ErrImagePull", "manifest unknown", "quay.io/x/y:1"));
        expect(pendingFailure(missing, 0, firstSeen(0))).toMatchObject({
            reason: "image_not_found",
            message: "The container image quay.io/x/y:1 does not exist or is not public.",
        });
        const invalid = pod(podStatus.waiting("tool", "InvalidImageName", "bad"));
        expect(pendingFailure(invalid, 0, firstSeen(0))?.reason).toBe("image_not_found");

        const flaky = pod(podStatus.waiting("stage-out", "ImagePullBackOff", "i/o timeout"));
        expect(pendingFailure(flaky, 1000, firstSeen(1000))).toBeNull();
        expect(pendingFailure(flaky, 1000 + IMAGE_PULL_GRACE_MS, firstSeen(1000))?.reason).toBe("image_pull");

        const config = pod(podStatus.waiting("tool", "CreateContainerConfigError", "volume not ready"));
        expect(pendingFailure(config, 5, firstSeen(5))).toBeNull();
        expect(pendingFailure(config, 5 + CREATE_CONTAINER_GRACE_MS, firstSeen(5))?.reason).toBe("rejected");
        expect(pendingFailure(pod(podStatus.pending()), 0, firstSeen(0))).toBeNull();
    });

    it("waits out quotas that running jobs will free and fails pod creations that cannot succeed", () => {
        const quota = (requested: string, limited: string) =>
            `pods "x" is forbidden: exceeded quota: planet-compute, requested: ${requested}, used: ${requested}, limited: ${limited}`;
        expect(quotaCanClear(quota("pods=1", "pods=20"), parseQuantity)).toBe(true);
        expect(
            quotaCanClear(
                quota("limits.memory=8Gi,requests.memory=8Gi", "limits.memory=64Gi,requests.memory=64Gi"),
                parseQuantity,
            ),
        ).toBe(true);
        expect(quotaCanClear(quota("requests.memory=100Gi", "requests.memory=64Gi"), parseQuantity)).toBe(false);

        const event = (message: string, time: string) => ({
            metadata: { name: time },
            involvedObject: { kind: "Job", name: "j" },
            reason: "FailedCreate",
            type: "Warning" as const,
            lastTimestamp: time,
            message,
        });
        expect(failedCreate([event(quota("pods=1", "pods=20"), "2026-01-01T00:00:00Z")], parseQuantity)).toBe("wait");
        expect(
            failedCreate(
                [
                    event(quota("pods=1", "pods=20"), "2026-01-01T00:00:00Z"),
                    event("maximum memory usage per Container is 32Gi, but limit is 64Gi", "2026-01-01T00:01:00Z"),
                ],
                parseQuantity,
            ),
        ).toMatchObject({ reason: "rejected", message: expect.stringContaining("maximum memory usage per Container") });
        expect(failedCreate([], parseQuantity)).toBeNull();
    });
});

describe("error classification", () => {
    it("separates errors worth retrying from rejections", () => {
        const admission = new KubeError(403, "Forbidden", "admission webhook denied the request: no");
        const rbac = new KubeError(403, "Forbidden", 'jobs.batch is forbidden: User "x" cannot create resource');
        expect(isPermanent(admission)).toBe(true);
        expect(isTransient(admission)).toBe(false);
        expect(isPermanent(new KubeError(422, "Invalid", "spec invalid"))).toBe(true);
        expect(isTransient(rbac)).toBe(true);
        expect(isTransient(new KubeError(0, "network_blocked", "unreachable"))).toBe(true);
        expect(isTransient(new S3Error(503, "ServiceUnavailable", "busy"))).toBe(true);
        expect(isTransient(new S3Error(404, "NoSuchKey", "missing"))).toBe(false);
        expect(isTransient(new ContainerResolutionError("down", true))).toBe(true);
        expect(isPermanent(new ContainerResolutionError("no image"))).toBe(true);
        expect(isTransient(Object.assign(new Error("inputs not ready"), { permanent: false }))).toBe(true);
        expect(isTransient(new Error("bug"))).toBe(false);
        expect(isPermanent(new Error("bug"))).toBe(false);
        expect(errorMessage(new Error("PUT https://b.example.org/k?X-Amz-Signature=s failed"))).toBe(
            "PUT <url> failed",
        );
    });
});
