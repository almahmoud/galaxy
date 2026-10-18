/** Errors of the backup module; `code` tells the API and the page what went wrong. */

export type BackupErrorCode =
    /** The data is not a Planet snapshot or state payload. */
    | "format"
    /** The snapshot uses a format version this build cannot read. */
    | "unsupported_version"
    /** The snapshot's IndexedDB schema version differs from this build's. */
    | "schema_version"
    | "wrong_passphrase"
    /** The new passphrase is too short or too long. */
    | "weak_passphrase"
    /** Decryption or decompression failed although the passphrase is right. */
    | "damaged"
    | "too_large"
    /** No passphrase is set on this device. */
    | "no_passphrase"
    /** The storage settings are incomplete. */
    | "not_configured"
    /** Restoring would replace records that are in no snapshot. */
    | "unsaved_changes"
    /** Another device holds the instance's lease. */
    | "lease_conflict";

export class BackupError extends Error {
    constructor(
        readonly code: BackupErrorCode,
        message: string,
        /** JSON fields the API adds to the error, such as the lease holder of a `lease_conflict`. */
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "BackupError";
    }
}

export function isBackupError(error: unknown, code?: BackupErrorCode): error is BackupError {
    return error instanceof BackupError && (code === undefined || error.code === code);
}
