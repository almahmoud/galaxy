// @vitest-environment node
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

import { clusterCommands, localClusterCommands } from "./commands";
import { CLUSTER, GARAGE } from "./presets";

const REPOSITORY = resolve(__dirname, "../../../../..");
const DEPLOY = resolve(REPOSITORY, "planet/deploy");
const DEV_CLUSTER = readFileSync(resolve(REPOSITORY, "planet/scripts/dev-cluster.sh"), "utf-8");

/** A line of allowed-origins.map: an exact origin mapped to 1. */
const ORIGIN_LINE = /^"(https?:\/\/[^"/]+)" 1;$/;

interface Resource {
    kind: string;
    metadata: { name: string; namespace?: string };
    type?: string;
    spec?: { ports?: { name: string; port: number }[] };
}

/** The Kubernetes resources of a manifest file under planet/deploy. */
function resources(file: string): Resource[] {
    return parseAllDocuments(readFileSync(resolve(DEPLOY, file), "utf-8")).map((doc) => doc.toJS() as Resource);
}

function findResource(file: string, kind: string, name: string): Resource | undefined {
    return resources(file).find((resource) => resource.kind === kind && resource.metadata.name === name);
}

/** Origins listed in an allowed-origins.map, comments removed. */
function allowedOrigins(file: string): string[] {
    return readFileSync(resolve(DEPLOY, file), "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => ORIGIN_LINE.exec(line)?.[1] ?? `invalid line: ${line}`);
}

function port(url: string): string {
    return new URL(url).port;
}

/** Default value of a `readonly NAME="${PLANET_...:-default}"` setting of dev-cluster.sh. */
function scriptDefault(name: string): string | undefined {
    return new RegExp(`^readonly ${name}="\\$\\{\\w+:-([^}]+)\\}"$`, "m").exec(DEV_CLUSTER)?.[1];
}

/** Subcommands handled by the `main` case statement of dev-cluster.sh. */
function scriptSubcommands(): string[] {
    const main = /^main\(\) \{\n([\s\S]*?)^\}$/m.exec(DEV_CLUSTER)?.[1] ?? "";
    return [...main.matchAll(/^ {4}([a-z][a-z-]*)\) cmd_/gm)].map((match) => match[1]!);
}

describe("cluster commands", () => {
    it("deploy an overlay of planet/deploy", () => {
        const apply = clusterCommands({ overlay: "example" }).find((step) => step.id === "apply")!;
        expect(apply.command).toBe("kubectl apply -k planet/deploy/overlays/example");
        expect(existsSync(resolve(REPOSITORY, apply.command.split(" ").pop()!, "kustomization.yaml"))).toBe(true);
        expect(clusterCommands().find((step) => step.id === "apply")?.command).toBe(
            "kubectl apply -k planet/deploy/overlays/mylab",
        );
    });

    it("write origin lines in the format of allowed-origins.map", () => {
        const origin = "https://planet.mylab.org";
        const line = clusterCommands({ origin })[0]!;
        expect(line.id).toBe("origin");
        expect(ORIGIN_LINE.exec(line.command)?.[1]).toBe(origin);
        expect(line.description).toContain("planet/deploy/overlays/example");
        for (const file of ["base/gateway/allowed-origins.map", "overlays/example/allowed-origins.map"]) {
            expect(allowedOrigins(file)).not.toContainEqual(expect.stringMatching(/^invalid line/));
        }
    });

    it("name the namespace, gateway and token of planet/deploy/base", () => {
        expect(findResource("base/namespace.yaml", "Namespace", CLUSTER.namespace)).toBeDefined();
        expect(findResource("base/gateway.yaml", "Deployment", "planet-gateway")?.metadata.namespace).toBe(
            CLUSTER.namespace,
        );
        expect(findResource("base/rbac.yaml", "ServiceAccount", CLUSTER.jobServiceAccount)?.metadata.namespace).toBe(
            CLUSTER.namespace,
        );
        const token = findResource("base/rbac.yaml", "Secret", "planet-client-token");
        expect(token?.type).toBe("kubernetes.io/service-account-token");
        expect(token?.metadata.namespace).toBe(CLUSTER.namespace);

        const service = findResource("base/gateway.yaml", "Service", "planet-gateway");
        const http = service?.spec?.ports?.find((entry) => entry.name === "http")?.port;
        const byId = Object.fromEntries(clusterCommands().map((step) => [step.id, step.command]));
        expect(byId["rollout"]).toBe(`kubectl -n ${CLUSTER.namespace} rollout status deployment/planet-gateway`);
        expect(byId["port-forward"]).toBe(
            `kubectl -n ${CLUSTER.namespace} port-forward --address 127.0.0.1 service/planet-gateway ` +
                `${port(CLUSTER.gatewayUrl)}:${http}`,
        );
        expect(byId["token"]).toBe(
            `kubectl -n ${CLUSTER.namespace} get secret planet-client-token -o jsonpath='{.data.token}' | base64 --decode`,
        );
    });
});

