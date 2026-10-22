"""Evaluate a tool's command, config files and environment like ``galaxy.tools.evaluation.ToolEvaluator``.

The parameter dictionary is built the way ``ToolEvaluator.build_param_dict``
builds it, with Galaxy's own wrappers, sanitization and ``fill_template``.
Output filters, formats and labels are resolved the way Galaxy resolves them
when a job is created (``tools/actions``), and reported in ``prepare.json``.
"""

import json
import logging
import os
import shlex
import string
from collections.abc import Mapping
from dataclasses import (
    dataclass,
    field,
)
from pathlib import Path
from typing import Any

import galaxy.model as model
from galaxy.job_execution.output_format import resolve_format_source
from galaxy.model.none_like import NoneDataset
from galaxy.security.object_wrapper import wrap_with_safe_string
from galaxy.tool_util_models.parameter_validators import (
    DiscriminatedAnyValidatorModel,
    StaticValidatorModel,
)
from galaxy.util import (
    find_instance_nested,
    unicodify,
)
from galaxy.util.template import fill_template
from galaxy.util.tree_dict import TreeDict
from packaging.version import Version

from planet_runtime import galaxy_env
from planet_runtime.datasets import (
    make_hda,
    make_hdca,
    make_input_hda,
    PlanetComputeEnvironment,
)
from planet_runtime.layout import Layout
from planet_runtime.parameters import (
    build_inputs,
    Conditional,
    DataCollectionToolParameter,
    DataToolParameter,
    ParameterError,
    ParameterValueError,
    params_from_basic,
    Repeat,
    Section,
    SelectToolParameter,
    ToolInfo,
    ToolOptions,
    visit_inputs,
)
from planet_runtime.tool import normalize as normalize_tool

galaxy_env.install()

from galaxy.tools.parameters import wrapped_json
from galaxy.tools.wrappers import (
    DatasetCollectionWrapper,
    DatasetFilenameWrapper,
    DatasetListWrapper,
    ElementIdentifierMapper,
    InputValueWrapper,
    RawObjectWrapper,
    SelectToolParameterWrapper,
    ToolParameterValueWrapper,
)

log = logging.getLogger(__name__)

INPUT_DBKEY_TOKEN = "__input__"


class EvaluationError(Exception):
    def __init__(self, phase: str, message: str):
        super().__init__(message)
        self.phase = phase


def tool_info(tool: Mapping[str, Any]) -> ToolInfo:
    profile = str(tool.get("profile") or "16.01")
    template_version = tool.get("python_template_version")
    if not template_version:
        template_version = "3.5" if Version(profile) >= Version("19.05") else "2.7"
    return ToolInfo(
        id=tool["id"],
        name=tool.get("name") or tool["id"],
        version=str(tool.get("version") or "1.0.0"),
        profile=profile,
        options=ToolOptions(sanitize=bool((tool.get("options") or {}).get("sanitize", True))),
        python_template_version=str(template_version),
    )


def home_and_tmp_targets(tool: Mapping[str, Any], info: ToolInfo) -> tuple[str | None, str | None, list[str]]:
    """Galaxy's ``home_target``/``tmp_target`` resolution (``tools/__init__.py``, ``parser/xml.py``)."""
    home_target = tool.get("home_target", "job_home" if info.profile_version >= Version("18.01") else "shared_home")
    tmp_target = tool.get("tmp_target", "job_tmp_if_explicit")
    tmp_directory_vars = list(tool.get("tmp_directory_vars") or ["TMPDIR", "TMP", "TEMP"])
    for variable in tool.get("environment_variables") or []:
        if variable.get("name") == "HOME":
            home_target = None
        elif variable.get("name") in tmp_directory_vars:
            tmp_target = None
    return home_target, tmp_target, tmp_directory_vars


