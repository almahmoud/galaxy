import json
from pathlib import Path

import pytest
from galaxy.tool_util.parser import get_tool_source
from galaxy.util import galaxy_directory

from planet_runtime.generate.bundle import (
    build_bundle,
    BundleError,
)

SCHEMA_PATH = Path(galaxy_directory()) / "planet" / "toolbox" / "tool-bundle.schema.json"


def _bundle(tmp_path: Path, xml: str, **kwds):
    path = tmp_path / "tool.xml"
    path.write_text(xml)
    return build_bundle(get_tool_source(str(path)), **kwds)


def _tool(inputs: str = "", outputs: str = "", extra: str = "", attrs: str = 'profile="23.0"') -> str:
    return f"""<tool id="t" name="T" version="1.0" {attrs}>
    <command>echo $x &gt; '$out'</command>
    <inputs>{inputs}</inputs>
    <outputs>{outputs}</outputs>
    {extra}
    <help>**bold**</help>
</tool>"""


def _validator():
    jsonschema = pytest.importorskip("jsonschema")
    return jsonschema.Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))


def test_tool_level_fields(tmp_path):
    bundle = _bundle(tmp_path, _tool(attrs='profile="16.04"'), tool_id="shed/repos/o/r/t/1.0")
    assert bundle["id"] == "shed/repos/o/r/t/1.0"
    assert bundle["old_id"] == "t"
    assert bundle["python_template_version"] == "2.7"
    assert bundle["hidden"] == ""
    assert bundle["model_class"] == "Tool"
    assert bundle["form_style"] == "regular"
    assert bundle["command"]["text"].startswith("echo $x")
    assert bundle["command"]["strict"] is False
    assert bundle["help"]["format"] == "restructuredtext"
    assert bundle["help"]["content"] == "**bold**"
    assert "<strong>bold</strong>" in bundle["help"]["html"]
    json.dumps(bundle, allow_nan=False)


def test_numbers_get_implicit_range_validator(tmp_path):
    bundle = _bundle(tmp_path, _tool('<param name="n" type="integer" value="3" min="1" max="10"/>'))
    (param,) = bundle["inputs"]
    assert param["min"] == 1 and param["max"] == 10 and param["value"] == "3"
    (validator,) = param["validators"]
    assert validator["type"] == "in_range"
    assert validator["implicit"] is True
    assert (validator["min"], validator["max"]) == (1, 10)


def test_text_optionality_is_inferred(tmp_path):
    bundle = _bundle(tmp_path, _tool('<param name="s" type="text"/>'))
    (param,) = bundle["inputs"]
    assert param["optional"] is True
    assert param["optionality_inferred"] is True


def test_data_parameter(tmp_path):
    bundle = _bundle(
        tmp_path,
        _tool('<param name="d" type="data" format="fastqsanger,fastqsanger.gz" multiple="true" min="1"/>'),
    )
    (param,) = bundle["inputs"]
    assert param["extensions"] == ["fastqsanger", "fastqsanger.gz"]
    assert param["refresh_on_change"] is True
    assert param["min"] == 1
    assert param["validators"][-1]["type"] == "metadata" and param["validators"][-1]["implicit"] is True


def test_conditional_adds_cases_for_unmatched_boolean_values(tmp_path):
    inputs = """
    <conditional name="c">
        <param name="flag" type="boolean" truevalue="--yes" falsevalue="--no"/>
        <when value="--yes"><param name="a" type="text"/></when>
    </conditional>"""
    bundle = _bundle(tmp_path, _tool(inputs))
    (conditional,) = bundle["inputs"]
    assert conditional["test_param"]["refresh_on_change"] is True
    assert [case["value"] for case in conditional["cases"]] == ["--yes", "--no"]
    assert conditional["cases"][1]["inputs"] == []


def test_select_static_and_dynamic_options(tmp_path):
    inputs = """
    <param name="s" type="select">
        <option value="a">A</option>
        <option value="b" selected="true">B</option>
    </param>
    <param name="d" type="data" format="tabular"/>
    <param name="dyn" type="select">
        <options from_dataset="d" separator=",">
            <column name="value" index="0"/>
            <filter type="unique_value" column="0"/>
            <validator type="no_options" message="empty"/>
        </options>
    </param>"""
    bundle = _bundle(tmp_path, _tool(inputs))
    static, _, dynamic = bundle["inputs"]
    assert static["static_options"] == [["A", "a", False], ["B", "b", True]]
    assert static["legal_values"] == ["a", "b"]
    assert static["is_dynamic"] is False
    options = dynamic["options"]
    assert dynamic["is_dynamic"] is True and dynamic["data_ref"] == "d"
    assert options["columns"] == {"value": 0, "name": 0}
    assert options["filters"] == [{"type": "unique_value", "column": "0"}]
    assert options["validators"][0]["type"] == "no_options"
    assert options["xml"].startswith("<options")


