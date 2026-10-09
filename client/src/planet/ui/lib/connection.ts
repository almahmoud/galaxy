/**
 * The setup page's Test connection actions. Requests start in this document, which can show the
 * browser's local network access prompt; a check that needs a secret saved earlier continues in the
 * Service Worker, which holds it.
 */

import type { PlanetSettings } from "@/planet/db/types";
import type { KubeClient, KubeClientConfig } from "@/planet/k8s";
import type { S3Client, S3Config } from "@/planet/s3";

import { type CheckRequest, PlanetApiError } from "./api";
import {
    checkCluster,
    type CheckOptions,
    type CheckReport,
    checkStorage,
    type ClusterReport,
    type LocalAccess,
    type Reachability,
    type StorageReport,
} from "./checks";
import {
    type ClusterForm,
    clusterTarget,
    clusterValues,
    secretSource,
    storageConfig,
    type StorageForm,
    storageValues,
} from "./forms";

export interface ConnectionDeps {
    runChecks: (request: CheckRequest) => Promise<CheckReport>;
    localNetworkAccess: (url: string) => Promise<LocalAccess>;
    probe: (url: string) => Promise<Reachability>;
    kubeClient?: (config: KubeClientConfig) => KubeClient;
    s3Client?: (config: S3Config) => S3Client;
    origin?: string;
}

function failedRun(error: unknown): string {
    const reason = error instanceof PlanetApiError ? error.message : "Planet did not answer.";
    return `Planet could not run the check with the saved secret. ${reason}`;
}

async function pageOptions(url: string, deps: ConnectionDeps): Promise<CheckOptions> {
    const localAccess = url ? await deps.localNetworkAccess(url).catch(() => "unknown" as const) : "unknown";
    const options: CheckOptions = {
        context: "page",
        mode: "full",
        probe: deps.probe,
        localAccess,
    };
    if (deps.kubeClient) {
        options.kubeClient = deps.kubeClient;
    }
    if (deps.s3Client) {
        options.s3Client = deps.s3Client;
    }
    if (deps.origin) {
        options.origin = deps.origin;
    }
    return options;
}

/** Tests the cluster settings in the form, using the saved token when none was typed. */
export async function testCluster(
    form: ClusterForm,
    saved: PlanetSettings["cluster"],
    deps: ConnectionDeps,
): Promise<ClusterReport> {
    const target = clusterTarget(form);
    const options = await pageOptions(target.gatewayUrl, deps);
    if (secretSource(form.token, form.clear_token, saved.has_token) !== "saved") {
        return checkCluster(target, options);
    }
    const anonymous = await checkCluster({ ...target, token: "" }, { ...options, anonymousOnly: true });
    if (anonymous.state !== "ok") {
        return anonymous;
    }
    const values = clusterValues(form);
    try {
        const report = await deps.runChecks({
            targets: ["cluster"],
            mode: "full",
            settings: { cluster: { gateway_url: values.gateway_url, namespace: values.namespace } },
        });
        return report.cluster ?? anonymous;
    } catch (error) {
        return {
            ...anonymous,
            state: "error",
            checks: [
                ...anonymous.checks,
                { id: "token", title: "Token", status: "error", message: failedRun(error), code: "check_failed" },
            ],
        };
    }
}

/** Tests the storage settings in the form, using the saved secret access key when none was typed. */
export async function testStorage(
    form: StorageForm,
    saved: PlanetSettings["storage"],
    deps: ConnectionDeps,
): Promise<StorageReport> {
    const config = storageConfig(form);
    const options = await pageOptions(config.endpoint, deps);
    if (secretSource(form.secret_access_key, form.clear_secret, saved.has_secret) !== "saved") {
        return checkStorage(config, options);
    }
    const anonymous = await checkStorage(config, { ...options, anonymousOnly: true });
    if (anonymous.state !== "ok") {
        return anonymous;
    }
    try {
        const report = await deps.runChecks({
            targets: ["storage"],
            mode: "full",
            settings: { storage: storageValues(form) },
        });
        return report.storage ?? anonymous;
    } catch (error) {
        return {
            ...anonymous,
            state: "error",
            checks: [
                { id: "bucket", title: "Bucket", status: "error", message: failedRun(error), code: "check_failed" },
            ],
        };
    }
}
