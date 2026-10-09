/**
 * Shared setup for the history, contents, user and configuration handler tests: a router with those handlers, an
 * in-memory IndexedDB, stubbed static data files and record builders.
 */

import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

import {
    closeDb,
    collections,
    type DatasetRecord,
    type HdaRecord,
    hdas,
    type HdcaRecord,
    histories,
    type JobRecord,
    jobs,
} from "@/planet/db";
import type { NewHda } from "@/planet/db/hdas";
import type { NewJob } from "@/planet/db/jobs";
import type { NewDataset } from "@/planet/db/records";
import { Router } from "@/planet/sw/router";
import { type PlanetEvent, subscribe } from "@/planet/util/events";

import { register as registerConfiguration, resetStaticData } from "../configuration";
import { register as registerContents } from "../contents";
import { register as registerContext } from "../context";
import { register as registerHistories } from "../histories";
import { register as registerLegacyHistory } from "../legacyHistory";
import { register as registerUsers } from "../users";

export const ORIGIN = "https://planet.test";

/** A trimmed `/api/datatypes/mapping` payload covering the extensions the tests use. */
export const MAPPING = {
    ext_to_class_name: {
        data: "galaxy.datatypes.data.Data",
        txt: "galaxy.datatypes.data.Text",
        tabular: "galaxy.datatypes.tabular.Tabular",
        csv: "galaxy.datatypes.tabular.CSV",
        interval: "galaxy.datatypes.interval.Interval",
        bed: "galaxy.datatypes.interval.Bed",
        vcf: "galaxy.datatypes.tabular.Vcf",
        bam: "galaxy.datatypes.binary.Bam",
        fasta: "galaxy.datatypes.sequence.Fasta",
    },
    class_to_classes: {
        "galaxy.datatypes.data.Data": { "galaxy.datatypes.data.Data": true },
        "galaxy.datatypes.data.Text": { "galaxy.datatypes.data.Text": true, "galaxy.datatypes.data.Data": true },
        "galaxy.datatypes.tabular.Tabular": {
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.tabular.TabularData": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.tabular.CSV": {
            "galaxy.datatypes.tabular.CSV": true,
            "galaxy.datatypes.tabular.BaseCSV": true,
            "galaxy.datatypes.tabular.TabularData": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.interval.Interval": {
            "galaxy.datatypes.interval.Interval": true,
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.tabular.TabularData": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.interval.Bed": {
            "galaxy.datatypes.interval.Bed": true,
            "galaxy.datatypes.interval.Interval": true,
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.tabular.TabularData": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.tabular.Vcf": {
            "galaxy.datatypes.tabular.Vcf": true,
            "galaxy.datatypes.tabular.BaseVcf": true,
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.tabular.TabularData": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.binary.Bam": {
            "galaxy.datatypes.binary.Bam": true,
            "galaxy.datatypes.binary.BamNative": true,
            "galaxy.datatypes.binary.CompressedArchive": true,
            "galaxy.datatypes.binary.Binary": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.sequence.Fasta": {
            "galaxy.datatypes.sequence.Fasta": true,
            "galaxy.datatypes.sequence.Sequence": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
    },
};

/** A trimmed generated configuration; the handlers add Planet's overrides. */
export const CONFIG = {
    brand: "Galaxy",
    welcome_url: "/static/other.html",
    logo_src: "/static/other.svg",
    single_user: true,
    enable_celery_tasks: true,
    chunk_upload_size: 10485760,
    themes: { blue: {} },
    version_major: "26.1",
    allow_user_dataset_purge: false,
    wiki_url: "https://galaxyproject.org/",
};

export const GENOMES = [
    ["unspecified (?)", "?"],
    ["Human Dec. 2013 (GRCh38/hg38) (hg38)", "hg38"],
    ["Mouse Dec. 2011 (GRCm38/mm10) (mm10)", "mm10"],
];

const STATIC_FILES: Record<string, unknown> = {
    "/static/planet/data/config.json": CONFIG,
    "/static/planet/data/datatypes/mapping.json": MAPPING,
    "/static/planet/data/genomes.json": GENOMES,
};

/** Replaces `fetch` with one serving the static data files above. Returns the mock to inspect calls. */
export function stubStaticData(files: Record<string, unknown> = STATIC_FILES) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
        if (Object.hasOwn(files, url.pathname)) {
            return new Response(JSON.stringify(files[url.pathname]), {
                headers: { "Content-Type": "application/json" },
            });
        }
        return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

/** Starts every test from an empty database, fresh static data and the stubbed fetch. */
export async function resetPlanet(): Promise<void> {
    await closeDb();
    globalThis.indexedDB = new IDBFactory();
    resetStaticData();
    stubStaticData();
}

/** Cleans up after a test. */
export async function teardownPlanet(): Promise<void> {
    await closeDb();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
}

/** A router with the handlers under test registered in `registerAll` order. */
export function makeRouter(): Router {
    const router = new Router();
    registerContext(router);
    registerConfiguration(router);
    registerUsers(router);
    registerHistories(router);
    registerLegacyHistory(router);
    registerContents(router);
    return router;
}

export function request(path: string, init: RequestInit = {}): Request {
    return new Request(`${ORIGIN}${path}`, init);
}

/** Sends a JSON request and returns the response. */
export function send(router: Router, method: string, path: string, body?: unknown, headers: HeadersInit = {}) {
    const init: RequestInit = {
        method,
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
    }
    return router.handle(request(path, init));
}

/** Sends a request and parses the JSON body, failing on an unexpected status. */
// The bodies are checked field by field in the tests, so they are returned untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchJson<T = any>(
    router: Router,
    method: string,
    path: string,
    body?: unknown,
    expectedStatus = 200,
    headers: HeadersInit = {},
): Promise<T> {
    const response = await send(router, method, path, body, headers);
    const text = await response.text();
    if (response.status !== expectedStatus) {
        throw new Error(`${method} ${path}: expected ${expectedStatus}, got ${response.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
}

/** Records the events published while a test runs. */
export function captureEvents(): { events: PlanetEvent[]; stop: () => void } {
    const events: PlanetEvent[] = [];
    const stop = subscribe((event) => events.push(event));
    return { events, stop };
}

/** Waits for queued event deliveries. */
export function flushEvents(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function currentHistoryId(): Promise<string> {
    return (await histories.getOrCreateCurrent()).id;
}

export interface DatasetFixture {
    hda: HdaRecord;
    dataset: DatasetRecord;
}

/** Adds a dataset to a history; `hid` is allocated unless given. */
export async function addDataset(
    historyId: string,
    hda: Partial<Omit<NewHda, "history_id" | "dataset_id">> = {},
    dataset: NewDataset = {},
): Promise<DatasetFixture> {
    return hdas.createWithDataset(
        { name: "dataset", extension: "txt", ...hda, history_id: historyId },
        { state: "ok", file_size: 100, total_size: 100, ...dataset },
    );
}

/** Adds a list collection of existing HDAs to a history. */
export async function addList(
    historyId: string,
    hdaIds: string[],
    hdca: Partial<Omit<HdcaRecord, "history_id" | "collection_id">> = {},
): Promise<HdcaRecord> {
    const created = await collections.createHdca({
        hdca: { name: "list", ...hdca, history_id: historyId },
        collection: {
            collection_type: "list",
            elements: hdaIds.map((id, index) => ({ identifier: `element${index}`, hda_id: id })),
        },
    });
    return created.hdca;
}

/** Adds a job to a history. */
export function addJob(historyId: string, fields: Partial<NewJob> = {}): Promise<JobRecord> {
    return jobs.create({ tool_id: "cat1", tool_version: "1.0.0", ...fields, history_id: historyId });
}

/**
 * Compile-time check: `assertAssignable<Model>()<View>()` fails type checking unless `View` is assignable to
 * `Model`, so a serializer view that drifts from Galaxy's API schema breaks the build.
 */
export function assertAssignable<Model>() {
    return <View extends Model>(): View | undefined => undefined;
}

/** Sorted keys of an object. */
export function keysOf(value: object): string[] {
    return Object.keys(value).sort();
}
