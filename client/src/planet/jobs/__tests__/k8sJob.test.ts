// @vitest-environment node
import { describe, expect, it } from "vitest";

import { defaultSettings } from "@/planet/db";
import type { Container, Job, PodSpec } from "@/planet/k8s";

import {
    buildJobSpec,
    DEFAULT_RUNTIME_IMAGE,
    DISPATCH_ID_ANNOTATION,
    jobName,
    JobSpecError,
    type JobSpecInput,
    parseQuantity,
    runtimePullPolicy,
    SPEC_HASH_ANNOTATION,
    specHash,
} from "../k8sJob";

const JOB_ID = "0123456789abcdef";
const INSTANCE = "a1b2c3d4";
const MANIFEST_KEY = `jobs/${JOB_ID}/a1/manifest.json`;
const MANIFEST_URL = `https://acct.r2.cloudflarestorage.com/bucket/planet/${MANIFEST_KEY}?X-Amz-Signature=deadbeef`;
const DISPATCH_ID = "5f0c2a9e7b1d3c4e";

type Overrides = Omit<Partial<JobSpecInput>, "plan" | "cluster"> & {
    plan?: Partial<JobSpecInput["plan"]>;
    cluster?: Partial<JobSpecInput["cluster"]>;
};

function input(overrides: Overrides = {}): JobSpecInput {
    const { plan, cluster, ...rest } = overrides;
    return {
        instanceId: INSTANCE,
        jobId: JOB_ID,
        attempt: 1,
        cluster: { ...defaultSettings(INSTANCE).cluster, ...cluster },
        plan: {
            kind: "tool",
            dispatchId: DISPATCH_ID,
            manifestKey: MANIFEST_KEY,
            manifestUrl: MANIFEST_URL,
            deadlineSeconds: 10800,
            walltimeSeconds: 3600,
            toolImage:
                "quay.io/biocontainers/samtools:1.21--h50ea8bc_0@sha256:" +
                "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
            resources: { cpu: "1500m", memory: "4Gi", scratch: "20Gi" },
            ...plan,
        },
        ...rest,
    };
}

/** The validations of planet/deploy/base/job-policy.yaml, as violations. */
function admissionViolations(job: Job): string[] {
    const pod = job.spec!.template.spec as PodSpec & { serviceAccount?: string; shareProcessNamespace?: boolean };
    const containers = [...pod.containers, ...(pod.initContainers ?? [])] as (Container & {
        envFrom?: { secretRef?: unknown }[];
    })[];
    const volumes = (pod.volumes ?? []) as unknown as Record<string, unknown>[];
    const violations: string[] = [];
    if (pod.serviceAccountName !== "planet-job" || (pod.serviceAccount && pod.serviceAccount !== "planet-job")) {
        violations.push("serviceAccountName");
    }
    if (pod.automountServiceAccountToken !== false) {
        violations.push("automountServiceAccountToken");
    }
    if (volumes.some((volume) => "secret" in volume || "hostPath" in volume || "projected" in volume)) {
        violations.push("volumes");
    }
    if (
        containers.some((c) => c.env?.some((e) => (e.valueFrom as Record<string, unknown> | undefined)?.secretKeyRef))
    ) {
        violations.push("secretKeyRef");
    }
    if (containers.some((c) => c.envFrom?.some((e) => e.secretRef))) {
        violations.push("envFrom");
    }
    const deadline = job.spec!.activeDeadlineSeconds;
    if (deadline === undefined || deadline > 604800) {
        violations.push("activeDeadlineSeconds");
    }
    if (job.spec!.ttlSecondsAfterFinished === undefined) {
        violations.push("ttlSecondsAfterFinished");
    }
    if (pod.shareProcessNamespace) {
        violations.push("shareProcessNamespace");
    }
    if ((job.spec as { manualSelector?: boolean }).manualSelector) {
        violations.push("manualSelector");
    }
    if (pod.priorityClassName === "planet-service" || pod.priorityClassName?.startsWith("system-")) {
        violations.push("priorityClassName");
    }
    return violations;
}

const RESTRICTED_VOLUME_TYPES = new Set([
    "configMap",
    "csi",
    "downwardAPI",
    "emptyDir",
    "ephemeral",
    "persistentVolumeClaim",
    "projected",
    "secret",
]);

