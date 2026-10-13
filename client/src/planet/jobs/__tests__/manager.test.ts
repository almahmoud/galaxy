// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resumePausedJobs } from "@/planet/api/legacyHistory";
import { datasets, hdas, jobs, kv, leader, outbox, setLeaderFence, settings, type StoredSettings } from "@/planet/db";
import { KubeError } from "@/planet/k8s";

import { DEPENDENT_PAUSE_MESSAGE } from "../gating";
import { FAILURE_MESSAGES } from "../ingest";
import { buildJobSpec, SPEC_HASH_ANNOTATION } from "../k8sJob";
import { JobManager, MISSING_JOB_GRACE_MS, NO_POD_GRACE_MS } from "../manager";
import { ProtocolError } from "../schemas";
import {
    container,
    fakeDeps,
    FakeKube,
    FakeProtocol,
    hdaState,
    podStatus,
    resetDb,
    seedHistory,
    seedJob,
    waitFor,
} from "./fakes";

let manager: JobManager | null = null;

beforeEach(resetDb);

afterEach(async () => {
    await manager?.stop();
    manager = null;
    await resetDb();
});

interface Harness {
    manager: JobManager;
    kube: FakeKube;
    protocol: FakeProtocol;
    s3: ReturnType<typeof fakeDeps>["s3"];
    stored: StoredSettings;
    errors: unknown[];
    fenced: number[];
    clock: { now: number };
    settle(): Promise<void>;
}

async function start(setup: { kube?: FakeKube; protocol?: FakeProtocol } = {}): Promise<Harness> {
    const kube = setup.kube ?? new FakeKube();
    const protocol = setup.protocol ?? new FakeProtocol();
    const { deps, s3 } = fakeDeps();
    const stored = await settings.getStored();
    const errors: unknown[] = [];
    const fenced: number[] = [];
    const clock = { now: Date.now() };
    const created = new JobManager({
        kube,
        deps,
        protocol,
        settings: stored,
        now: () => Math.max(clock.now, Date.now()),
        onError: (error) => errors.push(error),
        onFenced: () => fenced.push(1),
    });
    manager = created;
    const settle = async () => {
        for (let round = 0; round < 6; round++) {
            await waitFor(2);
            await created.idle();
        }
    };
    created.start();
    await settle();
    return { manager: created, kube, protocol, s3, stored, errors, fenced, clock, settle };
}

async function jobState(id: string) {
    return (await jobs.get(id))?.state;
}

