// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { purgeHda } from "@/planet/api/contents";
import { resumePausedJobs } from "@/planet/api/legacyHistory";
import {
    datasets,
    hdas,
    histories,
    JOB_STORES,
    type JobKubernetesInfo,
    jobs,
    kv,
    leader,
    LeaseFenceError,
    outbox,
    setLeaderFence,
    settings,
    type StoredSettings,
    withTransaction,
} from "@/planet/db";
import { KubeError } from "@/planet/k8s";
import { parseGalaxyTime } from "@/planet/util/time";

import { addOutput, addUpload, type FakeS3, testDeps } from "../__fixtures__/setup";
import type { JobDeps } from "../deps";
import { DEPENDENT_PAUSE_MESSAGE } from "../gating";
import { FAILURE_MESSAGES, ingestFailure, ingestResults, readPrepare } from "../ingest";
import { buildJobSpec, DISPATCH_ID_ANNOTATION, jobName, SPEC_HASH_ANNOTATION } from "../k8sJob";
import {
    JobManager,
    type JobProtocol,
    MISSING_JOB_GRACE_MS,
    NO_POD_GRACE_MS,
    POD_GONE_MS,
    PURGE_RECHECK_MS,
} from "../manager";
import { abortDispatch, adoptDispatch, DATA_FETCH_TOOL_ID, prepareDispatch } from "../manifest";
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
    errors: unknown[];
    stored: StoredSettings;
    fenced: number[];
    fencedErrors: unknown[];
    clock: { now: number };
    settle(): Promise<void>;
}

