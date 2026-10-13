// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
    createKubeClient,
    type Job,
    type KubeClientOptions,
    KubeError,
    missingPermissions,
    parseWarningHeader,
    type ResourceRule,
    rulesAllow,
} from ".";

const GATEWAY = "http://localhost:8080";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.token-value";

interface Call {
    raw: string;
    url: URL;
    method: string;
    headers: Headers;
    body: unknown;
}

type Responder = (call: Call, index: number, init: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function status(code: number, reason: string, message: string): Response {
    return json({ kind: "Status", apiVersion: "v1", status: "Failure", message, reason, code }, code);
}

function setup(responders: Responder | Responder[], options: KubeClientOptions = {}, gatewayUrl = GATEWAY) {
    const calls: Call[] = [];
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
        if (init.signal?.aborted) {
            throw init.signal.reason;
        }
        const call: Call = {
            raw: input,
            url: new URL(input),
            method: init.method ?? "GET",
            headers: new Headers(init.headers),
            body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
        };
        calls.push(call);
        const index = calls.length - 1;
        const responder = Array.isArray(responders) ? responders[index] : responders;
        if (!responder) {
            throw new Error(`unexpected request ${index}: ${call.method} ${input}`);
        }
        return responder(call, index, init);
    });
    const client = createKubeClient({ gatewayUrl, namespace: "planet", token: TOKEN }, { fetch, ...options });
    return { client, calls, fetch };
}

function job(name: string, resourceVersion: string, extra: Partial<Job> = {}): Job {
    return { apiVersion: "batch/v1", kind: "Job", metadata: { name, namespace: "planet", resourceVersion }, ...extra };
}

