"""Stage-in, the job script and stage-out end to end against a fake S3 endpoint."""

import io
import json
import tarfile

from conftest import (
    dataset_targets,
    job_files,
    new_uuid,
    parse_tool,
    run_tool_container,
    validate,
    write_bam,
    write_manifest,
)

from planet_runtime import (
    stage_in,
    stage_out,
)

TOOL_XML = r"""<tool id="planet_e2e" name="E2E" version="1.0.0" profile="21.01">
  <command><![CDATA[
printf '#chrom\tstart\tend\nchr1\t1\t10\nchr2\t5\t20\n' > '$table' &&
printf '>s1\nACGT\n>s2\nGGCCAA\n' > '$seqs' &&
cp '$bam_in' '$aligned' &&
cat '$__tool_directory__/greeting.txt' &&
mkdir split coll report_dir &&
printf 'x\n' > split/part1.txt && printf 'y\ny\n' > split/part2.txt &&
printf 'c1\t1\n' > coll/sampleA.tabular && printf 'c2\t2\n' > coll/sampleB.tabular &&
printf '<html><body><script>alert(1)</script><p>ok</p></body></html>\n' > '$report' &&
mkdir -p '$report.files_path/img' && printf 'png' > '$report.files_path/img/a.png' &&
echo "warning text" >&2
  ]]></command>
  <inputs><param name="bam_in" type="data" format="bam"/></inputs>
  <outputs>
    <data name="table" format="tabular"/>
    <data name="seqs" format="fasta"/>
    <data name="aligned" format="bam"/>
    <data name="report" format="html"/>
    <data name="split" format="txt">
      <discover_datasets pattern="(?P&lt;designation&gt;.+)\.txt" directory="split" ext="txt" visible="true"/>
    </data>
    <collection name="coll" type="list">
      <discover_datasets pattern="__name_and_ext__" directory="coll"/>
    </collection>
  </outputs>
</tool>
"""


def tool_job(s3, tmp_path, tool_xml=TOOL_XML, job_id="e2e1"):
    tool = parse_tool(tool_xml, tmp_path)
    bam_path = tmp_path / "in.bam"
    write_bam(bam_path)
    bam_uuid = new_uuid()
    s3.put(f"datasets/{bam_uuid}/data", bam_path.read_bytes())
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        greeting = b"hello from the tool directory\n"
        info = tarfile.TarInfo("tools/e2e/greeting.txt")
        info.size = len(greeting)
        tar.addfile(info, io.BytesIO(greeting))
    s3.put("tools/e2e/repo.tar", archive.getvalue())
    tool["archive"] = {"request": s3.request("tools/e2e/repo.tar"), "directory": "tools/e2e"}
    tool["inputs"] = [{"name": "bam_in", "type": "data", "formats": ["bam"]}]
    outputs = []
    for name in ("table", "seqs", "aligned", "report", "split"):
        targets = dataset_targets(s3, new_uuid(), extra_objects=2 if name == "report" else 0)
        outputs.append({"name": name, "id": len(outputs) + 10, "hid": len(outputs) + 2, **targets})
    slots = [dataset_targets(s3, new_uuid()) for _ in range(6)]
    return {
        "protocol": 1,
        "kind": "tool",
        "job": {"id": job_id, "attempt": 1, "walltime_seconds": 60, "slots": 1, "shell": "/bin/sh"},
        "tool": tool,
        "params": {"bam_in": {"src": "hda", "key": "bam1"}},
        "inputs": {
            "bam1": {
                "uuid": bam_uuid,
                "id": 1,
                "hid": 1,
                "name": "reads.bam",
                "ext": "bam",
                "dbkey": "hg38",
                "data": s3.request(f"datasets/{bam_uuid}/data"),
                "size": bam_path.stat().st_size,
                "metadata": {},
            }
        },
        "outputs": outputs,
        "output_collections": {"coll": {"name": "coll", "collection_type": "list", "elements": []}},
        "slots": slots,
        "job_files": job_files(s3, job_id),
        "user": {"email": "user@example.org", "username": "user"},
    }


def output_uuid(manifest, name):
    return next(o["uuid"] for o in manifest["outputs"] if o["name"] == name)


