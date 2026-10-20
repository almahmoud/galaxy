/**
 * Tool version order as Galaxy's `galaxy.tool_util.version.parse_version` defines it: PEP 440 versions in
 * `packaging`'s order, and other strings as packaging 21.3's `LegacyVersion`, which sorts before every PEP 440 version.
 * Tool lineages list their versions in this order, oldest first.
 */

const PEP440 = new RegExp(
    "^\\s*v?" +
        "(?:(?<epoch>[0-9]+)!)?" +
        "(?<release>[0-9]+(?:\\.[0-9]+)*)" +
        "(?<pre>[-_.]?(?<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?<pre_n>[0-9]+)?)?" +
        "(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?" +
        "(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?" +
        "(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?" +
        "\\s*$",
    "i",
);

/** A comparable part: numbers, strings, or the infinities `packaging` uses for missing segments. */
type Part = number | string | Part[];

const NEGATIVE = -Infinity;
const POSITIVE = Infinity;

function compareParts(a: Part, b: Part): number {
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const order = compareParts(a[i]!, b[i]!);
            if (order) {
                return order;
            }
        }
        return a.length - b.length;
    }
    // A missing segment (an infinity) compares against a present one (a tuple) by its sign alone.
    if (Array.isArray(a)) {
        return -Math.sign(b as number);
    }
    if (Array.isArray(b)) {
        return Math.sign(a as number);
    }
    if (typeof a === "number" && typeof b === "number") {
        return a === b ? 0 : a < b ? -1 : 1;
    }
    const left = String(a);
    const right = String(b);
    return left === right ? 0 : left < right ? -1 : 1;
}

function letterVersion(letter: string | undefined, number: string | undefined): Part[] | null {
    if (letter) {
        const lower = letter.toLowerCase();
        const normalized =
            lower === "alpha"
                ? "a"
                : lower === "beta"
                  ? "b"
                  : ["c", "pre", "preview"].includes(lower)
                    ? "rc"
                    : ["rev", "r"].includes(lower)
                      ? "post"
                      : lower;
        return [normalized, Number(number ?? 0)];
    }
    return number ? ["post", Number(number)] : null;
}

/** `packaging.version._cmpkey` of a PEP 440 version, or null when `version` is not one. */
function pep440Key(version: string): Part[] | null {
    const groups = PEP440.exec(version)?.groups;
    if (!groups) {
        return null;
    }
    const release = groups.release!.split(".").map(Number);
    while (release.length && release[release.length - 1] === 0) {
        release.pop();
    }
    const pre = letterVersion(groups.pre_l, groups.pre_n);
    const post = letterVersion(groups.post_l, groups.post_n1 ?? groups.post_n2);
    const dev = letterVersion(groups.dev_l, groups.dev_n);
    const local = groups.local
        ? groups.local
              .split(/[-_.]/)
              .map((part): Part => (/^[0-9]+$/.test(part) ? [Number(part), ""] : [NEGATIVE, part.toLowerCase()]))
        : NEGATIVE;
    return [
        Number(groups.epoch ?? 0),
        release,
        pre ?? (post === null && dev !== null ? NEGATIVE : POSITIVE),
        post ?? NEGATIVE,
        dev ?? POSITIVE,
        local,
    ];
}

const LEGACY_REPLACEMENTS = new Map([
    ["pre", "c"],
    ["preview", "c"],
    ["-", "final-"],
    ["rc", "c"],
    ["dev", "@"],
]);

/** `_legacy_cmpkey`: setuptools' original version scheme, with an epoch of -1. */
function legacyKey(version: string): Part[] {
    const pieces: string[] = [];
    for (const raw of version.toLowerCase().split(/(\d+|[a-z]+|\.|-)/)) {
        const piece = LEGACY_REPLACEMENTS.get(raw) ?? raw;
        if (piece && piece !== ".") {
            pieces.push(/^[0-9]/.test(piece) ? piece.padStart(8, "0") : `*${piece}`);
        }
    }
    pieces.push("*final");
    const parts: string[] = [];
    for (const part of pieces) {
        if (part.startsWith("*")) {
            if (part < "*final") {
                while (parts[parts.length - 1] === "*final-") {
                    parts.pop();
                }
            }
            while (parts[parts.length - 1] === "00000000") {
                parts.pop();
            }
        }
        parts.push(part);
    }
    return [-1, parts];
}

/** Negative, zero or positive as version `a` is older than, equal to or newer than `b`. */
export function compareToolVersions(a: string, b: string): number {
    return compareParts(pep440Key(a) ?? legacyKey(a), pep440Key(b) ?? legacyKey(b));
}