describe("local cluster commands", () => {
    it("are subcommands of dev-cluster.sh", () => {
        const subcommands = scriptSubcommands();
        expect(subcommands).toEqual(expect.arrayContaining(["up", "down", "status"]));
        for (const step of localClusterCommands()) {
            const [script, subcommand, ...rest] = step.command.split(" ");
            expect(script).toBe("planet/scripts/dev-cluster.sh");
            expect(rest).toEqual([]);
            expect(subcommands).toContain(subcommand);
        }
    });

    it("allow the origins the setup page names", () => {
        const up = localClusterCommands().find((step) => step.id === "up")!;
        const origins = allowedOrigins("overlays/local/allowed-origins.map");
        expect(origins).toEqual(["http://localhost:8787", "http://127.0.0.1:8787"]);
        for (const origin of origins) {
            expect(up.description).toContain(origin);
        }
        expect(DEV_CLUSTER).toContain('kube apply -k "$DEPLOY_DIR/overlays/local"');
    });

    it("forward the ports of the default settings", () => {
        expect(scriptDefault("GATEWAY_PORT")).toBe(port(CLUSTER.gatewayUrl));
        expect(scriptDefault("S3_PORT")).toBe(port(GARAGE.endpoint));
        const forward = localClusterCommands().find((step) => step.id === "port-forward")!;
        expect(forward.description).toContain(CLUSTER.gatewayUrl);
        expect(forward.description).toContain(GARAGE.endpoint);
    });
});

describe("Garage defaults", () => {
    it("match components/garage", () => {
        const cluster = new URL(GARAGE.clusterEndpoint);
        const [service, namespace] = cluster.hostname.split(".");
        const resource = findResource("components/garage/garage.yaml", "Service", service!);
        expect(resource?.metadata.namespace).toBe(namespace);
        expect(resource?.spec?.ports?.find((entry) => entry.name === "s3")?.port).toBe(Number(cluster.port));

        const toml = readFileSync(resolve(DEPLOY, "components/garage/garage.toml"), "utf-8");
        expect(/^s3_region = "([^"]+)"$/m.exec(toml)?.[1]).toBe(GARAGE.region);
        expect(toml).not.toMatch(/^root_domain\b/m);
        expect(GARAGE.pathStyle).toBe(true);

        const garage = readFileSync(resolve(DEPLOY, "components/garage/garage.yaml"), "utf-8");
        expect(garage).toMatch(new RegExp(`- name: GARAGE_DEFAULT_BUCKET\\n\\s+value: ${GARAGE.bucket}\\n`));
    });

    it("match the settings dev-cluster.sh storage prints", () => {
        const storage = /^cmd_storage\(\) \{\n[\s\S]*?^EOF$/m.exec(DEV_CLUSTER)?.[0] ?? "";
        const setting = (name: string) =>
            new RegExp(`^${name}: +(.+)$`, "m").exec(storage)?.[1]?.replace("${S3_PORT}", scriptDefault("S3_PORT")!);
        expect(setting("endpoint")).toBe(GARAGE.endpoint);
        expect(setting("cluster endpoint")).toBe(GARAGE.clusterEndpoint);
        expect(setting("bucket")).toBe(GARAGE.bucket);
        expect(setting("region")).toBe(GARAGE.region);
        expect(setting("path-style")).toBe(String(GARAGE.pathStyle));
    });
});
