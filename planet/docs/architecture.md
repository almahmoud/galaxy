# Architecture

Planet serves Galaxy's client as static files and replaces the Galaxy server with code in the
browser and in Kubernetes job pods. This page is for contributors; the [README](../README.md) has
the overview and a diagram.

## Invariants

| # | Rule | Reason |
| --- | --- | --- |
| 1 | No tool-author code runs on the site's origin. Cheetah templates, output filters, `change_format`, expression validators and `<code>` files are evaluated only in job or install pods. The browser evaluates only a side-effect-free expression subset in TypeScript (`client/src/planet/tools/expressions.ts`), and the pod's decisions in `prepare.json` override the browser's. | Any script on the origin can read the cluster token and bucket keys in IndexedDB. |
| 2 | No Python in the browser. Galaxy's Python runs in the `planet-runtime` image, built from this checkout. | Pods and generated data (datatypes, tool bundles) come from the same Galaxy code as the client. |
| 3 | The Service Worker does only short IndexedDB work, bounded reads and redirects; it never streams whole datasets. Uploads go from the page to the bucket, downloads are 302 redirects to presigned URLs. | Browsers stop Service Worker fetch events after minutes (Chrome) or seconds (Safari, Firefox). |
| 4 | The bucket is the system of record. IndexedDB is a cache the browser may evict. | Browsers delete site storage under pressure, and Safari after 7 days without interaction. |
| 5 | A pod never needs the browser while it runs. Everything it reads or writes is in a presigned manifest, and `results.json` is written last. | Tabs close, sleep and get throttled; a job finishes and is collected later. |
| 6 | Pods never receive the token or the bucket keys, only presigned URLs for single objects, which expire at most one hour after the job's deadline. | A tool can read everything its pod receives. |

## Where code runs

| Place | Code | Role |
| --- | --- | --- |
| Static host | `planet/site/worker.js` | Serves `planet/dist`; answers unmatched non-navigation requests with Galaxy-style JSON errors. |
| Page | Galaxy's client; `client/src/planet/boot` | The boot gate loads Galaxy's bundles once the Service Worker controls the page. |
| Page (Galaxy's center frame) | `client/src/planet/ui` | Welcome and setup page: settings, connection tests, backups, tool installation. |
| Service Worker | `client/src/planet/sw`, `api`, `db`, `tools`, `upload` (session side) | Galaxy API from IndexedDB, tool forms and job submission, upload sessions, dataset display. |
| Leader tab | `client/src/planet/leader`, `jobs`, `backup` | Leader election, job dispatch and collection, backups. |
| Gateway pod | `planet/deploy/base/gateway` | nginx: CORS and the allow-list in front of the Kubernetes API. |
| Job pods | `planet/runtime` | `planet-stager`: stage-in, Galaxy finishing, uploads, metadata, tool installation. |

Every top-level Planet tab joins a leader election on the Web Lock `planet:leader`. The leader claims
an epoch in IndexedDB, and every job write checks it, so a tab that lost the lock while frozen cannot
overwrite the new leader's work. A hidden leader hands over to a visible tab, and a tab takes the
lock when the leader's heartbeat is older than 90 seconds. The leader calls the gateway from the
document because only documents can ask for the browser's local network access permission.

## Data flows

**Upload.** Galaxy's upload dialog calls Planet's replacement of Galaxy's tus module
(`client/src/planet/upload`). The page opens an upload session with the Service Worker, which creates
a multipart upload of `uploads/<id>` and signs part URLs. The page sends `Blob` slices of the file,
three parts at a time, and completes the session. Galaxy's `POST /api/tools/fetch` then creates an
upload job, queued datasets and an outbox entry in one IndexedDB transaction. The leader dispatches
an upload pod, which runs Galaxy's `data_fetch` and finishing on the downloaded file and writes the
datasets to `datasets/<uuid>/`. The leader reads `results.json` and sets the datasets' state,
metadata and peek.

**Tool run.** `POST /api/tools` runs in the Service Worker: it validates the state against the tool
bundle, expands batch and map-over runs, and writes jobs, output datasets with their UUIDs,
collections and outbox entries in one transaction. The leader waits until the inputs are ready (or
pauses the job), resolves the tool's container image, copies the tool archive into the bucket when
it is missing, writes the attempt's manifest and creates the Kubernetes Job. Stage-in renders the
command with Galaxy's code, the tool container runs it, and stage-out runs Galaxy's finishing and
uploads the outputs and `results.json`. The leader follows Jobs and pods with watches and periodic
reconciliation, ingests the results and deletes the Job. Galaxy's client sees the changes through
its usual history polling, which the Service Worker answers.

Collection operations such as zip, flatten and sort run in the Service Worker without a pod.

## Job protocol

The browser writes `jobs/<job>/a<attempt>/manifest.json`, whose presigned requests cover every
object the pod reads or writes, and creates the Job. A tool job's pod has three containers:
`stage-in` (`planet-stager in`, an init container), the tool's own image running a POSIX `sh`
wrapper, and `stage-out` (`planet-stager out`), which waits on a FIFO until every tool process has
exited. Upload, set-metadata and tool installation jobs run one `planet-stager` container.
Stage-in writes `prepare.json` with the evaluated command and output decisions; stage-out writes the
datasets and then `results.json`, which commits the attempt. Each attempt has its own keys and a
deterministic Job name. A leader that finds an attempt's Job adopts it when it was created from
that attempt's dispatch record, and otherwise deletes it and starts the next attempt. The full
contract, with JSON Schemas, is in [job-protocol.md](job-protocol.md).

## Storage layout

Keys are relative to the configured prefix (`planet` by default).

| Key | Written by | Content |
| --- | --- | --- |
| `datasets/<uuid>/data` | pods | Dataset content |
| `datasets/<uuid>/meta.json`, `meta/<n>` | pods | Dataset record, metadata files |
| `datasets/<uuid>/extra.tar`, `extra.json`, `extra/<n>` | pods | Extra files as a tar with an index, and optional single objects |
| `jobs/<job>/a<n>/` | browser, pods | `manifest.json`, `dispatch.json`, `prepare.json`, `results.json`, `stdout`, `stderr` |
| `uploads/<id>` | page | Uploaded files before their upload job |
| `tools/<id>/<version>/repo.tar` | browser | Archives of built-in tools, copied from the site and checked by SHA-256 |
| `tools/installs/<job>-a<n>/<slot>/` | install pods | `bundle.json` and `repo.tar` of installed tools |
| `state/<instance>/` | leader | Encrypted snapshots, `latest.json`, `lease.json`, `forks/<fork>.json` markers of instances forked from it |

IndexedDB (`client/src/planet/db`) holds the records Galaxy's API returns: `histories`, `hdas`,
`datasets`, `hdcas`, `collections`, `dces`, `jobs`, plus `outbox`, `tools`, `toolPanel`, `uploads`,
`kv`, `settings` and `secrets`. As in Galaxy, state lives on the dataset and every copy shares it.
Schema changes go through `db/migrations.ts` and `DB_VERSION` in `db/schema.ts`, with a matching
entry in `PAYLOAD_MIGRATIONS` (`backup/payload.ts`) so older snapshots restore.

## Durability and backups

Dataset bytes, metadata and job results are in the bucket. The browser's records (histories, job
and dataset records, installed tools, settings without secrets) exist only in IndexedDB until the
user sets a backup passphrase. With one set, the leader writes an encrypted snapshot to
`state/<instance>/snapshots/` when the records have changed, checking every 15 minutes, and keeps
the newest 10. A snapshot can be restored from the bucket or a downloaded file, on the same device
or another one; `lease.json` names the device that holds an instance, and only that device runs its
jobs. The format, keys
and restore rules are in [`client/src/planet/backup/README.md`](../../client/src/planet/backup/README.md);
the security properties are in [security.md](security.md#backups).

## Build and caching

`planet/scripts/build-site.mjs` builds `planet/dist`:

1. `gen-config.mjs` writes `/context` and `/api/configuration` from Galaxy's config schema and
   serializers, with Planet's overrides.
2. Vite builds Galaxy's client with `client/vite.config.planet.mjs` (entries `libs`, `analysis`,
   `planet-welcome`, `planet-leader`) and the Service Worker and boot script with
   `client/vite.config.planet-sw.mjs`.