describe("dispatch and gating", () => {
    it("creates the Kubernetes Job of a ready job and marks the job and its outputs queued", async () => {
        const { history, input } = await seedHistory();
        const { job, outputHdaId } = await seedJob(history.id, [input.id]);

        const { kube, protocol, stored } = await start();

        expect(protocol.dispatched).toEqual([{ jobId: job.id, attempt: 1 }]);
        const name = `planet-${stored.instance_id}-${job.id}-a1`;
        expect(kube.created.map((created) => created.metadata.name)).toEqual([name]);
        const record = await jobs.get(job.id);
        expect(record?.state).toBe("queued");
        expect(record?.k8s).toMatchObject({ name, attempt: 1, kind: "tool", uid: `uid-${name}`, prepared: false });
        expect(record?.k8s?.spec_hash).toBe(kube.created[0]?.metadata.annotations?.[SPEC_HASH_ANNOTATION]);
        expect(await hdaState(outputHdaId)).toBe("queued");
        expect(await outbox.list()).toEqual([]);
        expect(kube.openWatches()).toBe(2);
    });

    it("keeps a job new while an input is not ready and dispatches it when the input becomes ok", async () => {
        const { history, input, inputDataset } = await seedHistory("queued");
        const { job } = await seedJob(history.id, [input.id]);

        const { kube, settle } = await start();
        expect(kube.created).toHaveLength(0);
        expect(await jobState(job.id)).toBe("new");
        const [entry] = await outbox.list();
        expect(entry?.attempts).toBe(0);
        expect(entry && entry.not_before > entry.create_time).toBe(true);

        await datasets.update(inputDataset.id, { state: "ok" });
        await settle();
        expect(kube.created).toHaveLength(1);
        expect(await jobState(job.id)).toBe("queued");
    });

    it("pauses a job whose input is in error with Galaxy's message, and dispatches it once resumed", async () => {
        const { history, input, inputDataset } = await seedHistory();
        await datasets.update(inputDataset.id, { state: "error" });
        const { job, outputHdaId } = await seedJob(history.id, [input.id]);

        const { kube, settle } = await start();
        expect(await jobState(job.id)).toBe("paused");
        expect(await hdaState(outputHdaId)).toBe("paused");
        expect((await hdas.get(outputHdaId))?.info).toBe(
            "Input dataset 'input.bed' is in error state. To resume this job fix the input dataset(s).",
        );
        expect(await outbox.list()).toEqual([]);
        expect(kube.created).toHaveLength(0);

        await datasets.update(inputDataset.id, { state: "ok" });
        expect(await resumePausedJobs(history.id)).toEqual([job.id]);
        await settle();
        expect(await jobState(job.id)).toBe("queued");
        expect(kube.created).toHaveLength(1);
    });

    it("fails a job whose input was purged", async () => {
        const { history, input } = await seedHistory();
        await hdas.update(input.id, { deleted: true, purged: true });
        const { job } = await seedJob(history.id, [input.id]);

        const { protocol, kube } = await start();
        expect(protocol.failures).toEqual([
            {
                jobId: job.id,
                failure: { reason: "unknown", message: "Input dataset 'input.bed' was deleted before the job started" },
                state: "new",
            },
        ]);
        expect(await jobState(job.id)).toBe("error");
        expect(kube.created).toHaveLength(0);
    });

    it("dispatches jobs created without an outbox entry, such as resumed ones", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id], { enqueue: false });

        const { kube } = await start();
        expect(kube.created).toHaveLength(1);
        expect(await jobState(job.id)).toBe("queued");
    });

    it("retries transient errors with backoff and fails jobs the cluster rejects", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const kube = new FakeKube();
        kube.createError = new KubeError(503, "ServiceUnavailable", "The gateway is unavailable");

        const { manager: running, protocol, clock } = await start({ kube });
        const [entry] = await outbox.list();
        expect(entry).toMatchObject({ attempts: 1, last_error: "The gateway is unavailable" });
        expect(await jobState(job.id)).toBe("new");

        kube.createError = new KubeError(
            403,
            "Forbidden",
            "admission webhook denied the request: ValidatingAdmissionPolicy 'planet-job-template' denied request",
        );
        clock.now = Date.now() + 60_000;
        await running.drainOutbox();
        expect(protocol.failures[0]?.failure.reason).toBe("rejected");
        expect(protocol.failures[0]?.failure.message).toContain("ValidatingAdmissionPolicy");
        expect(await jobState(job.id)).toBe("error");
        expect(await outbox.list()).toEqual([]);
    });

    it("adopts an existing Job with the same spec and replaces one with another spec", async () => {
        const { history, input } = await seedHistory();
        const first = await seedJob(history.id, [input.id]);
        const second = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const kube = new FakeKube();
        const protocol = new FakeProtocol();
        const plan = await protocol.prepareDispatch(first.job, fakeDeps().deps, { attempt: 1 });
        protocol.dispatched.length = 0;
        const same = await buildJobSpec({
            instanceId: stored.instance_id,
            jobId: first.job.id,
            attempt: 1,
            plan,
            cluster: stored.cluster,
        });
        await kube.createJob(same);
        const other = await buildJobSpec({
            instanceId: stored.instance_id,
            jobId: second.job.id,
            attempt: 1,
            plan: { ...plan, resources: { ...plan.resources, cpu: "2" } },
            cluster: stored.cluster,
        });
        await kube.createJob(other);
        kube.created.length = 0;

        await start({ kube, protocol });
        expect((await jobs.get(first.job.id))?.k8s?.name).toBe(same.metadata.name);
        expect(kube.deleted).toEqual([other.metadata.name]);
        expect(kube.created.map((job) => job.metadata.name)).toEqual([
            `planet-${stored.instance_id}-${second.job.id}-a2`,
        ]);
        expect((await jobs.get(second.job.id))?.k8s?.attempt).toBe(2);
        expect(protocol.dispatched).toContainEqual({ jobId: second.job.id, attempt: 2 });
    });
});

