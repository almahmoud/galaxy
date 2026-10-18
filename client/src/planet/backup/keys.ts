/**
 * The snapshot key: AES-256-GCM derived from the user's passphrase with PBKDF2-SHA-256 and a random salt. The
 * device keeps it as a non-extractable CryptoKey in IndexedDB (`kv` `backup:key`), so the leading tab can write
 * snapshots without asking for the passphrase. Scripts on Planet's origin can use the key but not read it; the
 * browser stores it in the profile, so it does not protect anything from someone who can read this browser's
 * data. The passphrase protects snapshots from whoever can read the bucket.
 */

import { randomHex } from "@/planet/util/ids";

import { BackupError } from "./errors";
import { fromBase64, fromUtf8, type KeyParams, PBKDF2_ITERATIONS, randomBytes, toBase64, utf8 } from "./format";

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

const SALT_BYTES = 16;

/** The key this device writes snapshots with (`kv` `backup:key`). */
export interface BackupKey extends KeyParams {
    key: CryptoKey;
    /** ISO 8601 UTC time the passphrase was set on this device. */
    created: string;
}

/** Why `passphrase` cannot be used, or null. */
export function passphraseProblem(passphrase: unknown): string | null {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
        return "Enter a passphrase.";
    }
    const length = [...passphrase.normalize("NFC")].length;
    if (length < MIN_PASSPHRASE_LENGTH) {
        return `Use at least ${MIN_PASSPHRASE_LENGTH} characters; several unrelated words work well.`;
    }
    if (length > MAX_PASSPHRASE_LENGTH) {
        return `Use at most ${MAX_PASSPHRASE_LENGTH} characters.`;
    }
    return null;
}

/** Derives the AES-GCM key. The passphrase is NFC-normalized so it derives the same key on every device. */
export async function deriveKey(
    passphrase: string,
    salt: Uint8Array<ArrayBuffer>,
    iterations: number,
): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey("raw", utf8(passphrase.normalize("NFC")), "PBKDF2", false, [
        "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

function checkText(keyId: string): string {
    return `planet-backup-key:${keyId}`;
}

/** Creates a key with a new salt and key id. */
export async function createBackupKey(passphrase: string, now: number = Date.now()): Promise<BackupKey> {
    const problem = passphraseProblem(passphrase);
    if (problem) {
        throw new BackupError("weak_passphrase", problem);
    }
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
    const keyId = randomHex(8);
    const iv = randomBytes(12);
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(checkText(keyId)));
    return {
        key,
        key_id: keyId,
        salt: toBase64(salt),
        iterations: PBKDF2_ITERATIONS,
        key_check: { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) },
        created: new Date(now).toISOString(),
    };
}

/**
 * Derives the key described by `params` from `passphrase`.
 *
 * @throws BackupError `wrong_passphrase` when the key check does not decrypt
 */
export async function unlockKey(passphrase: string, params: KeyParams, now: number = Date.now()): Promise<BackupKey> {
    const key = await deriveKey(passphrase, fromBase64(params.salt), params.iterations);
    let text: string | null = null;
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(params.key_check.iv) },
            key,
            fromBase64(params.key_check.data),
        );
        text = fromUtf8(new Uint8Array(plain));
    } catch {
        text = null;
    }
    if (text !== checkText(params.key_id)) {
        throw new BackupError("wrong_passphrase", "The passphrase is not the one this snapshot was written with.");
    }
    return {
        key,
        key_id: params.key_id,
        salt: params.salt,
        iterations: params.iterations,
        key_check: params.key_check,
        created: new Date(now).toISOString(),
    };
}

/** True when `passphrase` derives `record`'s key. */
export async function matchesPassphrase(record: KeyParams, passphrase: string): Promise<boolean> {
    try {
        await unlockKey(passphrase, record);
        return true;
    } catch {
        return false;
    }
}

/** The key parameters of a stored record, without the CryptoKey. */
export function keyParams(record: KeyParams): KeyParams {
    return {
        key_id: record.key_id,
        salt: record.salt,
        iterations: record.iterations,
        key_check: { ...record.key_check },
    };
}
