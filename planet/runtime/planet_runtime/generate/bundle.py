"""Serialize a parsed Galaxy tool source into a Planet tool bundle.

A bundle carries everything the browser form engine and the job stage-in need without
parsing tool XML again: tool metadata, the input tree with the attributes that
``galaxy.tools.parameters.basic`` and ``grouping`` read from the ``InputSource`` API,
``ToolOutput.to_dict()`` plus filters, format changes and actions, the raw command,
config files, environment variables, stdio rules, requirements and rendered help.

``galaxy.tools`` needs the ORM, so the constructors of ``galaxy.tools.Tool``,
``ToolParameter`` and the grouping classes are mirrored here on top of
``galaxy.tool_util``. Element-based definitions that Galaxy evaluates at run time
(dynamic options, sanitizers, output actions) are kept both as normalized data for the
browser and as XML snippets for Galaxy's own classes in the job pod.
"""

import copy
import logging
import math
from typing import Any

from galaxy.tool_util.loader import template_macro_params
from galaxy.tool_util.ontologies.ontology_data import expand_ontology_data
from galaxy.tool_util.parameters.factory import (
    get_color_value,
    input_models_for_pages,
)
from galaxy.tool_util.parser.interface import (
    InputSource,
    PageSource,
    ToolSource,
)
from galaxy.tool_util.parser.output_objects import (
    ToolExpressionOutput,
    ToolOutput,
    ToolOutputCollection,
)
from galaxy.tool_util.parser.parameter_validators import parse_xml_validators
from galaxy.tool_util.parser.util import (
    boolean_is_checked,
    boolean_true_and_false_values,
    parse_profile_version,
    parse_tool_version_with_defaults,
    text_input_is_optional,
)
from galaxy.tool_util_models.parameter_validators import (
    InRangeParameterValidatorModel,
    MetadataParameterValidatorModel,
)
from galaxy.util import (
    string_as_bool,
    xml_to_string,
)
from galaxy.util.bunch import Bunch
from galaxy.version import VERSION_MAJOR
from packaging.version import Version

from ._common import to_jsonable

try:
    from galaxy.util.rst_to_html import rst_to_html
except ImportError:  # docutils missing
    rst_to_html = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

BUNDLE_FORMAT_VERSION = 1

# galaxy.tools.TOOL_CLASSES keyed by tool_type, with the class names the API reports.
TOOL_TYPE_CLASSES = {
    "default": "Tool",
    "set_metadata": "SetMetadataTool",
    "output_parameter_json": "OutputParameterJSONTool",
    "expression": "ExpressionTool",
    "interactive": "InteractiveTool",
    "manage_data": "DataManagerTool",
    "data_source": "DataSourceTool",
    "data_source_async": "AsyncDataSourceTool",
    "unzip_collection": "UnzipCollectionTool",
    "zip_collection": "ZipCollectionTool",
    "merge_collection": "MergeCollectionTool",
    "relabel_from_file": "RelabelFromFileTool",
    "filter_from_file": "FilterFromFileTool",
    "duplicate_file_to_collection": "DuplicateFileToCollectionTool",
    "build_list": "BuildListCollectionTool",
    "extract_dataset": "ExtractDatasetCollectionTool",
    "data_destination": "DataDestinationTool",
    "convert_sample_sheet": "ConvertSampleSheetTool",
}
# Classes rendered with the regular tool form (Tool, InteractiveTool, DatabaseOperationTool subclasses).
REGULAR_FORM_CLASSES = {
    "Tool",
    "InteractiveTool",
    "UnzipCollectionTool",
    "ZipCollectionTool",
    "MergeCollectionTool",
    "RelabelFromFileTool",
    "FilterFromFileTool",
    "DuplicateFileToCollectionTool",
    "BuildListCollectionTool",
    "ExtractDatasetCollectionTool",
    "ConvertSampleSheetTool",
}

