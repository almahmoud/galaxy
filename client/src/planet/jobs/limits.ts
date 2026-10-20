/**
 * Size limits of the job protocol that the Service Worker checks at submit and the leader at dispatch and ingest. No
 * imports, so the Service Worker can use it without the leader's modules.
 */

/** Datasets a tool job may discover (`slots`). */
export const DEFAULT_SLOT_COUNT = 32;

/**
 * Datasets one upload may create: `hdas` elements, which are declared outputs, and the collection elements and
 * expanded archives or directories it discovers in slots ({@link uploadSlotCount}). Each adds about 7 KiB of presigned
 * requests to the manifest, which the pod reads up to 64 MiB.
 */
export const MAX_UPLOAD_SLOTS = 5000;

/** Pod documents (`prepare.json`) and dispatch records larger than this are refused. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** Room in `results.json` for each declared output: metadata values up to Galaxy's 5 MiB, peek and texts. */
export const RESULTS_BYTES_PER_OUTPUT = 8 * 1024 * 1024;

/** Room in `results.json` for each slot's discovered dataset. */
export const RESULTS_BYTES_PER_SLOT = 32 * 1024;

/** Largest `results.json` the browser reads, whatever the job's outputs. */
export const MAX_RESULTS_BYTES = 256 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The datasets of a fetch request's targets: `hdas` elements, and those discovered in slots. */
function countUploadDatasets(targets: unknown[]): { declared: number; slots: number } {
    let declared = 0;
    let discovered = 0;
    let dynamic = false;
    const leaves = (value: unknown): number => {
        if (Array.isArray(value)) {
            return value.reduce((sum: number, item) => sum + leaves(item), 0);
        }
        if (!isRecord(value)) {
            return 0;
        }
        if (value.elements_from) {
            dynamic = true;
        }
        return Array.isArray(value.elements) ? leaves(value.elements) : "src" in value ? 1 : 0;
    };
    for (const target of targets) {
        if (!isRecord(target) || !isRecord(target.destination)) {
            continue;
        }
        if (target.destination.type === "hdca") {
            discovered += leaves(target.elements ?? []);
            dynamic ||= Boolean(target.elements_from);
        } else if (target.elements_from) {
            dynamic = true;
        } else if (target.destination.type === "hdas") {
            declared += leaves(target.elements ?? []);
        }
    }
    return { declared, slots: discovered + (dynamic ? DEFAULT_SLOT_COUNT : 0) };
}

/** Datasets an upload discovers: collection elements and expanded archives or directories. */
export function uploadSlotCount(targets: unknown[]): number {
    return countUploadDatasets(targets).slots;
}

/** Why a fetch request's targets create more datasets than one upload job can, or null when they do not. */
export function uploadLimitProblem(targets: unknown): string | null {
    const { declared, slots } = Array.isArray(targets) ? countUploadDatasets(targets) : { declared: 0, slots: 0 };
    const total = declared + slots;
    if (total <= MAX_UPLOAD_SLOTS) {
        return null;
    }
    return (
        `This upload creates ${total} datasets; one upload can create at most ${MAX_UPLOAD_SLOTS}. ` +
        "Split it into several uploads."
    );
}

/** Largest `results.json` accepted from a job with `outputs` declared outputs and `slots` slots. */
export function resultsLimit(outputs: number, slots: number): number {
    return Math.min(
        MAX_RESULTS_BYTES,
        MAX_DOCUMENT_BYTES + outputs * RESULTS_BYTES_PER_OUTPUT + slots * RESULTS_BYTES_PER_SLOT,
    );
}
