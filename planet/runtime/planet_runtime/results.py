"""Per-dataset results and their uploads to the dataset's presigned keys.

A dataset record is written to ``datasets/<uuid>/meta.json`` and repeated in
``results.json``. Data larger than the single-PUT limit goes up as uniform
multipart parts; the browser completes the upload. Extra files go up as one
tar with an index and, when the dataset has enough extra object URLs, also as
one object per file.
"""

import json
import logging
import math
import os
import tarfile
from collections.abc import Mapping
from concurrent.futures import (
    as_completed,
    ThreadPoolExecutor,
)
from dataclasses import (
    dataclass,
    field,
)
from pathlib import Path
from typing import Any

import galaxy.model as model
from galaxy.datatypes.text import Html

from planet_runtime import datasets
from planet_runtime.transfer import (
    PresignedRequest,
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)

SINGLE_PUT_LIMIT = int(4.99 * 1024**3)
MIN_PART_SIZE = 5 * 1024**2
MAX_PART_SIZE = 5 * 1024**3
PART_UPLOAD_CONCURRENCY = 4
EXTRA_OBJECT_CONCURRENCY = 8
SANITIZE_LIMIT = 64 * 1024**2


@dataclass(frozen=True)
class ExtraObject:
    """A presigned PUT for one extra file and the key it stores, as recorded in ``extra.json``."""

    key: str
    request: PresignedRequest

    @classmethod
    def parse(cls, value: Mapping[str, Any]) -> "ExtraObject":
        return cls(str(value["key"]), PresignedRequest.parse(value["request"]))


@dataclass
class DatasetTargets:
    """Presigned destinations of one dataset: a declared output or a slot of the discovery pool."""

    put: PresignedRequest | None = None
    parts: list[PresignedRequest] = field(default_factory=list)
    part_size: int | None = None
    meta: PresignedRequest | None = None
    extra: PresignedRequest | None = None
    extra_index: PresignedRequest | None = None
    sanitized: PresignedRequest | None = None
    metadata_files: list[PresignedRequest] = field(default_factory=list)
    extra_objects: list[ExtraObject] = field(default_factory=list)

    @classmethod
    def parse(cls, value: Mapping[str, Any]) -> "DatasetTargets":
        data = value.get("data") or {}
        multipart = data.get("multipart") or {}

        def optional(key: str, source: Mapping[str, Any] = value) -> PresignedRequest | None:
            return PresignedRequest.parse(source[key]) if source.get(key) else None

        return cls(
            put=optional("put", data),
            parts=[PresignedRequest.parse(p) for p in multipart.get("parts") or []],
            part_size=multipart.get("part_size"),
            meta=optional("meta"),
            extra=optional("extra"),
            extra_index=optional("extra_index"),
            sanitized=optional("sanitized"),
            metadata_files=[PresignedRequest.parse(p) for p in value.get("metadata_files") or []],
            extra_objects=[ExtraObject.parse(o) for o in value.get("extra_objects") or []],
        )


def file_size(path: Path | None) -> int:
    try:
        return path.stat().st_size if path is not None else 0
    except FileNotFoundError:
        return 0


def data_path(hda: model.HistoryDatasetAssociation) -> Path | None:
    if hda.dataset.purged:
        return None
    name = hda.dataset.get_file_name()
    return Path(name) if name else None


def extra_files_path(hda: model.HistoryDatasetAssociation) -> Path | None:
    try:
        path = Path(hda.dataset.extra_files_path)
    except Exception:
        return None
    return path if path.is_dir() and any(path.iterdir()) else None


def dataset_state(hda: model.HistoryDatasetAssociation, job_state: str, metadata_ok: bool) -> str:
    """Result state; ``empty`` is a successful dataset without content (Galaxy state ``ok``)."""
    if job_state == "error" or hda.state == model.HistoryDatasetAssociation.states.ERROR:
        return "error"
    if not metadata_ok or hda.state == model.HistoryDatasetAssociation.states.FAILED_METADATA:
        return "failed_metadata"
    if file_size(data_path(hda)) == 0 and extra_files_path(hda) is None:
        return "empty"
    return "ok"


