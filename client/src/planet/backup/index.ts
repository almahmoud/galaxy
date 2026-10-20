/** Encrypted snapshots of Planet's IndexedDB records in the bucket, and restoring them. See README.md. */

export * from "./bucket";
export { BackupError, type BackupErrorCode, isBackupError } from "./errors";
export { FORK_KEY, type ForkRecord, sharedBefore } from "./forks";
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
    passphraseStrength,
} from "./keys";
export {
    acquireLease,
    InstanceLease,
    LEASE_CHECK_MS,
    LEASE_CONFLICT_MESSAGE,
    LEASE_VALID_MS,
    type LeaseView,
    TAKE_OVER_GRACE_MS,
} from "./lease";
export { collectState, isLocalKvKey, MIN_SCHEMA_VERSION, SNAPSHOT_STORES } from "./payload";
export { type ClusterEndpoints, forkInstance, PARKED_MESSAGE, parkedJobs, resumeParkedJobs } from "./restore";
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
