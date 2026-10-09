"""Tool parameters built from the manifest's parameter definitions.

These classes implement the behaviour of ``galaxy.tools.parameters.basic`` and
``grouping`` that command templates observe: restoring job state values
(``value_from_basic``), ``to_param_dict_string`` with Galaxy's sanitization,
``value_to_display_text``, select option fields and the attributes read by
``galaxy.tools.wrappers`` and ``wrapped_json``. Data and collection values are
resolved by a callable supplied by the caller.
"""

from collections.abc import (
    Callable,
    Mapping,
)
from dataclasses import dataclass
from typing import Any

from galaxy.util import (
    sanitize_param,
    string_as_bool,
    string_as_bool_or_none,
    unicodify,
    XML,
)
from packaging.version import Version

from planet_runtime import galaxy_env

galaxy_env.install_base()

from galaxy.tools.parameters.sanitize import ToolParameterSanitizer

__all__ = [
    "BooleanToolParameter",
    "ColorToolParameter",
    "ColumnListParameter",
    "DataCollectionToolParameter",
    "DataToolParameter",
    "DirectoryUriToolParameter",
    "DrillDownSelectToolParameter",
    "FloatToolParameter",
    "GenomeBuildParameter",
    "HiddenToolParameter",
    "IntegerToolParameter",
    "SelectTagParameter",
    "SelectToolParameter",
    "TextToolParameter",
    "ToolParameter",
]

ResolveData = Callable[[Any, "ToolParameter"], Any]


class ParameterError(ValueError):
    pass


@dataclass(frozen=True)
class ToolOptions:
    sanitize: bool = True


@dataclass(frozen=True)
class ToolInfo:
    """The parts of ``galaxy.tools.Tool`` that parameters and wrappers read."""

    id: str
    name: str
    version: str
    profile: str
    options: ToolOptions
    python_template_version: str = "3"

    @property
    def profile_version(self) -> Version:
        return Version(str(self.profile))


class ToolParameter:
    def __init__(self, tool: ToolInfo | None, definition: Mapping[str, Any]):
        self.tool = tool
        self.name: str = definition["name"]
        self.type: str = definition.get("type", "text")
        self.argument = definition.get("argument")
        self.label = definition.get("label") or ""
        self.hidden = bool(definition.get("hidden", False))
        self.optional = bool(definition.get("optional", False))
        self.multiple = False
        self.is_dynamic = False
        sanitizer = definition.get("sanitizer")
        if isinstance(sanitizer, Mapping):
            sanitizer = sanitizer.get("xml")
        self.sanitizer = ToolParameterSanitizer.from_element(XML(sanitizer)) if sanitizer else None

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} {self.name}>"

    def _sanitize(self, value):
        if self.tool is None or self.tool.options.sanitize:
            if self.sanitizer:
                return self.sanitizer.sanitize_param(value)
            return sanitize_param(value)
        return value

    def value_from_basic(self, value, resolve: ResolveData):
        return self.to_python(value)

    def to_python(self, value):
        return value

    def to_param_dict_string(self, value, other_values=None) -> str:
        if value is None:
            value = ""
        elif not isinstance(value, str):
            value = str(value)
        return self._sanitize(value)

    def value_to_display_text(self, value) -> str:
        return self.to_text(value)

    def to_text(self, value) -> str:
        if value is not None:
            str_value = unicodify(value)
            if not str_value:
                return "Empty."
            return str_value
        return "Not available."