def test_tool_job_end_to_end(s3, layout, transfers, tmp_path, monkeypatch):
    manifest = tool_job(s3, tmp_path)
    validate(manifest, "manifest")
    write_manifest(tmp_path, manifest, monkeypatch)

    assert stage_in.run(layout, transfers) == 0
    prepare = s3.json("jobs/e2e1/prepare.json")
    validate(prepare, "prepare")
    assert prepare["state"] == "ok"
    assert prepare["outputs"]["table"] == {"filtered": False, "format": "tabular", "label": "E2E on dataset 1"}
    assert "cp '/" in prepare["command_line"]

    assert run_tool_container(layout, "e2e1") == 0
    assert stage_out.run(layout, transfers) == 0

    results = s3.json("jobs/e2e1/results.json")
    validate(results, "results")
    assert results["state"] == "ok", results["job_messages"]
    assert results["exit_code"] == 0
    assert results["termination"] == "normal"
    assert results["tool_stdout"]["text"] == "hello from the tool directory\n"
    assert results["tool_stderr"]["text"] == "warning text\n"
    assert s3.get("jobs/e2e1/stdout") == b"hello from the tool directory\n"

    outputs = results["outputs"]
    table = outputs["table"]
    assert table["state"] == "ok"
    assert table["metadata"]["columns"] == 3
    assert table["metadata"]["column_types"] == ["str", "int", "int"]
    assert table["metadata"]["comment_lines"] == 1
    assert table["peek"].startswith("#chrom")
    assert "<table" in table["display_peek"]
    assert table["blurb"] == "2 lines 3 columns, 1 comments"
    assert table["info"] == "\nhello from the tool directory\nwarning text"
    assert s3.get(f"datasets/{table['uuid']}/data").startswith(b"#chrom\tstart")
    assert s3.json(f"datasets/{table['uuid']}/meta.json") == table

    seqs = outputs["seqs"]
    assert seqs["metadata"]["sequences"] == 2
    assert seqs["blurb"] == "2 sequences"

    aligned = outputs["aligned"]
    assert aligned["ext"] == "bam"
    assert aligned["metadata"]["reference_names"] == ["chr1"]
    assert aligned["metadata"]["sort_order"] == "coordinate"
    assert aligned["metadata_files"]["bam_index"]["index"] == 0
    assert s3.get(f"datasets/{aligned['uuid']}/meta/0")[:4] == b"BAI\x01"

    report = outputs["report"]
    assert report["sanitized"] is True
    sanitized = s3.get(f"datasets/{report['uuid']}/sanitized.html").decode()
    assert "<script>" not in sanitized and "<p>ok</p>" in sanitized
    assert report["extra_files"]["entries"][-1]["path"] == "img/a.png"
    extra_tar = s3.get(f"datasets/{report['uuid']}/extra.tar")
    entry = report["extra_files"]["entries"][-1]
    assert extra_tar[entry["offset"] : entry["offset"] + entry["size"]] == b"png"
    assert entry["key"] == f"datasets/{report['uuid']}/extra/0"
    assert s3.get(entry["key"]) == b"png"
    assert report["warnings"] == []
    assert s3.json(f"datasets/{report['uuid']}/extra.json") == report["extra_files"]

    assert outputs["split"]["state"] == "empty"
    discovered = {d["designation"]: d for d in results["discovered"] if d["output"] == "split"}
    assert sorted(discovered) == ["part1", "part2"]
    part2 = discovered["part2"]
    # Galaxy names a discovered dataset after the output dataset, whose name is its label.
    assert part2["name"] == "E2E on dataset 1 (part2)"
    assert part2["ext"] == "txt" and part2["visible"] is True
    assert part2["uuid"] == manifest["slots"][part2["slot"]]["uuid"]
    assert s3.get(f"datasets/{part2['uuid']}/data") == b"y\ny\n"
    assert part2["metadata"]["data_lines"] == 2

    coll = results["output_collections"]["coll"]
    assert coll["populated_state"] == "ok"
    identifiers = [e["element_identifier"] for e in coll["elements"]]
    assert identifiers == ["sampleA", "sampleB"]
    sample_b = results["discovered"][coll["elements"][1]["slot"]]
    assert sample_b["ext"] == "tabular" and sample_b["collection"] == "coll"
    assert sample_b["element_identifiers"] == ["sampleB"]
    assert s3.get(f"datasets/{sample_b['uuid']}/data") == b"c2\t2\n"

    termination = json.loads((tmp_path / "termination-log").read_text())
    assert termination == {
        "stage": "out",
        "state": "ok",
        "exit_code": 0,
        "termination": "normal",
        "results": "uploaded",
    }


FAILING_XML = r"""<tool id="planet_fail" name="Fail" version="1.0.0" profile="21.01">
  <command><![CDATA[printf 'partial\n' > '$out' && echo "Error: bad input" >&2 && exit 2]]></command>
  <inputs/>
  <outputs><data name="out" format="txt"/></outputs>
</tool>
"""


def simple_job(s3, tmp_path, xml, job_id):
    tool = parse_tool(xml, tmp_path)
    tool["inputs"] = []
    return {
        "protocol": 1,
        "kind": "tool",
        "job": {"id": job_id, "attempt": 1, "walltime_seconds": 60, "shell": "/bin/sh"},
        "tool": tool,
        "params": {},
        "inputs": {},
        "outputs": [{"name": "out", **dataset_targets(s3, new_uuid())}],
        "slots": [],
        "job_files": job_files(s3, job_id),
    }