def target_to_directory(target: str | None, layout: Layout) -> str | None:
    """``JobWrapper._target_to_directory`` for a destination that always sets ``tmp_dir``."""
    if target is None:
        return None
    if target in ("job_tmp", "job_tmp_if_explicit"):
        return "$_GALAXY_JOB_TMP_DIR"
    if target == "job_home":
        return "$_GALAXY_JOB_HOME_DIR"
    if target == "pwd":
        return str(layout.working)
    if target == "shared_home":
        return None
    raise EvaluationError("environment", f"Unknown target type [{target}]")


def tool_directory(tool: Mapping[str, Any], layout: Layout) -> Path:
    """Where the tool's directory is extracted; ``$__tool_directory__``."""
    subdirectory = ((tool.get("archive") or {}).get("directory") or "").strip("/")
    path = Path(os.path.normpath(layout.tool_directory / subdirectory))
    if path != layout.tool_directory and layout.tool_directory not in path.parents:
        raise EvaluationError("tool directory", f"Tool directory {subdirectory!r} is outside the tool archive")
    return path


@dataclass
class OutputPlan:
    name: str
    filtered: bool
    format: str | None
    label: str


@dataclass
class Evaluation:
    command_line: str | None = None
    version_command_line: str | None = None
    environment_variables: list[dict[str, Any]] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)
    outputs: dict[str, OutputPlan] = field(default_factory=dict)


def on_text_for_names(names: list[str], prefix: str | None = None) -> str:
    if not names:
        return ""
    if len(names) == 1:
        on_text = f"{names[0]}"
    elif len(names) == 2:
        on_text = f"{names[0]} and {names[1]}"
    elif len(names) == 3:
        on_text = f"{names[0]}, {names[1]}, and {names[2]}"
    else:
        on_text = f"{names[0]}, {names[1]}, and others"
    return f"{prefix} {on_text}" if prefix else on_text


def on_text_for_numeric_ids(ids: list[int], prefix: str | None = None) -> str:
    groups: list[str] = []
    unique_ids = sorted(set(ids))
    run: list[int] = []
    for value in unique_ids + [None]:  # type: ignore[list-item]
        if run and (value is None or value != run[-1] + 1):
            if len(run) == 1:
                groups.append(str(run[0]))
            elif len(run) == 2:
                groups.extend([str(run[0]), str(run[1])])
            else:
                groups.append(f"{run[0]}-{run[-1]}")
            run = []
        if value is not None:
            run.append(value)
    return on_text_for_names(groups, prefix)


def on_text_for_dataset_and_collections(dataset_hids: list[int], collection_hids: list[int]) -> str:
    parts = [
        text
        for text in (
            on_text_for_numeric_ids(dataset_hids, "dataset"),
            on_text_for_numeric_ids(collection_hids, "collection"),
        )
        if text
    ]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]


def static_validators(parameter) -> list[Any]:
    """Galaxy's validators for the static validator models of ``parameter`` (regex, expression, length, ...).

    Validators that need data tables or dataset metadata are not built.
    """
    try:
        models = [DiscriminatedAnyValidatorModel.validate_python(definition) for definition in parameter.validators]
    except ValueError as e:
        raise ParameterValueError(f"invalid validator: {e}", parameter.name) from None
    return galaxy_env.validation().to_validators(None, [m for m in models if isinstance(m, StaticValidatorModel)])


def copy_state(value):
    """Copy the dictionaries and lists of a job state, sharing the values (``make_dict_copy``)."""
    if isinstance(value, dict):
        return {key: copy_state(item) for key, item in value.items()}
    if isinstance(value, list):
        return [copy_state(item) for item in value]
    return value


