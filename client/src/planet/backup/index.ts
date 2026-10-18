/** Encrypted snapshots of Planet's IndexedDB records in the bucket, and restoring them. See README.md. */

export * from "./bucket";
export { BackupError, type BackupErrorCode, isBackupError } from "./errors";
export {
    fromBase64,
    MAX_PAYLOAD_BYTES,
    MAX_SNAPSHOT_BYTES,
    PBKDF2_ITERATIONS,
    readSnapshotFile,
    type SnapshotHeader,
    toBase64,
} from "./format";
export {
    type BackupKey,
    createBackupKey,
    matchesPassphrase,
    MAX_PASSPHRASE_LENGTH,
    MIN_PASSPHRASE_LENGTH,
    passphraseProblem,
} from "./keys";
export { collectState, isLocalKvKey, SNAPSHOT_STORES } from "./payload";
export { FORK_KEY, forkInstance, type ForkRecord } from "./restore";
export { BackupScheduler, type LeaderTask } from "./scheduler";
export {
    type BackupOutcome,
    buildSnapshot,
    hasUnsavedChanges,
    INTERVAL_MS,
    localSummary,
    restoreSnapshot,
    runBackup,
} from "./snapshot";
export * from "./state";
