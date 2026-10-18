"""Loading and checking the job manifest (see ``planet/docs/job-protocol.md``)."""

import copy
import json
import os
import re
import uuid
from collections.abc import Mapping
from typing import Any

from planet_runtime import PROTOCOL_VERSION
from planet_runtime.transfer import (
    PresignedRequest,
    Transfers,
)

MANIFEST_URL_ENV = "PLANET_MANIFEST_URL"
MANIFEST_FILE_ENV = "PLANET_MANIFEST_FILE"
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
KINDS = ("tool", "upload", "set_metadata", "tool_install")
_ID_TAG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_METADATA_NAME = re.compile(r"^[A-Za-z0-9_]{1,255}$")


class ManifestError(ValueError):
    pass


def load(transfers: Transfers) -> dict[str, Any]:
    """Fetch the manifest once; the URL is removed from the environment of the processes started later."""
    if url := os.environ.pop(MANIFEST_URL_ENV, None):
        raw = transfers.get_bytes(PresignedRequest(url), limit=MAX_MANIFEST_BYTES)
    elif path := os.environ.get(MANIFEST_FILE_ENV):
        with open(path, "rb") as fh:
            raw = fh.read(MAX_MANIFEST_BYTES + 1)
    else:
        raise ManifestError(f"{MANIFEST_URL_ENV} is not set")
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ManifestError("Manifest is too large")
    try:
        manifest = json.loads(raw)
    except ValueError as e:
        raise ManifestError(f"Manifest is not valid JSON: {e}") from None
    check(manifest)
    return manifest


def check(manifest: Any, kind: str | None = None) -> None:
    if not isinstance(manifest, Mapping):
        raise ManifestError("Manifest must be a JSON object")
    if manifest.get("protocol") != PROTOCOL_VERSION:
        raise ManifestError(f"Unsupported manifest protocol {manifest.get('protocol')!r}, expected {PROTOCOL_VERSION}")
    if manifest.get("kind") not in KINDS:
        raise ManifestError(f"Unknown manifest kind {manifest.get('kind')!r}")
    if kind is not None and manifest["kind"] != kind:
        raise ManifestError(f"Expected a manifest of kind '{kind}', got '{manifest['kind']}'")
    job = manifest.get("job")
    if not isinstance(job, Mapping) or not _ID_TAG.match(str(job.get("id", ""))):
        raise ManifestError("Manifest job.id is missing or not a valid identifier")
    if manifest["kind"] == "tool":
        tool = manifest.get("tool")
        if not isinstance(tool, Mapping) or not tool.get("id"):
            raise ManifestError("Manifest of kind 'tool' requires tool.id")
    if manifest["kind"] == "tool_install":
        install = manifest.get("install")
        if not isinstance(install, Mapping) or not isinstance(install.get("source"), Mapping):
            raise ManifestError("Manifest of kind 'tool_install' requires install.source")
    for record in manifest.get("outputs") or []:
        if not record.get("name"):
            raise ManifestError("Every output requires a name")
        _check_uuid(record.get("uuid"), f"output '{record['name']}'")
        _check_extra_objects(record, f"output '{record['name']}'")
    for index, slot in enumerate(manifest.get("slots") or []):
        _check_uuid(slot.get("uuid"), f"slot {index}")
        _check_extra_objects(slot, f"slot {index}")
    for key, record in (manifest.get("inputs") or {}).items():
        _check_uuid(record.get("uuid"), f"input '{key}'")
        for name in record.get("metadata_files") or {}:
            if not _METADATA_NAME.match(name):
                raise ManifestError(f"Input '{key}' has an invalid metadata file name {name!r}")


def _check_extra_objects(targets: Mapping[str, Any], what: str) -> None:
    keys = set()
    for item in targets.get("extra_objects") or []:
        if not isinstance(item, Mapping) or not isinstance(item.get("key"), str) or not item["key"]:
            raise ManifestError(f"Every extra object of {what} requires a key")
        if not item.get("request"):
            raise ManifestError(f"Extra object {item['key']!r} of {what} has no request")
        if item["key"] in keys:
            raise ManifestError(f"{what} lists extra object {item['key']!r} twice")
        keys.add(item["key"])


def _check_uuid(value: Any, what: str) -> None:
    try:
        canonical = str(uuid.UUID(str(value)))
    except ValueError:
        canonical = None
    if canonical != str(value).lower():
        raise ManifestError(f"{what} requires a uuid in canonical form")


def id_tag(manifest: Mapping[str, Any]) -> str:
    return str(manifest["job"]["id"])


def job_file(manifest: Mapping[str, Any], name: str) -> PresignedRequest | None:
    target = (manifest.get("job_files") or {}).get(name)
    return PresignedRequest.parse(target) if target else None


def limits(manifest: Mapping[str, Any]) -> Mapping[str, Any]:
    return manifest.get("limits") or {}


# Every presigned request of manifest.schema.json by its place; "*" stands for any key or index.
_TARGET_REQUESTS = (
    ("data", "put"),
    ("data", "multipart", "parts", "*"),
    ("meta",),
    ("extra",),
    ("extra_index",),
    ("sanitized",),
    ("metadata_files", "*"),
    ("extra_objects", "*", "request"),
)
REQUEST_PATHS: tuple[tuple[str, ...], ...] = (
    ("job_files", "*"),
    ("tool", "archive", "request"),
    ("inputs", "*", "data"),
    ("inputs", "*", "extra"),
    ("inputs", "*", "metadata_files", "*"),
    *(("outputs", "*", *path) for path in _TARGET_REQUESTS),
    *(("slots", "*", *path) for path in _TARGET_REQUESTS),
    ("upload", "files", "*", "request"),
    ("install", "slots", "*", "bundle", "request"),
    ("install", "slots", "*", "repo_tar", "request"),
)
# Sections tool-author code has no use for.
_NOT_FOR_TEMPLATES = ("job_files", "slots")


def without_requests(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """A copy of ``manifest`` for code that runs tool-author templates, with every request set to None.

    Requests are found by their place in the protocol only: parameters and
    bundle fields reach templates unchanged, whatever their names or values.
    """
    redacted = {key: copy.deepcopy(value) for key, value in manifest.items() if key not in _NOT_FOR_TEMPLATES}
    for path in REQUEST_PATHS:
        _clear(redacted, path)
    return redacted


def _clear(value: Any, path: tuple[str, ...]) -> None:
    head, rest = path[0], path[1:]
    if isinstance(value, dict):
        keys: list[Any] = list(value) if head == "*" else [head] if head in value else []
    elif isinstance(value, list) and head == "*":
        keys = list(range(len(value)))
    else:
        return
    for key in keys:
        if rest:
            _clear(value[key], rest)
        else:
            value[key] = None