describe("monitoring", () => {
    async function dispatched() {
        const { history, input } = await seedHistory();
        const seeded = await seedJob(history.id, [input.id]);
        const harness = await start();
        const name = (await jobs.get(seeded.job.id))!.k8s!.name;
        return { ...harness, ...seeded, history, name };
    }

    it("marks a job running once the tool container runs, then ingests its results and deletes the Job", async () => {
        const { kube, protocol, job, name, outputHdaId, settle } = await dispatched();

        kube.setPod(name, podStatus.stagingIn());
        await settle();
        expect(await jobState(job.id)).toBe("queued");

        kube.setPod(name, podStatus.running());
        await settle();
        expect(await jobState(job.id)).toBe("running");
        expect(await hdaState(outputHdaId)).toBe("running");
        expect((await jobs.get(job.id))?.k8s).toMatchObject({ pod_name: `${name}-pod`, node_name: "node-1" });
        expect(protocol.readPrepare).toHaveBeenCalled();

        protocol.results.set(job.id, "ok");
        kube.setPod(name, podStatus.finished({ exitCode: 0 }));
        kube.finishJob(name, "Complete");
        await settle();
        expect(await jobState(job.id)).toBe("ok");
        expect(kube.deleted).toContain(name);
        expect(kube.jobs.has(name)).toBe(false);
        expect(protocol.failures).toEqual([]);
    });

    it("pauses jobs that depend on a failed job", async () => {
        const { kube, protocol, job, name, outputHdaId, history, settle } = await dispatched();
        const dependent = await seedJob(history.id, [outputHdaId]);
        await settle();
        expect(await jobState(dependent.job.id)).toBe("new");

        protocol.results.set(job.id, "error");
        kube.setPod(name, podStatus.finished({ exitCode: 0 }));
        kube.finishJob(name, "Complete");
        await settle();
        expect(await jobState(job.id)).toBe("error");
        expect(await jobState(dependent.job.id)).toBe("paused");
        expect((await hdas.get(dependent.outputHdaId))?.info).toBe(DEPENDENT_PAUSE_MESSAGE);
        expect(await hdaState(dependent.outputHdaId)).toBe("paused");
    });

    it("records an OOM-killed tool for ingest and fails a job without results with Galaxy's message", async () => {
        const { kube, protocol, job, name, settle } = await dispatched();
        kube.logs.set(`${name}-pod/tool`, "reading input\nKilled\n");
        kube.setPod(name, podStatus.finished({ exitCode: 137, reason: "OOMKilled" }, { exitCode: 1 }));
        kube.finishJob(name, "Failed", "PodFailurePolicy");
        await settle();

        expect((await jobs.get(job.id))?.k8s?.tool_termination).toEqual({
            reason: "OOMKilled",
            exit_code: 137,
            message: null,
        });
        expect(protocol.failures).toHaveLength(1);
        expect(protocol.failures[0]?.failure).toMatchObject({
            reason: "oom",
            message: FAILURE_MESSAGES.oom,
            toolStdout: "reading input\nKilled\n",
        });
        expect(kube.logRequests[0]).toMatchObject({
            pod: `${name}-pod`,
            options: { container: "tool", limitBytes: 32768 },
        });
        expect(kube.deleted).toContain(name);
        expect(await jobState(job.id)).toBe("error");
    });

    it("fails a job past its deadline with Galaxy's walltime message", async () => {
        const { kube, protocol, name, settle } = await dispatched();
        kube.setPod(name, { ...podStatus.finished({ exitCode: 137 }, { exitCode: 137 }), reason: "DeadlineExceeded" });
        kube.finishJob(name, "Failed", "DeadlineExceeded", "Job was active longer than specified deadline");
        await settle();
        expect(protocol.failures[0]?.failure).toMatchObject({ reason: "walltime", message: FAILURE_MESSAGES.walltime });
    });

    it("fails fast when the tool image does not exist", async () => {
        const { kube, protocol, name, job, settle } = await dispatched();
        kube.setPod(
            name,
            podStatus.waiting(
                "tool",
                "ErrImagePull",
                'failed to resolve reference "quay.io/biocontainers/missing:1.0--0": not found',
            ),
        );
        await settle();
        expect(protocol.failures[0]?.failure.reason).toBe("image_not_found");
        expect(protocol.failures[0]?.failure.message).toContain("quay.io/biocontainers/missing:1.0--0");
        expect(kube.deleted).toContain(name);
        expect(kube.logRequests).toEqual([]);
        expect(await jobState(job.id)).toBe("error");
    });

    it("retries other image pull errors for five minutes", async () => {
        const { kube, protocol, name, job, clock, manager: running, settle } = await dispatched();
        kube.setPod(name, podStatus.waiting("tool", "ImagePullBackOff", "connection reset by peer"));
        await settle();
        expect(protocol.failures).toEqual([]);

        clock.now = Date.now() + 5 * 60_000 + 1000;
        running.schedule(job.id);
        await settle();
        expect(protocol.failures[0]?.failure.reason).toBe("image_pull");
    });

    it("fails a job whose architecture does not match the node", async () => {
        const { kube, protocol, name, settle } = await dispatched();
        kube.setPod(name, {
            ...podStatus.running(),
            phase: "Failed",
            containerStatuses: [
                container("tool", {
                    terminated: { exitCode: 128, reason: "StartError", message: "exec format error" },
                }),
                container("stage-out", { terminated: { exitCode: 1, reason: "Error" } }),
            ],
        });
        await settle();
        expect(protocol.failures[0]?.failure.reason).toBe("wrong_architecture");
    });

    it("reads events of a Job without pods and fails it when pod creation is refused", async () => {
        const { kube, protocol, name, job, clock, manager: running, settle } = await dispatched();
        kube.events.push({
            metadata: { name: "e1", creationTimestamp: new Date().toISOString() },
            involvedObject: { kind: "Job", name },
            reason: "FailedCreate",
            type: "Warning",
            message:
                'Error creating: pods "x" is forbidden: exceeded quota: planet-compute, requested: pods=1, used: pods=20, limited: pods=20',
        });
        clock.now = Date.now() + NO_POD_GRACE_MS + 1000;
        running.schedule(job.id);
        await settle();
        expect(protocol.failures).toEqual([]);
        expect(await jobState(job.id)).toBe("queued");

        kube.events.push({
            metadata: { name: "e2", creationTimestamp: new Date(Date.now() + 1000).toISOString() },
            involvedObject: { kind: "Job", name },
            reason: "FailedCreate",
            type: "Warning",
            lastTimestamp: new Date(Date.now() + 1000).toISOString(),
            message: 'Error creating: pods "x" is forbidden: violates PodSecurity "restricted:latest"',
        });
        clock.now = Date.now() + NO_POD_GRACE_MS + 60_000;
        running.schedule(job.id);
        await settle();
        expect(protocol.failures[0]?.failure.reason).toBe("rejected");
        expect(protocol.failures[0]?.failure.message).toContain("violates PodSecurity");
    });

    it("fails a job whose pod was evicted", async () => {
        const { kube, protocol, name, settle } = await dispatched();
        kube.setPod(name, {
            ...podStatus.running(),
            phase: "Failed",
            reason: "Evicted",
            message: "Pod ephemeral local storage usage exceeds the total limit of containers 22Gi.",
        });
        kube.finishJob(name, "Failed", "PodFailurePolicy");
        await settle();
        expect(protocol.failures[0]?.failure).toMatchObject({ reason: "evicted" });
        expect(protocol.failures[0]?.failure.message).toContain("ephemeral local storage");
    });

    it("starts a new attempt when stage-in fails before writing prepare.json", async () => {
        const { kube, protocol, name, job, stored, settle } = await dispatched();
        kube.setPod(name, {
            phase: "Failed",
            initContainerStatuses: [
                container("stage-in", {
                    terminated: {
                        exitCode: 1,
                        reason: "Error",
                        message: '{"stage":"in","state":"error","error":"HTTP 403"}',
                    },
                }),
            ],
        });
        kube.finishJob(name, "Failed", "PodFailurePolicy");
        await settle();
        expect(protocol.failures).toEqual([]);
        expect(kube.deleted).toContain(name);
        expect(protocol.dispatched).toEqual([
            { jobId: job.id, attempt: 1 },
            { jobId: job.id, attempt: 2 },
        ]);
        const record = await jobs.get(job.id);
        expect(record?.k8s?.name).toBe(`planet-${stored.instance_id}-${job.id}-a2`);
        expect(record?.state).toBe("queued");
    });

    it("fails a job whose results.json breaks the protocol", async () => {
        const { kube, protocol, name, settle } = await dispatched();
        protocol.ingestResults.mockRejectedValueOnce(
            new ProtocolError("results.json", "/state", "must be ok or error"),
        );
        kube.setPod(name, podStatus.finished({ exitCode: 0 }));
        kube.finishJob(name, "Complete");
        await settle();
        expect(protocol.failures[0]?.failure).toMatchObject({
            reason: "stage_out",
            message: "The job's results could not be read: results.json is invalid at /state: must be ok or error",
        });
        expect(kube.deleted).toContain(name);
    });

    it("waits for the replacement of a disrupted pod and forgets how the first one's tool ended", async () => {
        const { kube, name, job, protocol, settle } = await dispatched();
        const disrupted = podStatus.finished({ exitCode: 137, reason: "Error" }, { exitCode: 0 });
        disrupted.conditions = [{ type: "DisruptionTarget", status: "True", reason: "PreemptionByScheduler" }];
        kube.setPod(name, disrupted, "first");
        await settle();
        expect(protocol.ingestResults).not.toHaveBeenCalled();
        expect(protocol.failures).toEqual([]);
        expect((await jobs.get(job.id))?.k8s?.tool_termination?.exit_code).toBe(137);
        kube.pods.delete("first");
        kube.setPod(name, podStatus.running(), "second");
        await settle();
        expect((await jobs.get(job.id))?.k8s).toMatchObject({ pod_name: "second", tool_termination: null });
    });

    it("fails a job whose stage-in reported a template error", async () => {
        const { kube, protocol, name, job, settle } = await dispatched();
        protocol.prepared.add(job.id);
        kube.setPod(name, {
            phase: "Failed",
            initContainerStatuses: [
                container("stage-in", {
                    terminated: {
                        exitCode: 1,
                        reason: "Error",
                        message: '{"stage":"in","state":"error","error":"NotFound: cannot find \'x\'"}',
                    },
                }),
            ],
        });
        kube.finishJob(name, "Failed", "PodFailurePolicy");
        await settle();
        expect(protocol.failures[0]?.failure).toMatchObject({
            reason: "stage_in",
            message: "Preparing the job failed: NotFound: cannot find 'x'",
        });
    });

    it("cancels a deleting job: deletes its Kubernetes Job and marks it deleted", async () => {
        const { kube, name, job, settle } = await dispatched();
        kube.setPod(name, podStatus.running());
        await settle();
        await jobs.update(job.id, { state: "deleting" });
        await settle();
        expect(kube.deleted).toContain(name);
        expect(await jobState(job.id)).toBe("deleted");
    });

    it("runs upload jobs in one stager container", async () => {
        const { history } = await seedHistory();
        const upload = await seedJob(history.id, [], { toolId: "__DATA_FETCH__" });
        const { kube, protocol, settle } = await start();
        const record = await jobs.get(upload.job.id);
        expect(record?.k8s).toMatchObject({ kind: "upload", image: null });
        const name = record!.k8s!.name;
        expect(kube.jobs.get(name)?.spec?.template.spec.containers.map((c) => c.name)).toEqual(["stager"]);

        kube.setPod(name, { phase: "Running", containerStatuses: [container("stager", { running: {} })] });
        await settle();
        expect(await jobState(upload.job.id)).toBe("running");

        protocol.results.set(upload.job.id, "ok");
        kube.setPod(name, {
            phase: "Succeeded",
            containerStatuses: [container("stager", { terminated: { exitCode: 0 } })],
        });
        await settle();
        expect(await jobState(upload.job.id)).toBe("ok");
        expect(kube.deleted).toContain(name);
    });

    it("keeps a live console tail while a client reads it", async () => {
        const { kube, name, job, settle } = await dispatched();
        kube.setPod(name, podStatus.running());
        kube.logs.set(`${name}-pod/tool`, "2026-10-13T10:00:00.5Z line 1\n2026-10-13T10:00:01Z line 2\n");
        await settle();
        await jobs.requestConsole(job.id);
        await (manager as unknown as { consoleTick(): Promise<void> }).consoleTick();
        expect((await jobs.get(job.id))?.tool_stdout).toBe("line 1\nline 2\n");
        expect(kube.logRequests.at(-1)?.options).toMatchObject({
            container: "tool",
            timestamps: true,
            tailLines: 1000,
        });
    });
});

