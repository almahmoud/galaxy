"""``planet-stager in``: the init container of a tool job.

Fetches the tool directory and inputs, evaluates the command with Galaxy's
templating, writes ``prepare.json`` and prepares the tool container's scripts.
"""

import hashlib
import json
import logging
import os
import subprocess
import sys
import tarfile
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from planet_runtime import (
    isolation,
    manifest as manifest_module,
    PROTOCOL_VERSION,
    termination,
)
from planet_runtime.jobscript import (
    build_command,
    DEFAULT_SHELL,
    job_script,
    run_tool_script,
    tool_script,
    work_dir_outputs,
    write_executable,
)
from planet_runtime.layout import (
    ensure_empty_file,
    Layout,
)
from planet_runtime.redact import (
    error_message,
    redact,
)
from planet_runtime.template_worker import RESULT_PREFIX
from planet_runtime.tool import normalize as normalize_tool
from planet_runtime.transfer import (
    PresignedRequest,
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)

DOWNLOAD_CONCURRENCY = 4
TEMPLATE_TIMEOUT_SECONDS = 600


class StageInError(Exception):
    def __init__(self, phase: str, message: str):
        super().__init__(message)
        self.phase = phase


def prepare_layout(layout: Layout) -> None:
    for directory in [*layout.directories(), *layout.stager_directories()]:
        directory.mkdir(parents=True, exist_ok=True)
    if not layout.alive.exists():
        os.mkfifo(layout.alive, 0o600)


