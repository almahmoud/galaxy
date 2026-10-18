/** A replaceable set of setup page services for component tests. */

import { vi } from "vitest";

import type { SettingsUpdate } from "@/planet/db/settings";
import type { PlanetSettings } from "@/planet/db/types";

import type { LeaderStatus, PlanetStatus } from "../lib/api";
import { BACKUP_SERVICES } from "../lib/backup";
import type { CheckReport } from "../lib/checks";
import { SERVICES, type SetupServices } from "../lib/services";
import { TOOL_SERVICES } from "../lib/tools";
import { fakeBackupServices } from "./backup";
import { fakeKube, fakeS3, settingsFixture } from "./fakes";
import { fakeToolServices } from "./tools";

export const PINNED_RUNTIME = `ghcr.io/almahmoud/planet-runtime@sha256:${"ab".repeat(32)}`;

/** A job runner that has not run in this browser yet. */
export const NO_LEADER: LeaderStatus = {
    active: false,
    epoch: null,
    heartbeat_age_seconds: null,
    state: null,
    blocked_reason: null,
    last_error: null,
};

/** A job runner that sent a heartbeat a few seconds ago. */
export const ACTIVE_LEADER: LeaderStatus = {
    ...NO_LEADER,
    active: true,
    epoch: 3,
    heartbeat_age_seconds: 4,
    state: "active",
};

/** The status the API reports for `settings`; `extra` replaces parts of it. */
export function statusFor(settings: PlanetSettings, extra: Partial<PlanetStatus> = {}): PlanetStatus {
    const setting = settings.cluster.runtime_image.trim();
    return {
        configured: {
            cluster: Boolean(settings.cluster.gateway_url && settings.cluster.has_token),
            storage: Boolean(settings.storage.endpoint && settings.storage.has_secret),
        },
        build_id: "test-build",
        instance_id: settings.instance_id,
        leader: NO_LEADER,
        jobs: { queued: 0, running: 0 },
        runtime: {
            image: setting || PINNED_RUNTIME,
            source: setting ? "settings" : "build",
            default_image: PINNED_RUNTIME,
            build_image: PINNED_RUNTIME,
            pinned: (setting || PINNED_RUNTIME).includes("@sha256:"),
        },
        ...extra,
    };
}

/** Services backed by an in-memory settings object; `saveSettings` merges changes like the API does. */
export function testServices(initial: PlanetSettings = settingsFixture(), overrides: Partial<SetupServices> = {}) {
    let current = initial;
    const kube = fakeKube();
    const s3 = fakeS3();
    const services = {
        getSettings: vi.fn(async () => current),
        getStatus: vi.fn(async () => statusFor(current)),
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
    const backup = fakeBackupServices({
        storageConfigured: Boolean(initial.storage.endpoint && initial.storage.has_secret),
    });
    const tools = fakeToolServices();
    return {
        services,
        kube,
        s3,
        backup,
        tools,
        provide: {
            [SERVICES as symbol]: services,
            [BACKUP_SERVICES as symbol]: backup.services,
            [TOOL_SERVICES as symbol]: tools.services,
        },
    };
}