/** The Pod Security Standards `restricted` profile (Kubernetes 1.30+), as violations. */
function restrictedViolations(pod: PodSpec): string[] {
    const raw = pod as PodSpec & Record<string, unknown>;
    const containers = [...pod.containers, ...(pod.initContainers ?? [])];
    const violations: string[] = [];
    for (const field of ["hostNetwork", "hostPID", "hostIPC"]) {
        if (raw[field]) {
            violations.push(field);
        }
    }
    for (const volume of pod.volumes ?? []) {
        const types = Object.keys(volume).filter((key) => key !== "name");
        if (types.some((type) => !RESTRICTED_VOLUME_TYPES.has(type))) {
            violations.push(`volume ${volume.name}`);
        }
    }
    const userNamespace = pod.hostUsers === false;
    const podRunAsNonRoot = pod.securityContext?.runAsNonRoot === true;
    const podSeccomp = ["RuntimeDefault", "Localhost"].includes(pod.securityContext?.seccompProfile?.type ?? "");
    if (!userNamespace && pod.securityContext?.runAsUser === 0) {
        violations.push("pod runAsUser 0");
    }
    for (const c of containers) {
        const security = c.securityContext ?? {};
        const extra = c as Container & { ports?: { hostPort?: number }[] };
        if (security.privileged) {
            violations.push(`${c.name} privileged`);
        }
        if (security.allowPrivilegeEscalation !== false) {
            violations.push(`${c.name} allowPrivilegeEscalation`);
        }
        if (!security.capabilities?.drop?.includes("ALL")) {
            violations.push(`${c.name} capabilities.drop`);
        }
        if (security.capabilities?.add?.some((capability) => capability !== "NET_BIND_SERVICE")) {
            violations.push(`${c.name} capabilities.add`);
        }
        if (!userNamespace && !(security.runAsNonRoot ?? podRunAsNonRoot)) {
            violations.push(`${c.name} runAsNonRoot`);
        }
        if (!userNamespace && security.runAsUser === 0) {
            violations.push(`${c.name} runAsUser 0`);
        }
        if (!podSeccomp && !["RuntimeDefault", "Localhost"].includes(security.seccompProfile?.type ?? "")) {
            violations.push(`${c.name} seccompProfile`);
        }
        if (extra.ports?.some((port) => port.hostPort)) {
            violations.push(`${c.name} hostPort`);
        }
    }
    return violations;
}

function byName(spec: Job, name: string): Container {
    const pod = spec.spec!.template.spec;
    const found = [...(pod.initContainers ?? []), ...pod.containers].find((c) => c.name === name);
    if (!found) {
        throw new Error(`no container ${name}`);
    }
    return found;
}

function envOf(c: Container): Record<string, string | undefined> {
    return Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
}

describe("job names", () => {
    it("are deterministic and fit a DNS label", () => {
        const name = jobName(INSTANCE, JOB_ID, 12);
        expect(name).toBe("planet-a1b2c3d4-0123456789abcdef-a12");
        expect(name.length).toBeLessThanOrEqual(63);
        expect(() => jobName("Bad_Instance", JOB_ID, 1)).toThrow(JobSpecError);
        expect(() => jobName(INSTANCE, "../x", 1)).toThrow(JobSpecError);
        expect(() => jobName(INSTANCE, JOB_ID, 0)).toThrow(JobSpecError);
    });

    it("parses Kubernetes quantities", () => {
        expect(parseQuantity("1500m")).toBe(1.5);
        expect(parseQuantity("4Gi")).toBe(4 * 1024 ** 3);
        expect(parseQuantity("2e3")).toBe(2000);
        expect(parseQuantity("1G")).toBe(1e9);
        expect(parseQuantity("1.5x")).toBeNaN();
        expect(parseQuantity("")).toBeNaN();
    });
});

