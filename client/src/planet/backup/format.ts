/**
 * Snapshot files, as written to `state/<instance>/snapshots/` and exported to local files: the magic bytes
 * `PLNTSNP1`, the header length as a 4-byte big-endian integer, the header as UTF-8 JSON
 * ({@link SnapshotHeader}), then the AES-GCM ciphertext of the gzip-compressed state payload. Everything before
 * the ciphertext is authenticated as additional data, so a changed header fails decryption.
 */

import { BackupError } from "./errors";

export const SNAPSHOT_FORMAT = "planet-snapshot";
export const SNAPSHOT_VERSION = 1;
/** OWASP's 2023 minimum for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;
/** Snapshots asking for more iterations are refused, so a crafted header cannot stall the browser. */
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
/** Largest snapshot file accepted or written. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Largest uncompressed state payload accepted or written. */
export const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

const MAGIC = "PLNTSNP1";
const MAX_HEADER_BYTES = 16 * 1024;
const IV_BYTES = 12;
const INSTANCE_RE = /^[0-9a-f]{8}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Parameters that turn the passphrase into the snapshot key, and a value that tells a wrong passphrase apart. */
export interface KeyParams {
    key_id: string;
    /** Base64 PBKDF2 salt. */
    salt: string;
    iterations: number;
    /** AES-GCM encryption of a fixed text naming `key_id`. */
    key_check: { iv: string; data: string };
}

export interface SnapshotHeader {
    format: typeof SNAPSHOT_FORMAT;
    version: typeof SNAPSHOT_VERSION;
    instance_id: string;
    /** ISO 8601 UTC time the snapshot was taken. */
    created: string;
    /** IndexedDB schema version of the payload (`DB_VERSION`). */
    schema_version: number;
    kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
    key_id: string;
    key_check: KeyParams["key_check"];
    cipher: { name: "AES-GCM"; iv: string };
    compression: "gzip";
}

/** What a snapshot header says about the snapshot, besides its encryption. */
export interface SnapshotMeta {
    instance_id: string;
    created: string;
    schema_version: number;
}

export function utf8(text: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(length));
}

const BASE64_CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return btoa(binary);
}

/** @throws BackupError `format` when `text` is not base64 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    let binary: string;
    try {
        binary = atob(text);
    } catch {
        throw new BackupError("format", "The snapshot is not valid base64.");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

/** Reads `stream` into memory; more than `limit` bytes fail with `too_large` and `message`. */
export async function readLimited(
    stream: ReadableStream<Uint8Array>,
    limit: number,
    message: string,
): Promise<Uint8Array<ArrayBuffer>> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => undefined);
            throw new BackupError("too_large", message);
        }
        chunks.push(value);
    }
    return concat(...chunks);
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    // eslint-disable-next-line compat/compat -- gzip streams are in Chrome 80, Firefox 113 and Safari 16.4
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return readLimited(stream, Number.MAX_SAFE_INTEGER, "");
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    // eslint-disable-next-line compat/compat -- gzip streams are in Chrome 80, Firefox 113 and Safari 16.4
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    try {
        return await readLimited(stream, limit, `The snapshot holds more than ${limit / 1024 / 1024} MiB of data.`);
    } catch (error) {
        if (error instanceof BackupError) {
            throw error;
        }
        throw new BackupError("damaged", "The snapshot's compressed data is damaged.");
    }
}

function fail(message: string): never {
    throw new BackupError("format", `This is not a Planet snapshot: ${message}.`);
}

function base64Field(value: unknown, name: string, min: number, max: number): string {
    if (typeof value !== "string") {
        fail(`${name} is missing`);
    }
    let length: number;
    try {
        length = atob(value).length;
    } catch {
        fail(`${name} is not base64`);
    }
    if (length < min || length > max) {
        fail(`${name} has the wrong length`);
    }
    return value;
}

