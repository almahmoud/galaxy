# Job protocol

The contract between the browser and the pods that run Planet jobs. The browser
writes a manifest to the bucket, creates a Kubernetes Job whose containers run
`planet-stager` from the `planet-runtime` image, and reads the results back
from the bucket. A pod never calls the browser.

JSON Schemas: [`planet/runtime/schemas/`](../runtime/schemas): `manifest`,
`prepare` and `results` (draft 2020-12). This page describes protocol version 1.

## Objects

All keys are relative to the configured bucket prefix. Every dispatch of a job
is an attempt, numbered from 1 (the manifest's `job.attempt`), with its own
objects under `jobs/<job>/a<attempt>/`, so a later dispatch never rewrites what
the pod of an earlier attempt reads or writes.

| Key | Written by | Content |
|---|---|---|
| `jobs/<job>/a<n>/manifest.json` | browser | The manifest of attempt `n`. |
| `jobs/<job>/a<n>/dispatch.json` | browser | What the browser created for the attempt (below). Pods never read it. |
| `jobs/<job>/a<n>/prepare.json` | stage-in | Evaluated command and output decisions. |
| `jobs/<job>/a<n>/stdout`, `stderr` | stage-out | Full `tool_stdout` and `tool_stderr`. |
| `jobs/<job>/a<n>/results.json` | pod, last | Job and dataset results; its presence commits the attempt. |
| `datasets/<uuid>/data` | pod | Dataset content. |
| `datasets/<uuid>/meta.json` | pod | The dataset record also found in `results.json`. |
| `datasets/<uuid>/meta/<n>` | pod | Metadata files such as `bam_index`. |
| `datasets/<uuid>/extra.tar`, `extra.json` | pod | Extra files as an uncompressed tar and its index. |
| `datasets/<uuid>/extra/<n>` | pod | Optional copy of each extra file as its own object. |
| `tools/installs/<job>-a<n>/<slot>/bundle.json`, `repo.tar` | install pod | Bundle and directory archive of an installed tool. |

Jobs dispatched before attempts had their own prefix kept these objects
directly under `jobs/<job>/`; the browser still reads them there when it
ingests such a job, and writes nothing there.

`dispatch.json` is the browser's record of one attempt: `protocol`, `job_id`,
`attempt`, `dispatch_id` (a random hex string, also the
`planet.dev/dispatch-id` annotation of the Kubernetes Job created from it),
`kind`, `create_time`, `walltime_seconds`, `deadline_seconds`, `slots`,
`memory_mb`, `slot_uuids` (the dataset UUIDs of the manifest's `slots`, in
order) and `multipart` (the uploads the browser created for outputs: `output`,
`uuid`, `key`, `upload_id`, `part_size`, `parts`). Ingest accepts discovered
datasets only in those slots and completes or aborts those uploads.

The browser chooses every key and presigns one URL per object. The manifest
carries only presigned requests, `{"url": ..., "headers": {...}}` or a bare URL
string; headers, when present, are sent with the request as given. Requests in
the manifest should expire `activeDeadlineSeconds` plus one hour after the Job
is created.

The manifest itself is read once, by stage-in when it starts, so its presigned
GET has a shorter expiry of its own: long enough for the pod to be scheduled and
its images pulled, 24 hours by default, configurable, and never longer than
`activeDeadlineSeconds`. If it expires while the pod is pending, stage-in fails
without `prepare.json`; the browser then creates a new attempt with a new URL.

## Pod

| Container | Image | Command |
|---|---|---|
| init `stage-in` | planet-runtime | `planet-stager in` |
| `tool` | the tool's image | `/bin/sh /planet/bin/run-tool` |
| `stage-out` | planet-runtime | `planet-stager out` |

Upload, set-metadata and tool installation jobs use one container running
`planet-stager upload`, `planet-stager set-metadata` or `planet-stager install`.

`PLANET_MANIFEST_URL` (the presigned GET of the manifest) goes to stage-in
and to the container of upload, set-metadata and tool installation jobs only; stage-out and the
tool container must not receive it. The URL is part of the Job and Pod specs,
so until it expires anyone who can get or list pods or jobs in the namespace,
read etcd or read audit logs at the `RequestResponse` level can read it, and
with it the manifest and every presigned request the manifest holds.

The pod has `restartPolicy: Never`, must not set `shareProcessNamespace`, and
has two `emptyDir` volumes. Every container should run as uid and gid 10001.

| Volume | Mounted at | Containers |
|---|---|---|
| `planet` | `/planet` | all |
| `planet-stager` | `/planet-stager` | stage-in and stage-out, or the single stager container; never the tool container |

| Path | Use |
|---|---|
| `/planet/job` | Galaxy job directory: `working`, `outputs`, `configs`, `metadata`, `tmp`, `home`, `registry.xml`, `galaxy_<job>.sh`, `tool_script.sh` |
| `/planet/inputs` | `dataset_<uuid>.dat`, `dataset_<uuid>_files/`, `metadata/<uuid>_<name>` |
| `/planet/tool` | The extracted tool archive |
| `/planet/tmp` | Mount it at `/tmp` in the tool container (`subPath: tmp`); the stagers' `TMPDIR` |
| `/planet/ctl` | `alive` FIFO, `started`, `rc`, `walltime` |
| `/planet/bin/run-tool` | Tool container entry point |
| `/planet/objects` | Datasets discovered after the tool ran |
| `/planet-stager/stage-in.json` | Stage-in's decisions and the manifest, for stage-out |
| `/planet-stager/home`, `/planet-stager/cache` | Stager `HOME` and `XDG_CACHE_HOME` (the image's defaults) |

Everything under `/planet` is writable by the tool, so the stagers keep their
own state on `/planet-stager`. Stage-out never reads a file that resolves
outside `/planet`; such outputs end in state `error`. The stagers make
themselves non-dumpable (`PR_SET_DUMPABLE`) before reading the manifest, so
other processes with the same uid cannot read their `/proc/<pid>/environ`,
memory or file descriptors.

### Stage-in

1. Downloads the manifest, the tool archive and the inputs.
2. Checks `params` with the static validators of each parameter (`regex`,
   `expression`, `in_range`, `length`, `empty_field`, `no_options`) and the
   dataset counts of data parameters, with Galaxy's validator classes and
   messages, as Galaxy does when it creates a job. A failure fails stage-in
   in phase `parameters` with Galaxy's message, for example
   `Parameter 'columns': Column ordinal positions separated by commas`;
   several are joined with `, `. Validators that need dataset metadata or
   data tables are not checked in the pod.
3. Evaluates the command, config files and environment variables with
   Galaxy's `fill_template`, `galaxy.tools.wrappers` and sanitization, as
   `ToolEvaluator` does. Output filters, `format="input"`, `format_source`,
   `change_format` and labels are resolved as Galaxy resolves them when it
   creates a job, and declared outputs are named with their label, so
   `$output.name` renders like in Galaxy. Validators and this tool-author code
   run in a child process that gets the manifest without presigned requests
   and an environment without `PLANET_MANIFEST_URL`. Requests are removed by
   their place in the manifest: `job_files` and `slots` entirely, the request
   fields of `inputs`, `outputs` and `tool.archive`; `params` and the rest of
   `tool` are passed unchanged. The child starts before the downloads, so its
   imports overlap them. Processes the child leaves running are killed when it
   exits.
4. Creates every unfiltered declared output as an empty
   `outputs/dataset_<uuid>.dat`.
5. Writes Galaxy's job script (`DEFAULT_JOB_FILE_TEMPLATE.sh` with the
   Kubernetes runner's options): slots and memory statements, `HOME` and
   temporary directories, `tool_script.sh` with stdout and stderr streamed
   through `tee` into `outputs/tool_stdout` and `outputs/tool_stderr`, the exit
   code file and the `from_work_dir` copies.
6. Writes `run-tool` and the `alive` FIFO.
7. Clears `/planet-stager`, writes `stage-in.json` there, then uploads
   `prepare.json`.

It exits 1 when validation, templating or a download fails; `prepare.json` then has
`"state": "error"` and `errors`.

### Tool container

`run-tool` is POSIX `sh` and works with busybox. It keeps the write end of the
`alive` FIFO open in every process it starts, creates `started`, runs the job
script, and writes the job script's exit status to `rc`. After
`PLANET_WALLTIME_SECONDS` (default: the manifest's `job.walltime_seconds`) it
creates `walltime`, sends SIGTERM to every process and SIGKILL 30 s later.
`GALAXY_SLOTS` and `GALAXY_MEMORY_MB` default to the manifest's `job.slots`
and `job.memory_mb` when the pod does not set them.

### Stage-out

Reads the manifest and stage-in's decisions from `/planet-stager/stage-in.json`
and deletes the file; it does not fetch the manifest. Waits until every process
of the tool container has exited (end-of-file on the `alive` FIFO), including
when the kernel or kubelet killed them. It then runs Galaxy's finishing: the
stdio check (`galaxy.tool_util.output_checker`), `galaxy.json`, output
discovery (`collect_primary_datasets`, `collect_dynamic_outputs`), and for
every dataset `set_meta(overwrite=False)` and `set_peek` with Galaxy's
datatypes. It uploads every dataset, then `results.json`.

| Termination | Meaning |
|---|---|
| `normal` | `rc` exists; the exit code is the tool's. |
| `walltime` | The wrapper's walltime fired. |
| `signal` | All tool processes died without `rc`: memory limit, eviction or a kill. |
| `not_started` | The tool did not start within `limits.start_timeout_seconds` of stage-out starting (900 s when absent or null). |
| `oom` | Not written by the pod; the browser may use it when pod status reports `OOMKilled`. |

Every stager writes a JSON summary of at most 4 KiB to `/dev/termination-log`
(`PLANET_TERMINATION_LOG`), with `stage`, `state` and `error`; set
`terminationMessagePolicy: FallbackToLogsOnError`. Termination messages, logs
and the `errors` and `traceback` the stagers report carry no presigned
request: URL queries with SigV4 parameters and stray `X-Amz-*` or
`Signature=` values are replaced by `[redacted]`. Transfers retry with
exponential backoff on network errors, 408, 425, 429 and 5xx, for up to 10
minutes in stage-in and 30 minutes otherwise. A stager exits 0 when it
uploaded its result document, whatever the job's state.

## Manifest

```json
{
  "protocol": 1,
  "kind": "tool",
  "job": {"id": "f2db41a1fa8ec1d3", "attempt": 1, "walltime_seconds": 3600, "slots": 2, "memory_mb": 4096, "shell": "/bin/bash"},
  "tool": {"id": "cat1", "version": "1.0.0", "profile": "21.01", "command": "cat '$input1' > '$out_file1'", "inputs": [...], "outputs": {...}, "stdio": {...}},
  "params": {"input1": {"src": "hda", "key": "a1"}},
  "inputs": {"a1": {"uuid": "...", "hid": 1, "name": "x.bed", "ext": "bed", "dbkey": "hg38", "metadata": {...}, "data": {"url": "..."}}},
  "outputs": [{"name": "out_file1", "uuid": "...", "hid": 2, "data": {"put": {"url": "..."}}, "meta": {"url": "..."}, "metadata_files": [...]}],
  "slots": [{"uuid": "...", "data": {"put": {"url": "..."}}, "meta": {"url": "..."}}],
  "job_files": {"prepare": {...}, "results": {...}, "stdout": {...}, "stderr": {...}},
  "user": {"email": "user@example.org", "username": "user"}
}
```

`kind` is `tool`, `upload`, `set_metadata` or `tool_install`.

`tool` is the tool's bundle ([tool-bundle.md](tool-bundle.md)) as the generator
wrote it, plus `archive`: the tar of the tool directory (`request`, the tool's
`directory` inside it and an optional `sha256`, which defaults to the bundle's
`source.repo_tar.sha256`). Stage-in checks the digest and extracts the tar with
the `data` filter of Python's `tarfile`. The stager reads the command,
config files, environment variables, version command, `profile`,
`python_template_version`, `options.sanitize`, `template_macro_params`,
`stdio`, `outputs` (with `filters`, `change_format` and
`precreate_directory`), `home_target`, `tmp_target`, `tmp_directory_vars`,
`provided_metadata` and the `inputs` tree. Select parameters may carry
`option_fields`, the columns of the selected dynamic options by value, which
the browser resolves for `$param.fields.<column>`.

`params` is the job state in Galaxy's basic form. Data values are
`{"src": "hda", "key": <inputs key>}`; collection values are
`{"src": "hdca", "key": <collections key>}`. `dbkey`, `chromInfo`,
`__input_ext` and `<name>|__identifier__` are computed like Galaxy computes
them when absent.

`inputs` describes each input dataset: `uuid`, `id`, `hid`, `name`, `ext`,
`dbkey`, `tags`, `element_identifier`, `metadata` (Galaxy's external JSON
form), and requests for `data`, `extra` (an `extra.tar`) and
`metadata_files` by name. `collections` describes input collections with
nested `elements` that name `inputs` keys.

`outputs` lists the declared outputs, each with a pre-allocated `uuid`,
provisional `ext` and its targets: `data.put` (up to 4.99 GiB) and/or
`data.multipart` (presigned UploadPart URLs of an upload the browser created,
and optionally the `part_size` to use; by default max(5 MiB, size / parts)),
`meta`, `extra`, `extra_index`, `sanitized` (sanitized copy of HTML
outputs), a pool of `metadata_files` requests used in name order and an
optional `extra_objects` pool. `output_collections` gives the structure of
output collections; collections populated by discovery start with no elements.
`slots` is the pool of datasets for discovered outputs, used in order;
discovering more datasets than slots fails the job with Galaxy's
`max_discovered_files` message. Slots take the same targets as outputs.

`extra_objects` lists `{"key", "request"}` pairs: a presigned PUT and the
object key it writes, relative to the bucket prefix and inside the dataset's
own `datasets/<uuid>/` (for example `datasets/<uuid>/extra/0`). Keys must be
unique. The pod still uploads `extra.tar`, then stores each extra file up to
4.99 GiB as its own object, taking pool entries in `extra.json` entry order, and
copies the key into the file's entry. The service worker serves files that
have a key through presigned URLs, which media and members over 2 MiB inside
HTML reports need, and reads other members from the tar by range. A dataset with more extra files than pool entries keeps the tar
only and its record gets a `warnings` entry; so does a file over 4.99 GiB. A
failed upload of one object leaves the remaining files tar-only with a warning
and does not fail the job. Each pool entry adds about 0.5 KiB to the manifest,
which may not exceed 64 MiB, so give pools to outputs that may hold reports or
media, sized for their expected file count.

`job_files` holds the PUTs of `prepare.json`, `results.json`, `stdout` and
`stderr`. `user` gives `$__user_email__` and `$__user_name__`.
`input_datasets` maps Galaxy's job input names (such as `queries_0|input2`) to
`inputs` keys; it is derived from `params` when absent. `limits` sets
`max_discovered_files`, `max_metadata_value_size` and
`start_timeout_seconds` (900 when absent or null, 0 for no limit).

`upload` (kind `upload`) is the body of `POST /api/tools/fetch`. Elements with
`"src": "planet"` and `"file": <key>` are downloaded from `upload.files` and
passed to Galaxy's `data_fetch.py` as local paths. Elements whose `object_id`
matches an output's `object_id` fill that output; other datasets (collection
targets) take slots.

`set_metadata` (kind `set_metadata`) lists `{input, output, ext, detect,
overwrite}`: the input is re-typed (`ext`) or sniffed (`detect`), then its
metadata and peek are set and written to the output's `meta` and
`metadata_files` targets; data is not re-uploaded.

`install` (kind `tool_install`) is described under Tool installation.

## Tool installation

A `tool_install` job installs the tools of one repository revision. Its pod
reads the repository, parses every tool with Galaxy's parser and the bundle
generator, and stores a bundle and an archive per tool it can run. The browser
never reads the repository or its tool XML.

```json
"install": {
  "source": {"type": "toolshed", "tool_shed_url": "https://toolshed.g2.bx.psu.edu", "owner": "iuc", "name": "datamash_ops", "changeset_revision": "aaafc0ac4dd2"},
  "panel_section": {"id": "planet_installed", "name": "Installed tools"},
  "slots": [{"bundle": {"key": "tools/installs/<job>-a1/0/bundle.json", "request": {...}}, "repo_tar": {"key": "tools/installs/<job>-a1/0/repo.tar", "request": {...}}}]
}
```

`source` is a Tool Shed changeset (`changeset_revision`, 12 to 40 hexadecimal
digits) or a GitHub commit, `{"type": "github", "repository": "<owner>/<name>",
"ref": <40-digit commit SHA>, "path": <directory, "" for the root>}`.
`slots` are used in order, one per installed tool; the key of `repo_tar` is
written into the bundle as `source.repo_tar.path`. `job_files` only needs
`results`.

The stager:

1. Fetches the repository. A Tool Shed changeset is cloned with
   `hg clone --noupdate --rev <changeset> <tool shed>/repos/<owner>/<name>`, with
   an empty `HGRCPATH`, subrepositories disabled and no manifest URL in the
   environment; the checked-out changeset must start with the requested one, and
   `hg archive` writes its files. A GitHub commit is read from
   `https://codeload.github.com/<repository>/tar.gz/<ref>`, whose pax header
   must name the commit. Clones are tried three times, downloads retried like
   other transfers.
2. Extracts the files with the `data` filter of `tarfile`, without `test-data`,
   `.hg`, `.git` and `.hg_archival.txt`, special files or links the filter
   refuses, and refuses more than 1 GiB or 100,000 files.
3. Runs a child process that gets no presigned request and an environment
   without `PLANET_MANIFEST_URL`. It finds every tool XML file below the
   repository root or `path` in path order, expands macros (imports must stay
   inside the repository) and builds each bundle with the generator. Ids are
   `<tool shed host>/repos/<owner>/<name>/<tool id>/<version>` or
   `github.com/repos/<owner>/<repository>/<tool id>/<version>`. A tool's archive
   is the tar of its directory without `test-data`, with links that lead outside
   the repository left out.
4. Refuses tools Planet cannot run: tool types other than ordinary tools (data
   managers, data sources, interactive tools), tools with `<code>` files or
   `dynamic_options`, and templates that use `$__app__`. A tool without a
   container is not refused; its image is resolved from its requirements when
   it runs.
5. Uploads each tool's `repo.tar`, then its `bundle.json`, to the next slot, and
   writes `results.json`.

Besides the common fields, `results.json` holds `install` (`source`,
`repository_url`, the full `revision` and `warnings`) and `tools`, one entry
per tool file: `path`, `id`, `old_id`, `version`, `name`, `description`,
`state` (`installed`, `rejected` or `failed`), `slot`, `bundle` and `repo_tar`
(`sha256` and `size` of the uploaded objects), `errors` and `warnings`. `state`
is `ok` when at least one tool was installed. `job_stdout` lists the outcome of
each tool and `job_messages` the reasons a tool was not installed.

At ingest the browser stores an installed tool only when the bundle in its slot
matches the reported digest and size, its id starts with the source's prefix,
its `source.repo_tar` names the slot's archive with the reported digest and the
archive has that size; other tools are reported as `failed`. Tool jobs of
installed tools read the archive from that key, and stage-in checks its
SHA-256. Uninstalling a tool keeps its objects.

## prepare.json

```json
{"protocol": 1, "job_id": "...", "attempt": 1, "state": "ok", "command_line": "...", "version_command": null,
 "outputs": {"out_file1": {"filtered": false, "format": "bed", "label": "Concatenate on dataset 1"}},
 "environment": ["HOME", "TMPDIR", "TMP", "TEMP"], "configfiles": [], "errors": [], "timings": {...}}
```

Output decisions in `prepare.json` override the browser's provisional ones.

## results.json

| Field | Content |
|---|---|
| `state` | Galaxy job state, `ok` or `error`. |
| `exit_code`, `termination` | See Stage-out. |
| `job_messages` | Galaxy job messages (exit code, regex, discovery, termination). |
| `tool_stdout`, `tool_stderr`, `job_stdout`, `job_stderr` | `{text, size}`; `text` is shortened to 32 KiB like Galaxy's `set_streams`. |
| `command_line`, `command_version` | Evaluated command and version output. |
| `outputs` | Dataset records by declared output name. |
| `filtered_outputs` | Declared outputs removed by a filter. |
| `discovered` | Dataset records with `slot`, `output`, `designation`, `collection` and `element_identifiers`. |
| `output_collections` | `collection_type`, `populated_state` and nested `elements` referring to a `slot` or an `output`. |
| `errors`, `traceback`, `timings` | Stager diagnostics. |

A dataset record has `uuid`, `state` (`ok`, `error`, `failed_metadata`, or
`empty` for a successful dataset without content, whose Galaxy state is `ok`),
`name`, `ext`, `dbkey`, `visible`, `info`, `blurb`, `peek`, `display_peek`,
`metadata` (external JSON form without metadata files), `metadata_files`
(`{name: {index, size}}`, the index into the dataset's `metadata_files`
targets), `size`, `total_size`, `extra_files` (`{size, entries}` with each
member's data `offset` in `extra.tar` and, for files also stored on their own,
its `key`), `sanitized`, `created_from_basename`, `tool_version`, `errors`,
`warnings` and `data` (`mode` `put`, `multipart` or `none`; for multipart the
uniform `part_size` and each part's `part_number`, `etag` and `size`, for the
browser to complete the upload).
