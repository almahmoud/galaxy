/**
 * Ingest of tool installations (`tool_install` jobs). `jobs/ingest.ts` calls {@link ingestToolInstall} with the job's
 * checked `results.json` before it applies the results. Each tool the install pod reports installed is checked
 * against the objects of its slot: the bundle's SHA-256 and size, its id under the source's id prefix, and its
 * archive key, digest and size. Tools that pass are stored in the `tools` store (`source: "installed"`), and every
 * tool's outcome in the job's `params.tools`, in one transaction fenced like other job writes.
 */

import { type JobRecord, jobs, type ToolRecord, tools, writeTx } from "@/planet/db";
import type { JobDeps } from "@/planet/jobs/deps";
import { ProtocolError, type ResultJobMessage, type ResultsDocument, type ToolBundle } from "@/planet/jobs/schemas";
import { isNotFound } from "@/planet/s3";
import { isBundleName, isToolBundle } from "@/planet/tools/bundle";
import { sha256Hex } from "@/planet/util/digest";

import { INSTALL_SLOT_COUNT, installSlotKeys } from "./keys";
import { INSTALLED_PANEL_SECTION, type InstallSource, parseInstallSource, toolIdPrefix } from "./source";
import type { InstallParams, InstallToolOutcome } from "./views";

/** Largest bundle read back from a slot; the install pod refuses larger ones too. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
/** Tool files of one repository whose outcome is kept. */
export const MAX_REPORTED_TOOLS = 1000;
const MAX_TOOL_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_FIELD_LENGTH = 255;
/** Job states in which results change nothing (`SETTLED_STATES` of `jobs/ingest.ts`). */
const SETTLED_STATES: ReadonlySet<string> = new Set(["ok", "error", "deleted", "deleting"]);
const WARNING = 2;
const FATAL = 3;

interface Digest {
    sha256: string;
    size: number;
}

/** A tool entry of `results.json` (`#/properties/tools/items` of results.schema.json). */
interface ResultTool {
    path: string;
    id: string | null;
    old_id: string | null;
    version: string | null;
    name: string | null;
    description: string | null;
    state: "installed" | "rejected" | "failed";
    slot: number | null;
    bundle: Digest | null;
    repo_tar: Digest | null;
    errors: string[];
    warnings: string[];
}

/** The pod's tool files do not match what it reported. */
class VerificationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, detail: string): never {
    throw new ProtocolError("results.json", path, detail);
}

function nullableString(value: unknown, path: string): string | null {
    if (value !== null && typeof value !== "string") {
        fail(path, "expected a string or null");
    }
    return value;
}

function stringList(value: unknown, path: string): string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        fail(path, "expected a list of strings");
    }
    return value;
}

function digest(value: unknown, path: string): Digest | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value) ||
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.sha256) ||
        !Number.isSafeInteger(value.size) ||
        (value.size as number) < 0
    ) {
        fail(path, "expected {sha256, size}");
    }
    return { sha256: value.sha256, size: value.size as number };
}

/**
 * The `tools` of a `tool_install` results document, checked against results.schema.json.
 *
 * @throws ProtocolError naming the first entry that does not match
 */
export function resultTools(results: ResultsDocument): ResultTool[] {
    const value = (results as unknown as Record<string, unknown>).tools ?? [];
    if (!Array.isArray(value)) {
        fail("/tools", "expected a list");
    }
    if (value.length > MAX_REPORTED_TOOLS) {
        fail("/tools", `more than ${MAX_REPORTED_TOOLS} tool files`);
    }
    return value.map((item: unknown, index): ResultTool => {
        const at = `/tools/${index}`;
        if (!isRecord(item) || typeof item.path !== "string") {
            fail(at, "expected a tool entry with a path");
        }
        const state = item.state;
        if (state !== "installed" && state !== "rejected" && state !== "failed") {
            fail(`${at}/state`, "expected installed, rejected or failed");
        }
        const slot = item.slot ?? null;
        if (slot !== null && (!Number.isSafeInteger(slot) || (slot as number) < 0)) {
            fail(`${at}/slot`, "expected a slot number or null");
        }
        return {
            path: item.path,
            id: nullableString(item.id ?? null, `${at}/id`),
            old_id: nullableString(item.old_id ?? null, `${at}/old_id`),
            version: nullableString(item.version ?? null, `${at}/version`),
            name: nullableString(item.name ?? null, `${at}/name`),
            description: nullableString(item.description ?? null, `${at}/description`),
            state,
            slot: slot as number | null,
            bundle: digest(item.bundle ?? null, `${at}/bundle`),
            repo_tar: digest(item.repo_tar ?? null, `${at}/repo_tar`),
            errors: stringList(item.errors ?? [], `${at}/errors`),
            warnings: stringList(item.warnings ?? [], `${at}/warnings`),
        };
    });
}

