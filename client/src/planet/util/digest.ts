/** SHA-256 digests with Web Crypto. */

function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lower-case hex SHA-256 of `data` (strings are UTF-8 encoded). */
export async function sha256Hex(data: string | ArrayBuffer | ArrayBufferView): Promise<string> {
    let bytes: BufferSource;
    if (typeof data === "string") {
        bytes = new TextEncoder().encode(data);
    } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        bytes = data;
    }
    return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
