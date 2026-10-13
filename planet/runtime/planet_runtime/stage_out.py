"""``planet-stager out``: waits for the tool container, finishes the job and uploads its results.

The manifest and stage-in's decisions come from the stager volume, which the
tool container does not mount; everything on the shared volume is the tool's.
``results.json`` is uploaded last and is the job's commit marker.
"""

import json
import logging
import os
import select
import time
import traceback
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import (
    datetime,
    UTC,
)
from pathlib import Path
from typing import Any

from galaxy.tool_util.parser.stdio import StdioErrorLevel
from galaxy.util import shrink_and_unicodify

from planet_runtime import (
    manifest as manifest_module,
    PROTOCOL_VERSION,
    termination,
)
from planet_runtime.finishing import (
    FinishResult,
    galaxy_registry,
    read_exit_code,
    ToolFinisher,
)
from planet_runtime.layout import Layout
from planet_runtime.redact import (
    error_message,
    redact,
)
from planet_runtime.results import (
    dataset_state,
    DatasetTargets,
    DatasetUploader,
    file_size,
)
from planet_runtime.transfer import (
    PresignedRequest,
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)

DEFAULT_START_TIMEOUT_SECONDS = 900.0
STARTED_POLL_SECONDS = 0.2
SAFETY_POLL_SECONDS = 30.0


@dataclass
class ToolExit:
    started: bool
    exit_code: int | None
    termination: str
    tool_start: str | None
    tool_end: str


def _mtime(path: Path) -> str | None:
    try:
        stamp = path.stat().st_mtime
    except FileNotFoundError:
        return None
    return datetime.fromtimestamp(stamp, UTC).replace(tzinfo=None).isoformat(timespec="microseconds")


def wait_for_tool(layout: Layout, start_timeout: float | None = None) -> bool:
    """Block until every process of the tool container has exited.

    The ``run-tool`` wrapper opens the ``alive`` FIFO before it creates
    ``started``, and every process it starts inherits that descriptor. Once the
    last one is gone, a non-blocking read returns end-of-file and ``poll``
    reports POLLHUP. A read is checked as well as POLLHUP because Linux only
    reports POLLHUP for writers that opened after this reader.
    Returns False if the tool did not start within ``start_timeout`` seconds
    (``DEFAULT_START_TIMEOUT_SECONDS`` when None, no limit when 0).
    """
    if start_timeout is None:
        start_timeout = DEFAULT_START_TIMEOUT_SECONDS
    fd = os.open(layout.alive, os.O_RDONLY | os.O_NONBLOCK)
    try:
        deadline = time.monotonic() + start_timeout if start_timeout else None
        while not layout.started.exists():
            if deadline is not None and time.monotonic() > deadline:
                return False
            time.sleep(STARTED_POLL_SECONDS)
        poller = select.poll()
        poller.register(fd, select.POLLIN | select.POLLHUP)
        while True:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                data = None
            if data == b"":
                return True
            poller.poll(SAFETY_POLL_SECONDS * 1000)
    finally:
        os.close(fd)


def tool_exit(layout: Layout, id_tag: str, start_timeout: float | None = None) -> ToolExit:
    started = wait_for_tool(layout, start_timeout)
    end = termination.utcnow()
    if not started:
        return ToolExit(False, None, "not_started", None, end)
    wrapper_rc = None
    if layout.rc.exists():
        try:
            wrapper_rc = int(layout.rc.read_text().strip())
        except ValueError:
            wrapper_rc = None
    exit_code = read_exit_code(layout, id_tag)
    if exit_code is None:
        exit_code = wrapper_rc
    if layout.walltime_marker.exists():
        reason = "walltime"
    elif wrapper_rc is None:
        reason = "signal"
    else:
        reason = "normal"
    return ToolExit(True, exit_code, reason, _mtime(layout.started), _mtime(layout.rc) or end)


def stream_field(text: str, path: Path) -> dict[str, Any]:
    return {"text": shrink_and_unicodify(text), "size": file_size(path)}


def output_targets(manifest: Mapping[str, Any]) -> dict[str, DatasetTargets]:
    return {record["name"]: DatasetTargets.parse(record) for record in manifest.get("outputs") or []}


