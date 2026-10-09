"""Transient Galaxy model objects for the datasets a job reads and writes.

Objects are never attached to a database session. Inputs point at the files
stage-in downloaded; declared outputs point at ``outputs/dataset_<uuid>.dat``.
Datasets discovered after the tool ran are stored through
:class:`LinkingDiskObjectStore`, which hard-links files instead of copying them.
"""

import os
import uuid as uuid_module
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import galaxy.model as model
from galaxy.model.metadata import (
    FileParameter,
    MetadataTempFile,
)
from galaxy.objectstore import DiskObjectStore
from galaxy.util.bunch import Bunch

from planet_runtime.layout import Layout


class LinkingDiskObjectStore(DiskObjectStore):
    """Disk object store that hard-links files from the same volume instead of copying them."""

    def _update_from_file(self, obj, file_name=None, create=False, preserve_symlinks=False, **kwargs):
        if create:
            self._create(obj, **kwargs)
        if file_name and not (preserve_symlinks and os.path.islink(file_name)) and self._exists(obj, **kwargs):
            target = self._get_filename(obj, **kwargs)
            if os.path.abspath(file_name) == os.path.abspath(target):
                return
            try:
                os.unlink(target)
                os.link(file_name, target)
                return
            except OSError:
                pass
        super()._update_from_file(obj, file_name=file_name, create=False, preserve_symlinks=preserve_symlinks, **kwargs)


def object_store(layout: Layout) -> LinkingDiskObjectStore:
    config = Bunch(
        umask=0o077,
        jobs_directory=str(layout.job),
        new_file_path=str(layout.tmp),
        object_store_check_old_style=False,
        enable_quotas=False,
        object_store_store_by="uuid",
    )
    store = LinkingDiskObjectStore(config, {"files_dir": str(layout.objects), "store_by": "uuid"})
    model.Dataset.object_store = store
    return store


def file_parameter_names(hda: model.DatasetInstance) -> list[str]:
    return [name for name, spec in hda.metadata.spec.items() if isinstance(spec.param, FileParameter)]


def load_metadata(hda: model.DatasetInstance, metadata: Mapping[str, Any], files: Mapping[str, Path]) -> None:
    """Load metadata in Galaxy's external JSON form, with metadata files at local paths."""
    file_names = set(file_parameter_names(hda))
    hda.metadata.from_JSON_dict(json_dict={k: v for k, v in metadata.items() if k not in file_names})
    for name, path in files.items():
        if name in file_names:
            temp_file = MetadataTempFile()
            temp_file._filename = str(path)
            hda._metadata[name] = temp_file


def metadata_files(hda: model.DatasetInstance) -> dict[str, Path]:
    """Local paths of metadata files (such as ``bam_index``) set on ``hda``."""
    files: dict[str, Path] = {}
    for name in file_parameter_names(hda):
        value = hda._metadata.get(name)
        if value is None:
            continue
        if isinstance(value, MetadataTempFile) or isinstance(value, model.MetadataFile):
            path = Path(value.get_file_name())
            if path.is_file():
                files[name] = path
    return files


def external_metadata(hda: model.DatasetInstance) -> dict[str, Any]:
    """Metadata in Galaxy's external JSON form without metadata file references."""
    import json

    as_dict = json.loads(hda.metadata.to_JSON_dict())
    for name in file_parameter_names(hda):
        as_dict.pop(name, None)
    return as_dict


def make_tags(tags: list[str]) -> list[Any]:
    associations = []
    for tag in tags or []:
        if tag.startswith("#"):
            tag = f"name:{tag[1:]}"
        name, _, value = tag.partition(":")
        association = model.HistoryDatasetAssociationTagAssociation(
            user_tname=name, user_value=value or None, value=(value or "").lower() or None
        )
        associations.append(association)
    return associations