describe("tool job specs", () => {
    it("matches the recommended spec", async () => {
        expect(await buildJobSpec(input())).toMatchSnapshot();
    });

    it("pass the admission policy and Pod Security restricted, also with user namespaces", async () => {
        for (const cluster of [{}, { user_namespaces: true }, { arch_policy: "any" as const }]) {
            const spec = await buildJobSpec(input({ cluster }));
            expect(admissionViolations(spec)).toEqual([]);
            expect(restrictedViolations(spec.spec!.template.spec)).toEqual([]);
        }
    });

    it("give the manifest URL and the stager volume only to the stagers that need them", async () => {
        const spec = await buildJobSpec(input());
        const stageIn = byName(spec, "stage-in");
        const tool = byName(spec, "tool");
        const stageOut = byName(spec, "stage-out");
        expect(envOf(stageIn).PLANET_MANIFEST_URL).toBe(MANIFEST_URL);
        expect(envOf(tool).PLANET_MANIFEST_URL).toBeUndefined();
        expect(envOf(stageOut).PLANET_MANIFEST_URL).toBeUndefined();
        expect(JSON.stringify(tool)).not.toContain("X-Amz-Signature");
        expect(tool.volumeMounts).toEqual([
            { name: "planet", mountPath: "/planet" },
            { name: "planet", mountPath: "/tmp", subPath: "tmp" },
        ]);
        for (const stager of [stageIn, stageOut]) {
            expect(stager.volumeMounts).toEqual([
                { name: "planet", mountPath: "/planet" },
                { name: "planet-stager", mountPath: "/planet-stager" },
            ]);
            expect(stager.securityContext?.readOnlyRootFilesystem).toBe(true);
            expect(stager.terminationMessagePolicy).toBe("FallbackToLogsOnError");
            expect(envOf(stager)).toMatchObject({ HOME: "/planet-stager/home", TMPDIR: "/planet/tmp" });
        }
        expect(spec.spec!.template.spec.volumes).toEqual([
            { name: "planet", emptyDir: { sizeLimit: "20Gi" } },
            { name: "planet-stager", emptyDir: { sizeLimit: "1Gi" } },
        ]);
    });

    it("size the tool container from the plan and set Galaxy's slot and memory variables", async () => {
        const spec = await buildJobSpec(input());
        const tool = byName(spec, "tool");
        expect(tool.resources).toEqual({
            requests: { cpu: "1500m", memory: "4Gi", "ephemeral-storage": "20Gi" },
            limits: { memory: "4Gi", "ephemeral-storage": "22528Mi" },
        });
        expect(envOf(tool)).toMatchObject({
            HOME: "/planet/job/home",
            TMPDIR: "/planet/job/tmp",
            GALAXY_SLOTS: "2",
            GALAXY_MEMORY_MB: "4096",
            GALAXY_MEMORY_MB_PER_SLOT: "2048",
            PLANET_WALLTIME_SECONDS: "3600",
        });
    });

    it("follow the architecture policy and the user namespace setting", async () => {
        const amd64 = await buildJobSpec(input());
        expect(amd64.spec!.template.spec.nodeSelector).toEqual({ "kubernetes.io/arch": "amd64" });
        const any = await buildJobSpec(input({ cluster: { arch_policy: "any" } }));
        expect(any.spec!.template.spec.nodeSelector).toBeUndefined();
        const runtime = await buildJobSpec(input({ plan: { toolImage: DEFAULT_RUNTIME_IMAGE } }));
        expect(runtime.spec!.template.spec.nodeSelector).toBeUndefined();

        const userns = await buildJobSpec(input({ cluster: { user_namespaces: true } }));
        const pod = userns.spec!.template.spec;
        expect(pod.hostUsers).toBe(false);
        expect(pod.securityContext).toEqual({
            fsGroup: 10001,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
        });
        expect(byName(userns, "tool").securityContext?.runAsUser).toBeUndefined();
        expect(byName(userns, "stage-in").securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 10001 });
    });

    it("use the configured runtime image and pull pinned images only when missing", async () => {
        const pinned = `registry.example.org/planet-runtime@sha256:${"a".repeat(64)}`;
        const spec = await buildJobSpec(input({ cluster: { runtime_image: pinned } }));
        expect(byName(spec, "stage-in").image).toBe(pinned);
        const containers = [...spec.spec!.template.spec.initContainers!, ...spec.spec!.template.spec.containers];
        expect(containers.every((c) => c.imagePullPolicy === "IfNotPresent")).toBe(true);
        expect(byName(await buildJobSpec(input()), "stage-out").image).toBe(DEFAULT_RUNTIME_IMAGE);
        const build = "ghcr.io/example/planet-runtime@sha256:" + "c".repeat(64);
        expect(byName(await buildJobSpec(input({ buildRuntimeImage: build })), "stage-in").image).toBe(build);
        expect(
            byName(
                await buildJobSpec(input({ buildRuntimeImage: build, cluster: { runtime_image: "other:1" } })),
                "stage-out",
            ).image,
        ).toBe("other:1");
        await expect(buildJobSpec(input({ buildRuntimeImage: "bad image" }))).rejects.toThrow("build's runtime image");
    });

    it("pull runtime images without a digest every time, unless the build allows node-local images", async () => {
        const policies = (spec: Job) =>
            Object.fromEntries(
                [...(spec.spec!.template.spec.initContainers ?? []), ...spec.spec!.template.spec.containers].map(
                    (c) => [c.name, c.imagePullPolicy],
                ),
            );
        const tagged = await buildJobSpec(input({ cluster: { runtime_image: "registry.example.org/runtime:1" } }));
        expect(policies(tagged)).toEqual({ "stage-in": "Always", "stage-out": "Always", tool: "IfNotPresent" });
        expect(policies(await buildJobSpec(input()))).toMatchObject({ "stage-in": "Always", "stage-out": "Always" });

        // A tool without a container of its own runs in the runtime image, with the same policy.
        const inRuntime = await buildJobSpec(
            input({ cluster: { runtime_image: "planet-runtime:dev" }, plan: { toolImage: "planet-runtime:dev" } }),
        );
        expect(policies(inRuntime)).toEqual({ "stage-in": "Always", "stage-out": "Always", tool: "Always" });
        const local = await buildJobSpec(
            input({
                cluster: { runtime_image: "planet-runtime:dev" },
                plan: { toolImage: "planet-runtime:dev" },
                runtimeTagPullPolicy: "IfNotPresent",
            }),
        );
        expect(policies(local)).toEqual({
            "stage-in": "IfNotPresent",
            "stage-out": "IfNotPresent",
            tool: "IfNotPresent",
        });
        const upload = await buildJobSpec(input({ plan: { kind: "upload", toolImage: null } }));
        expect(policies(upload)).toEqual({ stager: "Always" });

        expect(runtimePullPolicy(`a/b@sha256:${"0".repeat(64)}`)).toBe("IfNotPresent");
        expect(runtimePullPolicy("a/b:latest")).toBe("Always");
        expect(runtimePullPolicy("a/b:latest", "IfNotPresent")).toBe("IfNotPresent");
    });

    it("refuse plans the cluster would reject", async () => {
        await expect(buildJobSpec(input({ plan: { deadlineSeconds: 700000 } }))).rejects.toThrow(JobSpecError);
        await expect(buildJobSpec(input({ plan: { walltimeSeconds: 20000 } }))).rejects.toThrow(JobSpecError);
        await expect(buildJobSpec(input({ plan: { toolImage: null } }))).rejects.toThrow(JobSpecError);
        await expect(buildJobSpec(input({ plan: { toolImage: "bad image" } }))).rejects.toThrow(JobSpecError);
        await expect(
            buildJobSpec(input({ plan: { resources: { cpu: "1", memory: "lots", scratch: "1Gi" } } })),
        ).rejects.toThrow(JobSpecError);
    });
});