/** The full revision the pod read (`install.revision`), or null. */
function resultRevision(results: ResultsDocument): string | null {
    const install = (results as unknown as Record<string, unknown>).install;
    const revision = isRecord(install) ? install.revision : null;
    return typeof revision === "string" && /^[0-9a-f]{12,64}$/.test(revision) ? revision : null;
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new VerificationError(`its bundle is larger than ${limit} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    while (reader) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => undefined);
            throw new VerificationError(`its bundle is larger than ${limit} bytes`);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function readObject(deps: JobDeps, key: string): Promise<Uint8Array> {
    try {
        return await readBytes(await deps.s3.getObject(key, { signal: deps.signal }), MAX_BUNDLE_BYTES);
    } catch (error) {
        if (isNotFound(error)) {
            throw new VerificationError(`${key} is missing from the bucket`);
        }
        throw error;
    }
}

async function objectSize(deps: JobDeps, key: string): Promise<number | null> {
    try {
        return (await deps.s3.headObject(key, { signal: deps.signal })).contentLength;
    } catch (error) {
        if (isNotFound(error)) {
            throw new VerificationError(`${key} is missing from the bucket`);
        }
        throw error;
    }
}

/**
 * Reads and checks the bundle of one tool the pod reports installed.
 *
 * @throws VerificationError when its objects do not match the report or the source
 */
async function verifiedBundle(
    entry: ResultTool,
    context: { job: JobRecord; attempt: number; prefix: string; slots: Set<number>; deps: JobDeps },
): Promise<ToolBundle> {
    const { id, old_id: oldId, version, slot } = entry;
    if (slot === null || slot >= INSTALL_SLOT_COUNT || context.slots.has(slot)) {
        throw new VerificationError("it has no slot of its own");
    }
    context.slots.add(slot);
    if (!id || !oldId || !version || oldId.includes("/") || id !== `${context.prefix}${oldId}/${version}`) {
        throw new VerificationError(`its id is not ${context.prefix}<tool id>/<version>`);
    }
    if (!isBundleName(id, version)) {
        throw new VerificationError("its id or version has characters tool ids cannot have");
    }
    if (!entry.bundle || !entry.repo_tar) {
        throw new VerificationError("the digests of its files are missing");
    }
    const keys = installSlotKeys(context.job.id, context.attempt, slot);
    const bytes = await readObject(context.deps, keys.bundle);
    if (bytes.byteLength !== entry.bundle.size || (await sha256Hex(bytes)) !== entry.bundle.sha256) {
        throw new VerificationError("its bundle does not match its digest");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new VerificationError("its bundle is not JSON");
    }
    if (!isToolBundle(parsed) || parsed.id !== id || parsed.version !== version) {
        throw new VerificationError("its bundle is not the bundle of this tool");
    }
    const bundle = parsed as unknown as ToolBundle;
    const archive = bundle.source?.repo_tar;
    if (
        !archive ||
        archive.path !== keys.repoTar ||
        archive.sha256 !== entry.repo_tar.sha256 ||
        archive.size !== entry.repo_tar.size
    ) {
        throw new VerificationError("its bundle does not name its archive");
    }
    if ((bundle.tool_type ?? "default") !== "default" || (Array.isArray(bundle.code) && bundle.code.length)) {
        throw new VerificationError("Planet cannot run tools of its kind");
    }
    const panelEntry = bundle.panel_entry;
    if (!isRecord(panelEntry) || panelEntry.id !== id || panelEntry.version !== version) {
        throw new VerificationError("its bundle has no tool panel entry");
    }
    if ((await objectSize(context.deps, keys.repoTar)) !== entry.repo_tar.size) {
        throw new VerificationError("its archive does not match its size");
    }
    return {
        ...bundle,
        panel_entry: {
            ...panelEntry,
            panel_section_id: INSTALLED_PANEL_SECTION.id,
            panel_section_name: INSTALLED_PANEL_SECTION.name,
        },
    };
}

function short(text: string, limit: number): string {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function outcomeOf(entry: ResultTool): InstallToolOutcome {
    const messages = (items: string[]) =>
        items.slice(0, MAX_TOOL_MESSAGES).map((item) => short(item, MAX_MESSAGE_LENGTH));
    return {
        path: short(entry.path, MAX_MESSAGE_LENGTH),
        id: entry.id && short(entry.id, MAX_MESSAGE_LENGTH),
        version: entry.version && short(entry.version, MAX_FIELD_LENGTH),
        name: entry.name && short(entry.name, MAX_FIELD_LENGTH),
        state: entry.state,
        errors: messages(entry.errors),
        warnings: messages(entry.warnings),
    };
}

function message(desc: string, level: number): ResultJobMessage {
    return { type: "internal", desc, code_desc: null, error_level: level } as ResultJobMessage;
}

function installedRecord(bundle: ToolBundle, warnings: string[]): Omit<ToolRecord, "create_time" | "update_time"> {
    return {
        tool_id: bundle.id,
        tool_version: bundle.version,
        source: "installed",
        status: "ready",
        message: warnings.length ? short(warnings.join(" "), MAX_MESSAGE_LENGTH) : null,
        bundle,
        bundle_url: null,
        panel_section_id: INSTALLED_PANEL_SECTION.id,
        panel_section_name: INSTALLED_PANEL_SECTION.name,
        hidden: false,
    };
}

/**
 * Stores the tools a tool installation installed and their outcome, then returns the results to apply to the job:
 * unchanged, or with a message for each tool Planet refused and state `error` when no tool was stored.
 *
 * @throws ProtocolError when the results do not follow the protocol
 */
export async function ingestToolInstall(
    job: JobRecord,
    results: ResultsDocument,
    deps: JobDeps,
): Promise<ResultsDocument> {
    let source: InstallSource;
    try {
        source = parseInstallSource((job.params as Partial<InstallParams>).source);
    } catch (error) {
        throw new ProtocolError("results.json", "", `the job names no install source: ${String(error)}`);
    }
    const entries = resultTools(results);
    const context = { job, attempt: results.attempt, prefix: toolIdPrefix(source), slots: new Set<number>(), deps };
    const verified = new Map<ResultTool, ToolBundle>();
    const refused: ResultJobMessage[] = [];
    for (const entry of entries) {
        if (entry.state !== "installed") {
            continue;
        }
        try {
            verified.set(entry, await verifiedBundle(entry, context));
        } catch (error) {
            if (!(error instanceof VerificationError)) {
                throw error;
            }
            const reason = `Planet could not verify its files: ${error.message}.`;
            entry.state = "failed";
            entry.errors = [...entry.errors, reason];
            refused.push(message(`${entry.path}: ${reason}`, WARNING));
        }
    }

    const stored = await writeTx(["tools", "jobs"], async (tx): Promise<number | null> => {
        const current = await jobs.get(job.id, tx);
        if (!current || SETTLED_STATES.has(current.state)) {
            return null;
        }
        let count = 0;
        for (const [entry, bundle] of verified) {
            const existing = await tools.get(bundle.id, bundle.version, tx);
            if (existing && existing.source !== "installed") {
                entry.state = "failed";
                entry.errors = [...entry.errors, "A built-in tool has the same id and version."];
                continue;
            }
            await tools.put(installedRecord(bundle, entry.warnings), tx);
            count++;
        }
        const params: InstallParams = {
            ...(current.params as unknown as InstallParams),
            source,
            revision: resultRevision(results),
            tools: entries.map(outcomeOf),
        };
        await jobs.update(job.id, { params: params as unknown as Record<string, unknown> }, tx);
        return count;
    });

    // A settled job keeps its state; applying the results changes nothing either.
    if (stored === null || (!refused.length && (stored || results.state === "error"))) {
        return results;
    }
    const messages = [...results.job_messages, ...refused];
    if (!stored && results.state === "ok") {
        messages.push(message("No tool of the repository could be installed.", FATAL));
        return { ...results, state: "error", job_messages: messages };
    }
    return { ...results, job_messages: messages };
}