class TextToolParameter(ToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.profile = tool.profile if tool else None
        self.value = definition.get("value")
        self.area = bool(definition.get("area", False))
        self.optionality_inferred = bool(definition.get("optionality_inferred", False)) and self.type == "text"

    @property
    def wrapper_default(self) -> str | None:
        legacy_behavior = self.profile is None or Version(str(self.profile)) < Version("23.0")
        if self.optional and self.optionality_inferred and legacy_behavior:
            return ""
        return None


class IntegerToolParameter(TextToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.multiple = bool(definition.get("multiple", False))

    def to_python(self, value):
        if self.multiple and value is not None:
            return [int(v) for v in (value if isinstance(value, list) else [value]) if v not in ("", None)]
        try:
            return int(value)
        except (TypeError, ValueError):
            if not value and self.optional:
                return None
            raise ParameterError(f"Parameter '{self.name}': an integer is required") from None


class FloatToolParameter(TextToolParameter):
    def to_python(self, value):
        try:
            return float(value)
        except (TypeError, ValueError):
            if not value and self.optional:
                return None
            raise ParameterError(f"Parameter '{self.name}': a float is required") from None


class BooleanToolParameter(ToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.truevalue = str(definition.get("truevalue", "true"))
        self.falsevalue = str(definition.get("falsevalue", "false"))
        self.optional = bool(definition.get("optional", False))

    def to_python(self, value):
        if not self.optional:
            return string_as_bool(value)
        return string_as_bool_or_none(value)

    def to_param_dict_string(self, value, other_values=None):
        return self.truevalue if self.to_python(value) else self.falsevalue


class HiddenToolParameter(ToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.value = definition.get("value")
        self.hidden = True


class ColorToolParameter(ToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.rgb = bool(definition.get("rgb", False))

    def to_param_dict_string(self, value, other_values=None):
        if self.rgb:
            try:
                return str(tuple(int(value.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4)))
            except Exception:
                raise ParameterError(f"Parameter '{self.name}': Failed to convert '{value}' to RGB.") from None
        return str(value)


class DirectoryUriToolParameter(ToolParameter):
    def to_param_dict_string(self, value, other_values=None) -> str:
        if value is None:
            return ""
        return value if isinstance(value, str) else str(value)


class OptionFields:
    """Dynamic option rows (``<options>`` from data tables or datasets) resolved by the browser."""

    def __init__(self, rows: Mapping[str, Mapping[str, Any]]):
        self.rows = rows

    def get_field_by_name_for_value(self, field_name, value, trans, other_values):
        values = value if isinstance(value, list) else [value]
        return [
            self.rows[str(v)][field_name] for v in values if str(v) in self.rows and field_name in self.rows[str(v)]
        ]


class SelectToolParameter(ToolParameter):
    value_label: str

    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.multiple = bool(definition.get("multiple", False))
        self.optional = bool(definition.get("optional", self.multiple))
        self.display = definition.get("display")
        self.separator = definition.get("separator", ",")
        self.is_dynamic = bool(definition.get("is_dynamic", False))
        if isinstance(definition.get("static_options"), list):
            self.static_options = [
                (label, value, bool(selected)) for label, value, selected in definition["static_options"]
            ]
        else:
            options = definition.get("options")
            self.static_options = [
                (option.get("label", option["value"]), option["value"], bool(option.get("selected", False)))
                for option in (options if isinstance(options, list) else [])
            ]
        fields = definition.get("option_fields")
        self.options = OptionFields(fields) if fields else None

    def to_python(self, value):
        return value

    def to_param_dict_string(self, value, other_values=None):
        if value in (None, []):
            return "None"
        if isinstance(value, list):
            if not self.multiple:
                raise ParameterError(
                    f"Parameter '{self.name}': multiple values provided but parameter is not expecting multiple values"
                )
            value = list(map(str, value))
        else:
            value = str(value)
        value = self._sanitize(value)
        if isinstance(value, list):
            value = self.separator.join(value)
        return value

    def to_text(self, value):
        if not isinstance(value, list):
            value = [value]
        if self.is_dynamic:
            rval = [str(v) for v in value]
        else:
            rval = [label for label, option_value, _ in self.static_options if option_value in value]
        if rval:
            return "\n".join(rval)
        return "Nothing selected."


class GenomeBuildParameter(SelectToolParameter):
    pass


class SelectTagParameter(SelectToolParameter):
    pass


class ColumnListParameter(SelectToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.is_dynamic = True


class DrillDownSelectToolParameter(SelectToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.hierarchy = definition.get("hierarchy", "exact")
        self.drill_down_options = definition.get("options") or []
        self.static_options = []

    def _options_list(self, value) -> list[str]:
        def base_option(value, options):
            for option in options:
                if value == option["value"]:
                    return option
                if found := base_option(value, option.get("options") or []):
                    return found
            return None

        def recurse(collected, option):
            if not option.get("options"):
                collected.append(option["value"])
            else:
                for child in option["options"]:
                    recurse(collected, child)

        collected: list[str] = []
        if option := base_option(value, self.drill_down_options):
            recurse(collected, option)
        return collected or [value]

    def to_param_dict_string(self, value, other_values=None):
        if value is None:
            return "None"
        values = value if isinstance(value, list) else [value]
        if self.hierarchy == "exact":
            rval = values
        else:
            rval = list(dict.fromkeys(v for item in values for v in self._options_list(item)))
        if len(rval) > 1 and not self.multiple:
            raise ParameterError(
                f"Parameter '{self.name}': multiple values provided but parameter is not expecting multiple values"
            )
        return self._sanitize(self.separator.join(rval))

    def to_text(self, value):
        def display(value, options):
            for option in options:
                if value == option["value"]:
                    return option["name"]
                if found := display(value, option.get("options") or []):
                    return found
            return None

        values = [] if not value else value if isinstance(value, list) else [value]
        rval = values if self.is_dynamic else [display(v, self.drill_down_options) or v for v in values]
        if rval:
            return "\n".join(map(str, rval))
        return "Nothing selected."


class BaseDataToolParameter(ToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.multiple = bool(definition.get("multiple", False))
        self.formats = definition.get("formats") or definition.get("extensions") or []
        self.load_contents = int(definition.get("load_contents") or 0)

    def value_from_basic(self, value, resolve: ResolveData):
        if value is None:
            return None
        if self.multiple or isinstance(value, list):
            values = value if isinstance(value, list) else [value]
            resolved = [resolve(v, self) for v in values]
            return resolved if self.multiple else (resolved[0] if resolved else None)
        return resolve(value, self)

    def to_param_dict_string(self, value, other_values=None):
        if value is None:
            return "None"
        return value.get_file_name()

    def to_text(self, value):
        if value and not isinstance(value, list):
            value = [value]
        if value:
            try:
                return ", ".join(f"{item.hid}: {item.name}" for item in value)
            except Exception:
                pass
        return "No dataset."


class DataToolParameter(BaseDataToolParameter):
    pass


class DataCollectionToolParameter(BaseDataToolParameter):
    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.multiple = False
        self.collection_types = definition.get("collection_types") or []


class Group:
    type = ""

    def __init__(self, tool: ToolInfo | None, definition: Mapping[str, Any]):
        self.name: str = definition["name"]
        self.inputs: dict[str, Any] = {}

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} {self.name}>"


class Repeat(Group):
    type = "repeat"

    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.inputs = build_inputs(tool, definition.get("inputs") or [])

    def value_from_basic(self, value, resolve: ResolveData):
        rval = []
        for i, d in enumerate(value or []):
            rval_dict = {"__index__": d.get("__index__", i)}
            for child in self.inputs.values():
                rval_dict[child.name] = child.value_from_basic(d.get(child.name), resolve)
            rval.append(rval_dict)
        return rval


class Section(Group):
    type = "section"

    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.inputs = build_inputs(tool, definition.get("inputs") or [])

    def value_from_basic(self, value, resolve: ResolveData):
        value = value or {}
        return {child.name: child.value_from_basic(value.get(child.name), resolve) for child in self.inputs.values()}


@dataclass
class ConditionalCase:
    value: str
    inputs: dict[str, Any]


class Conditional(Group):
    type = "conditional"

    def __init__(self, tool, definition):
        super().__init__(tool, definition)
        self.test_param = build_parameter(tool, definition["test_param"])
        self.cases = [
            ConditionalCase(str(case["value"]), build_inputs(tool, case.get("inputs") or []))
            for case in definition.get("cases") or []
        ]

    def get_current_case(self, value) -> int:
        str_value = self.test_param.to_param_dict_string(value)
        for index, case in enumerate(self.cases):
            if str_value == case.value:
                return index
        raise ParameterError(f"Conditional '{self.name}': no case matched value {str_value!r}")

    def value_from_basic(self, value, resolve: ResolveData):
        value = value or {}
        rval: dict[str, Any] = {}
        rval[self.test_param.name] = self.test_param.value_from_basic(value.get(self.test_param.name), resolve)
        current_case = rval["__current_case__"] = self.get_current_case(rval[self.test_param.name])
        for child in self.cases[current_case].inputs.values():
            rval[child.name] = child.value_from_basic(value.get(child.name), resolve)
        return rval


PARAMETER_TYPES: dict[str, type[ToolParameter]] = {
    "text": TextToolParameter,
    "integer": IntegerToolParameter,
    "float": FloatToolParameter,
    "boolean": BooleanToolParameter,
    "genomebuild": GenomeBuildParameter,
    "select": SelectToolParameter,
    "color": ColorToolParameter,
    "group_tag": SelectTagParameter,
    "data_column": ColumnListParameter,
    "hidden": HiddenToolParameter,
    "hidden_data": DataToolParameter,
    "baseurl": HiddenToolParameter,
    "data": DataToolParameter,
    "data_collection": DataCollectionToolParameter,
    "drill_down": DrillDownSelectToolParameter,
    "directory_uri": DirectoryUriToolParameter,
    "rules": ToolParameter,
}

GROUP_TYPES: dict[str, type[Group]] = {
    "repeat": Repeat,
    "section": Section,
    "conditional": Conditional,
}


GROUP_MODEL_CLASSES = {"Repeat": "repeat", "Section": "section", "Conditional": "conditional"}


def build_parameter(tool: ToolInfo | None, definition: Mapping[str, Any]):
    kind = GROUP_MODEL_CLASSES.get(definition.get("model_class", "")) or definition.get("type", "text")
    if kind in GROUP_TYPES:
        return GROUP_TYPES[kind](tool, definition)
    if kind not in PARAMETER_TYPES:
        raise ParameterError(f"Parameter '{definition.get('name')}' has an unsupported type '{kind}'")
    return PARAMETER_TYPES[kind](tool, definition)


def build_inputs(tool: ToolInfo | None, definitions) -> dict[str, Any]:
    inputs: dict[str, Any] = {}
    for definition in definitions:
        parameter = build_parameter(tool, definition)
        inputs[parameter.name] = parameter
    return inputs


def params_from_basic(inputs: Mapping[str, Any], values: Mapping[str, Any], resolve: ResolveData) -> dict[str, Any]:
    """Restore job state values like ``galaxy.tools.parameters.params_from_strings``.

    Keys without a parameter definition (``dbkey``, ``chromInfo``,
    ``__input_ext``, ``<name>|__identifier__`` and the like) are kept as given.
    """
    rval: dict[str, Any] = {}
    for key, value in values.items():
        parameter = inputs.get(key)
        rval[key] = parameter.value_from_basic(value, resolve) if parameter is not None else value
    for name, parameter in inputs.items():
        if name not in rval:
            rval[name] = parameter.value_from_basic(None, resolve)
    return rval


def visit_inputs(inputs: Mapping[str, Any], values: Mapping[str, Any], visitor, prefix: str = "") -> None:
    """Call ``visitor(parameter, values, prefixed_name)`` for each leaf parameter of the current state."""
    for parameter in inputs.values():
        if isinstance(parameter, Repeat):
            for d in values.get(parameter.name) or []:
                visit_inputs(parameter.inputs, d, visitor, f"{prefix}{parameter.name}_{d['__index__']}|")
        elif isinstance(parameter, Conditional):
            group_values = values[parameter.name]
            visitor(parameter.test_param, group_values, f"{prefix}{parameter.name}|{parameter.test_param.name}")
            case = parameter.cases[group_values["__current_case__"]]
            visit_inputs(case.inputs, group_values, visitor, f"{prefix}{parameter.name}|")
        elif isinstance(parameter, Section):
            visit_inputs(parameter.inputs, values[parameter.name], visitor, f"{prefix}{parameter.name}|")
        else:
            visitor(parameter, values, f"{prefix}{parameter.name}")
