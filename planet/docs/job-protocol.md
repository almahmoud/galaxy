# Job protocol

The contract between the browser and the pods that run Planet jobs. The browser
writes a manifest to the bucket, creates a Kubernetes Job whose containers run
`planet-stager` from the `planet-runtime` image, and reads the results back
from the bucket. A pod never calls the browser.

JSON Schemas: [`planet/runtime/schemas/`](../runtime/schemas): `manifest`,
`prepare` and `results` (draft 2020-12). This page describes protocol version 1.

## Objects

All keys are relative to the configured bucket prefix.

| Key | Written by | Content |
|---|---|---|
| `jobs/<job>/manifest.json` | browser | The manifest. |
| `jobs/<job>/prepare.json` | stage-in | Evaluated command and output decisions. |
| `jobs/<job>/stdout`, `stderr` | stage-out | Full `tool_stdout` and `tool_stderr`. |
| `jobs/<job>/results.json` | pod, last | Job and dataset results; its presence commits the job. |
| `datasets/<uuid>/data` | pod | Dataset content. |
| `datasets/<uuid>/meta.json` | pod | The dataset record also found in `results.json`. |
| `datasets/<uuid>/meta/<n>` | pod | Metadata files such as `bam_index`. |
| `datasets/<uuid>/extra.tar`, `extra.json` | pod | Extra files as an uncompressed tar and its index. |

The browser chooses every key and presigns one URL per object. The manifest
carries only presigned requests, `{"url": ..., "headers": {...}}` or a bare URL
string; headers, when present, are sent with the request as given. Expiry
should cover `activeDeadlineSeconds` plus one hour.

## Pod

| Container | Image | Command |
|---|---|---|
| init `stage-in` | planet-runtime | `planet-stager in` |
| `tool` | the tool's image | `/bin/sh /planet/bin/run-tool` |
| `stage-out` | planet-runtime | `planet-stager out` |

Upload and set-metadata jobs use one container running `planet-stager upload`
or `planet-stager set-metadata`.

Stager containers need `PLANET_MANIFEST_URL` (the presigned GET of the
manifest). The tool container must not receive it. All containers mount one
volume at `/planet` and should run as uid and gid 10001.

| Path | Use |
|---|---|
| `/planet/job` | Galaxy job directory: `working`, `outputs`, `configs`, `metadata`, `tmp`, `home`, `registry.xml`, `galaxy_<job>.sh`, `tool_script.sh` |
| `/planet/inputs` | `dataset_<uuid>.dat`, `dataset_<uuid>_files/`, `metadata/<uuid>_<name>` |
| `/planet/tool` | The extracted tool archive |
| `/planet/tmp` | Mount it at `/tmp` in the tool container (`subPath: tmp`) |
| `/planet/ctl` | `alive` FIFO, `started`, `rc`, `walltime` |
| `/planet/bin/run-tool` | Tool container entry point |
| `/planet/stager`, `/planet/cache` | Stager home and cache (`HOME`, `XDG_CACHE_HOME`) |

Everything under `/planet` is writable by the tool. Stage-out never reads a
file that resolves outside `/planet`; such outputs end in state `error`.

### Stage-in

1. Downloads the manifest, the tool archive and the inputs.
2. Evaluates the command, config files and environment variables with
   Galaxy's `fill_template`, `galaxy.tools.wrappers` and sanitization, as
   `ToolEvaluator` does. Output filters, `format="input"`, `format_source`,
   `change_format` and labels are resolved as Galaxy resolves them when it
   creates a job. This tool-author code runs in a child process that gets
   the manifest without presigned requests and an environment without
   `PLANET_MANIFEST_URL`.
3. Creates every unfiltered declared output as an empty
   `outputs/dataset_<uuid>.dat`.
4. Writes Galaxy's job script (`DEFAULT_JOB_FILE_TEMPLATE.sh` with the
   Kubernetes runner's options): slots and memory statements, `HOME` and
   temporary directories, `tool_script.sh` with stdout and stderr streamed
   through `tee` into `outputs/tool_stdout` and `outputs/tool_stderr`, the exit
   code file and the `from_work_dir` copies.
5. Writes `run-tool` and the `alive` FIFO, then uploads `prepare.json`.

It exits 1 when templating or a download fails; `prepare.json` then has
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

Waits until every process of the tool container has exited (end-of-file on the
`alive` FIFO), including when the kernel or kubelet killed them. It then runs
Galaxy's finishing: the stdio check (`galaxy.tool_util.output_checker`),
`galaxy.json`, output discovery (`collect_primary_datasets`,
`collect_dynamic_outputs`), and for every dataset `set_meta(overwrite=False)`
and `set_peek` with Galaxy's datatypes. It uploads every dataset, then
`results.json`.

| Termination | Meaning |
|---|---|
| `normal` | `rc` exists; the exit code is the tool's. |
| `walltime` | The wrapper's walltime fired. |
| `signal` | All tool processes died without `rc`: memory limit, eviction or a kill. |
| `not_started` | The tool did not start within `limits.start_timeout_seconds`. |
| `oom` | Not written by the pod; the browser may use it when pod status reports `OOMKilled`. |

Every stager writes a JSON summary of at most 4 KiB to `/dev/termination-log`
(`PLANET_TERMINATION_LOG`), with `stage`, `state` and `error`; set
`terminationMessagePolicy: FallbackToLogsOnError`. Transfers retry with
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
`directory` inside it and an optional `sha256`). The stager reads the command,
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
outputs) and a pool of `metadata_files` requests used in name order.
`output_collections` gives the structure of output collections; collections
populated by discovery start with no elements. `slots` is the pool of datasets
for discovered outputs, used in order; discovering more datasets than slots
fails the job with Galaxy's `max_discovered_files` message.

`job_files` holds the PUTs of `prepare.json`, `results.json`, `stdout` and
`stderr`. `user` gives `$__user_email__` and `$__user_name__`.
`input_datasets` maps Galaxy's job input names (such as `queries_0|input2`) to
`inputs` keys; it is derived from `params` when absent. `limits` sets
`max_discovered_files`, `max_metadata_value_size` and
`start_timeout_seconds`.

`upload` (kind `upload`) is the body of `POST /api/tools/fetch`. Elements with
`"src": "planet"` and `"file": <key>` are downloaded from `upload.files` and
passed to Galaxy's `data_fetch.py` as local paths. Elements whose `object_id`
matches an output's `object_id` fill that output; other datasets (collection
targets) take slots.

`set_metadata` (kind `set_metadata`) lists `{input, output, ext, detect,
overwrite}`: the input is re-typed (`ext`) or sniffed (`detect`), then its
metadata and peek are set and written to the output's `meta` and
`metadata_files` targets; data is not re-uploaded.

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
member's data `offset` in `extra.tar`), `sanitized`, `created_from_basename`,
`tool_version` and `data` (`mode` `put`, `multipart` or `none`; for multipart
the uniform `part_size` and each part's `part_number`, `etag` and `size`, for
the browser to complete the upload).
