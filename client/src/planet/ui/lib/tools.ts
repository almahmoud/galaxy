/** What the welcome page's Tools section calls: the Tool Shed search and the tool installation endpoints. */

import {
    faBan,
    faCheckCircle,
    faCircleNotch,
    faClock,
    faExclamationTriangle,
    faTimesCircle,
} from "@fortawesome/free-solid-svg-icons";
import { inject, type InjectionKey } from "vue";

import type { InstallSource } from "@/planet/install/source";
import {
    installableRevisions,
    type RepositoryHit,
    type SearchPage,
    searchRepositories,
    searchTools,
    type ToolHit,
} from "@/planet/install/toolshed";
import type { InstalledToolView, InstallPhase, InstallView } from "@/planet/install/views";
import { subscribeTo } from "@/planet/util/events";

import { call } from "./api";
import type { PillInfo } from "./display";

export interface ToolServices {
    searchRepositories(query: string, page: number, signal?: AbortSignal): Promise<SearchPage<RepositoryHit>>;
    searchTools(query: string, page: number, signal?: AbortSignal): Promise<SearchPage<ToolHit>>;
    /** Installable changesets of a Tool Shed repository, newest first. */
    revisions(owner: string, name: string): Promise<string[]>;
    install(source: InstallSource): Promise<InstallView>;
    listInstalls(): Promise<InstallView[]>;
    cancelInstall(id: string): Promise<void>;
    dismissInstall(id: string): Promise<void>;
    listInstalled(): Promise<InstalledToolView[]>;
    uninstall(id: string, version: string): Promise<void>;
    /** Calls `listener` when installed tools or jobs change in any tab. Returns an unsubscribe function. */
    onChange(listener: () => void): () => void;
}

export const TOOL_SERVICES: InjectionKey<ToolServices> = Symbol("planet-tool-services");

export function browserToolServices(): ToolServices {
    return {
        searchRepositories: (query, page, signal) => searchRepositories(query, page, { signal }),
        searchTools: (query, page, signal) => searchTools(query, page, { signal }),
        revisions: (owner, name) => installableRevisions(owner, name),
        install: (source) => call("POST", "/api/planet/tools/install", { source }),
        listInstalls: () => call("GET", "/api/planet/tools/installs"),
        cancelInstall: async (id) => {
            await call("DELETE", `/api/jobs/${encodeURIComponent(id)}`);
        },
        dismissInstall: async (id) => {
            await call("DELETE", `/api/planet/tools/installs/${encodeURIComponent(id)}`);
        },
        listInstalled: () => call("GET", "/api/planet/tools/installed"),
        uninstall: async (id, version) => {
            await call("DELETE", `/api/planet/tools/${encodeURIComponent(id)}/${encodeURIComponent(version)}`);
        },
        onChange(listener) {
            const stops = [
                subscribeTo("tools-changed", () => listener()),
                subscribeTo("job-changed", () => listener()),
            ];
            return () => stops.forEach((stop) => stop());
        },
    };
}

export function useToolServices(): ToolServices {
    const services = inject(TOOL_SERVICES, null);
    if (!services) {
        throw new Error("The setup page's tool services are not provided.");
    }
    return services;
}

export const INSTALL_PHASES: Record<InstallPhase, PillInfo> = {
    queued: { label: "Waiting", tone: "info", icon: faClock },
    running: { label: "Installing", tone: "info", icon: faCircleNotch, spin: true },
    installed: { label: "Installed", tone: "success", icon: faCheckCircle },
    partial: { label: "Partly installed", tone: "warning", icon: faExclamationTriangle },
    failed: { label: "Failed", tone: "danger", icon: faTimesCircle },
    cancelled: { label: "Cancelled", tone: "neutral", icon: faBan },
};

/** Identifies an installed tool version in the page's state. */
export function installedKey(tool: Pick<InstalledToolView, "id" | "version">): string {
    return `${tool.id}\n${tool.version}`;
}

/** The first 12 characters of a changeset or commit, as the Tool Shed and GitHub show them. */
export function shortRevision(revision: string | null | undefined): string {
    return revision ? revision.slice(0, 12) : "";
}

/** "13 Oct 2026, 14:05" in the browser's time zone, from a Galaxy timestamp (naive UTC). */
export function formatInstallTime(time: string): string {
    const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(time) ? time : `${time}Z`);
    if (Number.isNaN(date.getTime())) {
        return time;
    }
    return date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}
