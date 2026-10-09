"""A tool bundle from ``planet_runtime.generate`` used verbatim as the manifest's ``tool``."""

import pytest
from conftest import (
    dataset_targets,
    job_files,
    new_uuid,
    run_tool_container,
    validate,
    write_manifest,
)

from planet_runtime import (
    stage_in,
    stage_out,
)

TOOL_XML = r"""<tool id="bundle_tool" name="Bundle tool" version="2.0" profile="22.05">
  <version_command>echo 2.0</version_command>
  <command><![CDATA[
cp '$script' script.txt &&
python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["mode"]["kind"])' '$inputs' > '$out' 2>/dev/null ||
cat '$inputs' > '$out'
  ]]></command>
  <configfiles>
    <inputs name="inputs" data_style="paths"/>
    <configfile name="script">kind=$mode.kind label=$label
#if $mode.kind == "count":
n=$mode.n
#end if
</configfile>
  </configfiles>
  <inputs>
    <conditional name="mode">
      <param name="kind" type="select" label="Kind">
        <option value="count">Count</option>
        <option value="none">None</option>
      </param>
      <when value="count"><param name="n" type="integer" value="3"/></when>
      <when value="none"/>
    </conditional>
    <param name="label" type="text" value="x">
      <sanitizer invalid_char="_"><valid initial="string.ascii_letters"/></sanitizer>
    </param>
  </inputs>
  <outputs>
    <data name="out" format="txt" label="${tool.name}: $mode.kind"/>
  </outputs>
</tool>
"""


@pytest.fixture
def bundle(tmp_path):
    from galaxy.tool_util.parser import get_tool_source

    from planet_runtime.generate.bundle import build_bundle

    path = tmp_path / "bundle_tool.xml"
    path.write_text(TOOL_XML)
    return build_bundle(get_tool_source(str(path)))


def test_bundle_as_manifest_tool(bundle, s3, layout, transfers, tmp_path, monkeypatch):
    out = new_uuid()
    manifest = {
        "protocol": 1,
        "kind": "tool",
        "job": {"id": "bundle1", "attempt": 1, "walltime_seconds": 60, "shell": "/bin/sh"},
        "tool": bundle,
        "params": {"mode": {"kind": "count", "n": 5}, "label": "a b;c"},
        "inputs": {},
        "outputs": [{"name": "out", **dataset_targets(s3, out)}],
        "job_files": job_files(s3, "bundle1"),
    }
    validate(manifest, "manifest")
    write_manifest(tmp_path, manifest, monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    prepare = s3.json("jobs/bundle1/prepare.json")
    validate(prepare, "prepare")
    assert prepare["outputs"]["out"] == {"filtered": False, "format": "txt", "label": "Bundle tool: count"}
    assert prepare["version_command"].startswith("echo 2.0 > ")
    assert prepare["configfiles"] == ["inputs", "script"]

    run_tool_container(layout, "bundle1")
    assert (layout.working / "script.txt").read_text() == "kind=count label=a_b_c\nn=5\n"
    assert stage_out.run(layout, transfers) == 0
    results = s3.json("jobs/bundle1/results.json")
    validate(results, "results")
    assert results["state"] == "ok"
    assert results["command_version"] == "2.0"
    data = s3.get(f"datasets/{out}/data").decode()
    assert data in ("count\n", '{"mode": {"kind": "count", "n": 5}, "label": "a_b_c"}')