function objectField(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${name} is missing`);
    }
    return value as Record<string, unknown>;
}

/** Validates an untrusted header. */
export function parseHeader(value: unknown): SnapshotHeader {
    const header = objectField(value, "the header");
    if (header.format !== SNAPSHOT_FORMAT) {
        fail("the header names another format");
    }
    if (header.version !== SNAPSHOT_VERSION) {
        throw new BackupError(
            "unsupported_version",
            `The snapshot uses format version ${String(header.version)}; this Planet reads version ${SNAPSHOT_VERSION}.`,
        );
    }
    if (typeof header.instance_id !== "string" || !INSTANCE_RE.test(header.instance_id)) {
        fail("the instance id is invalid");
    }
    if (typeof header.created !== "string" || Number.isNaN(Date.parse(header.created))) {
        fail("the creation time is invalid");
    }
    if (!Number.isSafeInteger(header.schema_version) || (header.schema_version as number) < 1) {
        fail("the schema version is invalid");
    }
    const kdf = objectField(header.kdf, "kdf");
    if (kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256") {
        fail("the key derivation is not PBKDF2-SHA-256");
    }
    const iterations = kdf.iterations;
    if (
        typeof iterations !== "number" ||
        !Number.isSafeInteger(iterations) ||
        iterations < PBKDF2_ITERATIONS ||
        iterations > MAX_PBKDF2_ITERATIONS
    ) {
        fail(`the iteration count must be from ${PBKDF2_ITERATIONS} to ${MAX_PBKDF2_ITERATIONS}`);
    }
    if (typeof header.key_id !== "string" || !KEY_ID_RE.test(header.key_id)) {
        fail("the key id is invalid");
    }
    const check = objectField(header.key_check, "key_check");
    const cipher = objectField(header.cipher, "cipher");
    if (cipher.name !== "AES-GCM") {
        fail("the cipher is not AES-GCM");
    }
    if (header.compression !== "gzip") {
        fail("the compression is not gzip");
    }
    return {
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        instance_id: header.instance_id,
        created: header.created,
        schema_version: header.schema_version as number,
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: base64Field(kdf.salt, "the salt", 16, 64) },
        key_id: header.key_id,
        key_check: {
            iv: base64Field(check.iv, "the key check", IV_BYTES, IV_BYTES),
            data: base64Field(check.data, "the key check", 17, 128),
        },
        cipher: { name: "AES-GCM", iv: base64Field(cipher.iv, "the IV", IV_BYTES, IV_BYTES) },
        compression: "gzip",
    };
}

/** The parts of a snapshot file. */
export interface SnapshotFile {
    header: SnapshotHeader;
    /** The bytes authenticated with the ciphertext: magic, header length and header. */
    prefix: Uint8Array<ArrayBuffer>;
    ciphertext: Uint8Array<ArrayBuffer>;
}

/** Splits a snapshot file and validates its header, without decrypting it. */
export function readSnapshotFile(bytes: Uint8Array<ArrayBuffer>): SnapshotFile {
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
        throw new BackupError(
            "too_large",
            `Snapshots larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB are refused.`,
        );
    }
    const magic = utf8(MAGIC);
    if (bytes.byteLength < magic.byteLength + 4 || magic.some((byte, index) => bytes[index] !== byte)) {
        fail("the file does not start with a snapshot header");
    }
    const length = new DataView(bytes.buffer, bytes.byteOffset + magic.byteLength, 4).getUint32(0);
    const start = magic.byteLength + 4;
    if (length > MAX_HEADER_BYTES || start + length > bytes.byteLength) {
        fail("the header length is invalid");
    }
    let value: unknown;
    try {
        value = JSON.parse(fromUtf8(bytes.subarray(start, start + length)));
    } catch {
        fail("the header is not JSON");
    }
    return {
        header: parseHeader(value),
        prefix: bytes.slice(0, start + length),
        ciphertext: bytes.slice(start + length),
    };
}

/** Compresses and encrypts `payload` with `key` (the AES-GCM key derived with `params`). */
export async function sealSnapshot(
    payload: Uint8Array<ArrayBuffer>,
    key: CryptoKey,
    params: KeyParams,
    meta: SnapshotMeta,
): Promise<Uint8Array<ArrayBuffer>> {
    if (payload.byteLength > MAX_PAYLOAD_BYTES) {
        throw new BackupError(
            "too_large",
            `Planet's records take ${Math.ceil(payload.byteLength / 1024 / 1024)} MiB, more than a snapshot holds (${MAX_PAYLOAD_BYTES / 1024 / 1024} MiB).`,
        );
    }
    const compressed = await gzip(payload);
    const iv = randomBytes(IV_BYTES);
    const header: SnapshotHeader = {
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        instance_id: meta.instance_id,
        created: meta.created,
        schema_version: meta.schema_version,
        kdf: { name: "PBKDF2", hash: "SHA-256", iterations: params.iterations, salt: params.salt },
        key_id: params.key_id,
        key_check: params.key_check,
        cipher: { name: "AES-GCM", iv: toBase64(iv) },
        compression: "gzip",
    };
    const headerBytes = utf8(JSON.stringify(header));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, headerBytes.byteLength);
    const prefix = concat(utf8(MAGIC), length, headerBytes);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: prefix }, key, compressed);
    const sealed = concat(prefix, new Uint8Array(ciphertext));
    if (sealed.byteLength > MAX_SNAPSHOT_BYTES) {
        throw new BackupError(
            "too_large",
            `The snapshot would take ${Math.ceil(sealed.byteLength / 1024 / 1024)} MiB, more than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB.`,
        );
    }
    return sealed;
}

/**
 * Decrypts and decompresses a snapshot whose key was derived from its header.
 *
 * @throws BackupError `damaged` when the ciphertext or header was changed
 */
export async function openSnapshot(file: SnapshotFile, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
    let compressed: ArrayBuffer;
    try {
        compressed = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(file.header.cipher.iv), additionalData: file.prefix },
            key,
            file.ciphertext,
        );
    } catch {
        throw new BackupError(
            "damaged",
            "The snapshot was changed or damaged after it was written; it cannot be decrypted.",
        );
    }
    return gunzip(new Uint8Array(compressed), MAX_PAYLOAD_BYTES);
}