async function start(
    setup: {
        kube?: FakeKube;
        protocol?: FakeProtocol | JobProtocol;
        deps?: JobDeps;
        epoch?: number;
        leaseProblem?: () => string | null;
    } = {},
): Promise<Harness> {
    const kube = setup.kube ?? new FakeKube();
    const protocol = setup.protocol ?? new FakeProtocol();
    const fake = fakeDeps();
    const deps = setup.deps ?? fake.deps;
    const s3 = fake.s3;
    const stored = await settings.getStored();
    const errors: unknown[] = [];
    const fenced: number[] = [];
    const fencedErrors: unknown[] = [];
    const clock = { now: Date.now() };
    const created = new JobManager({
        kube,
        deps,
        protocol,
        settings: stored,
        epoch: setup.epoch,
        leaseProblem: setup.leaseProblem,
        now: () => Math.max(clock.now, Date.now()),
        onError: (error) => errors.push(error),
        onFenced: (error) => {
            fenced.push(1);
            fencedErrors.push(error);
        },
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
    return {
        manager: created,
        kube,
        protocol: protocol as FakeProtocol,
        s3,
        stored,
        errors,
        fenced,
        fencedErrors,
        clock,
        settle,
    };
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

    it("adopts the Job of an unrecorded dispatch without preparing again and replaces a Job of another dispatch", async () => {
        const { history, input } = await seedHistory();
        const first = await seedJob(history.id, [input.id]);
        const second = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const kube = new FakeKube();
        const protocol = new FakeProtocol();
        const plan = await protocol.prepareDispatch(first.job, fakeDeps().deps, { attempt: 1 });
        protocol.dispatched.length = 0;
        protocol.prepareDispatch.mockClear();
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
            plan: { ...plan, dispatchId: "f".repeat(16) },
            cluster: stored.cluster,
        });
        await kube.createJob(other);
        kube.created.length = 0;

        await start({ kube, protocol });
        expect((await jobs.get(first.job.id))?.k8s).toMatchObject({ name: same.metadata.name, attempt: 1 });
        expect(protocol.prepareDispatch).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: first.job.id }),
            expect.anything(),
            expect.anything(),
        );
        expect(kube.deleted).toEqual([other.metadata.name]);
        expect(protocol.abortDispatch).toHaveBeenCalledWith(
            expect.objectContaining({ id: second.job.id }),
            expect.anything(),
            {
                attempt: 1,
            },
        );
        expect(kube.created.map((job) => job.metadata.name)).toEqual([
            `planet-${stored.instance_id}-${second.job.id}-a2`,
        ]);
        expect((await jobs.get(second.job.id))?.k8s?.attempt).toBe(2);
        expect(protocol.dispatched).toEqual([{ jobId: second.job.id, attempt: 2 }]);
    });

    it("keeps the attempt it moved on to when the dispatch is retried", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const kube = new FakeKube();
        const protocol = new FakeProtocol();
        const plan = await protocol.prepareDispatch(job, fakeDeps().deps, { attempt: 1 });
        protocol.dispatched.length = 0;
        await kube.createJob(
            await buildJobSpec({
                instanceId: stored.instance_id,
                jobId: job.id,
                attempt: 1,
                plan: { ...plan, dispatchId: "e".repeat(16) },
                cluster: stored.cluster,
            }),
        );
        protocol.prepareError = new KubeError(503, "ServiceUnavailable", "The gateway is unavailable");

        const { manager: running, clock } = await start({ kube, protocol });
        const [entry] = await outbox.list();
        const replaced = jobName(stored.instance_id, job.id, 1);
        expect(entry?.payload).toEqual({ attempt: 2, replace: [replaced] });
        protocol.prepareError = null;
        clock.now = Date.now() + 60_000;
        await running.drainOutbox();
        expect(protocol.dispatched).toEqual([{ jobId: job.id, attempt: 2 }]);
        expect((await jobs.get(job.id))?.k8s?.attempt).toBe(2);
        expect(kube.deleted).toEqual([replaced, replaced]);
    });

    it("moves past an attempt whose Job of another dispatch it could not delete, and deletes it first next time", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const kube = new FakeKube();
        const protocol = new FakeProtocol();
        const plan = await protocol.prepareDispatch(job, fakeDeps().deps, { attempt: 1 });
        protocol.dispatched.length = 0;
        const replaced = jobName(stored.instance_id, job.id, 1);
        await kube.createJob(
            await buildJobSpec({
                instanceId: stored.instance_id,
                jobId: job.id,
                attempt: 1,
                plan: { ...plan, dispatchId: "e".repeat(16) },
                cluster: stored.cluster,
            }),
        );
        kube.created.length = 0;
        kube.deleteError = new KubeError(503, "ServiceUnavailable", "The gateway is unavailable");

        const { manager: running, clock } = await start({ kube, protocol });
        // The entry moved on before the deletion was tried, so attempt 1 is never prepared again.
        expect((await outbox.list())[0]?.payload).toEqual({ attempt: 2, replace: [replaced] });
        expect(kube.jobs.has(replaced)).toBe(true);
        expect(protocol.abortDispatch).not.toHaveBeenCalled();
        expect(kube.created).toEqual([]);

        clock.now = Date.now() + 60_000;
        await running.drainOutbox();
        expect(kube.jobs.has(replaced)).toBe(false);
        expect(protocol.dispatched).toEqual([{ jobId: job.id, attempt: 2 }]);
        expect(kube.created.map((created) => created.metadata.name)).toEqual([jobName(stored.instance_id, job.id, 2)]);
        expect(await outbox.list()).toEqual([]);
    });

    it("never prepares again an attempt whose objects exist although its Job does not", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const protocol = new FakeProtocol();
        // A dispatch wrote attempt 1's objects; its Job finished and was deleted by its TTL.
        await protocol.prepareDispatch(job, fakeDeps().deps, { attempt: 1 });
        protocol.dispatched.length = 0;

        const { kube } = await start({ protocol });
        expect(protocol.dispatched).toEqual([{ jobId: job.id, attempt: 2 }]);
        expect(kube.created.map((created) => created.metadata.name)).toEqual([jobName(stored.instance_id, job.id, 2)]);
        expect((await jobs.get(job.id))?.k8s).toMatchObject({ attempt: 2, stage_in_retries: 0 });
    });

    it("keeps the Job another leader recorded for a job while its own create request was in flight", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const kube = new FakeKube();
        const recorded: JobKubernetesInfo = {
            namespace: "planet",
            name: jobName(stored.instance_id, job.id, 7),
            uid: "uid-other",
            attempt: 7,
            spec_hash: null,
            pod_name: null,
            node_name: null,
            image: null,
            kind: "tool",
            created: null,
            prepared: false,
            tool_termination: null,
            multipart: [],
        };
        kube.beforeCreate = async () => {
            kube.beforeCreate = null;
            await jobs.update(job.id, { state: "queued", k8s: recorded });
        };

        await start({ kube });
        const ours = jobName(stored.instance_id, job.id, 1);
        expect(kube.created.map((created) => created.metadata.name)).toEqual([ours]);
        expect(kube.deleted).toEqual([ours]);
        expect((await jobs.get(job.id))?.k8s).toEqual(recorded);
        expect(await outbox.list()).toEqual([]);
    });

    it("deletes the Job it created for a job that can no longer be dispatched", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        const stored = await settings.getStored();
        const kube = new FakeKube();
        kube.beforeCreate = async () => {
            kube.beforeCreate = null;
            await jobs.update(job.id, { state: "paused" });
        };

        await start({ kube });
        const ours = jobName(stored.instance_id, job.id, 1);
        expect(kube.deleted).toEqual([ours]);
        expect(await jobs.get(job.id)).toMatchObject({ state: "paused", k8s: null });
    });
});

