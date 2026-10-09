const PREFIXES = ["", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"] as const;

function metricPrefix(value: number, base: number): [number, string] {
    const sign = value < 0 ? -1 : 1;
    const magnitude = Math.abs(value);
    let index = 0;
    while (index < PREFIXES.length - 1 && magnitude >= base ** (index + 1)) {
        index += 1;
    }
    return [(sign * magnitude) / base ** index, PREFIXES[index]!];
}

// Python's format() rounds exact ties to even; toFixed() rounds them up. At one decimal place an exact
// binary tie is a value ending in .x25 or .x75 (a multiple of 0.25 that is not a multiple of 0.5).
function formatOneDecimal(value: number): string {
    const magnitude = Math.abs(value);
    if (Number.isInteger(magnitude * 4) && !Number.isInteger(magnitude * 2)) {
        const tenths = Math.floor(magnitude * 10);
        const rounded = tenths % 2 === 0 ? tenths : tenths + 1;
        return `${value < 0 ? "-" : ""}${(rounded / 10).toFixed(1)}`;
    }
    return value.toFixed(1);
}

/**
 * Formats a byte count like Galaxy's `galaxy.util.nice_size`: `100 bytes`, `10.0 KB`, `1.0 MiB`.
 *
 * @param binary use powers of 1024 and IEC suffixes instead of powers of 1000
 */
export function niceSize(size: number | string | null | undefined, binary = false): string {
    const value = typeof size === "string" ? Number(size.trim() === "" ? NaN : size) : Number(size ?? NaN);
    if (!Number.isFinite(value)) {
        return "??? bytes";
    }
    const [scaled, prefix] = metricPrefix(value, binary ? 1024 : 1000);
    if (prefix === "") {
        return `${Math.trunc(scaled)} bytes`;
    }
    return `${formatOneDecimal(scaled)} ${prefix}${binary ? "iB" : "B"}`;
}
