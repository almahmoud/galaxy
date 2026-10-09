/**
 * Galaxy timestamps: naive UTC ISO 8601 strings with microseconds, e.g. `2026-10-09T12:34:56.789000`.
 *
 * Planet always writes six fractional digits, so stored timestamps sort lexicographically in time order
 * and can be compared as strings and used as IndexedDB index keys.
 */

const MICROS_PER_SECOND = 1_000_000;

let lastMicros = 0;

/**
 * Returns the current time in microseconds since the Unix epoch, strictly greater than every value
 * previously returned in this JavaScript context and than `floor`.
 */
export function nextMicros(floor = 0): number {
    const next = Math.max(Date.now() * 1000, lastMicros + 1, Math.floor(floor) + 1);
    lastMicros = next;
    return next;
}

/** Formats microseconds since the epoch as a Galaxy timestamp. */
export function formatGalaxyTime(micros: number): string {
    const whole = Math.floor(micros);
    const seconds = Math.floor(whole / MICROS_PER_SECOND);
    const fraction = whole - seconds * MICROS_PER_SECOND;
    const iso = new Date(seconds * 1000).toISOString();
    return `${iso.slice(0, 19)}.${String(fraction).padStart(6, "0")}`;
}

/**
 * Returns a new Galaxy timestamp for the current time. Two calls in the same context never return
 * the same value. Database writes take their timestamp from the write transaction instead
 * (`WriteTx.now`), which is monotonic across every context sharing the database.
 */
export function galaxyNow(): string {
    return formatGalaxyTime(nextMicros());
}

// Same grammar as Galaxy's `ModelFilterParser.date_string_re` (UTC only, optional time and fraction).
const GALAXY_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T| ]?(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?Z?$/;
const EPOCH_RE = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * Parses a timestamp the way Galaxy's filter parser does: seconds since the epoch (integer or
 * decimal) or an ISO 8601 UTC date with optional time, fraction and trailing `Z`.
 *
 * @returns microseconds since the Unix epoch
 * @throws RangeError when the value is not a valid timestamp
 */
export function parseGalaxyTime(value: string): number {
    if (EPOCH_RE.test(value)) {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
            return Math.round(seconds * MICROS_PER_SECOND);
        }
    }
    const match = GALAXY_DATE_RE.exec(value);
    if (!match) {
        throw new RangeError("datetime strings must be in the ISO 8601 format and in the UTC");
    }
    const [, y, mo, d, h = "0", mi = "0", s = "0", frac = ""] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    const second = Number(s);
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(ms);
    if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
    ) {
        throw new RangeError(`invalid date: ${value}`);
    }
    return ms * 1000 + Number(frac.padEnd(6, "0"));
}

/** Converts a Galaxy timestamp (or any value accepted by {@link parseGalaxyTime}) to a `Date`. */
export function galaxyTimeToDate(value: string): Date {
    return new Date(Math.floor(parseGalaxyTime(value) / 1000));
}
