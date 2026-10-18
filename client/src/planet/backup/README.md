# Backups

The bucket is Planet's system of record; IndexedDB is a cache that browsers may evict. This module writes
encrypted snapshots of the IndexedDB records to the bucket and restores them.

## Bucket layout

Under `<prefix>/state/<instance_id>/`:

| Object                                        | Content                                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `snapshots/<YYYYMMDDTHHMMSSmmm>Z.json.gz.enc` | An encrypted snapshot. The newest 10 are kept.                                               |
| `latest.json`                                 | Unencrypted pointer to the newest snapshot: name, time, size, schema version, record counts. |
| `lease.json`                                  | Unencrypted: the device (`kv` `backup:device`) that writes the instance's snapshots.         |

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

Restoring requires the same schema version as the running build; other versions are refused.

## Keys

The passphrase (NFC-normalized, at least 12 characters) derives the AES key with PBKDF2-SHA-256. The leading tab
writes snapshots without asking for the passphrase, so the derived key is stored on the device as a
non-extractable `CryptoKey` (`kv` `backup:key`). Pages of Planet's origin can use the key but cannot read it out;
the browser keeps it with the rest of the profile, so it protects nothing from someone who can use or copy that
profile. The passphrase protects snapshots from anyone who can read the bucket. Changing the passphrase changes
the key for new snapshots only; older ones still need the old passphrase.

## Writing

The leading tab (`BackupScheduler`, started by `leader/host.ts`) runs a cycle every minute; a cycle compares the
records with the last snapshot every 15 minutes, or at once when one is requested (`POST /api/planet/backup`),
and writes a snapshot when they differ. It writes only while this device holds the instance's lease. It takes a
missing lease, renews its own hourly, and takes another device's lease only when the user chooses to continue
the instance on this device. Two devices that find no lease at the same moment can each write one snapshot
before the next cycle shows the conflict.

## Restoring

`POST /api/planet/backup/restore` decrypts a snapshot from the bucket or a file and replaces every store except
`secrets` in one transaction. The device keeps its storage settings, its cluster settings when a cluster token is
stored, and its local `kv` entries. It refuses to replace records that are in no snapshot unless confirmed, and
to continue an instance whose lease another device holds unless the user takes the lease over or restores as a
new instance.

Restoring as a new instance gives the records a new instance id: jobs that had not finished fail (they stay with
the original instance), the outbox is emptied, and `kv` `instance_fork` records the fork. Datasets created before
the fork share their bucket objects with the original instance.
