/**
 * Checks the contents of a snapshot's records before a restore writes them. A snapshot file may come from someone
 * else, and the job manager acts on what records name: the bucket keys it presigns for pods and deletes, the
 * Kubernetes Jobs it deletes and the tools it runs. Records may only name what Planet itself writes:
 *
 * - datasets: the objects under `datasets/<uuid>/` of their own uuid; uploads: `uploads/<id>` of their own id;
 * - jobs: Kubernetes Jobs named `planet-<instance>-…` of the snapshot's instance, multipart uploads of dataset data;
 * - purge entries: dataset ids only (the manager deletes the objects of purged dataset records);
 * - tools: installed tools of the Tool Sheds and GitHub sources Planet installs from, with ids under their source's
 *   prefix and the archive an install pod stored, and never an id of a tool built into this build.
 */

import { isInstalledArchiveKey } from "@/planet/install/keys";
import { INSTALLED_PANEL_SECTION, TOOL_SHEDS } from "@/planet/install/source";
import { isBundleName, isToolBundle } from "@/planet/tools/bundle";

import { BackupError } from "./errors";
import type { StatePayload } from "./payload";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const DATA_KEY_RE = new RegExp(`^datasets/${UUID}/data$`);
const KUBE_NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const OUTBOX_KINDS: ReadonlySet<string> = new Set(["dispatch", "cancel", "cleanup", "purge"]);
const SOURCE_HOSTS = [...TOOL_SHEDS.map((url) => new URL(url).host), "github.com"];