# galaxy.tools.parameters.basic.parameter_types
PARAMETER_CLASSES = {
    "text": "TextToolParameter",
    "integer": "IntegerToolParameter",
    "float": "FloatToolParameter",
    "boolean": "BooleanToolParameter",
    "genomebuild": "GenomeBuildParameter",
    "select": "SelectToolParameter",
    "color": "ColorToolParameter",
    "group_tag": "SelectTagParameter",
    "data_column": "ColumnListParameter",
    "hidden": "HiddenToolParameter",
    "hidden_data": "HiddenDataToolParameter",
    "baseurl": "BaseURLToolParameter",
    "file": "FileToolParameter",
    "ftpfile": "FTPFileToolParameter",
    "data": "DataToolParameter",
    "data_collection": "DataCollectionToolParameter",
    "rules": "RulesListToolParameter",
    "directory_uri": "DirectoryUriToolParameter",
    "drill_down": "DrillDownSelectToolParameter",
}
SELECT_TYPES = {"select", "genomebuild", "group_tag", "data_column"}
DATA_TYPES = {"data", "data_collection", "hidden_data"}


class BundleError(Exception):
    """The tool source cannot be represented as a Planet bundle."""


def build_bundle(
    tool_source: ToolSource,
    *,
    tool_id: str | None = None,
    tool_dir: str | None = None,
    tool_shed_repository: dict[str, Any] | None = None,
    source: dict[str, Any] | None = None,
    datatypes_registry: Any = None,
    versions: list[str] | None = None,
    data_tables: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return the bundle for ``tool_source``.

    ``tool_id`` overrides the id in the tool source (Tool Shed GUIDs); ``datatypes_registry``
    adds EDAM terms to outputs as ``ToolOutput.to_dict(app=...)`` does on a server.
    """
    profile = parse_profile_version(tool_source)
    profile_version = Version(str(profile))
    old_id = tool_source.parse_id()
    tool_id = tool_id or old_id
    if not tool_id:
        raise BundleError("Tool has no id")
    if profile_version >= Version("16.04") and Version(VERSION_MAJOR) < profile_version:
        raise BundleError(f"Tool {tool_id} targets Galaxy {profile}, newer than {VERSION_MAJOR}")
    name = tool_source.parse_name()
    if not name:
        raise BundleError(f"Tool {tool_id} has no name")
    version = parse_tool_version_with_defaults(tool_id, tool_source, profile_version)

    python_template_version = tool_source.parse_python_template_version()
    if python_template_version is None:
        python_template_version = Version("3.5") if profile_version >= Version("19.05") else Version("2.7")

    tool_type = tool_source.parse_tool_type() or "default"
    if tool_source.parse_tool_module() is not None:
        raise BundleError(f"Tool {tool_id} declares a custom tool class")
    model_class = TOOL_TYPE_CLASSES.get(tool_type)
    if model_class is None:
        raise BundleError(f"Tool {tool_id} has unrecognized tool type {tool_type!r}")

    all_ids = [tool_id.lower()]
    if old_id and old_id != tool_id:
        all_ids = [tool_id.lower(), tool_id.lower().rsplit("/", 1)[0], old_id.lower()]
    ontology = expand_ontology_data(tool_source, all_ids, None)

    pages = tool_source.parse_input_pages()
    inputs_by_page: list[list[dict[str, Any]]] = []
    displays: list[str | None] = []
    for page_source in pages.page_sources:
        inputs_by_page.append(_parse_input_elem(page_source, profile))
        displays.append(page_source.parse_display())
    try:
        parameter_models = input_models_for_pages(pages, profile)
    except Exception as e:
        log.debug("No parameter model for %s: %s", tool_id, e)
        parameter_models = None

    root = getattr(tool_source, "root", None)
    form = {"check_values": True, "method": "post", "action": "/tool_runner/index", "nginx_upload": False}
    input_elem = getattr(pages, "input_elem", None)
    if input_elem is not None:
        form["check_values"] = string_as_bool(input_elem.get("check_values", True))
        form["nginx_upload"] = string_as_bool(input_elem.get("nginx_upload", False))
        form["action"] = input_elem.get("action", form["action"])
        form["method"] = input_elem.get("method", form["method"])

    is_workflow_compatible = len(inputs_by_page) <= 1 and not tool_type.startswith("data_source")
    if root is not None and not string_as_bool(root.get("workflow_compatible", "True")):
        is_workflow_compatible = False

    outputs, _ = tool_source.parse_outputs(None)
    output_app = Bunch(datatypes_registry=datatypes_registry) if datatypes_registry is not None else None
    output_elems = _output_elements(root)

    command = tool_source.parse_command()
    command_el = root.find("command") if root is not None else None
    version_command = tool_source.parse_version_command()
    exit_codes, regexes = tool_source.parse_stdio()
    requirements, containers, resource_requirements, javascript_requirements, credentials = (
        tool_source.parse_requirements()
    )
    environment_variables = tool_source.parse_environment_variables()
    tmp_directory_vars = tool_source.parse_tmp_directory_vars()
    home_target = tool_source.parse_home_target()
    tmp_target = tool_source.parse_tmp_target()
    for variable in environment_variables:
        if variable.get("name") == "HOME":
            home_target = None
            continue
        if variable.get("name") in tmp_directory_vars:
            tmp_target = None
    docker_env_pass_through = tool_source.parse_docker_env_pass_through()
    if environment_variables:
        docker_env_pass_through = list(docker_env_pass_through or []) + [v["name"] for v in environment_variables]
    required_files = tool_source.parse_required_files()

    bundle: dict[str, Any] = {
        "format_version": BUNDLE_FORMAT_VERSION,
        "id": tool_id,
        "old_id": old_id,
        "version": version,
        "versions": versions if versions is not None else [version],
        "name": name,
        "description": tool_source.parse_description(),
        "profile": tool_source.parse_profile(),
        "python_template_version": str(python_template_version),
        "tool_type": tool_type,
        "model_class": model_class,
        "form_style": "regular" if model_class in REGULAR_FORM_CLASSES else "special",
        "hidden": tool_source.parse_hidden(),
        "display_interface": tool_source.parse_display_interface(True),
        "require_login": tool_source.parse_require_login(False),
        "is_workflow_compatible": is_workflow_compatible,
        "has_parameters": parameter_models is not None,
        "icon": tool_source.parse_icon(),
        "license": tool_source.parse_license(),
        "creator": tool_source.parse_creator(),
        "funding": tool_source.parse_funding(),
        "edam_operations": list(ontology.edam_operations or []),
        "edam_topics": list(ontology.edam_topics or []),
        "xrefs": [dict(x) for x in ontology.xrefs],
        "tool_tags": list(ontology.tool_tags or []),
        "citations": tool_source.parse_citations(),
        "help": _help(tool_source),
        "requirements": requirements.to_dict(),
        "containers": [c.to_dict() for c in containers],
        "resource_requirements": [r.to_dict() for r in resource_requirements],
        "javascript_requirements": [r.to_dict() for r in javascript_requirements],
        "credentials": [c.to_dict() for c in credentials],
        "command": {
            "text": command.lstrip() if command is not None else None,
            "interpreter": tool_source.parse_interpreter() if command is not None else None,
            "strict": tool_source.parse_strict_shell(),
            "detect_errors": command_el.get("detect_errors") if command_el is not None else None,
            "oom_exit_code": command_el.get("oom_exit_code") if command_el is not None else None,
            "use_shared_home": command_el.get("use_shared_home") if command_el is not None else None,
            "attributes": dict(command_el.attrib) if command_el is not None else {},
        },
        "shell_command": tool_source.parse_shell_command(),
        "base_command": tool_source.parse_base_command(),
        "arguments": tool_source.parse_arguments(),
        "version_command": (
            {"command": version_command.strip(), "interpreter": tool_source.parse_version_command_interpreter()}
            if version_command is not None
            else None
        ),
        "stdio": {"exit_codes": [c.to_dict() for c in exit_codes], "regexes": [r.to_dict() for r in regexes]},
        "configfiles": {
            "configfiles": list(tool_source.parse_template_configfiles()),
            "inputs": list(tool_source.parse_input_configfiles()),
            "file_sources": list(tool_source.parse_file_sources()),
        },
        "environment_variables": environment_variables,
        "home_target": home_target,
        "tmp_target": tmp_target,
        "tmp_directory_vars": tmp_directory_vars,
        "docker_env_pass_through": docker_env_pass_through,
        "template_macro_params": template_macro_params(root) if root is not None else {},
        "options": {"sanitize": tool_source.parse_sanitize(), "refresh": tool_source.parse_refresh()},
        "provided_metadata": {
            "file": tool_source.parse_provided_metadata_file(),
            "style": tool_source.parse_provided_metadata_style(),
            "explicit": tool_source.parse_provided_metadata_is_explicit(),
        },
        "required_files": (
            {
                "includes": required_files.includes,
                "excludes": required_files.excludes,
                "extend_default_excludes": required_files.extend_default_excludes,
            }
            if required_files is not None
            else None
        ),
        "code": _code_files(root),
        "form": form,
        "display": displays[0] if displays else None,
        "inputs": inputs_by_page[0] if inputs_by_page else [],
        "inputs_by_page": inputs_by_page if len(inputs_by_page) > 1 else None,
        "outputs": [_output(output, output_elems.get(output.name), output_app) for output in outputs.values()],
        "parameter_models": (
            [m.model_dump(mode="json", by_alias=True) for m in parameter_models]
            if parameter_models is not None
            else None
        ),
        "data_tables": data_tables or [],
        "tool_dir": tool_dir,
        "tool_shed_repository": tool_shed_repository,
        "source": source,
    }
    return to_jsonable(bundle)


def _help(tool_source: ToolSource) -> dict[str, Any] | None:
    help_content = tool_source.parse_help()
    if help_content is None:
        return None
    rendered: str | None = None
    if help_content.format == "restructuredtext" and rst_to_html is not None:
        try:
            rendered = rst_to_html(help_content.content)
        except Exception:
            log.warning("Help for tool %s does not render", tool_source.parse_id(), exc_info=True)
            rendered = ""
    return {
        "format": help_content.format,
        "content": help_content.content,
        "html": rendered,
        "rendered": rendered is not None or help_content.format != "restructuredtext",
    }


def _code_files(root) -> list[dict[str, Any]]:
    if root is None:
        return []
    code = []
    for code_elem in root.findall("code"):
        hooks: dict[str, str] = {}
        for hook_elem in code_elem.findall("hook"):
            hooks.update(hook_elem.items())
        code.append({"file": code_elem.get("file"), "hooks": hooks})
    return code


# --- inputs -----------------------------------------------------------------------------


def _parse_input_elem(page_source: PageSource, profile: float) -> list[dict[str, Any]]:
    """Mirror ``Tool.parse_input_elem``: later inputs with the same name replace earlier ones."""
    inputs: dict[str, dict[str, Any]] = {}
    for input_source in page_source.parse_input_sources():
        input_type = input_source.parse_input_type()
        if input_type == "repeat":
            group = _repeat(input_source, profile)
        elif input_type == "conditional":
            group = _conditional(input_source, inputs, profile)
        elif input_type == "section":
            group = {
                "model_class": "Section",
                "type": "section",
                "name": input_source.get("name"),
                "title": input_source.get("title"),
                "help": input_source.get("help", None),
                "expanded": input_source.get_bool("expanded", False),
                "inputs": _parse_input_elem(input_source.parse_nested_inputs_source(), profile),
            }
        elif input_type == "upload_dataset":
            elem = input_source.elem()
            group = {
                "model_class": "UploadDataset",
                "type": "upload_dataset",
                "name": elem.get("name"),
                "title": elem.get("title"),
                "file_type_name": elem.get("file_type_name", "file_type"),
                "default_file_type": elem.get("default_file_type", "txt"),
                "metadata_ref": elem.get("metadata_ref", "files_metadata"),
                "inputs": _parse_input_elem(input_source.parse_nested_inputs_source(), profile),
            }
            file_type_param = inputs.get(group["file_type_name"])
            if file_type_param is not None and file_type_param["model_class"].endswith("Parameter"):
                file_type_param["refresh_on_change"] = True
        elif input_type == "param":
            group = parameter(input_source, profile)
        else:
            continue
        inputs[group["name"]] = group
    return list(inputs.values())


def _repeat(input_source: InputSource, profile: float) -> dict[str, Any]:
    name = input_source.get("name")
    minimum = int(input_source.get("min", 0))
    maximum = float(input_source.get("max", math.inf))
    if minimum > maximum:
        raise BundleError(f"Repeat {name}: min repeat count must be less-than-or-equal to the max")
    default = int(min(max(int(input_source.get("default", 0)), minimum), maximum))
    return {
        "model_class": "Repeat",
        "type": "repeat",
        "name": name,
        "title": input_source.get("title") or name,
        "help": input_source.get("help", None),
        "default": default,
        "min": minimum,
        "max": None if math.isinf(maximum) else int(maximum),
        "inputs": _parse_input_elem(input_source.parse_nested_inputs_source(), profile),
    }


def _conditional(input_source: InputSource, siblings: dict[str, dict[str, Any]], profile: float) -> dict[str, Any]:
    name = input_source.get("name")
    value_ref = input_source.get("value_ref", None)
    value_from = input_source.get("value_from", None)
    group: dict[str, Any] = {
        "model_class": "Conditional",
        "type": "conditional",
        "name": name,
        "value_ref": value_ref,
        "value_ref_in_group": input_source.get_bool("value_ref_in_group", True),
        "value_from": value_from,
    }
    if value_from:
        # Cases come from Python code in the tool (only builtin tools use this).
        if value_ref not in siblings:
            raise BundleError(f"Conditional {name}: value_ref {value_ref!r} is not a preceding input")
        siblings[value_ref]["refresh_on_change"] = True
        group["test_param"] = None
        group["cases"] = []
        return group

    test_param = parameter(input_source.parse_test_input_source(), profile)
    if test_param["type"] not in ("boolean", "select"):
        raise BundleError(f"Conditional {name}: test parameter must be a boolean or select")
    if test_param["optional"]:
        test_param["optional"] = False
        if test_param["type"] == "boolean" and test_param["checked"] is None:
            test_param["checked"] = False
    test_param["refresh_on_change"] = True
    if test_param["type"] == "boolean":
        possible_cases = [test_param["truevalue"], test_param["falsevalue"]]
    else:
        possible_cases = list(test_param["legal_values"])
    cases = []
    for value, case_source in input_source.parse_when_input_sources():
        cases.append({"value": value, "inputs": _parse_input_elem(case_source, profile)})
        if value in possible_cases:
            possible_cases.remove(value)
    # Galaxy adds an empty case for each selectable value without a <when>.
    for value in possible_cases:
        cases.append({"value": value, "inputs": []})
    group["test_param"] = test_param
    group["cases"] = cases
    return group


def parameter(input_source: InputSource, profile: float) -> dict[str, Any]:
    """Mirror the ``ToolParameter`` subclass constructors for one ``<param>``."""
    param_type = input_source.get("type")
    name = input_source.parse_name()
    if not param_type:
        raise BundleError(f"Parameter {name!r} requires a 'type'")
    if param_type not in PARAMETER_CLASSES:
        raise BundleError(f"Parameter {name!r} uses an unknown type {param_type!r}")
    elem = input_source.elem()
    param: dict[str, Any] = {
        "model_class": PARAMETER_CLASSES[param_type],
        "type": param_type,
        "name": name,
        "argument": input_source.get("argument"),
        "label": input_source.parse_label(),
        "help": input_source.parse_help(),
        "help_format": input_source.get("help_format") or "html",
        "hidden": input_source.get_bool("hidden", False),
        "refresh_on_change": input_source.get_bool("refresh_on_change", False),
        "optional": input_source.parse_optional(),
        "is_dynamic": False,
        "sanitizer": _sanitizer(input_source.parse_sanitizer_elem()),
        "validators": list(input_source.parse_validators()),
    }
    builder = _PARAMETER_BUILDERS.get(param_type)
    if builder is not None:
        builder(param, input_source, profile)
    param["attributes"] = dict(elem.attrib)
    return param


def _simple_text(param: dict[str, Any], input_source: InputSource) -> None:
    optional = input_source.get("optional", None)
    param["optional"] = string_as_bool(optional) if optional is not None else False
    param["value"] = None if param["optional"] else ""


def _text(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _simple_text(param, input_source)
    param["datalist"] = [{"label": label, "value": value} for label, value, _ in input_source.parse_static_options()]
    if param["type"] == "text":
        param["optional"], param["optionality_inferred"] = text_input_is_optional(input_source)
    else:
        param["optionality_inferred"] = False
    param["value"] = input_source.get("value")
    param["area"] = input_source.get_bool("area", False)
    # Only workflow parameters (no tool) accept multiple values.
    param["multiple"] = False


def _number(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _text(param, input_source, profile)
    convert = int if param["type"] == "integer" else float
    value = param["value"]
    if value:
        try:
            convert(value)
        except (TypeError, ValueError):
            raise BundleError(f"Parameter {param['name']}: the attribute 'value' must be a {param['type']}")
    for bound in ("min", "max"):
        raw = input_source.get(bound)
        if raw:
            try:
                raw = convert(raw)
            except ValueError:
                raise BundleError(f"Parameter {param['name']}: attribute {bound!r} must be a {param['type']}")
        param[bound] = raw
    if param["min"] is not None or param["max"] is not None:
        param["validators"].append(InRangeParameterValidatorModel(min=param["min"], max=param["max"], implicit=True))


def _boolean(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    try:
        param["truevalue"], param["falsevalue"] = boolean_true_and_false_values(input_source, profile)
    except Exception as e:
        raise BundleError(f"Parameter {param['name']}: {e}")
    param["optional"] = input_source.get_bool("optional", False)
    param["checked"] = boolean_is_checked(input_source, profile)


def _hidden(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    param["value"] = input_source.get("value")
    param["hidden"] = True


def _baseurl(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _hidden(param, input_source, profile)
    param["value"] = input_source.get("value", "")


def _color(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    param["value"] = get_color_value(input_source)
    param["rgb"] = input_source.get_bool("rgb", False)


def _directory_uri(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _simple_text(param, input_source)


def _select(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    param["multiple"] = input_source.get_bool("multiple", False)
    param["optional"] = input_source.parse_optional(param["multiple"])
    param["display"] = input_source.get("display", None)
    param["separator"] = input_source.get("separator", ",")
    param["dynamic_options"] = input_source.get("dynamic_options", None)
    param["options"] = _dynamic_options(input_source)
    param["data_ref"] = None
    param["static_options"] = None
    param["legal_values"] = []
    if param["options"] is not None:
        param["validators"].extend(param["options"]["validators"])
        if param["options"]["from_dataset"] is not None:
            param["data_ref"] = param["options"]["from_dataset"]
    if param["dynamic_options"] is None and param["options"] is None:
        static_options = input_source.parse_static_options()
        param["static_options"] = [[label, value, selected] for label, value, selected in static_options]
        param["legal_values"] = [value for _, value, _ in static_options]
    param["is_dynamic"] = param["dynamic_options"] is not None or param["options"] is not None


def _genomebuild(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _select(param, input_source, profile)
    # Options are the server's dbkeys (GET /api/genomes) at form build time.
    param["static_options"] = None
    param["is_dynamic"] = True


def _group_tag(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _select(param, input_source, profile)
    param["tag_key"] = input_source.get("group", False)
    # SelectTagParameter keeps the raw attribute strings; Python truthiness applies.
    param["optional"] = bool(input_source.get("optional", False))
    param["multiple"] = bool(input_source.get("multiple", False))
    param["accept_default"] = input_source.get_bool("accept_default", False)
    if param["accept_default"]:
        param["optional"] = True
    param["data_ref"] = input_source.get("data_ref", None)
    param["default_value"] = input_source.get("default_value", None)
    if param["default_value"] is None:
        param["default_value"] = input_source.get("value", None)
    param["is_dynamic"] = True


def _data_column(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _select(param, input_source, profile)
    param["numerical"] = input_source.get_bool("numerical", False)
    param["optional"] = input_source.parse_optional(False)
    param["accept_default"] = input_source.get_bool("accept_default", False)
    if param["accept_default"]:
        param["optional"] = True
    param["data_ref"] = input_source.get("data_ref", None)
    if Version(str(profile)) >= Version("24.2") and param["data_ref"] is None:
        raise BundleError(f"data_column parameter {param['name']} requires a valid data_ref attribute")
    default_value = input_source.get("default_value", None)
    if default_value is None:
        default_value = input_source.get("value", None)
    if default_value is not None:
        default_value = _strip_c(default_value)
    param["default_value"] = default_value
    param["usecolnames"] = input_source.get_bool("use_header_names", False)
    param["is_dynamic"] = True


def _strip_c(column: Any) -> str:
    # ColumnListParameter._strip_c
    column = str(column).strip()
    if column.startswith("c") and len(column) > 1 and all(c.isdigit() for c in column[1:]):
        column = column.lower()[1:]
    return column


def _drill_down(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    param["multiple"] = input_source.get_bool("multiple", False)
    param["display"] = input_source.get("display", None)
    param["hierarchy"] = input_source.get("hierarchy", "exact")
    param["separator"] = input_source.get("separator", ",")
    param["from_file"] = input_source.get("from_file", None)
    param["dynamic_options"] = input_source.get("dynamic_options", None)
    if param["dynamic_options"] is not None:
        param["is_dynamic"] = True
        param["options"] = []
    elif param["from_file"] is not None:
        # Read relative to Galaxy's tool-data directory, which Planet does not have.
        param["is_dynamic"] = False
        param["options"] = None
    else:
        param["is_dynamic"] = False
        param["options"] = input_source.parse_drill_down_static_options(None)


def _base_data(param: dict[str, Any], input_source: InputSource) -> None:
    for bound in ("min", "max"):
        raw = input_source.get(bound)
        if raw:
            try:
                raw = int(raw)
            except ValueError:
                raise BundleError(f"Parameter {param['name']}: attribute {bound!r} must be an integer")
        param[bound] = raw
    param["refresh_on_change"] = True
    param["extensions"] = input_source.parse_extensions()
    options = _dynamic_options(input_source)
    param["options"] = options
    param["options_filter_attribute"] = options["options_filter_attribute"] if options else None
    param["is_dynamic"] = options is not None
    param["default_object"] = input_source.parse_default()


def _data(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _base_data(param, input_source)
    param["load_contents"] = int(input_source.get("load_contents", 0))
    param["no_validation"] = input_source.get_bool("no_validation", False)
    if not param["no_validation"]:
        param["validators"].append(MetadataParameterValidatorModel(implicit=True))
    param["tag"] = input_source.get("tag")
    param["multiple"] = input_source.get_bool("multiple", False)
    if not param["multiple"] and (param["min"] is not None or param["max"] is not None):
        raise BundleError(f"Parameter {param['name']}: min/max require multiple=\"true\"")
    param["is_dynamic"] = True
    allow_uri = input_source.get("allow_uri_if_protocol", None)
    param["allow_uri_if_protocol"] = allow_uri.split(",") if allow_uri else []
    if param["optional"] and param["default_object"] is not None:
        raise BundleError(f"Parameter {param['name']}: cannot be both optional and have a default value")
    conversions = []
    for conv_name, conv_extension in input_source.parse_conversion_tuples():
        if conv_name is None or conv_extension is None:
            raise BundleError(f"Parameter {param['name']}: conversions need a name and a type")
        conversions.append({"name": conv_name, "extension": conv_extension.lower()})
    param["conversions"] = conversions


def _hidden_data(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _data(param, input_source, profile)
    param["value"] = "None"
    param["type"] = "hidden_data"
    param["hidden"] = True
    if not param["optional"]:
        raise BundleError(f"hidden_data parameter {param['name']} must declare optional=\"true\"")


def _data_collection(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    _base_data(param, input_source)
    collection_types = input_source.get("collection_type", None)
    param["collection_types"] = [t.strip() for t in collection_types.split(",")] if collection_types else None
    param["tag"] = input_source.get("tag")
    param["multiple"] = False
    param["is_dynamic"] = True
    param["fields"] = input_source.get("fields", None)
    param["column_definitions"] = input_source.get("column_definitions", None)
    if param["optional"] and param["default_object"] is not None:
        raise BundleError(f"Parameter {param['name']}: cannot be both optional and have a default value")


def _rules(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    param["data_ref"] = input_source.get("data_ref", None)


def _ftpfile(param: dict[str, Any], input_source: InputSource, profile: float) -> None:
    param["multiple"] = input_source.get_bool("multiple", True)
    param["optional"] = input_source.parse_optional(True)


_PARAMETER_BUILDERS = {
    "text": _text,
    "integer": _number,
    "float": _number,
    "boolean": _boolean,
    "hidden": _hidden,
    "baseurl": _baseurl,
    "color": _color,
    "select": _select,
    "genomebuild": _genomebuild,
    "group_tag": _group_tag,
    "data_column": _data_column,
    "drill_down": _drill_down,
    "data": _data,
    "hidden_data": _hidden_data,
    "data_collection": _data_collection,
    "rules": _rules,
    "directory_uri": _directory_uri,
    "ftpfile": _ftpfile,
}


def _snippet(elem) -> str:
    detached = copy.deepcopy(elem)
    detached.tail = None
    return xml_to_string(detached)


def _element(elem) -> dict[str, Any]:
    """Generic, lossless view of an element: tag, attributes, text and child elements."""
    node: dict[str, Any] = {"tag": elem.tag, "attributes": dict(elem.attrib)}
    text = (elem.text or "").strip()
    if text:
        node["text"] = elem.text
    children = [_element(child) for child in elem if isinstance(child.tag, str)]
    if children:
        node["children"] = children
    return node


def _dynamic_options(input_source: InputSource) -> dict[str, Any] | None:
    """Normalized ``<options>`` definition, mirroring ``DynamicOptions.__init__``."""
    dynamic = input_source.parse_dynamic_options()
    if dynamic is None:
        return None
    elem = dynamic.elem()
    if elem is None:
        return None
    columns: dict[str, int] = {}
    for column_elem in elem.findall("column"):
        column_name = column_elem.get("name")
        index = column_elem.get("index")
        if column_name is None or index is None:
            raise BundleError("<column> in <options> requires 'name' and 'index'")
        columns[column_name] = int(index)
    if columns and "name" not in columns and "value" in columns:
        columns["name"] = columns["value"]
    filters = []
    for filter_elem in elem.findall("filter"):
        definition = dict(filter_elem.attrib)
        children = [_element(child) for child in filter_elem if isinstance(child.tag, str)]
        if children:
            definition["children"] = children
        filters.append(definition)
    from_url = None
    if (from_url_value := elem.get("from_url")) is not None:
        request_elem = elem.find("request")
        postprocess = elem.find("postprocess_expression")
        from_url = {
            "url": from_url_value,
            "request": _element(request_elem) if request_elem is not None else None,
            "postprocess_expression": (
                {"type": postprocess.get("type"), "expression": postprocess.text} if postprocess is not None else None
            ),
        }
    return {
        "from_dataset": elem.get("from_dataset"),
        "from_file": elem.get("from_file"),
        "from_data_table": elem.get("from_data_table"),
        "from_parameter": elem.get("from_parameter"),
        "from_url": from_url,
        "transform_lines": elem.get("transform_lines"),
        "meta_file_key": elem.get("meta_file_key"),
        "options_filter_attribute": elem.get("options_filter_attribute"),
        "separator": elem.get("separator", "\t"),
        "startswith": elem.get("startswith"),
        "columns": columns,
        "filters": filters,
        "validators": parse_xml_validators(elem),
        "xml": _snippet(elem),
    }


def _sanitizer(elem) -> dict[str, Any] | None:
    """``<sanitizer>`` as read by ``ToolParameterSanitizer.from_element``."""
    if elem is None:
        return None

    def actions(parent) -> list[dict[str, Any]]:
        return [{"action": child.tag.lower(), **dict(child.attrib)} for child in parent if isinstance(child.tag, str)]

    return {
        "invalid_char": elem.get("invalid_char", "X"),
        "sanitize": string_as_bool(elem.get("sanitize", "True")),
        "valid": [{"initial": e.get("initial", "default"), "actions": actions(e)} for e in elem.findall("valid")],
        "mapping": [{"initial": e.get("initial", "default"), "actions": actions(e)} for e in elem.findall("mapping")],
        "xml": _snippet(elem),
    }


# --- outputs ----------------------------------------------------------------------------


def _output_elements(root) -> dict[str, Any]:
    """Map output names to their elements, including datasets nested in collections."""
    elems: dict[str, Any] = {}
    if root is None or (outputs_elem := root.find("outputs")) is None:
        return elems
    for child in outputs_elem.iter():
        if child.tag in ("data", "collection", "output") and child.get("name"):
            elems.setdefault(child.get("name"), child)
    return elems


def _output(output, elem, app) -> dict[str, Any]:
    as_dict = output.to_dict(app=app)
    as_dict["filters"] = [f.text for f in (elem.findall("filter") if elem is not None else [])]
    if isinstance(output, ToolOutput):
        as_dict["change_format"] = list(output.change_format or [])
        as_dict["precreate_directory"] = output.precreate_directory
        as_dict["from_expression"] = output.from_expression
    elif isinstance(output, ToolExpressionOutput):
        as_dict["from_expression"] = output.from_expression
        as_dict["path"] = output.path
    elif isinstance(output, ToolOutputCollection):
        as_dict["outputs"] = [_output(child, _child_elem(elem, child.name), app) for child in output.outputs.values()]
    actions_elem = elem.find("actions") if elem is not None else None
    as_dict["actions"] = (
        {"element": _element(actions_elem), "xml": _snippet(actions_elem)} if actions_elem is not None else None
    )
    return as_dict


def _child_elem(parent, name: str):
    if parent is None:
        return None
    for data_elem in parent.findall("data"):
        if data_elem.get("name") == name:
            return data_elem
    return None