def extract_tar(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(destination, filter="data")


def archive_sha256(tool: Mapping[str, Any]) -> str | None:
    """Expected digest of the tool archive: its own, else the bundle's ``source.repo_tar``."""
    archive = tool.get("archive") or {}
    repo_tar = (tool.get("source") or {}).get("repo_tar") or {}
    return archive.get("sha256") or repo_tar.get("sha256")


def fetch_tool_directory(transfers: Transfers, layout: Layout, tool: Mapping[str, Any]) -> None:
    archive = tool.get("archive")
    if not archive:
        return
    path = layout.stager / "tool.tar"
    transfers.download(PresignedRequest.parse(archive["request"]), path)
    if expected := archive_sha256(tool):
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise StageInError("tool directory", "Tool archive checksum does not match")
    extract_tar(path, layout.tool_directory)
    path.unlink()


def fetch_inputs(transfers: Transfers, layout: Layout, inputs: Mapping[str, Mapping[str, Any]]) -> None:
    jobs = []
    for record in inputs.values():
        uuid = record["uuid"]
        if record.get("data"):
            jobs.append((PresignedRequest.parse(record["data"]), layout.input_path(uuid), record.get("size"), None))
        else:
            ensure_empty_file(layout.input_path(uuid))
        if record.get("extra"):
            jobs.append(
                (
                    PresignedRequest.parse(record["extra"]),
                    layout.stager / f"extra-{uuid}.tar",
                    None,
                    layout.input_extra_files(uuid),
                )
            )
        for name, request in (record.get("metadata_files") or {}).items():
            jobs.append((PresignedRequest.parse(request), layout.input_metadata_file(uuid, name), None, None))

    def fetch(job) -> None:
        request, destination, size, extract_to = job
        transfers.download(request, destination, expected_size=size)
        if extract_to is not None:
            extract_tar(destination, extract_to)
            destination.unlink()

    with ThreadPoolExecutor(max_workers=DOWNLOAD_CONCURRENCY) as pool:
        list(pool.map(fetch, jobs))


class TemplateWorker:
    """The child process that runs tool-author code and never sees a presigned request.

    It starts before the downloads, so its imports run meanwhile, and gets the
    manifest without requests once they are done. Processes it leaves running
    are killed by the ``isolation.contained_children`` block around it.
    """

    def __init__(self, layout: Layout):
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in (manifest_module.MANIFEST_URL_ENV, manifest_module.MANIFEST_FILE_ENV)
        }
        environment["PLANET_ROOT"] = str(layout.root)
        environment["PLANET_STAGER_ROOT"] = str(layout.stager)
        self.process = subprocess.Popen(
            [sys.executable, "-m", "planet_runtime.template_worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
            cwd=layout.job,
        )

    def __enter__(self) -> "TemplateWorker":
        return self

    def __exit__(self, *exc_info) -> None:
        if self.process.poll() is None:
            self.process.kill()
            self.process.communicate()

    def evaluate(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        try:
            stdout, stderr = self.process.communicate(
                json.dumps(manifest_module.without_requests(manifest)), timeout=TEMPLATE_TIMEOUT_SECONDS
            )
        except subprocess.TimeoutExpired:
            raise StageInError(
                "templating", f"Template evaluation did not finish within {TEMPLATE_TIMEOUT_SECONDS} seconds"
            ) from None
        for line in reversed(stdout.splitlines()):
            if line.startswith(RESULT_PREFIX):
                result = json.loads(line[len(RESULT_PREFIX) :])
                break
        else:
            detail = stderr.strip().splitlines()[-1:] or [f"exit code {self.process.returncode}"]
            raise StageInError("templating", f"Template evaluation failed: {detail[0]}")
        if not result.pop("ok"):
            raise StageInError(result["phase"], result["message"])
        return result


def check_volumes(layout: Layout) -> None:
    root, stager = layout.root.resolve(), layout.stager.resolve()
    if root == stager or root in stager.parents or stager in root.parents:
        raise StageInError("stage-in", f"The stager volume {layout.stager} must be separate from {layout.root}")


def write_state(layout: Layout, state: Mapping[str, Any]) -> None:
    """Write stage-out's state to a stager volume cleared of anything the template evaluation left there."""
    isolation.clear_directory(layout.stager)
    for directory in layout.stager_directories():
        directory.mkdir(parents=True, exist_ok=True)
    fd = os.open(layout.state_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(state, fh)


def evaluate_tool_job(
    manifest: Mapping[str, Any], layout: Layout, transfers: Transfers, worker: TemplateWorker
) -> dict[str, Any]:
    """Download the tool directory and the inputs, then evaluate the templates in ``worker``."""
    check_volumes(layout)
    fetch_tool_directory(transfers, layout, normalize_tool(manifest["tool"]))
    fetch_inputs(transfers, layout, manifest.get("inputs") or {})
    return worker.evaluate(manifest)


def write_tool_job(manifest: Mapping[str, Any], layout: Layout, evaluation: Mapping[str, Any]) -> dict[str, Any]:
    """Write what the tool container runs and stage-out's state; returns the ``prepare.json`` fields.

    Called once the template worker and everything it started are gone.
    """
    tool = normalize_tool(manifest["tool"])
    job = manifest["job"]
    id_tag = manifest_module.id_tag(manifest)
    shell = job.get("shell") or DEFAULT_SHELL

    output_definitions = tool.get("outputs") or {}
    produced = []
    for record in manifest.get("outputs") or []:
        plan = evaluation["outputs"].get(record["name"]) or {}
        if plan.get("filtered"):
            continue
        definition = output_definitions.get(record["name"]) or {}
        if definition.get("precreate_directory"):
            layout.output_extra_files(record["uuid"]).mkdir(parents=True, exist_ok=True)
        produced.append((definition, record["uuid"]))

    command_line = evaluation["command_line"]
    full_command = f"{evaluation['version_command_line'] or ''}{command_line}"
    write_executable(layout.tool_script, tool_script(full_command, shell, bool(tool.get("strict_shell", False))))
    command = build_command(layout, full_command, shell, id_tag, work_dir_outputs(layout, produced))
    write_executable(
        layout.job_script(id_tag),
        job_script(
            layout,
            command,
            shell,
            evaluation["environment_variables"],
            preserve_python_environment=bool(tool.get("requires_galaxy_python_environment", False)),
        ),
    )
    write_executable(
        layout.run_tool,
        run_tool_script(
            layout,
            id_tag,
            shell,
            int(job.get("walltime_seconds") or 86400),
            int(job.get("slots") or 1),
            job.get("memory_mb"),
        ),
    )

    write_state(
        layout,
        {
            "id_tag": id_tag,
            "outputs": evaluation["outputs"],
            "input_datasets": evaluation["input_datasets"],
            "input_ext": evaluation["input_ext"],
            "command_line": command_line,
            "manifest": manifest,
        },
    )
    return {
        "command_line": command_line,
        "version_command": evaluation["version_command_line"],
        "outputs": evaluation["outputs"],
        "environment": [variable["name"] for variable in evaluation["environment_variables"]],
        "configfiles": evaluation["config_files"],
    }


def run(layout: Layout, transfers: Transfers) -> int:
    started = termination.utcnow()
    prepare: dict[str, Any] = {"protocol": PROTOCOL_VERSION, "state": "ok", "errors": []}
    manifest: Mapping[str, Any] | None = None
    try:
        prepare_layout(layout)
        # The worker imports Galaxy while the manifest, the tool directory and the inputs download.
        with isolation.contained_children(), TemplateWorker(layout) as worker:
            manifest = manifest_module.load(transfers)
            manifest_module.check(manifest, "tool")
            prepare.update(job_id=manifest["job"]["id"], attempt=manifest["job"].get("attempt", 1))
            evaluation = evaluate_tool_job(manifest, layout, transfers, worker)
        prepare.update(write_tool_job(manifest, layout, evaluation))
    except (StageInError, TransferError, manifest_module.ManifestError, OSError) as e:
        log.error("Stage-in failed: %s", e)
        prepare["state"] = "error"
        prepare["errors"].append({"phase": getattr(e, "phase", "stage-in"), "message": redact(str(e))})
    except Exception as e:
        log.exception("Stage-in failed")
        prepare["state"] = "error"
        prepare["errors"].append({"phase": "stage-in", "message": error_message(e)})
    prepare["timings"] = {"stage_in_start": started, "stage_in_end": termination.utcnow()}

    target = manifest_module.job_file(manifest, "prepare") if manifest is not None else None
    uploaded = target is None
    if target is not None:
        try:
            transfers.put_bytes(target, json.dumps(prepare).encode(), content_type="application/json")
            uploaded = True
        except TransferError as e:
            log.error("Uploading prepare.json failed: %s", e)
    summary: dict[str, Any] = {
        "stage": "in",
        "state": prepare["state"],
        "prepare": "none" if target is None else "uploaded" if uploaded else "failed",
    }
    if prepare["errors"]:
        summary["error"] = prepare["errors"][0]["message"]
    termination.write(summary)
    return 0 if prepare["state"] == "ok" and uploaded else 1
