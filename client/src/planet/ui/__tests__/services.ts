/** A replaceable set of setup page services for component tests. */

import { vi } from "vitest";

import type { SettingsUpdate } from "@/planet/db/settings";
import type { PlanetSettings } from "@/planet/db/types";

import type { CheckReport } from "../lib/checks";
import { SERVICES, type SetupServices } from "../lib/services";
import { fakeKube, fakeS3, settingsFixture } from "./fakes";

/** Services backed by an in-memory settings object; `saveSettings` merges changes like the API does. */
export function testServices(initial: PlanetSettings = settingsFixture(), overrides: Partial<SetupServices> = {}) {
    let current = initial;
    const kube = fakeKube();
    const s3 = fakeS3();
    const services = {
        getSettings: vi.fn(async () => current),
        getStatus: vi.fn(async () => ({
            configured: {
                cluster: Boolean(current.cluster.gateway_url && current.cluster.has_token),
                storage: Boolean(current.storage.endpoint && current.storage.has_secret),
            },
            build_id: "test-build",
            instance_id: current.instance_id,
            leader: false,
        })),
        saveSettings: vi.fn(async (change: SettingsUpdate) => {
            const { token, ...cluster } = change.cluster ?? {};
            const { secret_access_key: secret, ...storage } = change.storage ?? {};
            current = {
                ...current,
                cluster: {
                    ...current.cluster,
                    ...cluster,
                    has_token: token === undefined ? current.cluster.has_token : Boolean(token),
                },
                storage: {
                    ...current.storage,
                    ...storage,
                    has_secret: secret === undefined ? current.storage.has_secret : Boolean(secret),
                },
            };
            return current;
        }),
        runChecks: vi.fn(async (): Promise<CheckReport> => ({})),
        localNetworkAccess: vi.fn(async () => "granted" as const),
        probe: vi.fn(async () => "reachable" as const),
        onSettingsChanged: vi.fn(() => () => undefined),
        origin: "https://planet.example.org",
        kubeClient: kube.factory,
        s3Client: s3.factory,
        ...overrides,
    };
    return { services, kube, s3, provide: { [SERVICES as symbol]: services } };
}
