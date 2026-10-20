# Security

Planet has no server of its own. The site serves static files only; histories, datasets and
credentials stay in the browser, your cluster and your bucket. Planet trusts the browser profile it
runs in, the code served from the site's origin and the cluster's administrators. It does not trust
tool code, dataset contents or the Tool Shed.

## What is stored where

| Data | Where | Protection |
| --- | --- | --- |
| Kubernetes token, bucket secret access key | IndexedDB `secrets` store on the device, unencrypted | The browser's same-origin policy and the device's own security; never returned by Planet's API, never in snapshots |
| Settings, histories, dataset and job records, installed tools | IndexedDB on the device | As above; copied into encrypted snapshots when a backup passphrase is set |
| Backup key | IndexedDB `kv`, as a non-extractable `CryptoKey` | Pages of the origin can use it but not read it out |
| Dataset contents and metadata, job files, uploads, tool archives | The bucket, unencrypted by Planet | The bucket's access control |
| Snapshots | The bucket, `state/<instance>/` | AES-256-GCM with a key derived from the passphrase |
| Job pod specs, logs | The cluster | Kubernetes RBAC |

The token and the secret key are protected only as well as the browser profile is. Anyone who can
use or copy the profile, a browser extension allowed on the site, or a script that runs on the
site's origin can read them. Planet keeps scripts off the origin with invariant 1, sandboxed
dataset rendering and a strict Content Security Policy, described below.

The token is sent only to the configured gateway, as a bearer token. The secret key never leaves the
device; it signs S3 requests and presigned URLs. Changing the gateway URL removes the saved token, and
changing the bucket endpoint, cluster endpoint, bucket or access key ID removes the saved secret key,
unless the same change supplies a new one.

Besides the gateway and the bucket, Planet's code contacts the quay.io API to resolve tool images,
and the Tool Shed or GitHub when you search for or install tools. These requests carry no credentials
and no referrer.

## Tool code

No tool-author code runs on the site's origin ([architecture](architecture.md#invariants),
invariant 1). Cheetah templates, filter and validator expressions and `<code>` files are evaluated
only in pods. The browser evaluates a subset of expressions without function calls and with
own-property lookups only, and uses the pod's decisions when they differ.

In a job pod:

- Stage-in runs Galaxy's templating and validators in a child process that receives the manifest
  without presigned requests and an environment without `PLANET_MANIFEST_URL`; processes it leaves
  running are killed when it exits.
- The tool container does not receive the manifest URL, and the stagers keep their state on a
  volume the tool container does not mount. The stagers are non-dumpable, so processes of the same
  user cannot read their memory or environment.
- Containers run as uid 10001 (tool containers keep their image's user when user namespaces are
  enabled in the cluster settings), with all capabilities dropped, no privilege escalation and the
  `RuntimeDefault` seccomp profile; the stagers have a read-only root filesystem.

Install pods parse repositories in a child process without presigned requests, extract archives
with Python's `tarfile` `data` filter, keep macro imports inside the repository, and refuse data
managers, data sources, interactive tools, tools with `<code>` files or dynamic options, and templates
that use `$__app__`.

## Dataset contents

Dataset contents never run as active content on the site's origin:

- Previews are served as `text/plain`, tabular chunk JSON, or a redirect to the bucket for raster
  images.
- HTML datasets are served as documents only to navigations (frames and tabs), with a
  `sandbox` Content Security Policy without `allow-same-origin`. They run in an opaque origin with no
  access to IndexedDB, cannot fetch, cannot submit forms, and load scripts and styles only inline or
  from `https:` (and a plain-http local storage endpoint). `fetch` and `XMLHttpRequest` get their
  source as text.
- Relative subresources of a report are rewritten to presigned URLs or inlined from the dataset's
  extra files.
- Tool help is sanitized by Galaxy's client before display. Tool Shed answers are shown as text.

## Content Security Policy

