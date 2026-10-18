/**
 * Bucket objects of tool installations. Each attempt of a `tool_install` job owns `tools/installs/<job>-a<attempt>/`,
 * with one numbered slot per installed tool: `<n>/bundle.json` and `<n>/repo.tar`.
 */

import { isId } from "@/planet/util/ids";

/** Tools one installation can install: the size of `install.slots` (about 1 KiB of manifest each). */
export const INSTALL_SLOT_COUNT = 128;

const ARCHIVE_KEY = /^tools\/installs\/[0-9a-f]{16}-a[1-9][0-9]*\/(?:0|[1-9][0-9]*)\/repo\.tar$/;

export interface InstallSlotKeys {
    bundle: string;
    repoTar: string;
}

/** The objects of slot `slot` of an attempt of a tool installation. */
export function installSlotKeys(jobId: string, attempt: number, slot: number): InstallSlotKeys {
    if (!isId(jobId) || !Number.isSafeInteger(attempt) || attempt < 1) {
        throw new RangeError(`Invalid tool installation ${JSON.stringify(jobId)} attempt ${attempt}`);
    }
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= INSTALL_SLOT_COUNT) {
        throw new RangeError(`Invalid tool installation slot ${slot}`);
    }
    const base = `tools/installs/${jobId}-a${attempt}/${slot}/`;
    return { bundle: `${base}bundle.json`, repoTar: `${base}repo.tar` };
}

/** True for the archive key of an installed tool (`source.repo_tar.path` of its bundle). */
export function isInstalledArchiveKey(key: unknown): key is string {
    return typeof key === "string" && ARCHIVE_KEY.test(key);
}