def make_hda(
    record: Mapping[str, Any],
    path: Path | None,
    extension: str | None = None,
    extra_files_path: Path | None = None,
    state: str = "ok",
) -> model.HistoryDatasetAssociation:
    dataset = model.Dataset(state=state)
    dataset.uuid = uuid_module.UUID(record["uuid"]) if record.get("uuid") else uuid_module.uuid4()
    if path is not None:
        dataset.external_filename = str(path)
    if extra_files_path is not None:
        dataset.external_extra_files_path = str(extra_files_path)
    hda = model.HistoryDatasetAssociation(
        extension=extension or record.get("ext") or "data",
        dataset=dataset,
        create_dataset=False,
        flush=False,
        name=record.get("name") or "",
        visible=record.get("visible", True),
        info=record.get("info"),
        blurb=record.get("blurb"),
    )
    hda.id = record.get("id")
    hda.hid = record.get("hid")
    hda.state = state
    if record.get("created_from_basename"):
        hda.created_from_basename = record["created_from_basename"]
    hda.tags = make_tags(record.get("tags") or [])
    return hda


def make_input_hda(layout: Layout, record: Mapping[str, Any]) -> model.HistoryDatasetAssociation:
    uuid = record["uuid"]
    extra = layout.input_extra_files(uuid)
    hda = make_hda(record, layout.input_path(uuid), extra_files_path=extra)
    load_metadata(
        hda,
        record.get("metadata") or {},
        {name: layout.input_metadata_file(uuid, name) for name in (record.get("metadata_files") or {})},
    )
    if record.get("dbkey"):
        hda.dbkey = record["dbkey"]
    return hda


def make_collection(definition: Mapping[str, Any], resolve_dataset, key: str = "input") -> model.DatasetCollection:
    """Collection whose dataset elements name a dataset under ``key`` (``input`` or ``output``)."""
    collection = model.DatasetCollection(collection_type=definition["collection_type"], populated=True)
    for index, element in enumerate(definition.get("elements") or []):
        if "elements" in element:
            child: Any = make_collection(element, resolve_dataset, key)
        else:
            child = resolve_dataset(element[key])
        model.DatasetCollectionElement(
            collection=collection,
            element=child,
            element_index=index,
            element_identifier=element["element_identifier"],
            columns=element.get("columns"),
        )
    collection.element_count = len(collection.elements)
    return collection


def make_hdca(
    definition: Mapping[str, Any], resolve_dataset, key: str = "input"
) -> model.HistoryDatasetCollectionAssociation:
    hdca = model.HistoryDatasetCollectionAssociation(
        name=definition.get("name") or "", collection=make_collection(definition, resolve_dataset, key)
    )
    hdca.id = definition.get("id")
    hdca.hid = definition.get("hid")
    return hdca


class PlanetComputeEnvironment:
    """Paths the command template sees; mirrors ``galaxy.job_execution.compute_environment``."""

    def __init__(
        self,
        layout: Layout,
        galaxy_url: str = "",
        home_directory: str | None = None,
        tmp_directory: str | None = None,
        tool_directory: Path | None = None,
    ):
        self.layout = layout
        self._tool_directory = tool_directory or layout.tool_directory
        self._galaxy_url = galaxy_url
        self._home_directory = home_directory
        self._tmp_directory = tmp_directory
        self.materialized_objects: dict = {}

    def _uuid(self, dataset) -> str:
        return str(dataset.dataset.uuid)

    def input_path_rewrite(self, dataset) -> str:
        return str(self.layout.input_path(self._uuid(dataset)))

    def output_path_rewrite(self, dataset) -> str:
        return str(self.layout.output_path(self._uuid(dataset)))

    def input_extra_files_rewrite(self, dataset) -> str:
        return str(self.layout.input_extra_files(self._uuid(dataset)))

    def output_extra_files_rewrite(self, dataset) -> str:
        return str(self.layout.output_extra_files(self._uuid(dataset)))

    def input_metadata_rewrite(self, dataset, metadata_value) -> str | None:
        return None

    def unstructured_path_rewrite(self, path) -> str | None:
        return None

    def working_directory(self) -> str:
        return str(self.layout.job)

    def env_config_directory(self) -> str:
        return str(self.layout.job)

    def config_directory(self) -> str:
        return str(self.layout.configs)

    def new_file_path(self) -> str:
        return str(self.layout.tmp)

    def tool_directory(self) -> str:
        return str(self._tool_directory)

    def version_path(self) -> str:
        return str(self.layout.outputs / "COMMAND_VERSION")

    def home_directory(self) -> str | None:
        return self._home_directory

    def tmp_directory(self) -> str | None:
        return self._tmp_directory

    def galaxy_url(self) -> str:
        return self._galaxy_url

    def get_file_sources_dict(self) -> dict:
        return {}

    def sep(self) -> str:
        return "/"
