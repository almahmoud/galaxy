/** Random identifiers. All values come from the Web Crypto CSPRNG. */

/** Returns `bytes` random bytes as lowercase hex (two characters per byte). */
export function randomHex(bytes: number): string {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    let out = "";
    for (const byte of buffer) {
        out += byte.toString(16).padStart(2, "0");
    }
    return out;
}

/** Matches identifiers produced by {@link newId}. */
export const ID_PATTERN = /^[0-9a-f]{16}$/;

/** Returns a new object id: 16 lowercase hex characters, the shape of a Galaxy encoded id. */
export function newId(): string {
    return randomHex(8);
}

/** Returns true when `value` has the shape of an id produced by {@link newId}. */
export function isId(value: unknown): value is string {
    return typeof value === "string" && ID_PATTERN.test(value);
}

/** Returns a random RFC 4122 version 4 UUID in its canonical lowercase form. */
export function newUuid(): string {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Returns a new Planet instance id: 8 lowercase hex characters, valid inside DNS labels. */
export function newInstanceId(): string {
    return randomHex(4);
}

/** Returns a request id for the `X-Request-ID` response header (32 hex characters). */
export function newRequestId(): string {
    return randomHex(16);
}
