"""Termination message: a JSON summary of at most 4 KiB the leader reads from pod status."""

import json
import logging
import os
from datetime import (
    datetime,
    UTC,
)
from typing import Any

log = logging.getLogger(__name__)

TERMINATION_LOG_ENV = "PLANET_TERMINATION_LOG"
DEFAULT_TERMINATION_LOG = "/dev/termination-log"
MAX_BYTES = 4096


def utcnow() -> str:
    """Naive UTC ISO timestamp with microseconds, the form Galaxy's API uses."""
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="microseconds")


def encode(summary: dict[str, Any]) -> bytes:
    summary = dict(summary)
    data = json.dumps(summary, separators=(",", ":"), default=str).encode()
    while len(data) > MAX_BYTES:
        longest = max(
            (k for k, v in summary.items() if isinstance(v, str)), key=lambda k: len(summary[k]), default=None
        )
        if longest is None or len(summary[longest]) <= 16:
            data = json.dumps({"stage": summary.get("stage"), "truncated": True}).encode()
            break
        value = summary[longest]
        summary[longest] = value[: max(16, len(value) - (len(data) - MAX_BYTES) - 16)] + "…"
        data = json.dumps(summary, separators=(",", ":"), default=str).encode()
    return data


def write(summary: dict[str, Any]) -> None:
    path = os.environ.get(TERMINATION_LOG_ENV, DEFAULT_TERMINATION_LOG)
    try:
        with open(path, "wb") as fh:
            fh.write(encode(summary))
    except OSError as e:
        log.debug("Cannot write termination message to %s: %s", path, e)
