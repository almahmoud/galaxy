"""Galaxy's job finishing, run in the pod.

This follows the extended metadata path of
``galaxy.metadata.set_metadata.set_metadata_portable``: the stdio check, tool
provided metadata (``galaxy.json``), output discovery through Galaxy's
``collect_primary_datasets`` and ``collect_dynamic_outputs``, and for every
declared output ``set_meta`` (``overwrite=False``), ``set_peek``, blurb and
info. Discovered datasets go through Galaxy's own ``ModelPersistenceContext``,
which stores them in a local object store and sets their metadata.
"""

import logging
import os
import traceback
from collections.abc import Mapping
from dataclasses import (
    dataclass,
    field,
)
from pathlib import Path
from typing import Any

import galaxy.model as model
from galaxy.exceptions import MessageException
from galaxy.job_execution.output_collect import (
    BaseJobContext,
    collect_dynamic_outputs,
    collect_primary_datasets,
    collect_shrinked_content_from_path,
    MetadataSourceProvider,
    read_exit_code_from,
    validate_unnamed_outputs,
)
from galaxy.job_execution.setup import TOOL_PROVIDED_JOB_METADATA_KEYS
from galaxy.metadata.set_metadata import set_meta_with_tool_provided
from galaxy.model import (
    JOB_IO_NAME_MAX_LENGTH,
    JobOutputNameTooLongError,
)
from galaxy.model.metadata import MetadataTempFile
from galaxy.model.store.discover import (
    ensure_path_in_directory,
    MaxDiscoveredFilesExceededError,
    OutputCollectionSecurityError,
    SessionlessModelPersistenceContext,
)
from galaxy.model.tags import GalaxySessionlessTagHandler
from galaxy.tool_util.output_checker import (
    check_output,
    DETECTED_JOB_STATE,
    MaxDiscoveredFilesJobMessage,
    output_discovery_job_message,
    OutputCollectionSecurityJobMessage,
)
from galaxy.tool_util.parser.output_objects import (
    ToolOutput,
    ToolOutputCollection,
)
from galaxy.tool_util.parser.stdio import (
    StdioErrorLevel,
    ToolStdioExitCode,
    ToolStdioRegex,
)
from galaxy.tool_util.provided_metadata import (
    BaseToolProvidedMetadata,
    NullToolProvidedMetadata,
    parse_tool_provided_metadata,
)
from galaxy.util import unicodify
from galaxy.util.expressions import ExpressionContext

from planet_runtime import datasets
from planet_runtime.layout import Layout
from planet_runtime.tool import normalize as normalize_tool

log = logging.getLogger(__name__)

MAX_STDIO_READ_BYTES = 100 * 10**6

# Messages Galaxy's Kubernetes runner reports for jobs the cluster terminated.
TERMINATION_MESSAGES = {
    "walltime": "Job was active longer than specified deadline",
    "oom": "Tool failed due to insufficient memory. Try with more memory.",
    "signal": "Tool was terminated before it finished, possibly because it ran out of memory or disk space.",
    "not_started": "The tool container did not start.",
}


class _SessionShim:
    """Answers ``sa_session.get(HistoryDatasetAssociation, object_id)`` for pre-created outputs."""

    def __init__(self, hdas: Mapping[Any, model.HistoryDatasetAssociation]):
        self.hdas = {str(key): hda for key, hda in hdas.items()}

    def get(self, model_class, object_id):
        return self.hdas.get(str(object_id))

    def add(self, obj):
        pass


