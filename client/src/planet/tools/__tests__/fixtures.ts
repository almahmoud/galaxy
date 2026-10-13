/**
 * Shared setup for the tool engine tests: the build's generated data served from disk, a router with the tool and
 * job handlers, a history with datasets and collections of common types, and a client-side form data builder that
 * mirrors Galaxy's `FormDisplay`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { vi } from "vitest";

import { matchCase, visitInputs } from "@/components/Form/utilities";
import { collections, type HdaRecord, hdas, type HdcaRecord, histories } from "@/planet/db";
import { Router } from "@/planet/sw/router";
import { findStaticFile } from "@/planet/util/staticFiles.fixtures";

import { register as registerJobs } from "../../api/jobs";
import { register as registerTools } from "../../api/tools";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The data `planet/scripts/generate-data.sh` writes; tests that need real bundles are skipped without it. */
export const GENERATED_DATA = resolve(HERE, "../../../../../planet/build/generated/static/planet/data");

export function hasGeneratedData(): boolean {
    return existsSync(join(GENERATED_DATA, "toolbox", "bundles"));
}

/** Every bundle file below the generated toolbox, as paths relative to the data root. */
export function generatedBundlePaths(): string[] {
    const root = join(GENERATED_DATA, "toolbox", "bundles");
    const out: string[] = [];
    const walk = (directory: string) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
            } else if (name.endsWith(".json")) {
                out.push(path.slice(GENERATED_DATA.length + 1));
            }
        }
    };
    walk(root);
    return out.sort();
}

export function readGenerated<T = unknown>(relative: string): T {
    return JSON.parse(readFileSync(join(GENERATED_DATA, relative), "utf8")) as T;
}

/**
 * Serves `/static/planet/data/...` from `files` (JSON by path) and then from the generated data on disk.
 */
export function stubData(files: Record<string, unknown> = {}, useGenerated = true) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            "https://planet.test",
        );
        const body = findStaticFile(files, url.pathname);
        if (body !== undefined) {
            return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        }
        const prefix = "/static/planet/data/";
        if (useGenerated && url.pathname.startsWith(prefix)) {
            const relative = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
            const path = join(GENERATED_DATA, relative);
            if (path.startsWith(GENERATED_DATA) && existsSync(path) && statSync(path).isFile()) {
                return new Response(readFileSync(path), { headers: { "Content-Type": "application/json" } });
            }
        }
        return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

export function makeToolRouter(): Router {
    const router = new Router();
    registerTools(router);
    registerJobs(router);
    return router;
}

export interface HistoryFixture {
    historyId: string;
    table: HdaRecord;
    reads1: HdaRecord;
    reads2: HdaRecord;
    bam: HdaRecord;
    fasta: HdaRecord;
    text: HdaRecord;
    readsList: HdcaRecord;
    readsPair: HdcaRecord;
    tables: HdcaRecord;
}

async function addDataset(
    historyId: string,
    name: string,
    extension: string,
    fields: Partial<HdaRecord> = {},
    size = 100,
): Promise<HdaRecord> {
    const { hda } = await hdas.createWithDataset(
        { history_id: historyId, name, extension, ...fields },
        { state: "ok", file_size: size, total_size: size },
    );
    return hda;
}

/** A history with a table, reads, an alignment, a reference, text and three collections. */
export async function seedHistory(): Promise<HistoryFixture> {
    const history = await histories.getOrCreateCurrent();
    const historyId = history.id;
    const table = await addDataset(historyId, "table.tsv", "tabular", {
        dbkey: "hg38",
        metadata: { columns: 3, column_types: ["str", "int", "float"], column_names: ["name", "count", "score"] },
        tags: ["name:sample"],
    });
    const reads1 = await addDataset(historyId, "reads_1.fq", "fastqsanger");
    const reads2 = await addDataset(historyId, "reads_2.fq", "fastqsanger");
    const bam = await addDataset(historyId, "aligned.bam", "bam", {
        metadata: { read_groups: ["rg1", "rg2"], dbkey: "hg38" },
        dbkey: "hg38",
    });
    const fasta = await addDataset(historyId, "reference.fa", "fasta");
    const text = await addDataset(historyId, "notes.txt", "txt");
    const element1 = await addDataset(historyId, "a.fq", "fastqsanger", { visible: false });
    const element2 = await addDataset(historyId, "b.fq", "fastqsanger", { visible: false });
    const readsList = (
        await collections.createHdca({
            hdca: { history_id: historyId, name: "reads" },
            collection: {
                collection_type: "list",
                elements: [
                    { identifier: "a", hda_id: element1.id },
                    { identifier: "b", hda_id: element2.id },
                ],
            },
        })
    ).hdca;
    const forward = await addDataset(historyId, "forward.fq", "fastqsanger", { visible: false });
    const reverse = await addDataset(historyId, "reverse.fq", "fastqsanger", { visible: false });
    const readsPair = (
        await collections.createHdca({
            hdca: { history_id: historyId, name: "pair" },
            collection: {
                collection_type: "paired",
                elements: [
                    { identifier: "forward", hda_id: forward.id },
                    { identifier: "reverse", hda_id: reverse.id },
                ],
            },
        })
    ).hdca;
    const tableElement = await addDataset(historyId, "t1.tsv", "tabular", {
        visible: false,
        metadata: { columns: 2, column_types: ["str", "int"] },
    });
    const tables = (
        await collections.createHdca({
            hdca: { history_id: historyId, name: "tables" },
            collection: { collection_type: "list", elements: [{ identifier: "t1", hda_id: tableElement.id }] },
        })
    ).hdca;
    return { historyId, table, reads1, reads2, bam, fasta, text, readsList, readsPair, tables };
}

type ModelNode = Record<string, unknown>;

/**
 * The flat form data Galaxy's `FormDisplay` submits for a form model: each active parameter's value, with data
 * parameters defaulting to their first option as `FormData` does.
 */
export function formDataFromModel(inputs: ModelNode[]): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    visitInputs(inputs, (node: ModelNode, name: string) => {
        let value = node.value;
        if ((node.type === "data" || node.type === "data_collection") && !value && !node.optional) {
            const options = node.options as Record<string, { id: string; src: string }[]>;
            const first = node.type === "data" ? options.hda?.[0] : options.hdca?.[0];
            value = first ? { values: [{ id: first.id, src: first.src }], batch: false } : null;
        } else if ((node.type === "data" || node.type === "data_collection") && value) {
            value = { ...(value as object), batch: false };
        }
        data[name] = value ?? null;
    });
    return data;
}

/** Calls `fn` for every node of a form model, including inactive conditional cases and repeat templates. */
export function walkModel(inputs: ModelNode[], fn: (node: ModelNode, path: string) => void, prefix = ""): void {
    for (const node of inputs) {
        const name = `${prefix}${String(node.name)}`;
        fn(node, name);
        if (node.type === "conditional") {
            fn(node.test_param as ModelNode, `${name}|${String((node.test_param as ModelNode).name)}`);
            for (const when of node.cases as { inputs: ModelNode[] }[]) {
                walkModel(when.inputs, fn, `${name}|`);
            }
        } else if (node.type === "section") {
            walkModel(node.inputs as ModelNode[], fn, `${name}|`);
        } else if (node.type === "repeat") {
            walkModel(node.inputs as ModelNode[], fn, `${name}_template|`);
            ((node.cache as ModelNode[][] | undefined) ?? []).forEach((instance, index) =>
                walkModel(instance, fn, `${name}_${index}|`),
            );
        }
    }
}

export { matchCase };