describe("recovery", () => {
    it("picks up jobs that were queued or running when the previous leader stopped", async () => {
        const { history, input } = await seedHistory();
        const stored = await settings.getStored();
        const kube = new FakeKube();
        const protocol = new FakeProtocol();
        const first = await start({ kube, protocol });
        const running = await seedJob(history.id, [input.id]);
        const finished = await seedJob(history.id, [input.id]);
        const vanished = await seedJob(history.id, [input.id]);
        await first.settle();
        await first.manager.stop();
        manager = null;
        const names = await Promise.all(
            [running, finished, vanished].map(async ({ job }) => (await jobs.get(job.id))!.k8s!.name),
        );
        expect(names.every((name) => name.startsWith(`planet-${stored.instance_id}-`))).toBe(true);

        // While no leader ran: one job started, one finished and its Job was removed by the TTL controller, and
        // one Job disappeared without results.
        kube.setPod(names[0]!, podStatus.running());
        protocol.results.set(finished.job.id, "ok");
        kube.dropJob(names[1]!);
        kube.dropJob(names[2]!);

        const second = await start({ kube, protocol });
        second.clock.now = Date.now() + MISSING_JOB_GRACE_MS + 1000;
        await second.manager.reconcile();
        await second.settle();

        expect(await jobState(running.job.id)).toBe("running");
        expect(await jobState(finished.job.id)).toBe("ok");
        expect(await jobState(vanished.job.id)).toBe("error");
        expect(protocol.failures.map((failure) => failure.failure)).toEqual([
            { reason: "deleted", message: FAILURE_MESSAGES.deleted },
        ]);
        expect(kube.created).toHaveLength(3);
    });

    it("deletes Kubernetes Jobs of jobs that settled while no leader watched", async () => {
        const { history, input } = await seedHistory();
        const kube = new FakeKube();
        const first = await start({ kube });
        const { job } = await seedJob(history.id, [input.id]);
        await first.settle();
        await first.manager.stop();
        const name = (await jobs.get(job.id))!.k8s!.name;
        await jobs.update(job.id, { state: "ok" });

        await start({ kube });
        expect(kube.deleted).toContain(name);
    });
});