describe("requests", () => {
    it("reads the server version through a gateway base path", async () => {
        const { client, calls } = setup(
            () => json({ major: "1", minor: "35", gitVersion: "v1.35.0" }),
            {},
            "https://gw.example.org/k8s/",
        );
        expect(await client.version()).toMatchObject({ gitVersion: "v1.35.0" });
        expect(calls[0]!.url.href).toBe("https://gw.example.org/k8s/version");
        expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        expect(calls[0]!.headers.get("accept")).toBe("application/json");
    });

    it("creates Jobs in the configured namespace", async () => {
        const { client, calls } = setup((call) => json(call.body, 201));
        const spec: Job = {
            metadata: { name: "planet-ab12cd34-j1-a1", labels: { "planet.galaxyproject.org/job": "j1" } },
            spec: { template: { spec: { containers: [{ name: "tool", image: "busybox" }], restartPolicy: "Never" } } },
        };
        const created = await client.createJob(spec);
        expect(calls[0]!.method).toBe("POST");
        expect(calls[0]!.url.pathname).toBe("/apis/batch/v1/namespaces/planet/jobs");
        expect(calls[0]!.headers.get("content-type")).toBe("application/json");
        expect(calls[0]!.body).toMatchObject({
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: { name: "planet-ab12cd34-j1-a1", namespace: "planet" },
        });
        expect(created.metadata.namespace).toBe("planet");
        await expect(
            client.createJob({ ...spec, metadata: { name: "x", namespace: "default" } }),
        ).rejects.toMatchObject({
            reason: "Invalid",
        });
    });

    it("gets Jobs and Pods by validated name", async () => {
        const { client, calls, fetch } = setup([() => json(job("j1", "5")), () => json({ metadata: { name: "p1" } })]);
        await client.getJob("j1");
        await client.getPod("p1");
        expect(calls.map((c) => c.url.pathname)).toEqual([
            "/apis/batch/v1/namespaces/planet/jobs/j1",
            "/api/v1/namespaces/planet/pods/p1",
        ]);
        await expect(client.getJob("../../secrets")).rejects.toMatchObject({ reason: "Invalid" });
        await expect(client.getPod("A")).rejects.toBeInstanceOf(KubeError);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("deletes Jobs with Background propagation in the query and no body", async () => {
        const { client, calls } = setup([
            () => json({ kind: "Status", status: "Success" }),
            () => status(404, "NotFound", 'jobs.batch "j2" not found'),
            () => status(400, "BadRequest", "GET and DELETE requests must not have a body"),
        ]);
        expect(await client.deleteJob("j1-a2")).toBe(true);
        expect(calls[0]!.method).toBe("DELETE");
        expect(calls[0]!.raw).toBe(
            `${GATEWAY}/apis/batch/v1/namespaces/planet/jobs/j1-a2?propagationPolicy=Background`,
        );
        expect(calls[0]!.body).toBeUndefined();
        expect(calls[0]!.headers.has("content-type")).toBe(false);
        expect(await client.deleteJob("j2")).toBe(false);
        await expect(client.deleteJob("j3")).rejects.toMatchObject({ status: 400, reason: "BadRequest" });
    });

    it("percent-encodes query values but never parameter names", async () => {
        const { client, calls } = setup(() => json({ metadata: {}, items: [] }));
        await client.listEvents({ fieldSelector: "involvedObject.name=j1", labelSelector: "app in (a b),x!=y/z" });
        expect(calls[0]!.raw).toBe(
            `${GATEWAY}/api/v1/namespaces/planet/events?fieldSelector=involvedObject.name%3Dj1` +
                "&labelSelector=app%20in%20(a%20b)%2Cx!%3Dy%2Fz&limit=500",
        );
        expect(calls[0]!.url.searchParams.get("labelSelector")).toBe("app in (a b),x!=y/z");
    });

    it("lists all pages and keeps the first page's resourceVersion", async () => {
        const { client, calls } = setup([
            () =>
                json({
                    kind: "PodList",
                    metadata: { resourceVersion: "100", continue: "c1" },
                    items: [{ metadata: { name: "a" } }],
                }),
            () => json({ kind: "PodList", metadata: { resourceVersion: "100" }, items: [{ metadata: { name: "b" } }] }),
        ]);
        const list = await client.listPods("planet.galaxyproject.org/instance=ab12cd34,job-name");
        expect(list.items.map((pod) => pod.metadata.name)).toEqual(["a", "b"]);
        expect(list.metadata).toEqual({ resourceVersion: "100" });
        expect(calls[0]!.url.pathname).toBe("/api/v1/namespaces/planet/pods");
        expect(calls[0]!.url.searchParams.get("labelSelector")).toBe(
            "planet.galaxyproject.org/instance=ab12cd34,job-name",
        );
        expect(calls[0]!.url.searchParams.get("limit")).toBe("500");
        expect(calls[0]!.url.searchParams.has("continue")).toBe(false);
        expect(calls[1]!.url.searchParams.get("continue")).toBe("c1");
    });

    it("lists Jobs and events", async () => {
        const { client, calls } = setup([
            () => json({ metadata: { resourceVersion: "7" }, items: [job("j1", "6")] }),
            () => json({ metadata: { resourceVersion: "8" }, items: null }),
        ]);
        const jobs = await client.listJobs("app=planet");
        expect(jobs.items).toHaveLength(1);
        const events = await client.listEvents({ fieldSelector: "involvedObject.kind=Job,involvedObject.name=j1" });
        expect(events.items).toEqual([]);
        expect(calls[1]!.url.pathname).toBe("/api/v1/namespaces/planet/events");
        expect(calls[1]!.url.searchParams.get("fieldSelector")).toBe("involvedObject.kind=Job,involvedObject.name=j1");
        expect(calls[1]!.url.searchParams.has("labelSelector")).toBe(false);
    });

    it("reads container logs as text", async () => {
        const { client, calls } = setup(
            () => new Response("line 1\nline 2\n", { headers: { "content-type": "text/plain" } }),
        );
        const log = await client.getPodLog("p1", {
            container: "tool",
            limitBytes: 65536,
            sinceTime: "2026-10-09T10:00:00Z",
            previous: true,
        });
        expect(log).toBe("line 1\nline 2\n");
        const url = calls[0]!.url;
        expect(url.pathname).toBe("/api/v1/namespaces/planet/pods/p1/log");
        expect(Object.fromEntries(url.searchParams)).toEqual({
            container: "tool",
            limitBytes: "65536",
            sinceTime: "2026-10-09T10:00:00Z",
            previous: "true",
        });
        expect(calls[0]!.headers.get("accept")).toBe("text/plain, */*");
    });

    it("summarises SelfSubjectRulesReview", async () => {
        const rules: ResourceRule[] = [
            { verbs: ["create", "get", "list", "watch", "delete"], apiGroups: ["batch"], resources: ["jobs"] },
            { verbs: ["get", "list", "watch"], apiGroups: [""], resources: ["pods"] },
            { verbs: ["get"], apiGroups: [""], resources: ["pods/log"] },
            { verbs: ["get"], apiGroups: [""], resources: ["secrets"], resourceNames: ["one"] },
            { verbs: ["create"], apiGroups: ["authorization.k8s.io"], resources: ["selfsubjectrulesreviews"] },
        ];
        const { client, calls } = setup(() =>
            json({
                apiVersion: "authorization.k8s.io/v1",
                kind: "SelfSubjectRulesReview",
                spec: {},
                status: { resourceRules: rules, nonResourceRules: [], incomplete: false },
            }),
        );
        const review = await client.rulesReview();
        expect(calls[0]!.method).toBe("POST");
        expect(calls[0]!.url.pathname).toBe("/apis/authorization.k8s.io/v1/selfsubjectrulesreviews");
        expect(calls[0]!.body).toEqual({
            apiVersion: "authorization.k8s.io/v1",
            kind: "SelfSubjectRulesReview",
            spec: { namespace: "planet" },
        });
        expect(review.incomplete).toBe(false);
        expect(review.evaluationError).toBeNull();
        expect(review.allowed).toEqual({
            "jobs.batch": ["create", "delete", "get", "list", "watch"],
            pods: ["get", "list", "watch"],
            "pods/log": ["get"],
            "selfsubjectrulesreviews.authorization.k8s.io": ["create"],
        });
        expect(missingPermissions(review.rules)).toEqual(["list events", "watch events"]);
    });
});

describe("rulesAllow", () => {
    it("handles wildcards and subresources", () => {
        expect(rulesAllow([{ verbs: ["*"], apiGroups: ["*"], resources: ["*"] }], "delete", "pods/log")).toBe(true);
        expect(rulesAllow([{ verbs: ["get"], apiGroups: [""], resources: ["*/log"] }], "get", "pods/log")).toBe(true);
        expect(rulesAllow([{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }], "get", "pods/log")).toBe(false);
        expect(rulesAllow([{ verbs: ["get"], apiGroups: ["apps"], resources: ["jobs"] }], "get", "jobs", "batch")).toBe(
            false,
        );
    });
});

describe("errors", () => {
    it("parses Status objects", async () => {
        const { client } = setup([
            () => status(404, "NotFound", 'jobs.batch "j9" not found'),
            () => status(409, "AlreadyExists", 'jobs.batch "j1" already exists'),
            () =>
                json(
                    {
                        kind: "Status",
                        status: "Failure",
                        message: 'Job.batch "x" is invalid',
                        reason: "Invalid",
                        code: 422,
                        details: { name: "x", kind: "Job", causes: [{ field: "spec.template", message: "required" }] },
                    },
                    422,
                ),
        ]);
        const notFound = await client.getJob("j9").catch((e: unknown) => e);
        expect(notFound).toBeInstanceOf(KubeError);
        expect(notFound).toMatchObject({ status: 404, reason: "NotFound", message: 'jobs.batch "j9" not found' });
        await expect(client.createJob(job("j1", ""))).rejects.toMatchObject({ status: 409, reason: "AlreadyExists" });
        const invalid = (await client.createJob(job("x", "")).catch((e: unknown) => e)) as KubeError;
        expect(invalid.details?.causes?.[0]?.field).toBe("spec.template");
    });

    it("explains gateway rejections that are not Status objects", async () => {
        const { client } = setup([
            () => new Response("<html><body>403 Forbidden</body></html>", { status: 403 }),
            () => new Response("Unauthorized", { status: 401 }),
            () => new Response("bad gateway", { status: 502 }),
        ]);
        const forbidden = await client.version().catch((e: unknown) => e);
        expect(forbidden).toMatchObject({ status: 403, reason: "Forbidden" });
        expect((forbidden as Error).message).toContain("gateway");
        await expect(client.version()).rejects.toMatchObject({ status: 401, reason: "Unauthorized" });
        await expect(client.version()).rejects.toMatchObject({ status: 502, reason: "BadGateway" });
    });

    it("maps fetch TypeErrors to network_blocked without leaking the token", async () => {
        const { client } = setup(() => {
            throw new TypeError("Failed to fetch");
        });
        const error = (await client.version().catch((e: unknown) => e)) as KubeError;
        expect(error).toBeInstanceOf(KubeError);
        expect(error.status).toBe(0);
        expect(error.reason).toBe("network_blocked");
        expect(error.message).toContain("http://localhost:8080");
        expect(error.message).toContain("CORS");
        expect(error.message).toContain("local network access");
        expect(error.message).not.toContain(TOKEN);
    });

    it("rejects with the abort reason", async () => {
        const controller = new AbortController();
        controller.abort();
        const { client, fetch } = setup(() => json({}));
        await expect(client.getJob("j1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("rejects calls with invalid settings", async () => {
        const fetch = vi.fn();
        const bad = createKubeClient({ gatewayUrl: "localhost:8080", namespace: "planet", token: "t" }, { fetch });
        await expect(bad.version()).rejects.toMatchObject({ reason: "invalid_config" });
        const badNamespace = createKubeClient({ gatewayUrl: GATEWAY, namespace: "Planet", token: "t" }, { fetch });
        await expect(badNamespace.listJobs("")).rejects.toMatchObject({ reason: "invalid_config" });
        const badToken = createKubeClient({ gatewayUrl: GATEWAY, namespace: "planet", token: "a\nb" }, { fetch });
        await expect(badToken.version()).rejects.toMatchObject({ reason: "invalid_config" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("reports Warning headers", async () => {
        const onWarning = vi.fn();
        const { client } = setup(
            () =>
                json(job("j1", "1"), 201, {
                    warning:
                        '299 - "would violate PodSecurity \\"restricted:latest\\": runAsNonRoot != true", 299 - "second"',
                }),
            { onWarning },
        );
        await client.createJob(job("j1", ""));
        expect(onWarning).toHaveBeenCalledWith([
            'would violate PodSecurity "restricted:latest": runAsNonRoot != true',
            "second",
        ]);
        expect(parseWarningHeader("not a warning")).toEqual([]);
    });
});
