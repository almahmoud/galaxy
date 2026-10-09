import json
from pathlib import Path
from typing import Any

import pytest
from conftest import new_uuid

from planet_runtime.evaluation import (
    EvaluationError,
    JobEvaluator,
)
from planet_runtime.stage_in import prepare_layout

BED = "chr1\t10\t20\tn1\t0\t+\nchr2\t30\t40\tn2\t0\t-\n"


def tool_manifest(
    command: str, inputs=(), params=None, datasets=None, outputs=(), tool_outputs=None, collections=None, **tool
):
    return {
        "protocol": 1,
        "kind": "tool",
        "job": {"id": "job1", "attempt": 1, "walltime_seconds": 60, "slots": 2, "shell": "/bin/sh"},
        "tool": {
            "id": "test_tool",
            "version": "1.0.0",
            "name": "Test Tool",
            "profile": "21.01",
            "command": command,
            "inputs": list(inputs),
            "outputs": tool_outputs or {},
            **tool,
        },
        "params": params or {},
        "inputs": datasets or {},
        "collections": collections or {},
        "outputs": list(outputs),
        "user": {"email": "user@example.org", "username": "user"},
    }


def add_input(layout, key: str, content: str, **record) -> dict[str, Any]:
    record = {"uuid": new_uuid(), "id": 7, "hid": 3, "name": key, "ext": "txt", "dbkey": "?", **record}
    path = layout.input_path(record["uuid"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return record


def evaluate(layout, manifest):
    prepare_layout(layout)
    evaluator = JobEvaluator(manifest, layout)
    return evaluator, evaluator.build()


def test_conditional_repeat_data_and_sanitization(layout):
    bed = add_input(
        layout,
        "in1",
        BED,
        name="evil'; rm -rf ~ #.bed",
        ext="bed",
        dbkey="hg38",
        metadata={"columns": 6, "chromCol": 1, "startCol": 2, "endCol": 3, "strandCol": 6},
    )
    out_uuid = new_uuid()
    command = r"""
#import re
#set $safe = re.sub('[^\w\-_\.]', '_', str($input1.element_identifier))
ln -s '$input1' '${safe}.${input1.ext}' &&
tool
#if $mode.type == "fast":
  -k $mode.k
#end if
#for $r in $queries:
  --q '$r.q'
#end for
--cols $input1.metadata.columns --chrom $input1.metadata.chromCol --strand $input1.metadata.strandCol
$flag --title '$title' --name '$input1.name' --dbkey $input1.dbkey --ratio $ratio
#if $input1.is_of_type("interval"):
  --interval
#end if
--threads \${GALAXY_SLOTS:-1} --hid $input1.hid --user '$__user_email__'
> '$out_file1'
"""
    manifest = tool_manifest(
        command,
        inputs=[
            {"name": "input1", "type": "data", "formats": ["bed"]},
            {
                "name": "mode",
                "type": "conditional",
                "test_param": {"name": "type", "type": "select", "options": [{"value": "fast"}, {"value": "slow"}]},
                "cases": [
                    {"value": "fast", "inputs": [{"name": "k", "type": "integer"}]},
                    {"value": "slow", "inputs": [{"name": "r", "type": "float"}]},
                ],
            },
            {"name": "queries", "type": "repeat", "inputs": [{"name": "q", "type": "text"}]},
            {"name": "flag", "type": "boolean", "truevalue": "--flag", "falsevalue": ""},
            {"name": "title", "type": "text"},
            {"name": "ratio", "type": "float"},
        ],
        params={
            "input1": {"src": "hda", "key": "in1"},
            "mode": {"type": "fast", "k": "5"},
            "queries": [{"q": "x y"}, {"q": "it's"}],
            "flag": True,
            "title": "a;b`rm`",
            "ratio": "1",
        },
        datasets={"in1": bed},
        outputs=[{"name": "out_file1", "uuid": out_uuid, "ext": "tabular"}],
        tool_outputs={"out_file1": {"model_class": "ToolOutput", "name": "out_file1", "format": "tabular"}},
    )
    evaluator, result = evaluate(layout, manifest)
    input_path = layout.input_path(bed["uuid"])
    assert result.command_line == (
        f"ln -s '{input_path}' 'evil__sq__X_rm_-rf_X___pd__.bed.bed' && tool -k 5 --q 'x y' --q 'it__sq__s' "
        "--cols 6 --chrom 1 --strand 6 --flag --title 'aXbXrmX' --name 'evil__sq__X rm -rf X __pd__.bed' "
        "--dbkey hg38 --ratio 1.0 --interval --threads ${GALAXY_SLOTS:-1} --hid 3 --user 'user@example.org' "
        f"> '{layout.output_path(out_uuid)}'"
    )
    assert result.outputs["out_file1"].format == "tabular"
    assert result.outputs["out_file1"].label == "Test Tool on dataset 3"
    assert evaluator.incoming["dbkey"] == "hg38"
    assert evaluator.incoming["__input_ext"] == "input"


def test_custom_sanitizer_and_unsanitized_tool(layout):
    sanitizer = '<sanitizer invalid_char=""><valid initial="string.ascii_letters"/></sanitizer>'
    inputs = [{"name": "word", "type": "text", "sanitizer": sanitizer}, {"name": "raw", "type": "text"}]
    params = {"word": "ab;c'd 1", "raw": "a'b"}
    _, result = evaluate(layout, tool_manifest("echo $word '$raw'", inputs=inputs, params=params))
    assert result.command_line == "echo abcd 'a__sq__b'"

    manifest = tool_manifest("echo $word '$raw'", inputs=inputs, params=params, options={"sanitize": False})
    _, result = evaluate(layout, manifest)
    assert result.command_line == "echo ab;c'd 1 'a'b'"


def test_python_2_template(layout):
    command = (
        "#set $n = 10L\n#set $items = [x * 2 for x in range(3)]\necho $n ${len($items)} ${'-'.join(map(str, $items))}"
    )
    manifest = tool_manifest(command, profile="18.01")
    evaluator, result = evaluate(layout, manifest)
    assert evaluator.tool.python_template_version == "2.7"
    assert result.command_line == "echo 10 3 0-2-4"


def test_configfile_with_inputs_json_and_environment(layout):
    bed = add_input(layout, "in1", BED, ext="bed")
    manifest = tool_manifest(
        "python '$__tool_directory__/run.py' '$inputs' '$script' && cat '$script'",
        inputs=[
            {"name": "input1", "type": "data", "formats": ["bed"]},
            {"name": "size", "type": "integer"},
            {"name": "sel", "type": "select", "multiple": True, "options": [{"value": "a"}, {"value": "b"}]},
            {"name": "opt", "type": "boolean", "optional": True},
        ],
        params={"input1": {"src": "hda", "key": "in1"}, "size": 4, "sel": ["a", "b"], "opt": None},
        datasets={"in1": bed},
        configfiles=[
            {"name": "inputs", "type": "inputs", "handle_files": "paths"},
            {"name": "script", "type": "configfile", "content": "size=$size\nsel=$sel\n"},
        ],
        environment_variables=[{"name": "TOOL_SIZE", "template": "$size", "strip": True}],
    )
    evaluator, result = evaluate(layout, manifest)
    configs = sorted(layout.configs.iterdir())
    assert len(configs) == 2
    by_content = {path.read_text()[:1]: path for path in configs}
    inputs_json = json.loads(by_content["{"].read_text())
    assert inputs_json == {
        "input1": str(layout.input_path(bed["uuid"])),
        "size": 4,
        "sel": ["a", "b"],
        "opt": None,
    }
    assert by_content["s"].read_text() == "size=4\nsel=a,b\n"
    assert result.command_line.startswith(f"python '{layout.tool_directory}/run.py' '{layout.configs}/")
    names = [variable["name"] for variable in result.environment_variables]
    assert names == ["TOOL_SIZE", "HOME", "TMPDIR", "TMP", "TEMP"]
    tool_size = result.environment_variables[0]
    assert Path(tool_size["job_directory_path"]).read_text() == "4"
    assert result.environment_variables[1]["value"] == '"$_GALAXY_JOB_HOME_DIR"'


def test_legacy_profile_text_default_and_shared_home(layout):
    manifest = tool_manifest(
        "echo x${opt}x",
        inputs=[{"name": "opt", "type": "text", "optional": True, "optionality_inferred": True}],
        params={"opt": None},
        profile="16.04",
    )
    _, result = evaluate(layout, manifest)
    assert result.command_line == "echo xx"
    assert [v["name"] for v in result.environment_variables] == ["TMPDIR", "TMP", "TEMP"]


def test_output_filter_label_and_change_format(layout):
    tool_outputs = {
        "kept": {
            "model_class": "ToolOutput",
            "name": "kept",
            "format": "txt",
            "label": "${tool.name} on ${on_string}: $mode",
            "change_format": [{"input": "$mode", "value": "csv", "format": "csv"}],
        },
        "dropped": {"model_class": "ToolOutput", "name": "dropped", "format": "txt", "filters": ["mode == 'tsv'"]},
    }
    kept, dropped = new_uuid(), new_uuid()
    manifest = tool_manifest(
        "echo $mode > '$kept'\n#if $dropped:\n&& echo '$dropped'\n#end if",
        inputs=[{"name": "mode", "type": "select", "options": [{"value": "csv"}, {"value": "tsv"}]}],
        params={"mode": "csv"},
        outputs=[{"name": "kept", "uuid": kept}, {"name": "dropped", "uuid": dropped}],
        tool_outputs=tool_outputs,
    )
    _, result = evaluate(layout, manifest)
    assert result.outputs["kept"].format == "csv"
    assert result.outputs["kept"].label == "Test Tool on : csv"
    assert result.outputs["dropped"].filtered
    assert result.command_line == f"echo csv > '{layout.output_path(kept)}'"


def test_collection_input(layout):
    first = add_input(layout, "e1", "a\n", ext="txt", hid=5)
    second = add_input(layout, "e2", "b\n", ext="txt", hid=6)
    manifest = tool_manifest(
        "#for $e in $coll\ncat '$e' > '${e.element_identifier}.txt';\n#end for\necho ${coll.keys()}",
        inputs=[{"name": "coll", "type": "data_collection", "collection_types": ["list"]}],
        params={"coll": {"src": "hdca", "key": "c1"}},
        datasets={"e1": first, "e2": second},
        collections={
            "c1": {
                "name": "my list",
                "hid": 7,
                "collection_type": "list",
                "elements": [
                    {"element_identifier": "sample1", "input": "e1"},
                    {"element_identifier": "sample2", "input": "e2"},
                ],
            }
        },
    )
    _, result = evaluate(layout, manifest)
    assert result.command_line == (
        f"cat '{layout.input_path(first['uuid'])}' > 'sample1.txt'; "
        f"cat '{layout.input_path(second['uuid'])}' > 'sample2.txt'; echo dict_keys(['sample1', 'sample2'])"
    )


def test_template_error_is_reported(layout):
    manifest = tool_manifest("echo $missing_variable")
    with pytest.raises(EvaluationError) as error:
        evaluate(layout, manifest)
    assert error.value.phase == "command line"


def test_data_in_repeat_and_conditional_after_output_planning(layout):
    first = add_input(layout, "a", "1\n", ext="txt", hid=4)
    second = add_input(layout, "b", "2\n", ext="tabular", hid=9)
    manifest = tool_manifest(
        "#for $q in $queries\ncat '$q.part' >> out;\n#end for\n#if $opt.use == 'yes'\ncat '$opt.extra' >> out\n#end if",
        inputs=[
            {"name": "queries", "type": "repeat", "inputs": [{"name": "part", "type": "data", "formats": ["txt"]}]},
            {
                "name": "opt",
                "type": "conditional",
                "test_param": {"name": "use", "type": "boolean", "truevalue": "yes", "falsevalue": "no"},
                "cases": [
                    {"value": "yes", "inputs": [{"name": "extra", "type": "data", "formats": ["tabular"]}]},
                    {"value": "no", "inputs": []},
                ],
            },
        ],
        params={
            "queries": [{"part": {"src": "hda", "key": "a"}}],
            "opt": {"use": True, "extra": {"src": "hda", "key": "b"}},
        },
        datasets={"a": first, "b": second},
        tool_outputs={"o": {"model_class": "ToolOutput", "name": "o", "format": "txt", "label": "${on_string}"}},
    )
    evaluator, result = evaluate(layout, manifest)
    assert result.command_line == (
        f"cat '{layout.input_path(first['uuid'])}' >> out; cat '{layout.input_path(second['uuid'])}' >> out"
    )
    assert result.outputs["o"].label == "dataset 4 and 9"
    assert sorted(evaluator.input_datasets) == ["opt|extra", "queries_0|part"]
