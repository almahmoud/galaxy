"""The ``results.json`` document every stager writes last; its upload commits the job."""

import json
import logging
from collections.abc import Mapping
from typing import Any

from galaxy.tool_util.parser.stdio import StdioErrorLevel

from planet_runtime import (
    manifest as manifest_module,
    PROTOCOL_VERSION,
)
from planet_runtime.transfer import (
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)


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
