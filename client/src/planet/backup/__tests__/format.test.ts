// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { isBackupError } from "../errors";
import {
    MAX_PAYLOAD_BYTES,
    openSnapshot,
    parseHeader,
    PBKDF2_ITERATIONS,
    readSnapshotFile,
    sealSnapshot,
    type SnapshotHeader,
    utf8,
} from "../format";
import { createBackupKey, passphraseProblem, unlockKey } from "../keys";
import { PASSPHRASE } from "./helpers";

// Every key derivation runs PBKDF2 with 600,000 iterations.
vi.setConfig({ testTimeout: 30_000 });

const META = { instance_id: "a1b2c3d4", created: "2026-10-13T12:00:00.000Z", schema_version: 2 };
const key = await createBackupKey(PASSPHRASE);

async function sealed(text = '{"hello":"world"}'): Promise<Uint8Array<ArrayBuffer>> {
    return sealSnapshot(utf8(text), key.key, key, META);
}

function headerOf(bytes: Uint8Array<ArrayBuffer>): SnapshotHeader {
    return readSnapshotFile(bytes).header;
}

async function code(promise: Promise<unknown>): Promise<string | null> {
    try {
        await promise;
        return null;
    } catch (error) {
        return isBackupError(error) ? error.code : `unexpected: ${String(error)}`;
    }
}

/** Replaces the header JSON with `change(header)`, keeping the ciphertext. */
function withHeader(bytes: Uint8Array<ArrayBuffer>, change: (header: Record<string, unknown>) => void) {
    const file = readSnapshotFile(bytes);
    const header = JSON.parse(JSON.stringify(file.header)) as Record<string, unknown>;
    change(header);
    const json = utf8(JSON.stringify(header));
    const out = new Uint8Array(12 + json.byteLength + file.ciphertext.byteLength);
    out.set(bytes.subarray(0, 8));
    new DataView(out.buffer).setUint32(8, json.byteLength);
    out.set(json, 12);
    out.set(file.ciphertext, 12 + json.byteLength);
    return out;
}

describe("snapshot files", () => {
    it("round-trips the payload and describes it in an unencrypted header", async () => {
        const bytes = await sealed();
        const header = headerOf(bytes);
        expect(header).toMatchObject({
            format: "planet-snapshot",
            version: 1,
            ...META,
            kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: key.salt },
            key_id: key.key_id,
            cipher: { name: "AES-GCM" },
            compression: "gzip",
        });
        expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
        const unlocked = await unlockKey(PASSPHRASE, { ...key, salt: header.kdf.salt });
        const plain = await openSnapshot(readSnapshotFile(bytes), unlocked.key);
        expect(new TextDecoder().decode(plain)).toBe('{"hello":"world"}');
    });

    it("uses a fresh IV for every snapshot and never stores the payload in clear", async () => {
        const text = JSON.stringify({ secret: "visible-marker-".repeat(20) });
        const [first, second] = [await sealed(text), await sealed(text)];
        expect(headerOf(first).cipher.iv).not.toBe(headerOf(second).cipher.iv);
        expect(Buffer.from(first).includes("visible-marker")).toBe(false);
    });

    it("refuses a wrong passphrase before decrypting", async () => {
        const header = headerOf(await sealed());
        const params = {
            key_id: header.key_id,
            salt: header.kdf.salt,
            iterations: header.kdf.iterations,
            key_check: header.key_check,
        };
        expect(await code(unlockKey("not the right passphrase", params))).toBe("wrong_passphrase");
    });

    it("detects a changed ciphertext", async () => {
        const bytes = await sealed();
        bytes[bytes.byteLength - 20] = bytes[bytes.byteLength - 20]! ^ 0x01;
        expect(await code(openSnapshot(readSnapshotFile(bytes), key.key))).toBe("damaged");
    });

    it("detects a changed header, which is authenticated with the ciphertext", async () => {
        const bytes = withHeader(await sealed(), (header) => {
            header.created = "2026-10-13T12:00:00.001Z";
        });
        expect(headerOf(bytes).created).toBe("2026-10-13T12:00:00.001Z");
        expect(await code(openSnapshot(readSnapshotFile(bytes), key.key))).toBe("damaged");
    });

    it("refuses files that are not snapshots", async () => {
        const bytes = await sealed();
        expect(() => readSnapshotFile(utf8('{"format":"planet-snapshot"}'))).toThrow(/not a Planet snapshot/);
        expect(() => readSnapshotFile(bytes.slice(0, 20))).toThrow(/header length/);
        const garbled = bytes.slice();
        garbled[14] = 0x7b;
        expect(() => readSnapshotFile(garbled)).toThrow(/not a Planet snapshot/);
    });

    it("refuses another format version", async () => {
        const bytes = withHeader(await sealed(), (header) => {
            header.version = 2;
        });
        expect(() => readSnapshotFile(bytes)).toThrow(expect.objectContaining({ code: "unsupported_version" }));
    });

    it("refuses iteration counts below the minimum or large enough to stall the browser", () => {
        const header = {
            format: "planet-snapshot",
            version: 1,
            ...META,
            kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 100_000, salt: key.salt },
            key_id: key.key_id,
            key_check: key.key_check,
            cipher: { name: "AES-GCM", iv: "AAAAAAAAAAAAAAAA" },
            compression: "gzip",
        };
        expect(() => parseHeader(header)).toThrow(/iteration count/);
        expect(() => parseHeader({ ...header, kdf: { ...header.kdf, iterations: 50_000_000 } })).toThrow(
            /iteration count/,
        );
        expect(parseHeader({ ...header, kdf: { ...header.kdf, iterations: PBKDF2_ITERATIONS } }).kdf.iterations).toBe(
            PBKDF2_ITERATIONS,
        );
        expect(() => parseHeader({ ...header, kdf: { ...header.kdf, hash: "SHA-1" } })).toThrow(/PBKDF2-SHA-256/);
        expect(() => parseHeader({ ...header, instance_id: "../../x" })).toThrow(/instance id/);
    });

    it("refuses payloads larger than a snapshot holds", async () => {
        const big = { byteLength: MAX_PAYLOAD_BYTES + 1 } as Uint8Array<ArrayBuffer>;
        expect(await code(sealSnapshot(big, key.key, key, META))).toBe("too_large");
    });
});

describe("passphrases", () => {
    it("asks for at least 12 characters", () => {
        expect(passphraseProblem("")).toMatch(/Enter/);
        expect(passphraseProblem("short words")).toMatch(/at least 12/);
        expect(passphraseProblem(PASSPHRASE)).toBeNull();
        expect(passphraseProblem("x".repeat(1025))).toMatch(/at most/);
    });

    it("derives the same key from differently normalized input", async () => {
        const composed = "café au lait, s'il vous plaît";
        const decomposed = composed.normalize("NFD");
        const created = await createBackupKey(composed);
        await expect(unlockKey(decomposed, created)).resolves.toMatchObject({ key_id: created.key_id });
    });

    it("keeps the key non-extractable", async () => {
        expect(key.key.extractable).toBe(false);
        await expect(crypto.subtle.exportKey("raw", key.key)).rejects.toThrow();
    });
});
