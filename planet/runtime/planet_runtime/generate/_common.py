"""Helpers shared by the generators."""

import json
import logging
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from pydantic import (
    BaseModel,
    TypeAdapter,
)

log = logging.getLogger(__name__)

# Characters allowed in a tool id or version segment written to disk. Galaxy tool ids and
# Tool Shed GUIDs stay well inside this set; anything else is rejected rather than escaped.
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9._+@~-]+$")


def configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # Galaxy logs expected fallbacks (missing EDAM ontology, unknown datatypes) at WARNING.
    logging.getLogger("galaxy").setLevel(logging.DEBUG if verbose else logging.ERROR)


def to_jsonable(value: Any) -> Any:
    """Convert Galaxy values (pydantic models, sets, tuples, infinities) to plain JSON data."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True)
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(to_jsonable(v) for v in value)
    if isinstance(value, float) and (math.isinf(value) or math.isnan(value)):
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def api_json(annotation: Any, value: Any) -> Any:
    """Serialize ``value`` the way FastAPI serializes a route's declared return type."""
    adapter = TypeAdapter(annotation)
    return adapter.dump_python(adapter.validate_python(value), mode="json", by_alias=True)


def write_json(path: str | os.PathLike, data: Any) -> int:
    """Write compact UTF-8 JSON atomically and return its size in bytes."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(encoded)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return len(encoded)


def safe_relative_path(*parts: str) -> Path:
    """Join tool ids and versions into a relative path, refusing traversal or unusual characters.

    ``/`` inside a part (Tool Shed GUIDs) becomes a directory separator. Static hosts
    percent-decode request paths before looking files up, so clients address these files
    by encoding each ``/``-separated segment with ``encodeURIComponent``.
    """
    segments: list[str] = []
    for part in parts:
        for segment in part.split("/"):
            if segment in ("", ".", "..") or not _SAFE_SEGMENT.match(segment):
                raise ValueError(f"Unsafe path segment {segment!r} in {part!r}")
            segments.append(segment)
    return Path(*segments)