The site's documents get this policy from `planet/site/_headers`; documents built by the Service
Worker get a stricter version of it (`client/src/planet/sw/csp.ts`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*;
media-src 'self' blob: https: http://localhost:* http://127.0.0.1:*; font-src 'self' data:;
connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src 'self' blob:;
worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

Scripts load only from the site, without inline scripts or `eval`; the client uses Vue's
runtime-only build, which needs neither. `connect-src` allows any `https:` host because each user
chooses the gateway and bucket, so a script that did run on the origin could send data to any HTTPS
host. Plain-http connections are limited to `localhost` and `127.0.0.1`.

The Service Worker also refuses cross-site use of the API: navigations reach only read-only document
and download routes, and requests that change state are refused when they come from another origin
or not from a script's `fetch` or `XMLHttpRequest`.

## Cluster

[Cluster setup](cluster-setup.md#security) describes each control. In short:

- The gateway holds no credential. It forwards the browser's token for an allow-list of paths: Jobs,
  pods, pod logs and events in the namespace, the API version and a permissions check. It answers
  CORS only for the origins in `allowed-origins.map`, strips impersonation headers and limits
  request rates. CORS does not authenticate: any client with the token can use the gateway.
- The `planet-client` token can create, read, watch and delete Jobs, read pods and their logs, and
  list events in the namespace, nothing else.
- The admission policy `planet-job-template` rejects Jobs whose pods use another service account or
  mount its token, mount a Secret or host path, read a Secret into their environment, share a process
  namespace or use a reserved priority class, and Jobs without a deadline of at most 7 days or a TTL.
- The namespace enforces the `restricted` Pod Security Standard.
- NetworkPolicies deny ingress to the namespace except to the gateway, and let Job pods reach only
  the cluster DNS, Garage when the cluster runs it, and public addresses; private, link-local and
  CGNAT ranges, which include the cloud metadata endpoints, are blocked.

## Presigned URLs

Each presigned URL allows one method on one object.

| URL | Expires |
| --- | --- |
| Requests in a job manifest (inputs, outputs, job files) | One hour after the Job's deadline. The deadline is the walltime plus 2 hours, at most 7 days minus 1 hour. |
| The manifest itself (`PLANET_MANIFEST_URL`) | 24 hours after dispatch by default, never after the deadline |
| Upload parts | 1 hour; the page renews them during an upload |
| Downloads, displays and report subresources from the Service Worker | 15 minutes |

`PLANET_MANIFEST_URL` is part of the Job and pod specs. Until it expires, anyone who can read Jobs or
pods in the namespace, etcd or detailed audit logs can read the manifest, and with it every
presigned request of that job.

## Backups

Snapshots are encrypted in the browser with AES-256-GCM. The key is derived from the passphrase
with PBKDF2-SHA-256, at least 600,000 iterations and a random salt; the snapshot header is
authenticated with the ciphertext. Snapshots never contain the token or the secret key. The format
is described in [`client/src/planet/backup/README.md`](../../client/src/planet/backup/README.md).

Limits:

- The leader writes snapshots without asking for the passphrase, so the derived key stays on the
  device. Anyone who can use the browser profile can use it.
- The passphrase protects snapshots from readers of the bucket, not dataset contents, which are
  stored unencrypted.
- `latest.json`, `lease.json` and the snapshot headers are not encrypted. They show the instance id,
  device ids, snapshot times and sizes, the database schema version and the number of records per
  store.
- Someone with write access to the bucket cannot read or change a snapshot, but can delete
  snapshots or rewrite `latest.json`.
- A snapshot defines the jobs, tools and settings a restoring device uses. Restore only snapshots
  written by your own devices.

## Multiple devices

Each browser profile keeps its own IndexedDB. `lease.json` in an instance's `state/` prefix names
the device that holds the instance. Only that device runs the instance's jobs, and only while it
has read the lease within the last 3 minutes. Another device takes over the lease only when the user
chooses to continue the instance there, and starts its jobs 3.5 minutes later, once the old device
has stopped them; restoring as a new instance gives the copy its own instance id and lease. Run an
instance on one device at a time, and close Planet on the old device before continuing on a new one.

## Leaked credentials

**Kubernetes token.** The holder can run containers with internet access in the namespace, within
its quota and the admission policy. They can delete Planet's Jobs, read pod logs, and read the
manifest URLs of current jobs, and through them those jobs' inputs and outputs. The token cannot read Secrets, exec
into pods or reach other namespaces. Delete the Secret `planet-client-token` to revoke it
([cluster setup](cluster-setup.md#token)).

**Bucket keys.** The holder can read, change and delete every object the key can reach: datasets,
job files and uploads, and snapshots as ciphertext. By rewriting the manifest of a job that has not
started, they can choose the command its pod runs. Revoke the key with the storage provider.

**The browser profile.** Whoever can use it can read both credentials and use the backup key.

## Reporting a vulnerability

Report vulnerabilities in Planet's code (`planet/`, `client/src/planet/`) privately through
[GitHub's vulnerability reporting](https://github.com/almahmoud/galaxy/security/advisories/new) for
this repository, not in a public issue. Vulnerabilities in Galaxy itself go to the Galaxy project, as
described in [`SECURITY.md`](../../SECURITY.md).