3. Generated data from `planet/build/generated` (datatypes, genomes, toolbox, tool archives), the
   shells and `_headers` from `planet/site`, and `runtime.json` (the default job runtime image) are
   copied in; every tool bundle's archive is checked against its recorded size and SHA-256.
4. The build id is the short commit SHA and a hash of the built files. It is compiled into the
   bundles, and `static/planet/build.json` lists the SHA-256 of every file without a content hash
   and splits hashed chunks into `boot` and `lazy`.

The build fails on more than 20,000 files or a file over 25 MiB (Workers Static Assets limits) and
when `PLANET_RUNTIME_IMAGE` has no digest, unless `PLANET_ALLOW_UNPINNED_RUNTIME=1`.

`planet/site/_headers` marks the shells and entry files `no-cache` and hashed files under
`static/dist/chunks/` and `static/dist/assets/` immutable. The Service Worker installs into a cache
per build id, fetches unhashed files past the HTTP cache and rejects copies whose digest differs
from `build.json`, then caches the `lazy` chunks after activation. It never activates itself: the
boot gate shows a banner when a new build is waiting and activates it from its Reload button.

## Upstream mergeability

Planet is based on `galaxyproject/galaxy` `dev`. To keep merges from upstream simple:

- New code goes in new directories: `client/src/planet/` and `planet/`. Galaxy's files outside them
  are unchanged except `client/package.json` (`aws4fetch`, `idb` and the `build:planet` script) and
  `client/pnpm-lock.yaml`. Planet's two Vite configurations sit next to Galaxy's in `client/`.
- Planet's builds derive from Galaxy's: `vite.config.planet.mjs` imports `vite.config.mjs` and
  changes it through Vite seams: an alias of `vue` to the runtime-only compat build (with Galaxy's
  `@vue/compat` patch re-applied), a resolver plugin that swaps `src/utils/tusUpload.ts` for
  `src/planet/upload/tusUpload.ts`, and dropped server-only plugins. Prefer a seam to an edit of a
  Galaxy file.
- Galaxy behaviour the browser needs is ported to TypeScript under `client/src/planet/`, with the
  Galaxy function it follows named in a comment; Galaxy behaviour that needs Python runs unmodified in
  `planet-runtime`, which installs Galaxy's packages from this checkout.
