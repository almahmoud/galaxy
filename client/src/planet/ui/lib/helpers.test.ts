// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { R2_ACCOUNT } from "../__tests__/fakes";
import { clusterCommands, localClusterCommands } from "./commands";
import { addressSpace, localNetworkAccess, probe } from "./network";
import { awsEndpoint, detectProvider, parseAwsEndpoint, parseR2Endpoint, r2Endpoint } from "./presets";

describe("presets", () => {
    it("builds and parses R2 endpoints", () => {
        expect(r2Endpoint(R2_ACCOUNT)).toBe(`https://${R2_ACCOUNT}.r2.cloudflarestorage.com`);
        expect(parseR2Endpoint(r2Endpoint(R2_ACCOUNT, "fedramp"))).toEqual({
            accountId: R2_ACCOUNT,
            jurisdiction: "fedramp",
        });
        expect(parseR2Endpoint("https://bucket.example.org")).toBeNull();
    });

    it("builds and parses AWS endpoints", () => {
        expect(awsEndpoint("eu-central-1")).toBe("https://s3.eu-central-1.amazonaws.com");
        expect(parseAwsEndpoint("https://s3.eu-central-1.amazonaws.com")).toBe("eu-central-1");
        expect(parseAwsEndpoint("https://s3.amazonaws.com")).toBe("us-east-1");
        expect(detectProvider("http://localhost:8002")).toBe("garage");
    });
});

describe("commands", () => {
    it("uses the namespace and origin", () => {
        const commands = clusterCommands({ namespace: "jobs", origin: "https://planet.example.org" });
        expect(commands.map((command) => command.id)).toEqual(["origin", "apply", "port-forward", "token"]);
        expect(commands[0]?.command).toBe('"https://planet.example.org" 1;');
        expect(commands[2]?.command).toBe(
            "kubectl -n jobs port-forward --address 127.0.0.1 service/planet-gateway 8001:8080",
        );
        expect(commands[3]?.command).toContain("kubectl -n jobs get secret planet-client-token");
    });

    it("defaults to the planet namespace and lists the kind workflow", () => {
        expect(clusterCommands().map((command) => command.id)).toEqual(["apply", "port-forward", "token"]);
        expect(clusterCommands()[1]?.command).toContain("-n planet ");
        expect(
            localClusterCommands().every((command) => command.command.startsWith("planet/scripts/dev-cluster.sh ")),
        ).toBe(true);
    });
});

describe("network", () => {
    it.each([
        ["http://localhost:8001", "loopback"],
        ["http://127.0.0.1:8001", "loopback"],
        ["http://[::1]:8001", "loopback"],
        ["http://planet.localhost", "loopback"],
        ["http://192.168.1.4:8001", "local"],
        ["http://10.0.0.2", "local"],
        ["http://172.20.0.1", "local"],
        ["http://nas.local:9000", "local"],
        ["http://[fd00::1]:9000", "local"],
        ["https://k8s.example.org", "public"],
        ["http://172.32.0.1", "public"],
        ["not a url", "public"],
    ])("classifies %s as %s", (url: string, space: string) => {
        expect(addressSpace(url)).toBe(space);
    });

    it("queries the newest permission name first and falls back", async () => {
        const query = vi.fn(async ({ name }: { name: string }) => {
            if (name === "loopback-network") {
                throw new TypeError("unknown permission");
            }
            return { state: "prompt" } as PermissionStatus;
        });
        expect(await localNetworkAccess("http://127.0.0.1:8001", { query } as unknown as Permissions)).toBe("prompt");
        expect(query.mock.calls.map(([descriptor]: [{ name: string }]) => descriptor.name)).toEqual([
            "loopback-network",
            "local-network-access",
        ]);
    });

    it("treats public URLs as allowed and unknown permissions as unknown", async () => {
        const query = vi.fn(async () => {
            throw new TypeError("unknown permission");
        });
        const permissions = { query } as unknown as Permissions;
        expect(await localNetworkAccess("https://k8s.example.org", permissions)).toBe("granted");
        expect(await localNetworkAccess("http://192.168.1.4", permissions)).toBe("unknown");
        expect(await localNetworkAccess("http://192.168.1.4", undefined)).toBe("unknown");
    });

    it("probes without CORS or credentials", async () => {
        const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
        expect(await probe("http://127.0.0.1:8001/version", fetchFn)).toBe("reachable");
        expect(fetchFn).toHaveBeenCalledWith(
            "http://127.0.0.1:8001/version",
            expect.objectContaining({ mode: "no-cors", credentials: "omit", cache: "no-store" }),
        );
        const failing = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
        expect(await probe("http://127.0.0.1:8001/version", failing)).toBe("unreachable");
    });
});
