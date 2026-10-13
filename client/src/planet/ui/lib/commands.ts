/** Commands shown on the setup page. Each one appears in planet/docs/cluster-setup.md (see commands.test.ts). */

import { CLUSTER } from "./presets";

export interface SetupCommand {
    id: string;
    title: string;
    description: string;
    command: string;
}

export const REPOSITORY_URL = "https://github.com/almahmoud/galaxy/tree/planet";
export const CLUSTER_GUIDE_URL = "https://github.com/almahmoud/galaxy/blob/planet/planet/docs/cluster-setup.md";
export const STORAGE_GUIDE_URL = "https://github.com/almahmoud/galaxy/blob/planet/planet/docs/storage-setup.md";

export const DEFAULT_GATEWAY_URL = CLUSTER.gatewayUrl;

export interface CommandContext {
    namespace?: string;
    /** Origin to list in the gateway's allowed-origins.map. */
    origin?: string;
    /** Overlay directory under planet/deploy/overlays. */
    overlay?: string;
}

/** Steps to deploy Planet's manifests to an existing cluster and connect to its gateway. */
export function clusterCommands(context: CommandContext = {}): SetupCommand[] {
    const namespace = context.namespace || CLUSTER.namespace;
    const overlay = context.overlay || "mylab";
    const commands: SetupCommand[] = [];
    if (context.origin) {
        commands.push({
            id: "origin",
            title: "Allow this site",
            description: `Copy planet/deploy/overlays/example to overlays/${overlay} and add this line to its allowed-origins.map.`,
            command: `"${context.origin}" 1;`,
        });
    }
    commands.push(
        {
            id: "apply",
            title: "Deploy Planet's manifests",
            description: "Run from a checkout of the Planet repository, with cluster-admin rights.",
            command: `kubectl apply -k planet/deploy/overlays/${overlay}`,
        },
        {
            id: "rollout",
            title: "Wait for the gateway",
            description: "Waits until the gateway pod is ready.",
            command: `kubectl -n ${namespace} rollout status deployment/planet-gateway`,
        },
        {
            id: "port-forward",
            title: "Open the gateway on this computer",
            description: `Keep it running while you use Planet. The gateway URL is then ${DEFAULT_GATEWAY_URL}.`,
            command: `kubectl -n ${namespace} port-forward --address 127.0.0.1 service/planet-gateway 8001:8080`,
        },
        {
            id: "token",
            title: "Read the token",
            description: "Paste the output into the Token field.",
            command: `kubectl -n ${namespace} get secret planet-client-token -o jsonpath='{.data.token}' | base64 --decode`,
        },
    );
    return commands;
}

/** Steps for a local kind cluster managed by planet/scripts/dev-cluster.sh. */
export function localClusterCommands(): SetupCommand[] {
    return [
        {
            id: "up",
            title: "Create the cluster",
            description:
                "Needs Docker, kubectl, openssl and kind. Allows the origins http://localhost:8787 and http://127.0.0.1:8787.",
            command: "planet/scripts/dev-cluster.sh up",
        },
        {
            id: "port-forward",
            title: "Open the gateway and Garage",
            description: "Gateway on http://127.0.0.1:8001, Garage S3 on http://127.0.0.1:8002.",
            command: "planet/scripts/dev-cluster.sh port-forward",
        },
        {
            id: "token",
            title: "Read the token",
            description: "Paste the output into the Token field.",
            command: "planet/scripts/dev-cluster.sh token",
        },
        {
            id: "storage",
            title: "Read the Garage settings",
            description: "Use them with the Local Garage storage option.",
            command: "planet/scripts/dev-cluster.sh storage",
        },
    ];
}
