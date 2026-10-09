/**
 * Local Network Access helpers for the setup page. Chrome and Firefox ask the user before an https://
 * page connects to this computer or the local network, and only a document can trigger that prompt:
 * the Service Worker's requests fail until the permission is granted.
 */

import type { LocalAccess, Reachability } from "./checks";

export type AddressSpace = "loopback" | "local" | "public";

/** Permission names to query, newest first; Chrome split `local-network-access` into two around version 145. */
const PERMISSION_NAMES: Record<Exclude<AddressSpace, "public">, string[]> = {
    loopback: ["loopback-network", "local-network-access"],
    local: ["local-network", "local-network-access"],
};

const PROBE_TIMEOUT_MS = 8000;

function isPrivateIpv4(host: string): boolean {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }
    const [a, b] = parts as [number, number, number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The address space a URL's host belongs to, as far as the host name tells. */
export function addressSpace(url: string): AddressSpace {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return "public";
    }
    if (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]") {
        return "loopback";
    }
    if (host.endsWith(".local") || isPrivateIpv4(host) || /^\[(f[cd]|fe[89ab])/.test(host)) {
        return "local";
    }
    return "public";
}

/** The browser's local network permission for `url`, or "granted" when the URL is public. */
export async function localNetworkAccess(
    url: string,
    permissions: Pick<Permissions, "query"> | undefined = globalThis.navigator?.permissions,
): Promise<LocalAccess> {
    const space = addressSpace(url);
    if (space === "public") {
        return "granted";
    }
    if (!permissions) {
        return "unknown";
    }
    for (const name of PERMISSION_NAMES[space]) {
        try {
            const status = await permissions.query({ name } as unknown as PermissionDescriptor);
            return status.state;
        } catch {
            // Browsers reject permission names they do not know.
        }
    }
    return "unknown";
}

/**
 * Requests `url` without CORS. The response is opaque, so this only tells whether the server answered:
 * a server that answers this but fails a CORS request does not allow this site's origin.
 */
export async function probe(
    url: string,
    fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Reachability> {
    try {
        await fetchFn(url, {
            mode: "no-cors",
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return "reachable";
    } catch {
        return "unreachable";
    }
}