function invalid(message: string): never {
    throw new BackupError("format", `The snapshot's records are invalid: ${message}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(payload: StatePayload, store: string): Record<string, unknown>[] {
    return (payload.stores[store] ?? []) as Record<string, unknown>[];
}

function checkDataset(dataset: Record<string, unknown>): void {
    const { id, uuid } = dataset;
    if (typeof uuid !== "string" || !UUID_RE.test(uuid)) {
        invalid(`dataset ${String(id)} has no valid uuid`);
    }
    const prefix = `datasets/${uuid}/`;
    const extra = dataset.extra_files;
    const files = dataset.metadata_files;
    const keysValid =
        dataset.object_key === `${prefix}data` &&
        dataset.meta_key === `${prefix}meta.json` &&
        (extra === null ||
            (isObject(extra) && extra.key === `${prefix}extra.tar` && extra.index_key === `${prefix}extra.json`)) &&
        isObject(files) &&
        Object.values(files).every(
            (file) =>
                isObject(file) &&
                typeof file.key === "string" &&
                file.key.startsWith(`${prefix}meta/`) &&
                /^[A-Za-z0-9_-]{1,128}$/.test(file.key.slice(prefix.length + 5)),
        );
    if (!keysValid) {
        invalid(`dataset ${String(id)} names bucket objects outside datasets/${uuid}/`);
    }
}

function checkJob(job: Record<string, unknown>, instanceId: string): void {
    const k8s = job.k8s;
    if (k8s === null || k8s === undefined) {
        return;
    }
    const prefix = `planet-${instanceId}-`;
    if (
        !isObject(k8s) ||
        typeof k8s.name !== "string" ||
        !KUBE_NAME_RE.test(k8s.name) ||
        !k8s.name.startsWith(prefix) ||
        !Number.isSafeInteger(k8s.attempt) ||
        (k8s.attempt as number) < 1
    ) {
        invalid(`job ${String(job.id)} names a Kubernetes Job that is not one of instance ${instanceId}`);
    }
    const uploads = k8s.multipart;
    if (
        !Array.isArray(uploads) ||
        !uploads.every(
            (upload) =>
                isObject(upload) &&
                typeof upload.key === "string" &&
                DATA_KEY_RE.test(upload.key) &&
                typeof upload.upload_id === "string",
        )
    ) {
        invalid(`job ${String(job.id)} names multipart uploads outside its datasets`);
    }
}

function checkOutbox(entry: Record<string, unknown>): void {
    if (typeof entry.kind !== "string" || !OUTBOX_KINDS.has(entry.kind)) {
        invalid(`outbox entry ${String(entry.id)} has an unknown kind`);
    }
    if (entry.kind !== "purge") {
        return;
    }
    const payload = entry.payload;
    if (
        !isObject(payload) ||
        Object.keys(payload).some((key) => key !== "dataset_ids") ||
        !Array.isArray(payload.dataset_ids) ||
        !payload.dataset_ids.every((id) => typeof id === "string")
    ) {
        invalid(`purge entry ${String(entry.id)} names more than dataset ids`);
    }
}

/** The beginning of the ids of tools installed from a source, `<host>/repos/<owner>/<name>/`, or null. */
function sourcePrefix(toolId: string): string | null {
    const segments = toolId.split("/");
    if (segments.length < 6 || !SOURCE_HOSTS.includes(segments[0]!) || segments[1] !== "repos") {
        return null;
    }
    return `${segments.slice(0, 4).join("/")}/`;
}

function checkTool(tool: Record<string, unknown>, builtIn: ReadonlySet<string>): void {
    const id = tool.tool_id;
    const version = tool.tool_version;
    const name = `${String(id)} ${String(version)}`;
    if (tool.source !== "installed" || tool.status !== "ready") {
        invalid(`tool ${name} is not an installed tool`);
    }
    const prefix = typeof id === "string" ? sourcePrefix(id) : null;
    // `<prefix><tool id>/<version>`, as install ingest stores them.
    const oldId = prefix && typeof version === "string" ? String(id).slice(prefix.length, -(version.length + 1)) : "";
    if (
        typeof id !== "string" ||
        typeof version !== "string" ||
        !isBundleName(id, version) ||
        prefix === null ||
        !oldId ||
        oldId.includes("/") ||
        id !== `${prefix}${oldId}/${version}`
    ) {
        invalid(`tool ${name} has no id of an installed tool`);
    }
    if (builtIn.has(id)) {
        invalid(`tool ${name} has the id of a tool built into Planet`);
    }
    const bundle = tool.bundle;
    const source = isObject(bundle) && isObject(bundle.source) ? bundle.source : null;
    const archive = source && isObject(source.repo_tar) ? source.repo_tar : null;
    const panel = isObject(bundle) && isObject(bundle.panel_entry) ? bundle.panel_entry : null;
    if (
        !isToolBundle(bundle) ||
        bundle.id !== id ||
        bundle.version !== version ||
        tool.bundle_url !== null ||
        !archive ||
        !isInstalledArchiveKey(archive.path) ||
        (bundle.tool_type ?? "default") !== "default" ||
        (Array.isArray((bundle as unknown as Record<string, unknown>).code) &&
            ((bundle as unknown as Record<string, unknown>).code as unknown[]).length > 0) ||
        tool.panel_section_id !== INSTALLED_PANEL_SECTION.id ||
        (panel !== null && panel.panel_section_id !== INSTALLED_PANEL_SECTION.id)
    ) {
        invalid(`tool ${name} is not a tool an installation stored`);
    }
}

/**
 * Throws BackupError `format` when a record of `payload` names objects, Jobs or tools Planet does not write for it.
 * `builtInToolIds` are the ids of the tools of this build's toolbox.
 */
export function checkRecords(payload: StatePayload, builtInToolIds: ReadonlySet<string>): void {
    for (const dataset of records(payload, "datasets")) {
        checkDataset(dataset);
    }
    for (const upload of records(payload, "uploads")) {
        if (upload.key !== `uploads/${String(upload.id)}`) {
            invalid(`upload ${String(upload.id)} names another bucket object`);
        }
    }
    for (const job of records(payload, "jobs")) {
        checkJob(job, payload.instance_id);
    }
    for (const entry of records(payload, "outbox")) {
        checkOutbox(entry);
    }
    for (const tool of records(payload, "tools")) {
        checkTool(tool, builtInToolIds);
    }
}