describe("upload and set-metadata job specs", () => {
    it("run one stager container with the manifest URL", async () => {
        for (const kind of ["upload", "set_metadata"] as const) {
            const spec = await buildJobSpec(input({ plan: { kind, toolImage: null } }));
            const pod = spec.spec!.template.spec;
            expect(pod.initContainers).toBeUndefined();
            expect(pod.containers.map((c) => c.name)).toEqual(["stager"]);
            const stager = pod.containers[0]!;
            expect(stager.command).toEqual(["planet-stager", kind === "upload" ? "upload" : "set-metadata"]);
            expect(envOf(stager).PLANET_MANIFEST_URL).toBe(MANIFEST_URL);
            expect(stager.volumeMounts?.map((mount) => mount.name)).toEqual(["planet", "planet-stager"]);
            expect(pod.nodeSelector).toBeUndefined();
            expect(spec.metadata.labels?.["planet.dev/kind"]).toBe(kind.replace("_", "-"));
            expect(admissionViolations(spec)).toEqual([]);
            expect(restrictedViolations(pod)).toEqual([]);
        }
    });
});

describe("spec hashes", () => {
    it("ignore the presigned manifest URL and change with anything else", async () => {
        const first = await buildJobSpec(input());
        const again = await buildJobSpec(input({ plan: { manifestUrl: `${MANIFEST_URL}&X-Amz-Date=later` } }));
        const bigger = await buildJobSpec(input({ plan: { resources: { cpu: "2", memory: "4Gi", scratch: "20Gi" } } }));
        const hash = first.metadata.annotations?.[SPEC_HASH_ANNOTATION];
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(again.metadata.annotations?.[SPEC_HASH_ANNOTATION]).toBe(hash);
        expect(bigger.metadata.annotations?.[SPEC_HASH_ANNOTATION]).not.toBe(hash);
        expect(await specHash(first, MANIFEST_KEY)).toBe(hash);
    });

    it("cover the attempt's manifest key and the dispatch the Job was created from", async () => {
        const first = await buildJobSpec(input());
        const hash = first.metadata.annotations?.[SPEC_HASH_ANNOTATION];
        expect(first.metadata.annotations?.[DISPATCH_ID_ANNOTATION]).toBe(DISPATCH_ID);
        const otherAttemptKey = await buildJobSpec(input({ plan: { manifestKey: `jobs/${JOB_ID}/a2/manifest.json` } }));
        const otherDispatch = await buildJobSpec(input({ plan: { dispatchId: "6f0c2a9e7b1d3c4e" } }));
        expect(otherAttemptKey.metadata.annotations?.[SPEC_HASH_ANNOTATION]).not.toBe(hash);
        expect(otherDispatch.metadata.annotations?.[SPEC_HASH_ANNOTATION]).not.toBe(hash);
        await expect(buildJobSpec(input({ plan: { dispatchId: "../x" } }))).rejects.toThrow(JobSpecError);
    });
});
