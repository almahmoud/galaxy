/**
 * Default cluster settings and the storage providers offered by the setup page, with the settings each one
 * implies. The values follow planet/docs/cluster-setup.md, planet/docs/storage-setup.md and planet/deploy.
 */

/** Cluster settings for planet/deploy with the gateway port-forwarded to 127.0.0.1:8001. */
export const CLUSTER = {
    gatewayUrl: "http://127.0.0.1:8001",
    namespace: "planet",
    jobServiceAccount: "planet-job",
} as const;

export type StorageProvider = "r2" | "aws" | "garage" | "custom";
export type R2Jurisdiction = "default" | "eu" | "fedramp";

export interface ProviderPreset {
    id: StorageProvider;
    label: string;
    description: string;
}

export const PROVIDERS: readonly ProviderPreset[] = [
    { id: "r2", label: "Cloudflare R2", description: "A bucket in your Cloudflare account." },
    { id: "aws", label: "Amazon S3", description: "A bucket in any AWS region." },
    { id: "garage", label: "Local Garage", description: "Garage in a local kind cluster, through the gateway." },
    { id: "custom", label: "Other", description: "Any other S3-compatible service." },
];

export const R2_JURISDICTIONS: readonly { id: R2Jurisdiction; label: string }[] = [
    { id: "default", label: "Default" },
    { id: "eu", label: "European Union" },
    { id: "fedramp", label: "FedRAMP" },
];

/** Garage from planet/deploy/components/garage, with the gateway's S3 listener port-forwarded to 127.0.0.1:8002. */
export const GARAGE = {
    endpoint: "http://127.0.0.1:8002",
    clusterEndpoint: "http://garage.planet-storage.svc:3900",
    region: "garage",
    bucket: "planet",
    pathStyle: true,
} as const;

export const DEFAULT_PREFIX = "planet";

const R2_ENDPOINT = /^https:\/\/([a-f0-9]{32})(?:\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/;
const AWS_ENDPOINT = /^https:\/\/s3[.-]([a-z0-9-]+)\.amazonaws\.com$/;
const R2_ACCOUNT = /^[a-f0-9]{32}$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction = "default"): string {
    const zone = jurisdiction === "default" ? "" : `.${jurisdiction}`;
    return `https://${accountId}${zone}.r2.cloudflarestorage.com`;
}

export function parseR2Endpoint(endpoint: string): { accountId: string; jurisdiction: R2Jurisdiction } | null {
    const match = R2_ENDPOINT.exec(endpoint);
    return match ? { accountId: match[1]!, jurisdiction: (match[2] as R2Jurisdiction | undefined) ?? "default" } : null;
}

export function awsEndpoint(region: string): string {
    return `https://s3.${region}.amazonaws.com`;
}

/** The AWS region of a regional S3 endpoint; `https://s3.amazonaws.com` is us-east-1. */
export function parseAwsEndpoint(endpoint: string): string | null {
    if (endpoint === "https://s3.amazonaws.com") {
        return "us-east-1";
    }
    const match = AWS_ENDPOINT.exec(endpoint);
    return match ? match[1]! : null;
}

export function r2AccountError(value: string): string | null {
    if (!value) {
        return "Enter the account ID.";
    }
    return R2_ACCOUNT.test(value)
        ? null
        : "The account ID has 32 characters, 0-9 and a-f. Find it on the R2 overview page of the Cloudflare dashboard.";
}

export function awsRegionError(value: string): string | null {
    if (!value) {
        return "Enter the bucket's region.";
    }
    return AWS_REGION.test(value) ? null : "Enter an AWS region such as us-east-1 or eu-central-1.";
}

/** The provider whose settings match a stored endpoint. An empty endpoint selects Cloudflare R2. */
export function detectProvider(endpoint: string): StorageProvider {
    if (!endpoint || parseR2Endpoint(endpoint)) {
        return "r2";
    }
    if (parseAwsEndpoint(endpoint)) {
        return "aws";
    }
    if (endpoint === GARAGE.endpoint || endpoint === "http://localhost:8002") {
        return "garage";
    }
    return "custom";
}