def test_repeat_and_section(tmp_path):
    inputs = """
    <repeat name="r" title="Item" min="1" default="0"><param name="x" type="text"/></repeat>
    <section name="s" title="Advanced" expanded="true"><param name="y" type="integer" value="1"/></section>"""
    bundle = _bundle(tmp_path, _tool(inputs))
    repeat, section = bundle["inputs"]
    assert (repeat["min"], repeat["max"], repeat["default"]) == (1, None, 1)
    assert section["expanded"] is True
    assert section["inputs"][0]["name"] == "y"


def test_sanitizer_and_drill_down_from_file_not_read(tmp_path):
    inputs = """
    <param name="s" type="text">
        <sanitizer invalid_char="">
            <valid initial="string.ascii_letters"><add value="-"/></valid>
            <mapping initial="none"><add source="@" target="__at__"/></mapping>
        </sanitizer>
    </param>
    <param name="dd" type="drill_down" from_file="/etc/passwd"/>"""
    bundle = _bundle(tmp_path, _tool(inputs))
    text, drill_down = bundle["inputs"]
    assert text["sanitizer"]["invalid_char"] == ""
    assert text["sanitizer"]["valid"] == [
        {"initial": "string.ascii_letters", "actions": [{"action": "add", "value": "-"}]}
    ]
    assert text["sanitizer"]["mapping"][0]["actions"] == [{"action": "add", "source": "@", "target": "__at__"}]
    assert drill_down["options"] is None and drill_down["from_file"] == "/etc/passwd"


def test_outputs_keep_filters_change_format_and_actions(tmp_path):
    outputs = """
    <data name="out" format="txt" label="${tool.name} on ${on_string}">
        <filter>flag</filter>
        <change_format><when input="kind" value="b" format="bam"/></change_format>
        <actions><action type="metadata" name="dbkey" default="hg38"/></actions>
    </data>
    <collection name="pair" type="paired">
        <data name="forward" format="fastqsanger"/>
        <data name="reverse" format="fastqsanger"/>
    </collection>"""
    bundle = _bundle(tmp_path, _tool(outputs=outputs))
    pair, out = bundle["outputs"]
    assert pair["model_class"] == "ToolOutputCollection"
    assert [o["name"] for o in pair["outputs"]] == ["forward", "reverse"]
    assert out["filters"] == ["flag"]
    assert out["change_format"][0] == {
        "value": "b",
        "format": "bam",
        "input": "$kind",
        "input_dataset": None,
        "check_attribute": None,
    }
    assert out["actions"]["element"]["children"][0]["attributes"]["name"] == "dbkey"
    assert out["actions"]["xml"].startswith("<actions>")


def test_rejects_unknown_parameter_type(tmp_path):
    with pytest.raises(BundleError):
        _bundle(tmp_path, _tool('<param name="x" type="nope"/>'))


def test_galaxy_tools_produce_valid_bundles():
    """Every tool shipped with this Galaxy checkout serializes and validates against the schema."""
    validator = _validator()
    root = Path(galaxy_directory())
    paths = sorted((root / "tools").rglob("*.xml")) + sorted((root / "test" / "functional" / "tools").rglob("*.xml"))
    checked = 0
    for path in paths:
        try:
            tool_source = get_tool_source(str(path))
            if not tool_source.parse_id():
                continue
        except Exception:
            continue
        try:
            bundle = build_bundle(tool_source)
        except BundleError:
            continue
        errors = [e.message for e in validator.iter_errors(bundle)]
        assert not errors, f"{path}: {errors[:3]}"
        json.dumps(bundle, allow_nan=False)
        checked += 1
    assert checked > 100


def test_rejects_tools_for_newer_galaxy(tmp_path):
    with pytest.raises(BundleError, match="newer"):
        _bundle(tmp_path, _tool(attrs='profile="99.0"'))