def test_failing_tool_reports_galaxy_error(s3, layout, transfers, tmp_path, monkeypatch):
    write_manifest(tmp_path, simple_job(s3, tmp_path, FAILING_XML, "fail1"), monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    assert run_tool_container(layout, "fail1") == 2
    assert stage_out.run(layout, transfers) == 0
    results = s3.json("jobs/fail1/results.json")
    validate(results, "results")
    assert results["state"] == "error"
    assert results["exit_code"] == 2
    assert results["job_messages"] == [
        {"type": "exit_code", "desc": "Fatal error: Exit code 2 ()", "exit_code": 2, "code_desc": "", "error_level": 3}
    ]
    out = results["outputs"]["out"]
    assert out["state"] == "error"
    assert out["blurb"] == "error"
    assert s3.get(f"datasets/{out['uuid']}/data") == b"partial\n"


def test_walltime_without_exit_code(s3, layout, transfers, tmp_path, monkeypatch):
    write_manifest(tmp_path, simple_job(s3, tmp_path, FAILING_XML, "slow1"), monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    layout.started.touch()
    layout.walltime_marker.touch()
    (layout.outputs / "tool_stdout").write_text("partial log\n")
    assert stage_out.run(layout, transfers) == 0
    results = s3.json("jobs/slow1/results.json")
    validate(results, "results")
    assert results["termination"] == "walltime"
    assert results["exit_code"] is None
    assert results["state"] == "error"
    assert results["job_stderr"]["text"] == "Job was active longer than specified deadline"
    assert results["tool_stdout"]["text"] == "partial log\n"


def test_tool_that_never_starts_gets_not_started_results(s3, layout, transfers, tmp_path, monkeypatch):
    manifest = simple_job(s3, tmp_path, FAILING_XML, "nostart1")
    assert "limits" not in manifest
    write_manifest(tmp_path, manifest, monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    monkeypatch.setattr(stage_out, "DEFAULT_START_TIMEOUT_SECONDS", 0.5)
    assert stage_out.run(layout, transfers) == 0
    results = s3.json("jobs/nostart1/results.json")
    validate(results, "results")
    assert results["termination"] == "not_started"
    assert results["state"] == "error"
    assert results["job_messages"][0]["desc"] == "The tool container did not start."
    assert results["outputs"]["out"]["state"] == "error"


def test_template_error_fails_stage_in(s3, layout, transfers, tmp_path, monkeypatch):
    manifest = simple_job(s3, tmp_path, FAILING_XML, "bad1")
    manifest["tool"]["command"] = "echo $undefined_name"
    write_manifest(tmp_path, manifest, monkeypatch)
    assert stage_in.run(layout, transfers) == 1
    prepare = s3.json("jobs/bad1/prepare.json")
    validate(prepare, "prepare")
    assert prepare["state"] == "error"
    assert prepare["errors"][0]["phase"] == "command line"
    termination = json.loads((tmp_path / "termination-log").read_text())
    assert termination["stage"] == "in" and termination["state"] == "error"


def test_output_symlink_outside_the_volume_is_not_read(s3, layout, transfers, tmp_path, monkeypatch):
    manifest = simple_job(s3, tmp_path, FAILING_XML, "link1")
    manifest["tool"]["command"] = "ln -sf /etc/passwd '$out'"
    write_manifest(tmp_path, manifest, monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    assert run_tool_container(layout, "link1") == 0
    assert stage_out.run(layout, transfers) == 0
    results = s3.json("jobs/link1/results.json")
    validate(results, "results")
    out = results["outputs"]["out"]
    assert out["state"] == "error"
    assert out["info"] == "Output links to a file outside the job directory"
    assert "root" not in json.dumps(out)
    assert s3.get(f"datasets/{out['uuid']}/data") == b""


def test_templates_cannot_see_presigned_requests(s3, layout, transfers, tmp_path, monkeypatch):
    manifest = simple_job(s3, tmp_path, FAILING_XML, "secret1")
    manifest["tool"]["command"] = (
        "#import os, gc\n"
        "#set $leaks = [o for o in gc.get_objects() if isinstance(o, str) and 'X-Amz-Signature' in o]\n"
        "echo ${os.environ.get('PLANET_MANIFEST_FILE', 'none')} ${len($leaks)} > '$out'"
    )
    write_manifest(tmp_path, manifest, monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    prepare = s3.json("jobs/secret1/prepare.json")
    assert prepare["command_line"].startswith("echo none 0 > ")