describe("dispatch through the protocol module", () => {
    /** An upload job of one 5 GiB file, whose output gets a browser-created multipart upload. */
    async function largeUpload() {
        const history = await histories.create({ name: "uploads" });
        const upload = await addUpload({ name: "reads.fastq", size: 5 * 1024 ** 3, key: "uploads/u1" });
        const output = await addOutput(history.id, { name: "reads.fastq", extension: "auto" }, { state: "queued" });
        const job = await withTransaction(JOB_STORES, "readwrite", async (t) => {
            const created = await jobs.create(
                {
                    tool_id: DATA_FETCH_TOOL_ID,
                    tool_version: "1.0.0",
                    history_id: history.id,
                    request: {
                        targets: [{ destination: { type: "hdas" }, elements: [{ src: "planet", file: upload.id }] }],
                    },
                    outputs: [{ name: "output0", src: "hda", id: output.hda.id }],
                },
                t,
            );
            await outbox.enqueue({ kind: "dispatch", job_id: created.id }, t);
            return created;
        });
        const deps = testDeps();
        const protocol: JobProtocol = {
            prepareDispatch,
            adoptDispatch,
            abortDispatch,
            ingestResults,
            readPrepare,
            ingestFailure,
        };
        return { job, deps, protocol, s3: deps.s3 as FakeS3 };
    }

    it("adopts a Job created before the leader recorded it, rewriting and aborting nothing", async () => {
        const { job, deps, protocol, s3 } = await largeUpload();
        const stored = await settings.getStored();
        const kube = new FakeKube();
        // A leader prepared attempt 1 and created its Job, then went away before recording the dispatch.
        const plan = await prepareDispatch(job, deps, { attempt: 1 });
        expect(plan.multipart).toHaveLength(1);
        await kube.createJob(
            await buildJobSpec({
                instanceId: stored.instance_id,
                jobId: job.id,
                attempt: 1,
                plan,
                cluster: stored.cluster,
            }),
        );
        const objects = new Map([...s3.objects].map(([key, bytes]) => [key, bytes.slice()]));
        const operations = s3.log.length;

        await start({ kube, protocol, deps });
        const record = await jobs.get(job.id);
        expect(record?.state).toBe("queued");
        expect(record?.k8s).toMatchObject({
            name: jobName(stored.instance_id, job.id, 1),
            attempt: 1,
            kind: "upload",
            multipart: [{ key: plan.multipart[0]!.key, upload_id: plan.multipart[0]!.uploadId }],
        });
        expect(kube.created).toHaveLength(1);
        expect(s3.aborted).toEqual([]);
        expect(
            s3.log.slice(operations).filter((entry) => !entry.startsWith("GET ") && !entry.startsWith("HEAD ")),
        ).toEqual([]);
        expect(s3.objects).toEqual(objects);
    });

    it("keeps the uploads of a create request whose outcome is unknown, and aborts them once the Job proves absent", async () => {
        const { job, deps, protocol, s3 } = await largeUpload();
        const kube = new FakeKube();
        kube.createError = new TypeError("Failed to fetch");

        const { manager: running, clock } = await start({ kube, protocol, deps });
        expect(await jobState(job.id)).toBe("new");
        expect(s3.aborted).toEqual([]);

        clock.now = Date.now() + 60_000;
        await running.drainOutbox();
        expect(s3.aborted).toEqual(["upload-1"]);
        expect((await jobs.get(job.id))?.k8s?.multipart).toEqual([
            { key: expect.stringMatching(/^datasets\/.+\/data$/), upload_id: "upload-2" },
        ]);
    });

    it("aborts the uploads of a dispatch the cluster refused", async () => {
        const { job, deps, protocol, s3 } = await largeUpload();
        const kube = new FakeKube();
        kube.createError = new KubeError(422, "Invalid", "spec.template is invalid");

        await start({ kube, protocol, deps });
        expect(await jobState(job.id)).toBe("error");
        expect(s3.aborted).toEqual(["upload-1"]);
    });

    it("writes nothing to the bucket once another tab leads", async () => {
        const { job, deps, protocol, s3 } = await largeUpload();
        setLeaderFence(await leader.claimEpoch());
        await leader.claimEpoch();

        const { fenced } = await start({ protocol, deps });
        expect(fenced.length).toBeGreaterThan(0);
        expect(s3.log.filter((entry) => !/^(GET|HEAD|LIST) /.test(entry))).toEqual([]);
        expect(await jobState(job.id)).toBe("new");
    });

    it("writes nothing for an earlier epoch of the same tab, even while that tab's current epoch is valid", async () => {
        const { job, deps, protocol, s3 } = await largeUpload();
        const previous = await leader.claimEpoch();
        // The tab leads again: its fence now holds the new, current epoch.
        setLeaderFence(await leader.claimEpoch());

        const { fenced, kube } = await start({ protocol, deps, epoch: previous });
        expect(fenced.length).toBeGreaterThan(0);
        expect(kube.created).toEqual([]);
        expect(s3.aborted).toEqual([]);
        expect(await jobState(job.id)).toBe("new");
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

    it("fails a job whose image is for another architecture while stage-out still waits for the tool", async () => {
        const { kube, protocol, name, job, settle } = await dispatched();
        kube.setPod(name, {
            ...podStatus.running(),
            containerStatuses: [
                container("tool", {
                    terminated: {
                        exitCode: 128,
                        reason: "StartError",
                        message: "failed to create containerd task: exec /bin/sh: exec format error",
                    },
                }),
                container("stage-out", { running: {} }),
            ],
        });
        await settle();
        expect(protocol.failures[0]?.failure.reason).toBe("wrong_architecture");
        expect(protocol.failures[0]?.failure.message).toContain("amd64-only");
        expect(kube.deleted).toContain(name);
        expect(kube.logRequests).toEqual([]);
        expect(await jobState(job.id)).toBe("error");
    });

    it("fails fast when the runtime cannot start the tool container", async () => {
        const { kube, protocol, name, job, settle } = await dispatched();
        kube.setPod(name, {
            ...podStatus.running(),
            containerStatuses: [
                container("tool", {
                    terminated: {
                        exitCode: 128,
                        reason: "StartError",
                        message: 'exec: "/bin/sh": stat /bin/sh: no such file or directory',
                    },
                }),
                container("stage-out", { running: {} }),
            ],
        });
        await settle();
        expect(protocol.failures[0]?.failure).toMatchObject({
            reason: "unknown",
            message: 'The tool container could not start: exec: "/bin/sh": stat /bin/sh: no such file or directory',
        });
        expect(kube.deleted).toContain(name);
        expect(await jobState(job.id)).toBe("error");
    });

    it("keeps waiting while the tool container runs and stage-out waits", async () => {
        const { kube, protocol, name, job, settle } = await dispatched();
        kube.setPod(name, podStatus.running());
        await settle();
        expect(protocol.failures).toEqual([]);
        expect(await jobState(job.id)).toBe("running");
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

    it("retries a stage-in that failed before prepare.json, counting stage-in runs apart from attempt numbers", async () => {
        const { kube, protocol, job, name, settle, clock, manager: running } = await dispatched();
        // Attempt 2's objects already exist (an earlier dispatch), so the retry runs as attempt 3.
        await protocol.prepareDispatch(job, fakeDeps().deps, { attempt: 2 });
        const failStageIn = (jobName: string) => {
            kube.setPod(jobName, {
                phase: "Failed",
                initContainerStatuses: [
                    container("stage-in", { terminated: { exitCode: 1, reason: "Error", message: "expired" } }),
                ],
            });
            kube.finishJob(jobName, "Failed", "PodFailurePolicy");
        };
        failStageIn(name);
        await settle();
        clock.now = Date.now() + 60_000;
        await running.drainOutbox();
        await settle();
        expect((await jobs.get(job.id))?.k8s).toMatchObject({ attempt: 3, stage_in_retries: 1 });
        expect(protocol.failures).toEqual([]);

        failStageIn((await jobs.get(job.id))!.k8s!.name);
        await settle();
        clock.now = Date.now() + 120_000;
        await running.drainOutbox();
        await settle();
        expect((await jobs.get(job.id))?.k8s).toMatchObject({ attempt: 4, stage_in_retries: 2 });

        failStageIn((await jobs.get(job.id))!.k8s!.name);
        await settle();
        expect(protocol.failures.map((failure) => failure.failure.reason)).toEqual(["stage_in"]);
        expect(await jobState(job.id)).toBe("error");
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
        // The dataset's prefix and the markers of forks of this instance.
        expect(harness.s3.listObjects).toHaveBeenCalledTimes(2);
        expect(harness.s3.abortMultipartUpload).toHaveBeenCalledWith("datasets/u/data", "up1");
        expect(harness.kube.deleted).toEqual([ours]);
        expect(await outbox.list()).toEqual([]);
    });
});

describe("purging datasets", () => {
    it("deletes the bucket objects of a dataset purged through the API once its last copy is purged", async () => {
        const { history } = await seedHistory();
        const { hda, dataset } = await hdas.createWithDataset(
            { history_id: history.id, name: "gone" },
            { state: "ok" },
        );
        const copy = await hdas.copy(hda.id, history.id);
        await withTransaction(JOB_STORES, "readwrite", (t) => purgeHda(hda.id, t));
        expect(await outbox.list()).toEqual([]);
        await withTransaction(JOB_STORES, "readwrite", (t) => purgeHda(copy.id, t));
        expect((await outbox.list()).map((entry) => [entry.kind, entry.payload])).toEqual([
            ["purge", { dataset_ids: [dataset.id] }],
        ]);

        const kube = new FakeKube();
        const { deps, s3 } = fakeDeps();
        const keys = [`datasets/${dataset.uuid}/data`, `datasets/${dataset.uuid}/meta.json`];
        s3.listObjects.mockImplementation((async (prefix: string) => ({
            objects: prefix === `datasets/${dataset.uuid}/` ? keys.map((key) => ({ key })) : [],
            commonPrefixes: [],
            isTruncated: false,
            nextContinuationToken: null,
        })) as never);
        await start({ kube, deps });
        expect(s3.listObjects).toHaveBeenCalledWith(`datasets/${dataset.uuid}/`, { continuationToken: undefined });
        expect(s3.deleteObject.mock.calls.map(([key]) => key)).toEqual(keys);
        expect(await outbox.list()).toEqual([]);
    });
});

describe("purging outputs of jobs that may still write them", () => {
    async function purgedOutput() {
        const { history, input } = await seedHistory();
        const { job, outputDatasetId } = await seedJob(history.id, [input.id]);
        const dataset = await datasets.update(outputDatasetId, { purged: true, deleted: true, job_id: job.id });
        await outbox.enqueue({ kind: "purge", payload: { dataset_ids: [dataset.id] } });
        return { job, dataset };
    }

    function listedPrefixes(s3: ReturnType<typeof fakeDeps>["s3"]): string[] {
        return s3.listObjects.mock.calls.map((call) => (call as unknown as [string])[0]);
    }

    it("deletes nothing until the creating job settled and its Job is gone", async () => {
        const { job, dataset } = await purgedOutput();
        const { manager: running, kube, s3, clock, settle } = await start();
        const prefix = `datasets/${dataset.uuid}/`;
        expect(await jobState(job.id)).toBe("queued");
        expect(listedPrefixes(s3)).not.toContain(prefix);
        const [entry] = (await outbox.list()).filter((each) => each.kind === "purge");
        expect(entry?.payload).toEqual({ dataset_ids: [dataset.id] });
        expect(entry!.not_before > entry!.create_time).toBe(true);

        // Settled, but its Job and pod are still in the cluster.
        await jobs.update(job.id, { state: "ok" });
        clock.now = Date.now() + PURGE_RECHECK_MS + 1000;
        await running.drainOutbox();
        expect(listedPrefixes(s3)).not.toContain(prefix);

        await kube.deleteJob((await jobs.get(job.id))!.k8s!.name);
        await settle();
        clock.now += PURGE_RECHECK_MS + 1000;
        await running.drainOutbox();
        expect(listedPrefixes(s3)).toContain(prefix);
        expect((await outbox.list()).filter((each) => each.kind === "purge")).toEqual([]);
    });

    it("without a listing of the cluster, waits until the creating job settled a while ago", async () => {
        const { job, dataset } = await purgedOutput();
        await jobs.update(job.id, { state: "error" });
        const kube = new FakeKube();
        kube.listJobs = async () => {
            throw new TypeError("Failed to fetch");
        };
        const { manager: running, s3, clock } = await start({ kube });
        const prefix = `datasets/${dataset.uuid}/`;
        expect(listedPrefixes(s3)).not.toContain(prefix);

        clock.now = Date.now() + POD_GONE_MS + 1000;
        await running.drainOutbox();
        expect(listedPrefixes(s3)).toContain(prefix);
    });
});

describe("forks", () => {
    async function purgedDataset(name: string) {
        const { history } = await seedHistory();
        const { dataset } = await hdas.createWithDataset({ history_id: history.id, name }, { state: "ok" });
        await datasets.update(dataset.id, { purged: true, deleted: true });
        return (await datasets.get(dataset.id))!;
    }

    function deletedPrefixes(s3: ReturnType<typeof fakeDeps>["s3"]): string[] {
        return s3.listObjects.mock.calls
            .map((call) => (call as unknown as [string])[0])
            .filter((prefix) => prefix.startsWith("datasets/"));
    }

    it("keeps the objects of datasets a fork shares with its origin", async () => {
        const shared = await purgedDataset("before the fork");
        const instanceId = (await settings.getStored()).instance_id;
        await kv.set(
            "instance_fork" as never,
            {
                from: "a1b2c3d4",
                to: instanceId,
                time: shared.create_time,
                clock: parseGalaxyTime(shared.create_time),
            } as never,
        );
        const own = await purgedDataset("after the fork");
        await outbox.enqueue({ kind: "purge", payload: { dataset_ids: [shared.id, own.id] } });
        const { s3 } = await start();
        expect(deletedPrefixes(s3)).toEqual([`datasets/${own.uuid}/`]);
        expect(await outbox.list()).toEqual([]);
    });

    it("keeps the objects of datasets a fork of this instance shares", async () => {
        const shared = await purgedDataset("before the fork");
        const own = await purgedDataset("after the fork");
        const instanceId = (await settings.getStored()).instance_id;
        const { deps, s3 } = fakeDeps();
        const marker = `state/${instanceId}/forks/0badc0de.json`;
        s3.listObjects.mockImplementation((async (prefix: string) => ({
            objects: prefix === `state/${instanceId}/forks/` ? [{ key: marker }] : [],
            commonPrefixes: [],
            isTruncated: false,
            nextContinuationToken: null,
        })) as never);
        (s3 as unknown as Record<string, unknown>).getObject = async (key: string) =>
            new Response(
                JSON.stringify({
                    format: "planet-instance-fork",
                    version: 1,
                    from: instanceId,
                    to: "0badc0de",
                    time: shared.create_time,
                    clock: parseGalaxyTime(shared.create_time),
                }),
                { headers: { "x-key": key } },
            );
        await outbox.enqueue({ kind: "purge", payload: { dataset_ids: [shared.id, own.id] } });
        await start({ deps });
        expect(deletedPrefixes(s3)).toEqual([`datasets/${own.uuid}/`]);
    });

    it("ignores purges by uuid", async () => {
        const dataset = await purgedDataset("named by uuid");
        await outbox.enqueue({ kind: "purge", payload: { uuids: [dataset.uuid] } as never });
        const { s3 } = await start();
        expect(deletedPrefixes(s3)).toEqual([]);
        expect(await outbox.list()).toEqual([]);
    });
});

describe("the instance lease", () => {
    it("writes nothing to the cluster or the bucket while the lease does not allow it", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id]);
        let problem: string | null = "Another device runs jobs for this instance.";
        const { kube, fenced, fencedErrors, manager: running, settle } = await start({ leaseProblem: () => problem });
        expect(kube.created).toEqual([]);
        expect(fenced.length).toBeGreaterThan(0);
        expect(fencedErrors[0]).toBeInstanceOf(LeaseFenceError);
        expect((fencedErrors[0] as Error).message).toBe("Another device runs jobs for this instance.");
        expect(await jobState(job.id)).toBe("new");

        problem = null;
        await running.reconcile();
        await settle();
        expect(kube.created).toHaveLength(1);
    });

    it("never deletes Kubernetes Jobs of other instances", async () => {
        const { history, input } = await seedHistory();
        const { job } = await seedJob(history.id, [input.id], { enqueue: false });
        await jobs.update(job.id, {
            state: "deleting",
            k8s: {
                namespace: "planet",
                name: "planet-ffffffff-0123456789abcdef-a1",
                uid: null,
                attempt: 1,
                spec_hash: null,
                pod_name: null,
                node_name: null,
                image: null,
                kind: "tool",
                created: null,
                prepared: false,
                tool_termination: null,
                multipart: [],
            },
        });
        const { kube, errors } = await start();
        expect(kube.deleted).toEqual([]);
        expect(await jobState(job.id)).toBe("deleted");
        expect(errors.map((error) => String(error))).toContainEqual(
            expect.stringMatching(/not one of this instance's/),
        );
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