class JobEvaluator:
    def __init__(self, manifest: Mapping[str, Any], layout: Layout):
        self.manifest = manifest
        self.layout = layout
        self.tool_def: Mapping[str, Any] = normalize_tool(manifest["tool"])
        self.tool = tool_info(self.tool_def)
        self.registry = galaxy_env.registry()
        self.inputs = build_inputs(self.tool, self.tool_def.get("inputs") or [])
        home_target, tmp_target, self.tmp_directory_vars = home_and_tmp_targets(self.tool_def, self.tool)
        job = manifest.get("job") or {}
        self.compute_environment = PlanetComputeEnvironment(
            layout,
            galaxy_url=job.get("galaxy_url") or "",
            home_directory=target_to_directory(home_target, layout),
            tmp_directory=target_to_directory(tmp_target, layout),
            tool_directory=tool_directory(self.tool_def, layout),
        )
        self.hdas: dict[str, model.HistoryDatasetAssociation] = {
            key: make_input_hda(layout, record) for key, record in (manifest.get("inputs") or {}).items()
        }
        self.collections: dict[str, Any] = {
            key: self._make_collection_input(definition)
            for key, definition in (manifest.get("collections") or {}).items()
        }
        self.incoming = self._restore_params()
        self.input_datasets = self._input_datasets()
        self.input_collections = self._input_collections()
        self._add_implicit_params()
        self.param_dict: dict[str, Any] = {}

    def _make_collection_input(self, definition: Mapping[str, Any]):
        hdca = make_hdca(definition, lambda key: self.hdas[key])
        if definition.get("element_identifier"):
            return model.DatasetCollectionElement(
                element=hdca.collection, element_identifier=definition["element_identifier"]
            )
        return hdca

    def _resolve(self, value, parameter):
        if isinstance(value, Mapping):
            key = str(value.get("key", value.get("id")))
            if value.get("src") in ("hdca", "dce", "collection") or isinstance(parameter, DataCollectionToolParameter):
                return self.collections[key]
            return self.hdas[key]
        if isinstance(value, str) and value in self.hdas:
            return self.hdas[value]
        raise ParameterError(f"Parameter '{parameter.name}': cannot resolve dataset reference {value!r}")

    def _restore_params(self) -> dict[str, Any]:
        try:
            return params_from_basic(self.inputs, self.manifest.get("params") or {}, self._resolve)
        except (ParameterError, KeyError, TypeError, ValueError) as e:
            raise EvaluationError("parameters", f"Invalid job parameters: {e}") from e

    def _input_datasets(self) -> dict[str, Any]:
        """Job input dataset associations, named like ``DefaultToolAction._collect_input_datasets``."""
        explicit = self.manifest.get("input_datasets")
        if explicit:
            return {name: self.hdas[key] if key is not None else None for name, key in explicit.items()}
        input_datasets: dict[str, Any] = {}

        def visitor(parameter, values, prefixed_name):
            if not isinstance(parameter, DataToolParameter):
                return
            value = values.get(parameter.name)
            if isinstance(value, list) or isinstance(value, model.HistoryDatasetCollectionAssociation):
                for i, item in enumerate(DatasetListWrapper.to_dataset_instances(value)):
                    # Collection elements stand for their datasets, as in ``process_dataset``.
                    item = getattr(item, "hda", item)
                    if i == 0:
                        input_datasets[prefixed_name] = item
                    input_datasets[f"{prefixed_name}{i + 1}"] = item
            else:
                input_datasets[prefixed_name] = getattr(value, "hda", value)

        visit_inputs(self.inputs, self.incoming, visitor)
        return input_datasets

    def _input_collections(self) -> dict[str, Any]:
        collections: dict[str, Any] = {}

        def visitor(parameter, values, prefixed_name):
            if isinstance(parameter, DataCollectionToolParameter) and values.get(parameter.name) is not None:
                collections[prefixed_name] = values[parameter.name]

        visit_inputs(self.inputs, self.incoming, visitor)
        return collections

    def _add_implicit_params(self) -> None:
        """Values Galaxy stores in the job parameters when the job is created."""
        incoming = self.incoming
        legacy = self.tool.profile_version < Version("16.04")
        input_ext = "data" if legacy else "input"
        input_dbkey = incoming.get("dbkey", "?")
        for name, data in reversed(list(self.input_datasets.items())):
            if not data:
                continue
            if legacy:
                input_ext = data.ext
            if data.dbkey not in (None, "?"):
                input_dbkey = data.dbkey
            identifier = self._element_identifier(data)
            if identifier is not None:
                incoming.setdefault(f"{name}|__identifier__", identifier)
        incoming.setdefault("dbkey", input_dbkey)
        incoming.setdefault("__input_ext", input_ext)
        incoming.setdefault(
            "chromInfo", str(self.layout.tool_data / "shared" / "ucsc" / "chrom" / f"{incoming['dbkey']}.len")
        )
        incoming.update(self._user_template_environment())

    def _element_identifier(self, data) -> str | None:
        for key, hda in self.hdas.items():
            if hda is data:
                return (self.manifest["inputs"][key] or {}).get("element_identifier")
        return None

    def _user_template_environment(self) -> dict[str, Any]:
        user_record = self.manifest.get("user") or {}
        user = None
        if user_record.get("email"):
            user = model.User(email=user_record["email"])
            user.username = user_record.get("username") or ""
            user.id = user_record.get("id", 1)
        return model.User.user_template_environment(user)

    def validate(self) -> None:
        """Check the job state with the static validators, as ``check_param`` does when Galaxy creates the job.

        Tool-author regular expressions and expressions run here, in the template child. Messages are joined
        like those of Galaxy's ``RequestParameterInvalidException``.
        """
        errors: list[str] = []

        def visitor(parameter, values, prefixed_name):
            try:
                parameter.validate(values.get(parameter.name), static_validators(parameter))
            except ParameterError as e:
                errors.append(str(e))

        visit_inputs(self.inputs, self.incoming, visitor)
        if errors:
            raise EvaluationError("parameters", ", ".join(errors))

    # Outputs, as decided when Galaxy creates the job.

    def plan_outputs(self) -> dict[str, OutputPlan]:
        plans: dict[str, OutputPlan] = {}
        wrapped = self._wrapped_params()
        on_text = self._on_text()
        for name, output in (self.tool_def.get("outputs") or {}).items():
            filtered = self._filtered(name, output)
            output_format = None
            if output.get("model_class", "ToolOutput") == "ToolOutput":
                output_format = self._determine_format(output, wrapped)
            plans[name] = OutputPlan(name, filtered, output_format, self._label(output, wrapped, on_text))
        return plans

    def _filtered(self, name: str, output: Mapping[str, Any]) -> bool:
        """``galaxy.tools.execution_helpers.filter_output``; tool-author code, evaluated in the pod."""
        for text in output.get("filters") or []:
            try:
                if not eval(text.strip(), {}, dict(self.incoming)):
                    return True
            except Exception as e:
                log.debug("Tool %s output %s: dataset output filter (%s) failed: %s", self.tool.id, name, text, e)
        return False

    def _determine_format(self, output: Mapping[str, Any], wrapped: Mapping[str, Any]) -> str | None:
        """``tools.actions.determine_output_format``."""
        ext = output.get("format") or "data"
        random_input_ext = self.incoming.get("__input_ext", "data")
        if ext == "input":
            if self.input_datasets and random_input_ext in {"data", "auto"}:
                first = next(iter(self.input_datasets.values()))
                if first is not None:
                    random_input_ext = first.ext
            ext = random_input_ext
        if (format_source := output.get("format_source")) is not None:
            ext = resolve_format_source(format_source, self.input_datasets, self.input_collections, ext)
        for change in output.get("change_format") or []:
            input_check = change.get("input")
            if input_check is not None:
                try:
                    rendered = fill_template(
                        input_check, context=wrapped, python_template_version=self.tool.python_template_version
                    )
                    if rendered == change.get("value") and change.get("format"):
                        return change["format"]
                except Exception:
                    continue
            elif (input_dataset_check := change.get("input_dataset")) is not None:
                dataset = self.input_datasets.get(input_dataset_check)
                check_format = change.get("format") or ext
                check_value = change.get("value")
                check_attribute = change.get("check_attribute")
                if dataset is not None and check_value is not None and check_attribute is not None:
                    if hasattr(dataset, check_attribute) and str(getattr(dataset, check_attribute)) == str(check_value):
                        return check_format
                    metadata_value = dataset.metadata.get(check_attribute) if dataset.metadata is not None else None
                    if metadata_value is not None and str(metadata_value) == str(check_value):
                        return check_format
        return ext

    def _on_text(self) -> str:
        dataset_hids: list[int] = []
        collection_hids: list[int] = []
        for collection in self.input_collections.values():
            if isinstance(collection, model.HistoryDatasetCollectionAssociation) and collection.hid:
                collection_hids.append(collection.hid)
        for name, data in self.input_datasets.items():
            if name in self.input_collections:
                continue
            if any(name.startswith(key) and name[len(key) :].isdigit() for key in self.input_collections):
                continue
            if getattr(data, "hid", None):
                dataset_hids.append(data.hid)
        return on_text_for_dataset_and_collections(dataset_hids, collection_hids)

    def _label(self, output: Mapping[str, Any], wrapped: Mapping[str, Any], on_text: str) -> str:
        label = output.get("label")
        if label:
            context = dict(wrapped)
            context["tool"] = self.tool
            context["on_string"] = on_text
            try:
                return fill_template(label, context=context, python_template_version=self.tool.python_template_version)
            except Exception as e:
                log.debug("Output label of %s failed to render: %s", output.get("name"), e)
        name = self.tool.name
        if on_text:
            name += f" on {on_text}"
        return name

    def _wrapped_params(self) -> dict[str, Any]:
        """``galaxy.tools.parameters.wrapped.WrappedParameters.params``."""
        params = copy_state(self.incoming)
        mapper = ElementIdentifierMapper(self.input_datasets)
        self._wrap_values(self.inputs, params, mapper, params, compute_environment=None)
        return params

    # Command evaluation, as in ToolEvaluator.

    def build(self, plans: Mapping[str, OutputPlan] | None = None) -> Evaluation:
        result = Evaluation()
        result.outputs = dict(plans) if plans is not None else self.plan_outputs()
        self.output_hdas = self._output_hdas(result.outputs)
        self.output_collections = self._output_collections()
        self.param_dict = self.build_param_dict()
        result.config_files = self._run("config files", self._build_config_files)
        self._run("param file", self._build_param_file)
        result.command_line = self._run("command line", self._build_command_line)
        result.version_command_line = self._build_version_command()
        result.environment_variables = self._run("environment variables", self._build_environment_variables)
        return result

    @staticmethod
    def _run(phase: str, action):
        try:
            return action()
        except EvaluationError:
            raise
        except Exception as e:
            raise EvaluationError(phase, f"Error building {phase}: {unicodify(e)}") from e

    def _output_hdas(self, plans: Mapping[str, OutputPlan]) -> dict[str, model.HistoryDatasetAssociation]:
        hdas: dict[str, model.HistoryDatasetAssociation] = {}
        for record in self.manifest.get("outputs") or []:
            plan = plans.get(record["name"])
            if plan is not None and plan.filtered:
                continue
            uuid = record["uuid"]
            ext = (plan.format if plan and plan.format else None) or record.get("ext") or "data"
            hda = make_hda(
                record,
                self.layout.output_path(uuid),
                extension=ext,
                extra_files_path=self.layout.output_extra_files(uuid),
                state="running",
            )
            if plan is not None:
                # Galaxy names output datasets with their label when it creates the job ($output.name).
                hda.name = plan.label
            hda.init_meta()
            hdas[record["name"]] = hda
        return hdas

    def _output_collections(self) -> dict[str, model.HistoryDatasetCollectionAssociation]:
        collections = {}
        for name, definition in (self.manifest.get("output_collections") or {}).items():
            collections[name] = make_hdca(
                {**definition, "elements": definition.get("elements") or []},
                lambda key: self.output_hdas[key],
                key="output",
            )
        return collections

    def build_param_dict(self) -> dict[str, Any]:
        compute_environment = self.compute_environment
        job_working_directory = compute_environment.working_directory()
        param_dict: TreeDict = TreeDict({})
        param_dict["__datatypes_config__"] = param_dict["GALAXY_DATATYPES_CONF_FILE"] = os.path.join(
            job_working_directory, "registry.xml"
        )
        if history_id := (self.manifest.get("job") or {}).get("history_id"):
            param_dict["__history_id__"] = history_id
        param_dict["__galaxy_url__"] = compute_environment.galaxy_url()
        template_macro_params = dict(self.tool_def.get("template_macro_params") or {})
        param_dict.update(template_macro_params)
        param_dict.update(copy_state(self.incoming))

        self._populate_wrappers(param_dict, job_working_directory)
        self._populate_input_dataset_wrappers(param_dict)
        self._populate_output_dataset_wrappers(param_dict)
        self._populate_output_collection_wrappers(param_dict, job_working_directory)
        self._sanitize_param_dict(param_dict, template_macro_params)
        self._populate_non_job_params(param_dict)

        if "input" not in param_dict.data:

            def input():
                raise SyntaxError("Unbound variable 'input'.")

            param_dict.data["input"] = input

        return param_dict.clean_copy()

    def _wrap_values(self, inputs, input_values, mapper, param_dict, compute_environment) -> None:
        tool = self.tool
        registry = self.registry
        profile = tool.profile

        def wrap_input(values, parameter):
            value = values[parameter.name]
            if isinstance(parameter, DataToolParameter) and parameter.multiple:
                values[parameter.name] = DatasetListWrapper(
                    compute_environment and compute_environment.working_directory(),
                    DatasetListWrapper.to_dataset_instances(value),
                    compute_environment=compute_environment,
                    datatypes_registry=registry,
                    tool=tool,
                    name=parameter.name,
                    tool_evaluator=None,
                )
            elif isinstance(parameter, DataToolParameter):
                values[parameter.name] = DatasetFilenameWrapper(
                    dataset=value,
                    datatypes_registry=registry,
                    tool=tool,
                    name=parameter.name,
                    compute_environment=compute_environment,
                    identifier=mapper.identifier(value, param_dict),
                    tool_evaluator=None,
                )
            elif isinstance(parameter, DataCollectionToolParameter):
                values[parameter.name] = DatasetCollectionWrapper(
                    job_working_directory=compute_environment and compute_environment.working_directory(),
                    has_collection=value,
                    datatypes_registry=registry,
                    compute_environment=compute_environment,
                    tool=tool,
                    name=parameter.name,
                )
            elif isinstance(parameter, SelectToolParameter):
                if parameter.multiple and not isinstance(value, list):
                    value = [] if value is None else [value]
                values[parameter.name] = SelectToolParameterWrapper(
                    parameter, value, other_values=param_dict, compute_environment=compute_environment
                )
            else:
                values[parameter.name] = InputValueWrapper(parameter, value, param_dict, profile=profile)

        def walk(inputs, values):
            for parameter in inputs.values():
                if isinstance(parameter, Repeat):
                    for d in values[parameter.name]:
                        walk(parameter.inputs, d)
                elif isinstance(parameter, Conditional):
                    group_values = values[parameter.name]
                    wrap_input(group_values, parameter.test_param)
                    walk(parameter.cases[group_values["__current_case__"]].inputs, group_values)
                elif isinstance(parameter, Section):
                    walk(parameter.inputs, values[parameter.name])
                else:
                    wrap_input(values, parameter)

        walk(inputs, input_values)

    def _populate_wrappers(self, param_dict, job_working_directory) -> None:
        mapper = ElementIdentifierMapper(self.input_datasets)
        self._wrap_values(self.inputs, param_dict, mapper, param_dict, self.compute_environment)

    def _populate_input_dataset_wrappers(self, param_dict) -> None:
        matches = None
        for name, data in self.input_datasets.items():
            param_dict_value = param_dict.get(name, None)
            if data and param_dict_value is None:
                if matches is None:
                    matches = find_instance_nested(param_dict, instances=(DatasetFilenameWrapper, DatasetListWrapper))
                wrapper = matches.get(name)
                if wrapper:
                    param_dict[name] = wrapper
                    continue
            if not isinstance(param_dict_value, ToolParameterValueWrapper):
                param_dict[name] = DatasetFilenameWrapper(
                    dataset=data,
                    datatypes_registry=self.registry,
                    tool=self.tool,
                    name=name,
                    compute_environment=self.compute_environment,
                )

    def _populate_output_dataset_wrappers(self, param_dict) -> None:
        for name, hda in self.output_hdas.items():
            param_dict[name] = DatasetFilenameWrapper(
                hda, compute_environment=self.compute_environment, io_type="output"
            )
        for name, output in (self.tool_def.get("outputs") or {}).items():
            if name not in param_dict and output.get("filters"):
                ext = output.get("format") if output.get("model_class", "ToolOutput") == "ToolOutput" else None
                param_dict[name] = NoneDataset(datatypes_registry=self.registry, ext=ext or "data")

    def _populate_output_collection_wrappers(self, param_dict, job_working_directory) -> None:
        for name, hdca in self.output_collections.items():
            wrapper = DatasetCollectionWrapper(
                job_working_directory=job_working_directory,
                has_collection=hdca,
                datatypes_registry=self.registry,
                compute_environment=self.compute_environment,
                io_type="output",
                tool=self.tool,
                name=name,
            )
            param_dict[name] = wrapper
            definition = (self.manifest.get("output_collections") or {}).get(name) or {}
            for element in definition.get("elements") or []:
                if element.get("param_name"):
                    param_dict[element["param_name"]] = wrapper[element["element_identifier"]]

    def _sanitize_param_dict(self, param_dict, template_macro_params) -> None:
        skip = ["chromInfo", *template_macro_params.keys()]
        if self.tool.options.sanitize:
            for key, value in list(param_dict.items()):
                if key not in skip:
                    del param_dict[key]
                    param_dict[wrap_with_safe_string(key, no_wrap_classes=ToolParameterValueWrapper)] = (
                        wrap_with_safe_string(value, no_wrap_classes=ToolParameterValueWrapper)
                    )

    def _populate_non_job_params(self, param_dict) -> None:
        def get_data_table_entry(table_name, query_attr, query_val, return_attr):
            return None

        param_dict["__tool_directory__"] = self.compute_environment.tool_directory()
        param_dict["__get_data_table_entry__"] = get_data_table_entry
        param_dict["__local_working_directory__"] = str(self.layout.job)
        param_dict["__app__"] = RawObjectWrapper(_UnavailableApp())
        param_dict["__new_file_path__"] = self.compute_environment.new_file_path()
        param_dict["__tool_data_path__"] = param_dict["GALAXY_DATA_INDEX_DIR"] = str(self.layout.tool_data)
        param_dict["__root_dir__"] = param_dict["GALAXY_ROOT_DIR"] = str(galaxy_env.galaxy_lib().parent)
        param_dict["__admin_users__"] = ""
        param_dict["__user__"] = RawObjectWrapper(param_dict.get("__user__", None))

    def _write_workdir_file(self, path: Path, content: str, template: bool, strip: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if template:
            value = fill_template(
                content, context=self.param_dict, python_template_version=self.tool.python_template_version
            )
        else:
            value = unicodify(content)
        if strip:
            value = value.strip()
        path.write_text(value, encoding="utf-8")
        path.chmod(0o644)

    def _register_extra_file(self, name: str, local_path: Path) -> None:
        self.param_dict[name] = f"{self.compute_environment.config_directory()}/{local_path.name}"

    def _build_config_files(self) -> list[str]:
        import tempfile

        names = []
        for config_file in self.tool_def.get("configfiles") or []:
            kind = config_file.get("type", "configfile")
            if kind == "inputs":
                content = json.dumps(
                    wrapped_json.json_wrap(
                        self.inputs, self.param_dict, self.tool.profile, handle_files=config_file.get("handle_files")
                    )
                )
                template = False
            elif kind == "files":
                content = json.dumps(self.compute_environment.get_file_sources_dict())
                template = False
            else:
                content = config_file.get("content") or ""
                template = (config_file.get("eval_engine") or "cheetah") == "cheetah"
            self.layout.configs.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=self.layout.configs, delete=False) as temp:
                path = Path(temp.name)
            if config_file.get("filename"):
                self._link_config_file(path, config_file["filename"])
            self._write_workdir_file(path, content, template)
            if config_file.get("name"):
                self._register_extra_file(config_file["name"], path)
            names.append(config_file.get("name") or path.name)
        return names

    def _link_config_file(self, path: Path, filename: str) -> None:
        directory = self.layout.working
        link_path = Path(os.path.normpath(directory / filename))
        if link_path == directory or not str(link_path).startswith(f"{directory}{os.sep}"):
            raise EvaluationError(
                "config files",
                f"Config file filename {filename!r} must be a relative path inside the job working directory",
            )
        resolved_parent = link_path.parent.resolve()
        if not str(resolved_parent).startswith(str(directory.resolve())):
            raise EvaluationError("config files", f"Config file filename {filename!r} escapes the working directory")
        link_path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        os.link(path, link_path)

    def _build_param_file(self) -> None:
        command = self.tool_def.get("command") or ""
        if self.tool.profile_version < Version("16.04") and "$param_file" in command:
            import tempfile

            with tempfile.NamedTemporaryFile(mode="w", dir=self.layout.job, delete=False) as param:
                for key, value in self.param_dict.items():
                    for elem in value if isinstance(value, list) else [value]:
                        param.write(f"{key}={elem}\n")
            self.param_dict["param_file"] = param.name

    def _build_command_line(self) -> str | None:
        command = self.tool_def.get("command") or ""
        if not command:
            return None
        command_line = fill_template(
            command, context=self.param_dict, python_template_version=self.tool.python_template_version
        )
        command_line = "\n".join(line.strip() for line in command_line.split("\n"))
        command_line = command_line.replace("\n", " ").replace("\r", " ").strip()
        if interpreter := self.tool_def.get("interpreter"):
            executable = command_line.split()[0]
            abs_executable = os.path.join(self.compute_environment.tool_directory(), executable)
            command_line = command_line.replace(executable, f"{interpreter} {shlex.quote(abs_executable)}", 1)
        return command_line

    def _build_version_command(self) -> str | None:
        if version_command := self.tool_def.get("version_command"):
            if interpreter := self.tool_def.get("version_command_interpreter"):
                executable = version_command.split()[0]
                abs_executable = os.path.join(self.compute_environment.tool_directory(), executable)
                version_command = f"{interpreter} {version_command.replace(executable, abs_executable, 1)}"
            command = string.Template(version_command).safe_substitute(
                {"__tool_directory__": self.compute_environment.tool_directory()}
            )
            return f"{command} > {self.compute_environment.version_path()} 2>&1;\n"
        return None

    def _build_environment_variables(self) -> list[dict[str, Any]]:
        import tempfile

        environment_variables: list[dict[str, Any]] = []
        for definition in self.tool_def.get("environment_variables") or []:
            variable = dict(definition)
            template = definition.get("template") or ""
            inject = definition.get("inject")
            if inject:
                # Galaxy API keys and OIDC tokens do not exist in Planet.
                template, is_template = "", False
            else:
                is_template = True
            with tempfile.NamedTemporaryFile(dir=self.layout.job, prefix="tool_env_", delete=False) as temp:
                path = Path(temp.name)
            self._write_workdir_file(path, template, is_template, strip=bool(definition.get("strip", False)))
            variable["value"] = f'`cat "{self.compute_environment.env_config_directory()}/{path.name}"`'
            variable["raw"] = True
            variable["job_directory_path"] = str(path)
            environment_variables.append(variable)
        if home_dir := self.compute_environment.home_directory():
            environment_variables.append({"name": "HOME", "value": f'"{home_dir}"', "raw": True})
        if tmp_dir := self.compute_environment.tmp_directory():
            for name in self.tmp_directory_vars:
                environment_variables.append({"name": name, "value": f'"{tmp_dir}"', "raw": True})
        return environment_variables


class _UnavailableApp:
    def __getattr__(self, name):
        raise AttributeError(f"$__app__.{name} is not available in Planet jobs")
