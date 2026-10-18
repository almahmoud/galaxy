/** In-memory tool services for the Tools section's tests. */

import { vi } from "vitest";

import { type InstallSource, sourceLabel, sourcePageUrl, sourceRevision } from "@/planet/install/source";
import type { RepositoryHit, SearchPage, ToolHit } from "@/planet/install/toolshed";
import type { InstalledToolView, InstallView } from "@/planet/install/views";

import type { ToolServices } from "../lib/tools";

export const DATAMASH_HIT: RepositoryHit = {
    owner: "iuc",
    name: "datamash_ops",
    description: "GNU Datamash performs basic numeric, textual and statistical operations.",
    homepage_url: "https://www.gnu.org/software/datamash/",
    remote_repository_url: "https://github.com/galaxyproject/tools-iuc/tree/main/tools/datamash",
    times_downloaded: 6031,
    categories: "text manipulation",
};

export const DATAMASH_TOOL: InstalledToolView = {
    id: "toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/datamash_ops/1.9+galaxy0",
    version: "1.9+galaxy0",
    name: "Datamash",
    description: "(operations on tabular data)",
    repository: "iuc/datamash_ops",
    revision: "aaafc0ac4dd2",
    page_url: "https://toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops",
    install_time: "2026-10-14T12:00:00.000000",
};

/** An installation of `source` as the endpoints report it. */
export function installViewOf(source: InstallSource, fields: Partial<InstallView> = {}): InstallView {
    return {
        id: "0123456789abcdef",
        state: "new",
        phase: "queued",
        source,
        label: sourceLabel(source),
        requested_revision: sourceRevision(source),
        revision: null,
        page_url: sourcePageUrl(source),
        create_time: "2026-10-14T12:00:00.000000",
        update_time: "2026-10-14T12:00:00.000000",
        message: null,
        tools: [],
        ...fields,
    };
}

export function fakeToolServices(overrides: Partial<ToolServices> = {}) {
    const state = { installs: [] as InstallView[], installed: [] as InstalledToolView[] };
    const listeners = new Set<() => void>();
    const page = <T>(hits: T[]): SearchPage<T> => ({ hits, total: hits.length, page: 1 });
    const services = {
        searchRepositories: vi.fn(async (_query: string, _page: number) => page([DATAMASH_HIT])),
        searchTools: vi.fn(async (_query: string, _page: number) =>
            page<ToolHit>([
                {
                    id: "datamash_ops",
                    name: "Datamash",
                    description: "(operations on tabular data)",
                    owner: "iuc",
                    repository: "datamash_ops",
                },
            ]),
        ),
        revisions: vi.fn(async () => ["aaafc0ac4dd2", "2f3c6f2dcf39"]),
        install: vi.fn(async (source: InstallSource) => {
            const view = installViewOf(source, { id: `${state.installs.length}`.padStart(16, "0") });
            state.installs = [view, ...state.installs];
            return view;
        }),
        listInstalls: vi.fn(async () => state.installs),
        cancelInstall: vi.fn(async (id: string) => {
            state.installs = state.installs.map((view) =>
                view.id === id ? { ...view, state: "deleted", phase: "cancelled" } : view,
            );
        }),
        dismissInstall: vi.fn(async (id: string) => {
            state.installs = state.installs.filter((view) => view.id !== id);
        }),
        listInstalled: vi.fn(async () => state.installed),
        uninstall: vi.fn(async (id: string, version: string) => {
            state.installed = state.installed.filter((tool) => tool.id !== id || tool.version !== version);
        }),
        onChange: vi.fn((listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        ...overrides,
    } satisfies ToolServices;
    return { services, state, notify: () => listeners.forEach((listener) => listener()) };
}
