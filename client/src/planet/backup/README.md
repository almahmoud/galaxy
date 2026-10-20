# Backups

The bucket is Planet's system of record; IndexedDB is a cache that browsers may evict. This module writes
encrypted snapshots of the IndexedDB records to the bucket and restores them.

## Bucket layout

Under `<prefix>/state/<instance_id>/`:

| Object                                        | Content                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `snapshots/<YYYYMMDDTHHMMSSmmm>Z.json.gz.enc` | An encrypted snapshot. The newest 10 are kept.                                                         |
| `latest.json`                                 | Unencrypted pointer to the newest snapshot: name, time, size, schema version, record counts.           |
| `lease.json`                                  | Unencrypted: the device (`kv` `backup:device`) that runs the instance's jobs and writes its snapshots. |
| `forks/<instance>.json`                       | Unencrypted: an instance made from this one's records, and which datasets the two share.               |

## Snapshot file

1. The bytes `PLNTSNP1`.
2. The header length, a 4-byte big-endian integer.
3. The header, UTF-8 JSON: format and version, instance id, creation time, IndexedDB schema version
   (`DB_VERSION`), PBKDF2 parameters (SHA-256, at least 600,000 iterations, random 16-byte salt), key id, a key
   check value, and the AES-GCM IV.
4. AES-256-GCM ciphertext of the gzip-compressed state payload. Parts 1 to 3 are its additional authenticated
   data, so a changed header fails decryption.

The state payload is JSON (`format: "planet-state"`, `version: 1`) holding every store except `secrets`. Left out
as well: the `kv` entries of this device and browser session (`clock`, `leader*`, `backup:*`, `console:*`,
`container:*`) and the pod and node names of jobs. Dataset contents are in the bucket already and are not part of
a snapshot.

Snapshots of older schema versions restore: `PAYLOAD_MIGRATIONS` in `payload.ts` has one step per database migration.
Snapshots of newer versions are refused. The first cycle after restoring an older snapshot writes one in the current
version.

## Keys

The passphrase (NFC-normalized, at least 12 characters, and not easy to guess by `passphraseStrength`: repeated
characters, runs such as `1234`, repetitions and common words count little) derives the AES key with PBKDF2-SHA-256. The leading tab
writes snapshots without asking for the passphrase, so the derived key is stored on the device as a
non-extractable `CryptoKey` (`kv` `backup:key`). Pages of Planet's origin can use the key but cannot read it out;
the browser keeps it with the rest of the profile, so it protects nothing from someone who can use or copy that
profile. The passphrase protects snapshots from anyone who can read the bucket. Changing or removing the passphrase
needs the current one. A change applies to new snapshots; once one is written, the leading tab re-encrypts the
instance's older snapshots with the new key (the old key stays on the device until then), deletes them, or leaves
them, as the user chose. Downloaded copies keep their passphrase.

## The lease

One device runs an instance's jobs and writes its snapshots: the one named in `lease.json`. The leading tab
(`InstanceLease` in `lease.ts`, started by `leader/host.ts`) reads the lease every minute, also without a passphrase.
It takes a missing lease, renews its own hourly, and takes another device's only when the user chooses to continue
the instance on this device. The job manager runs only while the lease is this device's and was read within the
last 3 minutes; every bucket and Kubernetes write checks this. A device that took the lease from another one starts
jobs 3.5 minutes later, when the other device has stopped. Two devices that find no lease at the same moment can
both run jobs for up to a minute before the next read stops one of them.

## Writing

The leading tab (`BackupScheduler`) runs a cycle every minute; a cycle compares the records with the last snapshot
every 15 minutes, or at once when one is requested (`POST /api/planet/backup`), and writes a snapshot when they
differ or the last snapshot has an older schema version. It writes only while this device holds the lease.

## Restoring

`POST /api/planet/backup/restore` decrypts a snapshot from the bucket or a file and replaces every store except
`secrets` in one transaction. A snapshot file can come from someone else, so the records are checked first
(`validate.ts`): datasets and uploads name only their own bucket objects, jobs only Kubernetes Jobs of the
snapshot's instance, purges only dataset ids, and tools are installed tools of the supported sources with the
archive an install stored and no id of a built-in tool.

The device keeps its storage settings, its cluster settings when a cluster token is stored, and its local `kv`
entries. A snapshot's cluster gateway and runtime image replace this device's only after the user confirmed them.
The restore refuses to replace records that are in no snapshot unless confirmed, and to continue an instance whose
lease another device holds unless the user takes the lease over or restores as a new instance.

Continuing an instance pauses its jobs that had not reached the cluster and drops the outbox's dispatches, cancels
and cleanups until the user resumes restored jobs (`resume_restored_jobs`); jobs in the cluster continue.

Restoring as a new instance gives the records a new instance id: jobs that had not finished fail (they stay with
the original instance), the outbox is emptied, and `kv` `instance_fork` records the fork. Datasets created before
the fork share their bucket objects with the original instance, which the fork tells through
`state/<original>/forks/<fork>.json` (`forks.ts`). Neither instance deletes the objects of shared datasets when
they are purged.