def build_extra_tar(directory: Path, tar_path: Path) -> dict[str, Any]:
    """Write an uncompressed tar of ``directory`` and index the byte offset of every member's data."""
    entries: list[dict[str, Any]] = []
    tar_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as tar:
        for root, dirs, files in os.walk(directory):
            dirs.sort()
            for name in [*sorted(dirs), *sorted(files)]:
                path = Path(root) / name
                arcname = str(path.relative_to(directory))
                info = tar.gettarinfo(str(path), arcname)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                header = info.tobuf(tar.format, tar.encoding, tar.errors)
                start = tar.offset
                if info.isreg():
                    with open(path, "rb") as fh:
                        tar.addfile(info, fh)
                    entries.append({"path": arcname, "type": "file", "offset": start + len(header), "size": info.size})
                else:
                    tar.addfile(info)
                    if info.issym():
                        entries.append({"path": arcname, "type": "symlink", "target": info.linkname})
                    elif info.isdir():
                        entries.append({"path": arcname, "type": "directory"})
    return {"size": tar_path.stat().st_size, "entries": entries}


def display_peek(hda: model.HistoryDatasetAssociation) -> str | None:
    try:
        return hda.display_peek()
    except Exception:
        return None


class DatasetUploader:
    """Uploads dataset files; files must resolve inside ``allowed_root``, the pod volume."""

    def __init__(self, transfers: Transfers, scratch: Path, allowed_root: Path):
        self.transfers = transfers
        self.scratch = scratch
        self.allowed_root = allowed_root.resolve()

    def _inside(self, path: Path | None) -> bool:
        if path is None:
            return True
        resolved = path.resolve()
        return resolved == self.allowed_root or self.allowed_root in resolved.parents

    def upload_data(self, path: Path | None, targets: DatasetTargets) -> dict[str, Any]:
        size = file_size(path)
        if path is None:
            return {"mode": "none", "size": 0}
        if targets.put is not None and (size <= SINGLE_PUT_LIMIT or not targets.parts):
            if size > SINGLE_PUT_LIMIT:
                raise TransferError(f"Dataset of {size} bytes exceeds the single PUT limit and no parts were given")
            etag = self.transfers.put_file(targets.put, path)
            return {"mode": "put", "size": size, "etag": etag}
        if not targets.parts:
            raise TransferError("No upload destination for dataset data")
        part_size = targets.part_size or max(MIN_PART_SIZE, math.ceil(size / len(targets.parts)))
        if part_size > MAX_PART_SIZE or part_size * len(targets.parts) < size:
            raise TransferError(f"Dataset of {size} bytes needs more than the {len(targets.parts)} parts given")
        count = max(1, math.ceil(size / part_size))

        def upload(index: int) -> dict[str, Any]:
            offset = index * part_size
            length = min(part_size, size - offset)
            etag = self.transfers.put_file(targets.parts[index], path, offset=offset, length=length)
            return {"part_number": index + 1, "etag": etag, "size": length}

        with ThreadPoolExecutor(max_workers=PART_UPLOAD_CONCURRENCY) as pool:
            parts = list(pool.map(upload, range(count)))
        return {"mode": "multipart", "size": size, "part_size": part_size, "parts": parts}

    def upload_extra_objects(self, directory: Path, index: dict[str, Any], pool: list[ExtraObject]) -> list[str]:
        """Store every extra file as its own object too and add its ``key`` to the index; returns warnings.

        Files are matched to the pool in index order. When the pool is smaller than the
        number of files, nothing is stored separately and the files are read from the tar.
        """
        if not pool:
            return []
        files = [entry for entry in index["entries"] if entry["type"] == "file"]
        warnings = [
            f"Extra file '{entry['path']}' is larger than a single PUT allows and is only stored in extra.tar"
            for entry in files
            if entry["size"] > SINGLE_PUT_LIMIT
        ]
        files = [entry for entry in files if entry["size"] <= SINGLE_PUT_LIMIT]
        if len(files) > len(pool):
            message = f"{len(files)} extra files exceed the {len(pool)} extra object URLs given"
            return [f"{message}; extra files are only stored in extra.tar"]

        def upload(entry: dict[str, Any], target: ExtraObject) -> None:
            self.transfers.put_file(target.request, directory / entry["path"])
            entry["key"] = target.key

        failure: TransferError | None = None
        with ThreadPoolExecutor(max_workers=EXTRA_OBJECT_CONCURRENCY) as executor:
            futures = [executor.submit(upload, entry, target) for entry, target in zip(files, pool)]
            try:
                for future in as_completed(futures):
                    future.result()
            except TransferError as e:
                failure = e
                for future in futures:
                    future.cancel()
        if failure is not None:
            missing = sum(1 for entry in files if "key" not in entry)
            warnings.append(
                f"Storing extra files as separate objects failed ({failure}); "
                f"{missing} of {len(files)} are only stored in extra.tar"
            )
        return warnings

    def upload(
        self,
        hda: model.HistoryDatasetAssociation,
        targets: DatasetTargets,
        state: str,
        upload_data: bool = True,
        extra: Mapping[str, Any] | None = None,
        uuid: str | None = None,
    ) -> dict[str, Any]:
        """Upload a dataset's files and return its record; ``meta.json`` is written last.

        ``uuid`` overrides the dataset's own UUID, for datasets stored before their slot was known.
        """
        uuid = uuid or str(hda.dataset.uuid)
        path = data_path(hda)
        extra_dir = extra_files_path(hda)
        unsafe = [p for p in (path, extra_dir) if not self._inside(p)]
        if unsafe:
            # A tool may replace an output with a symlink; never upload files from outside the job volume.
            path = extra_dir = None
        record: dict[str, Any] = {
            "uuid": uuid,
            "state": state,
            "name": hda.name,
            "ext": hda.extension,
            "dbkey": hda.dbkey,
            "visible": bool(hda.visible),
            "info": hda.info or "",
            "blurb": hda.blurb,
            "peek": hda.peek,
            "display_peek": display_peek(hda),
            "metadata": datasets.external_metadata(hda),
            "metadata_files": {},
            "size": file_size(path),
            "total_size": file_size(path),
            "extra_files": None,
            "created_from_basename": hda.created_from_basename,
            "tool_version": getattr(hda, "tool_version", None),
            "sanitized": False,
            "errors": [],
            "warnings": [],
        }
        if extra:
            record.update(extra)
        if unsafe:
            record["state"] = "error"
            record["size"] = record["total_size"] = 0
            record["errors"].append("Output links to a file outside the job directory")
        if upload_data:
            record["data"] = self.upload_data(path, targets)

        metadata_paths = {k: v for k, v in datasets.metadata_files(hda).items() if self._inside(v)}
        for index, (name, metadata_path) in enumerate(sorted(metadata_paths.items())):
            if index >= len(targets.metadata_files):
                record["errors"].append(f"No upload destination for metadata file '{name}'")
                if record["state"] != "error":
                    record["state"] = "failed_metadata"
                continue
            self.transfers.put_file(targets.metadata_files[index], metadata_path)
            record["metadata_files"][name] = {"index": index, "size": file_size(metadata_path)}

        if extra_dir is not None:
            if targets.extra is None:
                record["errors"].append("No upload destination for extra files")
            else:
                tar_path = self.scratch / f"extra-{uuid}.tar"
                index = build_extra_tar(extra_dir, tar_path)
                self.transfers.put_file(targets.extra, tar_path, content_type="application/x-tar")
                record["warnings"].extend(self.upload_extra_objects(extra_dir, index, targets.extra_objects))
                record["extra_files"] = index
                record["total_size"] += sum(e.get("size", 0) for e in index["entries"])
                if targets.extra_index is not None:
                    self.transfers.put_bytes(
                        targets.extra_index, json.dumps(index).encode(), content_type="application/json"
                    )
                tar_path.unlink(missing_ok=True)

        if targets.sanitized is not None and path is not None and isinstance(hda.datatype, Html):
            if 0 < record["size"] <= SANITIZE_LIMIT:
                from galaxy.util.sanitize_html import sanitize_html

                sanitized = sanitize_html(path.read_bytes()).encode("utf-8")
                self.transfers.put_bytes(targets.sanitized, sanitized, content_type="text/html; charset=utf-8")
                record["sanitized"] = True

        if targets.meta is not None:
            self.transfers.put_bytes(
                targets.meta, json.dumps(record, default=str).encode(), content_type="application/json"
            )
        return record
