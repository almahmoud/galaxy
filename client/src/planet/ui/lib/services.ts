/** Everything the setup page calls outside itself, provided to its components so tests can replace it. */

import { inject, type InjectionKey } from "vue";

import type { SettingsUpdate } from "@/planet/db/settings";
import type { PlanetSettings } from "@/planet/db/types";
import { subscribeTo } from "@/planet/util/events";

import { getSettings, getStatus, type PlanetStatus, runChecks, saveSettings } from "./api";
import type { ConnectionDeps } from "./connection";
import { localNetworkAccess, probe } from "./network";

export interface SetupServices extends ConnectionDeps {
    getSettings(): Promise<PlanetSettings>;
    saveSettings(change: SettingsUpdate): Promise<PlanetSettings>;
    getStatus(): Promise<PlanetStatus>;
    /** Calls `listener` when any tab or the Service Worker changes the settings. Returns an unsubscribe function. */
    onSettingsChanged(listener: () => void): () => void;
}

export const SERVICES: InjectionKey<SetupServices> = Symbol("planet-setup-services");

export function browserServices(): SetupServices {
    return {
        getSettings,
        saveSettings,
        getStatus,
        runChecks,
        localNetworkAccess: (url) => localNetworkAccess(url),
        probe: (url) => probe(url),
        onSettingsChanged: (listener) => subscribeTo("settings-changed", () => listener()),
        origin: window.location.origin,
    };
}

export function useServices(): SetupServices {
    const services = inject(SERVICES, null);
    if (!services) {
        throw new Error("The setup page's services are not provided.");
    }
    return services;
}