class PlanetJobContext(SessionlessModelPersistenceContext, BaseJobContext):
    """Job context for Galaxy's discovery code that records created objects instead of exporting them."""

    def __init__(
        self,
        layout: Layout,
        object_store,
        tool_provided_metadata: BaseToolProvidedMetadata,
        final_job_state: str,
        max_discovered_files: int | float,
        job_id: str,
        tool_outputs: Mapping[str, Mapping[str, Any]],
        input_datasets: Mapping[str, Any] | None = None,
        input_dbkey: str = "?",
        existing_hdas: Mapping[Any, model.HistoryDatasetAssociation] | None = None,
    ):
        super().__init__(object_store, None, str(layout.working), allows_external_output_paths=False)
        self.tool_provided_metadata = tool_provided_metadata
        self.final_job_state = final_job_state
        self.max_discovered_files = max_discovered_files
        self.discovered_file_count = 0
        self.allows_unnamed_outputs = True
        self._job_id = job_id
        self._tool_outputs = tool_outputs
        self._input_datasets = dict(input_datasets or {})
        self._input_dbkey = input_dbkey
        self._session = _SessionShim(existing_hdas or {})
        self.created: list[model.HistoryDatasetAssociation] = []
        self.associations: dict[str, model.HistoryDatasetAssociation] = {}
        self.collections: list[Any] = []

    @property
    def sa_session(self):
        return self._session

    @property
    def tag_handler(self):
        return GalaxySessionlessTagHandler(None, galaxy_session=None)

    @property
    def input_datasets(self):
        return self._input_datasets

    @property
    def metadata_source_provider(self) -> MetadataSourceProvider:
        return MetadataSourceProvider(self._input_datasets)

    @property
    def input_dbkey(self) -> str:
        return self._input_dbkey

    @property
    def change_datatype_actions(self):
        return {}

    def output_def(self, name):
        definition = self._tool_outputs.get(name)
        if not definition or definition.get("model_class", "ToolOutput") != "ToolOutput":
            return None
        return ToolOutput.from_dict(name, definition)

    def output_collection_def(self, name):
        definition = self._tool_outputs.get(name)
        if not definition or definition.get("model_class") != "ToolOutputCollection":
            return None
        return ToolOutputCollection.from_dict(name, definition)

    def get_job_id(self):
        return self._job_id

    def job_id(self):
        return self._job_id

    def get_hdca(self, object_id):
        raise MessageException("Populating existing collections is not supported.")

    def add_output_dataset_association(self, name, dataset):
        if name and len(name) > JOB_IO_NAME_MAX_LENGTH:
            raise JobOutputNameTooLongError(
                f"Tool produced an output name that exceeds the {JOB_IO_NAME_MAX_LENGTH} character name length limit "
                f"(got {len(name)} characters), tool is likely broken"
            )
        self.associations[name] = dataset

    def add_datasets_to_history(self, datasets_to_add, for_output_dataset=None):
        for dataset in datasets_to_add:
            if all(dataset is not created for created in self.created):
                self.created.append(dataset)

    def add_dataset_collection(self, collection):
        if all(collection is not known for known in self.collections):
            self.collections.append(collection)

    def persist_library_folder(self, library_folder) -> None:
        raise MessageException("Library destinations are not supported.")


@dataclass
class DiscoveredDataset:
    hda: model.HistoryDatasetAssociation
    output: str | None = None
    designation: str | None = None
    collection: str | None = None
    element_identifiers: list[str] = field(default_factory=list)


@dataclass
class FinishResult:
    state: str
    exit_code: int | None
    termination: str
    job_messages: list[dict[str, Any]]
    tool_stdout: str
    tool_stderr: str
    job_stderr: str
    command_version: str | None
    outputs: dict[str, model.HistoryDatasetAssociation]
    discovered: list[DiscoveredDataset]
    collections: dict[str, Any]
    failed_metadata: set[int]
    traceback: str | None = None


def read_stream(path: Path) -> str:
    try:
        with open(path, "rb") as fh:
            return unicodify(fh.read(MAX_STDIO_READ_BYTES), strip_null=True)
    except FileNotFoundError:
        return ""


def load_tool_provided_metadata(layout: Layout, tool: Mapping[str, Any]) -> BaseToolProvidedMetadata:
    if tool.get("uses_tool_provided_metadata") is False:
        return NullToolProvidedMetadata()
    job_metadata = layout.working / (tool.get("provided_metadata_file") or "galaxy.json")
    ensure_path_in_directory(job_metadata, layout.working)
    return parse_tool_provided_metadata(str(job_metadata), provided_metadata_style=tool.get("provided_metadata_style"))


def set_metadata_on(
    hda: model.HistoryDatasetAssociation,
    file_dict: Mapping[str, Any],
    layout: Layout,
    max_metadata_value_size: int,
    overwrite: bool = False,
) -> None:
    """``set_meta_with_tool_provided`` with the keyword arguments Galaxy's job finishing uses."""
    set_meta_kwds = {"overwrite": overwrite, "metadata_tmp_files_dir": str(layout.metadata)}
    set_meta_with_tool_provided(hda, file_dict, set_meta_kwds, galaxy_registry(), max_metadata_value_size)


def galaxy_registry():
    from planet_runtime import galaxy_env

    return galaxy_env.registry()