def collection_elements(collection, slot_of: Mapping[int, int], output_of: Mapping[int, str]) -> list[dict[str, Any]]:
    elements = []
    for element in collection.elements:
        entry: dict[str, Any] = {"element_identifier": element.element_identifier}
        if element.child_collection is not None:
            entry["collection_type"] = element.child_collection.collection_type
            entry["elements"] = collection_elements(element.child_collection, slot_of, output_of)
        elif element.hda is not None:
            if id(element.hda) in slot_of:
                entry["slot"] = slot_of[id(element.hda)]
            elif id(element.hda) in output_of:
                entry["output"] = output_of[id(element.hda)]
        if element.columns:
            entry["columns"] = element.columns
        elements.append(entry)
    return elements


def publish_datasets(
    manifest: Mapping[str, Any],
    uploader: DatasetUploader,
    result: FinishResult,
    errors: list[str],
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Upload declared, discovered and collection outputs; returns their result entries."""
    targets = output_targets(manifest)
    outputs: dict[str, Any] = {}
    output_of: dict[int, str] = {}
    for name, hda in result.outputs.items():
        output_of[id(hda)] = name
        state = dataset_state(hda, result.state, id(hda) not in result.failed_metadata)
        try:
            outputs[name] = uploader.upload(hda, targets[name], state)
        except TransferError as e:
            errors.append(redact(f"Uploading output '{name}' failed: {e}"))
            raise

    slots = manifest.get("slots") or []
    discovered: list[dict[str, Any]] = []
    slot_of: dict[int, int] = {}
    for index, item in enumerate(result.discovered):
        if index >= len(slots):
            errors.append(f"{len(result.discovered) - index} discovered datasets exceed the slot pool")
            break
        slot = slots[index]
        slot_of[id(item.hda)] = index
        state = dataset_state(item.hda, result.state, id(item.hda) not in result.failed_metadata)
        record = uploader.upload(
            item.hda,
            DatasetTargets.parse(slot),
            state,
            uuid=slot["uuid"],
            extra={
                "slot": index,
                "output": item.output,
                "designation": item.designation,
                "collection": item.collection,
                "element_identifiers": item.element_identifiers,
            },
        )
        discovered.append(record)

    collections = {}
    for name, hdca in result.collections.items():
        collection = hdca.collection
        collections[name] = {
            "name": hdca.name,
            "collection_type": collection.collection_type,
            "populated_state": collection.populated_state,
            "populated_state_message": collection.populated_state_message,
            "elements": collection_elements(collection, slot_of, output_of),
        }
    return outputs, discovered, collections


def upload_stream(transfers: Transfers, target: PresignedRequest | None, path: Path) -> None:
    if target is None:
        return
    if path.exists():
        transfers.put_file(target, path, content_type="text/plain; charset=utf-8")
    else:
        transfers.put_bytes(target, b"", content_type="text/plain; charset=utf-8")


def base_results(manifest: Mapping[str, Any], kind: str, state: str) -> dict[str, Any]:
    empty_stream = {"text": "", "size": 0}
    return {
        "protocol": PROTOCOL_VERSION,
        "kind": kind,
        "job_id": manifest["job"]["id"],
        "attempt": manifest["job"].get("attempt", 1),
        "state": state,
        "exit_code": None,
        "termination": "normal",
        "command_line": None,
        "command_version": None,
        "job_messages": [],
        "tool_stdout": dict(empty_stream),
        "tool_stderr": dict(empty_stream),
        "job_stdout": dict(empty_stream),
        "job_stderr": dict(empty_stream),
        "filtered_outputs": [],
        "outputs": {},
        "discovered": [],
        "output_collections": {},
        "errors": [],
    }


def internal_message(description: str) -> dict[str, Any]:
    return {"type": "internal", "desc": description, "code_desc": None, "error_level": StdioErrorLevel.FATAL}


def read_state(layout: Layout) -> dict[str, Any]:
    """Load stage-in's state and remove it, so no request is left on disk while the tool's files are read."""
    with open(layout.state_file, "rb") as fh:
        state = json.load(fh)
    layout.state_file.unlink()
    if not isinstance(state, dict):
        raise manifest_module.ManifestError("Stage-in state is not a JSON object")
    manifest_module.check(state.get("manifest"), "tool")
    return state


def finish_tool_job(
    state: Mapping[str, Any], layout: Layout, transfers: Transfers, exit_info: ToolExit, results: dict[str, Any]
) -> None:
    """Run Galaxy's finishing and upload every dataset; fills ``results``."""
    manifest = state["manifest"]
    plans = state.get("outputs") or {}
    result = ToolFinisher(
        manifest,
        layout,
        {name: plan.get("format") for name, plan in plans.items()},
        {name for name, plan in plans.items() if plan.get("filtered")},
        exit_info.exit_code,
        exit_info.termination,
        input_dataset_keys=state.get("input_datasets"),
        input_ext=state.get("input_ext") or "data",
        output_labels={name: plan.get("label") for name, plan in plans.items()},
    ).run()
    results.update(
        {
            "state": result.state,
            "command_line": state.get("command_line"),
            "command_version": result.command_version,
            "job_messages": result.job_messages,
            "tool_stdout": stream_field(result.tool_stdout, layout.outputs / "tool_stdout"),
            "tool_stderr": stream_field(result.tool_stderr, layout.outputs / "tool_stderr"),
            "job_stderr": {"text": shrink_and_unicodify(result.job_stderr), "size": len(result.job_stderr.encode())},
            "filtered_outputs": sorted(name for name, plan in plans.items() if plan.get("filtered")),
        }
    )
    if result.traceback:
        results["traceback"] = redact(result.traceback)
    uploader = DatasetUploader(transfers, layout.stager, layout.root)
    results["outputs"], results["discovered"], results["output_collections"] = publish_datasets(
        manifest, uploader, result, results["errors"]
    )
    upload_stream(transfers, manifest_module.job_file(manifest, "stdout"), layout.outputs / "tool_stdout")
    upload_stream(transfers, manifest_module.job_file(manifest, "stderr"), layout.outputs / "tool_stderr")


def run(layout: Layout, transfers: Transfers) -> int:
    stage_out_start = termination.utcnow()
    try:
        state = read_state(layout)
    except (OSError, ValueError) as e:
        log.error("Cannot load stage-in's state: %s", e)
        termination.write({"stage": "out", "state": "error", "results": "failed", "error": str(e)})
        return 1

    manifest = state["manifest"]
    limits = manifest_module.limits(manifest)
    try:
        # Loaded while the tool runs rather than after it; finishing reports a failure.
        galaxy_registry()
    except Exception:
        log.debug("Loading the datatypes registry failed", exc_info=True)
    exit_info = tool_exit(layout, manifest_module.id_tag(manifest), limits.get("start_timeout_seconds"))
    log.info("Tool finished: termination=%s exit_code=%s", exit_info.termination, exit_info.exit_code)

    results = base_results(manifest, "tool", "error")
    results.update(exit_code=exit_info.exit_code, termination=exit_info.termination)
    ok = True
    try:
        finish_tool_job(state, layout, transfers, exit_info, results)
    except TransferError as e:
        ok = False
        results["state"] = "error"
        results["errors"].append(redact(str(e)))
        results["job_messages"].append(internal_message(redact(f"Uploading job results failed: {e}")))
    except Exception as e:
        log.exception("Finishing the job failed")
        ok = False
        results["state"] = "error"
        results["errors"].append(error_message(e))
        results["traceback"] = redact(traceback.format_exc())
        results["job_messages"].append(internal_message("Finishing the job failed in the pod."))

    results["timings"] = {
        "tool_start": exit_info.tool_start,
        "tool_end": exit_info.tool_end,
        "stage_out_start": stage_out_start,
        "stage_out_end": termination.utcnow(),
    }
    uploaded = publish_results(transfers, manifest, results)
    errors = results["errors"]
    termination.write(
        {
            "stage": "out",
            "state": results["state"],
            "exit_code": results["exit_code"],
            "termination": results["termination"],
            "results": "uploaded" if uploaded else "failed",
            **({"error": errors[0]} if errors else {}),
        }
    )
    return 0 if ok and uploaded else 1


def publish_results(transfers: Transfers, manifest: Mapping[str, Any], results: Mapping[str, Any]) -> bool:
    target = manifest_module.job_file(manifest, "results")
    if target is None:
        return True
    try:
        transfers.put_bytes(target, json.dumps(results, default=str).encode(), content_type="application/json")
        return True
    except TransferError as e:
        log.error("Uploading results.json failed: %s", e)
        return False