describe("outbox maintenance", () => {
    it("deletes the bucket objects of purged datasets and retries failed cleanups", async () => {
        const { history } = await seedHistory();
        const { dataset } = await hdas.createWithDataset({ history_id: history.id, name: "gone" }, { state: "ok" });
        await datasets.update(dataset.id, { purged: true, deleted: true });
        const kept = await hdas.createWithDataset({ history_id: history.id, name: "kept" }, { state: "ok" });
        await outbox.enqueue({ kind: "purge", payload: { dataset_ids: [dataset.id, kept.dataset.id] } });
        await outbox.enqueue({
            kind: "cleanup",
            payload: { multipart: [{ key: "datasets/u/data", upload_id: "up1" }] },
        });
        const stored = await settings.getStored();
        const ours = `planet-${stored.instance_id}-0123456789abcdef-a1`;
        await outbox.enqueue({ kind: "cleanup", payload: { k8s_jobs: ["someone-elses-job", ours] } });

        const harness = await start();
        expect(harness.s3.listObjects).toHaveBeenCalledWith(`datasets/${dataset.uuid}/`, {
            continuationToken: undefined,
        });
        expect(harness.s3.listObjects).toHaveBeenCalledTimes(1);
        expect(harness.s3.abortMultipartUpload).toHaveBeenCalledWith("datasets/u/data", "up1");
        expect(harness.kube.deleted).toEqual([ours]);
        expect(await outbox.list()).toEqual([]);
    });
});

describe("leader fencing", () => {
    it("stops job writes once another tab claimed a newer epoch", async () => {
        const epoch = await leader.claimEpoch();
        setLeaderFence(epoch);
        const { history, input } = await seedHistory();
        const { fenced, kube, settle } = await start();
        await leader.claimEpoch();

        const { job } = await seedJob(history.id, [input.id]).catch(() => ({ job: null }));
        expect(job).toBeNull();
        setLeaderFence(null);
        const seeded = await seedJob(history.id, [input.id]);
        setLeaderFence(epoch);
        await settle();
        expect(fenced.length).toBeGreaterThan(0);
        expect(kube.created).toEqual([]);
        expect(await jobState(seeded.job.id)).toBe("new");
        expect(await kv.get("leader_epoch")).toBe(epoch + 1);
    });
});