def element_identifiers(collection) -> dict[int, list[str]]:
    """Map ``id(hda)`` to the element identifier path of every dataset in ``collection``."""
    paths: dict[int, list[str]] = {}

    def walk(current, prefix):
        for element in current.elements:
            identifiers = [*prefix, element.element_identifier]
            if element.child_collection is not None:
                walk(element.child_collection, identifiers)
            elif element.hda is not None:
                paths[id(element.hda)] = identifiers

    walk(collection, [])
    return paths


class ToolFinisher:
    def __init__(
        self,
        manifest: Mapping[str, Any],
        layout: Layout,
        output_formats: Mapping[str, str | None],
        filtered: set[str],
        exit_code: int | None,
        termination: str,
        input_dataset_keys: Mapping[str, str | None] | None = None,
        input_ext: str = "data",
        output_labels: Mapping[str, str | None] | None = None,
    ):
        self.manifest = manifest
        self.output_labels = dict(output_labels or {})
        self.input_dataset_keys = dict(input_dataset_keys or self.manifest.get("input_datasets") or {})
        self.input_ext = input_ext
        self.layout = layout
        self.tool = normalize_tool(manifest["tool"])
        self.output_formats = output_formats
        self.filtered = filtered
        self.exit_code = exit_code
        self.termination = termination
        limits = manifest.get("limits") or {}
        self.max_metadata_value_size = int(limits.get("max_metadata_value_size") or 0)
        self.slot_count = len(manifest.get("slots") or [])
        configured = limits.get("max_discovered_files")
        self.max_discovered_files = int(configured) if configured is not None else float("inf")
        self.registry = galaxy_registry()
        self.object_store = datasets.object_store(layout)
        MetadataTempFile.tmp_dir = str(layout.metadata)

    def _input_hdas(self) -> dict[str, model.HistoryDatasetAssociation]:
        inputs = self.manifest.get("inputs") or {}
        return {key: datasets.make_input_hda(self.layout, record) for key, record in inputs.items()}

    def _input_datasets(self, hdas) -> dict[str, Any]:
        return {name: hdas.get(key) if key is not None else None for name, key in self.input_dataset_keys.items()}

    def _output_hdas(self, input_datasets) -> dict[str, model.HistoryDatasetAssociation]:
        outputs = {}
        for record in self.manifest.get("outputs") or []:
            name = record["name"]
            if name in self.filtered:
                continue
            uuid = record["uuid"]
            extension = self.output_formats.get(name) or record.get("ext") or "data"
            hda = datasets.make_hda(record, self.layout.output_path(uuid), extension=extension, state="running")
            if label := self.output_labels.get(name):
                hda.name = label
            if isinstance(hda.id, int):
                hda.dataset.id = hda.id
            definition = (self.tool.get("outputs") or {}).get(name) or {}
            source = input_datasets.get(definition.get("metadata_source") or "")
            try:
                hda.init_meta(copy_from=source) if source is not None else hda.init_meta()
            except Exception:
                log.exception("Copying metadata from %s failed", definition.get("metadata_source"))
                hda.init_meta()
            if record.get("metadata"):
                datasets.load_metadata(hda, record["metadata"], {})
            hda.dbkey = record.get("dbkey") or hda.dbkey
            outputs[name] = hda
        return outputs

    def _output_collections(self, outputs) -> dict[str, model.HistoryDatasetCollectionAssociation]:
        collections = {}
        for name, definition in (self.manifest.get("output_collections") or {}).items():
            hdca = datasets.make_hdca(
                {**definition, "elements": definition.get("elements") or []}, lambda key: outputs[key], key="output"
            )
            collections[name] = hdca
        return collections

    def run(self) -> FinishResult:
        layout = self.layout
        tool_stdout = read_stream(layout.outputs / "tool_stdout")
        tool_stderr = read_stream(layout.outputs / "tool_stderr")
        job_messages: list[dict[str, Any]] = []
        job_stderr_lines: list[str] = []

        metadata_ok = True
        try:
            tool_provided_metadata = load_tool_provided_metadata(layout, self.tool)
        except Exception as e:
            log.warning("Invalid tool provided metadata: %s", e)
            metadata_ok = False
            tool_provided_metadata = NullToolProvidedMetadata()
            job_messages.append(_message_dict(output_discovery_job_message(unicodify(e))))

        stdio = self.tool.get("stdio") or {}
        exit_codes = [ToolStdioExitCode(d) for d in stdio.get("exit_codes") or []]
        regexes = [ToolStdioRegex(d) for d in stdio.get("regexes") or []]
        exit_code = self.exit_code
        if self.termination == "normal":
            detected, tool_stdout, tool_stderr, messages = check_output(
                regexes, exit_codes, tool_stdout, tool_stderr, exit_code if exit_code is not None else 0
            )
            job_messages.extend(_message_dict(m) for m in messages)
            ok = metadata_ok and detected == DETECTED_JOB_STATE.OK and not tool_provided_metadata.has_failed_outputs()
        else:
            message = TERMINATION_MESSAGES.get(self.termination, TERMINATION_MESSAGES["signal"])
            job_stderr_lines.append(message)
            job_messages.append(
                {"type": "internal", "desc": message, "code_desc": None, "error_level": StdioErrorLevel.FATAL}
            )
            ok = False
        final_job_state = "ok" if ok else "error"

        command_version = collect_shrinked_content_from_path(str(layout.outputs / "COMMAND_VERSION"))
        expression_context = ExpressionContext(dict(stdout=tool_stdout[:255], stderr=tool_stderr[:255]))

        input_hdas = self._input_hdas()
        input_datasets = self._input_datasets(input_hdas)
        outputs = self._output_hdas(input_datasets)
        output_collections = self._output_collections(outputs)
        dbkeys = [d.dbkey for d in input_datasets.values() if d is not None and d.dbkey not in (None, "?")]
        job_context = PlanetJobContext(
            layout,
            self.object_store,
            tool_provided_metadata,
            final_job_state,
            self.max_discovered_files,
            str((self.manifest.get("job") or {}).get("id", "")),
            self.tool.get("outputs") or {},
            input_datasets=input_datasets,
            input_dbkey=dbkeys[0] if dbkeys else "?",
        )

        traceback_text = None
        if self.termination == "normal":
            try:
                validate_unnamed_outputs(job_context)
                collect_primary_datasets(job_context, outputs, input_ext=self.input_ext)
                dynamic = {
                    name: hdca
                    for name, hdca in output_collections.items()
                    if (job_context.output_collection_def(name) is not None)
                }
                collect_dynamic_outputs(job_context, dynamic)
                output_collections.update(dynamic)
                check_slot_pool(job_context, self.slot_count)
            except (MaxDiscoveredFilesExceededError, JobOutputNameTooLongError, OutputCollectionSecurityError) as e:
                log.warning("Job failed during output discovery: %s", e)
                final_job_state = "error"
                message_type = (
                    OutputCollectionSecurityJobMessage
                    if isinstance(e, OutputCollectionSecurityError)
                    else MaxDiscoveredFilesJobMessage
                )
                job_messages.append(
                    _message_dict(
                        message_type(
                            type=(
                                "output_collection_security"
                                if isinstance(e, OutputCollectionSecurityError)
                                else "max_discovered_files"
                            ),
                            desc=str(e),
                            code_desc=None,
                            error_level=StdioErrorLevel.FATAL,
                        )
                    )
                )
            except MessageException as e:
                final_job_state = "error"
                job_messages.append(_message_dict(output_discovery_job_message(unicodify(e))))
            except Exception:
                log.exception("Unexpected failure during output discovery")
                final_job_state = "error"
                traceback_text = traceback.format_exc()
                job_messages.append(_message_dict(output_discovery_job_message()))

        failed_metadata: set[int] = set()
        for name, hda in outputs.items():
            if not self._finish_output(
                name, hda, tool_provided_metadata, final_job_state, expression_context, command_version
            ):
                failed_metadata.add(id(hda))
        for hda in job_context.created:
            if hda.state == model.HistoryDatasetAssociation.states.FAILED_METADATA:
                failed_metadata.add(id(hda))

        discovered = self._discovered(job_context, output_collections)
        return FinishResult(
            state=final_job_state,
            exit_code=exit_code,
            termination=self.termination,
            job_messages=job_messages,
            tool_stdout=tool_stdout,
            tool_stderr=tool_stderr,
            job_stderr="\n".join(job_stderr_lines),
            command_version=command_version,
            outputs=outputs,
            discovered=discovered,
            collections=output_collections,
            failed_metadata=failed_metadata,
            traceback=traceback_text,
        )

    def _finish_output(
        self,
        name: str,
        hda: model.HistoryDatasetAssociation,
        tool_provided_metadata: BaseToolProvidedMetadata,
        final_job_state: str,
        expression_context: ExpressionContext,
        version_string: str | None,
    ) -> bool:
        """The per-output block of ``set_metadata_portable`` (extended metadata)."""
        layout = self.layout
        dataset = hda.dataset
        ok = True
        if not getattr(hda, "discovered", False):
            external_filename = str(layout.output_path(str(dataset.uuid)))
            if not os.path.exists(external_filename):
                with open(external_filename, "wb"):
                    pass
            dataset.external_filename = external_filename
            extra_files = layout.output_extra_files(str(dataset.uuid))
            for location in (layout.outputs, layout.working):
                candidate = location / extra_files.name
                if candidate.exists():
                    dataset.external_extra_files_path = str(candidate)
                    break
            else:
                dataset.external_extra_files_path = str(extra_files)
            if not all(_inside(Path(p), layout.root) for p in (external_filename, dataset.external_extra_files_path)):
                # Never read files of the stage-out container through a link the tool created.
                for p in (external_filename, dataset.external_extra_files_path):
                    if os.path.islink(p):
                        os.unlink(p)
                with open(external_filename, "wb"):
                    pass
                hda.state = dataset.state = hda.states.ERROR
                hda.info = "Output links to a file outside the job directory"
        file_dict = tool_provided_metadata.get_dataset_meta(name, dataset.id, str(dataset.uuid))
        if "ext" in file_dict:
            hda.extension = file_dict["ext"]
        if not hda.state == hda.states.ERROR:
            hda.state = dataset.state = final_job_state
        try:
            set_metadata_on(hda, file_dict, layout, self.max_metadata_value_size)
        except Exception:
            log.exception("Setting metadata of output %s failed", name)
            ok = False
        meta = tool_provided_metadata.get_dataset_meta(name, dataset.id, str(dataset.uuid))
        context = ExpressionContext(meta, expression_context) if meta else expression_context
        hda.blurb = "done"
        hda.peek = "no peek"
        hda.info = hda.info or ""
        if context["stdout"].strip():
            hda.info = f"{hda.info.rstrip()}\n{context['stdout'].strip()}"
        if context["stderr"].strip():
            hda.info = f"{hda.info.rstrip()}\n{context['stderr'].strip()}"
        hda.tool_version = version_string
        if final_job_state != "error":
            try:
                hda.set_peek(line_count=context.get("line_count", None))
            except Exception:
                log.exception("Setting peek of output %s failed", name)
        for key in TOOL_PROVIDED_JOB_METADATA_KEYS:
            if key in context:
                setattr(hda, key, context[key])
        if final_job_state == "error":
            hda.blurb = "error"
            hda.visible = True
        return ok

    def _discovered(self, job_context: PlanetJobContext, collections) -> list[DiscoveredDataset]:
        by_association = {id(hda): name for name, hda in job_context.associations.items()}
        identifiers: dict[int, tuple[str, list[str]]] = {}
        for collection_name, hdca in collections.items():
            for hda_id, path in element_identifiers(hdca.collection).items():
                identifiers[hda_id] = (collection_name, path)
        discovered = []
        for hda in job_context.created:
            item = DiscoveredDataset(hda)
            association = by_association.get(id(hda), "")
            if association.startswith("__new_primary_file_") and association.endswith("__"):
                output, _, designation = association[len("__new_primary_file_") : -2].partition("|")
                item.output = output
                item.designation = designation
            if id(hda) in identifiers:
                item.collection, item.element_identifiers = identifiers[id(hda)]
            discovered.append(item)
        return discovered


def _inside(path: Path, root: Path) -> bool:
    resolved = path.resolve()
    root = root.resolve()
    return resolved == root or root in resolved.parents


def check_slot_pool(job_context: PlanetJobContext, slots: int) -> None:
    """Every discovered dataset needs a pre-allocated slot."""
    if len(job_context.created) > slots:
        raise MaxDiscoveredFilesExceededError(f"Job generated more than maximum number ({slots}) of output datasets")


def _message_dict(message) -> dict[str, Any]:
    if isinstance(message, Mapping):
        return dict(message)
    if hasattr(message, "model_dump"):
        return message.model_dump()
    return dict(message)


def read_exit_code(layout: Layout, id_tag: str) -> int | None:
    path = layout.exit_code_file(id_tag)
    if path.exists():
        return read_exit_code_from(str(path), id_tag)
    return None
