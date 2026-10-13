"""What tool-author code in stage-in and the tool container can and cannot reach."""

import json
import os
import subprocess
import sys
import time

import pytest
from conftest import (
    dataset_targets,
    job_files,
    new_uuid,
    run_tool_container,
    schema,
    write_manifest,
)

from planet_runtime import (
    isolation,
    manifest as manifest_module,
    stage_in,
    stage_out,
)
from planet_runtime.layout import Layout

linux_only = pytest.mark.skipif(not isolation.LINUX, reason="prctl and /proc are Linux only")

NAMES_XML = r"""<tool id="names_tool" name="Names" version="1.0" profile="22.05">
  <command><![CDATA[echo '$url' '$slots' '$job_files' '$fetch.mode' '$fetch.url' > '$out']]></command>
  <inputs>
    <param name="url" type="text" value=""/>
    <param name="slots" type="integer" value="1"/>
    <param name="job_files" type="text" value="default"/>
    <conditional name="fetch">
      <param name="mode" type="select">
        <option value="remote">Remote</option>
        <option value="none">None</option>
      </param>
      <when value="remote"><param name="url" type="text" value=""/></when>
      <when value="none"/>
    </conditional>
  </inputs>
  <outputs>
    <data name="out" format="txt"/>
  </outputs>
</tool>
"""

USER_URL = "https://example.org/a.txt?X-Amz-Signature=user"


def names_tool(tmp_path) -> dict:
    from galaxy.tool_util.parser import get_tool_source

    from planet_runtime.generate.bundle import build_bundle

    path = tmp_path / "names_tool.xml"
    path.write_text(NAMES_XML)
    return build_bundle(get_tool_source(str(path)))


def names_job(s3, tmp_path, job_id: str, command: str | None = None) -> dict:
    tool = names_tool(tmp_path)
    if command is not None:
        tool["command"] = command
    return {
        "protocol": 1,
        "kind": "tool",
        "job": {"id": job_id, "attempt": 1, "walltime_seconds": 60, "shell": "/bin/sh"},
        "tool": tool,
        "params": {
            "url": USER_URL,
            "slots": 4,
            "job_files": "jf",
            "fetch": {"mode": "remote", "url": "https://example.org/b.txt", "__current_case__": 0},
        },
        "inputs": {},
        "outputs": [{"name": "out", **dataset_targets(s3, new_uuid())}],
        "slots": [dataset_targets(s3, new_uuid())],
        "job_files": job_files(s3, job_id),
    }


def schema_request_paths() -> set[tuple[str, ...]]:
    """Places of ``#/$defs/request`` in the manifest schema, with "*" for any key or index."""
    manifest_schema = schema("manifest")
    definitions = manifest_schema["$defs"]
    found: set[tuple[str, ...]] = set()

    def walk(node, path, seen):
        if not isinstance(node, dict):
            return
        reference = node.get("$ref")
        if reference == "#/$defs/request":
            found.add(path)
            return
        if reference:
            name = reference.rsplit("/", 1)[-1]
            if name not in seen:
                walk(definitions[name], path, seen | {name})
        for key, child in (node.get("properties") or {}).items():
            walk(child, (*path, key), seen)
        for key in ("additionalProperties", "items"):
            walk(node.get(key), (*path, "*"), seen)
        for key in ("allOf", "anyOf", "oneOf"):
            for child in node.get(key) or []:
                walk(child, path, seen)

    walk(manifest_schema, (), frozenset())
    return found


def matches(pattern: tuple[str, ...], path: tuple[str, ...]) -> bool:
    return len(pattern) == len(path) and all(p in ("*", q) for p, q in zip(pattern, path))


def test_redaction_knows_every_request_of_the_schema():
    in_schema = schema_request_paths()
    assert in_schema
    assert [path for path in in_schema if not any(matches(p, path) for p in manifest_module.REQUEST_PATHS)] == []
    assert [p for p in manifest_module.REQUEST_PATHS if not any(matches(p, path) for path in in_schema)] == []


def test_redaction_removes_requests_by_place_and_keeps_parameters(s3, tmp_path):
    manifest = names_job(s3, tmp_path, "red1")
    manifest["params"]["request"] = {"url": "https://example.org/c", "headers": {"x": "y"}}
    manifest["params"]["rep"] = [{"url": "https://example.org/d", "meta": "m", "extra": "e"}]
    manifest["tool"]["source"] = {"url": "https://github.com/example/tools"}
    manifest["tool"]["archive"] = {"request": s3.request("tools/x.tar"), "directory": "x"}
    output_uuid = manifest["outputs"][0]["uuid"]
    manifest["outputs"][0].update(dataset_targets(s3, output_uuid, multipart_parts=2, extra_objects=1))
    input_uuid = new_uuid()
    manifest["inputs"] = {
        "a": {
            "uuid": input_uuid,
            "name": "url",
            "data": s3.url(f"datasets/{input_uuid}/data"),
            "extra": s3.request(f"datasets/{input_uuid}/extra.tar"),
            "metadata": {"url": "kept"},
            "metadata_files": {"bam_index": s3.request(f"datasets/{input_uuid}/meta/0")},
        }
    }
    manifest["upload"] = {"request": {"targets": []}, "files": {"f": {"request": s3.request("uploads/f"), "size": 1}}}

    redacted = manifest_module.without_requests(manifest)

    assert "X-Amz-Signature=test" not in json.dumps(redacted)
    assert "X-Amz-Signature=test" in json.dumps(manifest)
    assert redacted["params"] == manifest["params"]
    assert redacted["tool"]["inputs"] == manifest["tool"]["inputs"]
    assert redacted["tool"]["source"] == manifest["tool"]["source"]
    assert redacted["tool"]["archive"] == {"request": None, "directory": "x"}
    assert "slots" not in redacted and "job_files" not in redacted
    record = redacted["inputs"]["a"]
    assert record["data"] is None and record["extra"] is None
    assert record["metadata_files"] == {"bam_index": None}
    assert record["metadata"] == {"url": "kept"} and record["name"] == "url"
    output = redacted["outputs"][0]
    assert output["uuid"] == output_uuid and output["name"] == "out"
    assert output["data"] == {"put": None, "multipart": {"parts": [None, None]}}
    assert output["extra_objects"] == [{"key": f"datasets/{output_uuid}/extra/0", "request": None}]
    assert redacted["upload"]["files"] == {"f": {"request": None, "size": 1}}


def test_parameters_named_like_protocol_fields_reach_templates(s3, layout, transfers, tmp_path, monkeypatch):
    write_manifest(tmp_path, names_job(s3, tmp_path, "names1"), monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    prepare = s3.json("jobs/names1/prepare.json")
    assert prepare["state"] == "ok", prepare["errors"]
    assert prepare["command_line"].startswith(f"echo '{USER_URL}' '4' 'jf' 'remote' 'https://example.org/b.txt' > ")


def test_manifest_url_is_removed_from_the_environment(monkeypatch):
    manifest = {"protocol": 1, "kind": "tool", "job": {"id": "env0"}, "tool": {"id": "t"}}
    url = "https://bucket.example/jobs/env0/manifest.json?X-Amz-Signature=x"

    class Transfers:
        def get_bytes(self, request, limit):
            assert request.url == url
            return json.dumps(manifest).encode()

    monkeypatch.setenv(manifest_module.MANIFEST_URL_ENV, url)
    assert manifest_module.load(Transfers()) == manifest
    assert manifest_module.MANIFEST_URL_ENV not in os.environ


READ_PARENT_ENVIRON = """
import os
try:
    data = open("/proc/%d/environ" % os.getppid(), "rb").read()
    print("secret" if b"PLANET_TEST_SECRET=s3cr3t" in data else "readable")
except OSError as e:
    print(type(e).__name__)
"""

PARENT = """
import subprocess, sys
from planet_runtime import isolation
if sys.argv[1] == "undumpable":
    isolation.make_undumpable()
reader = subprocess.run([sys.executable, "-c", sys.argv[2]], env={}, capture_output=True, text=True)
print(reader.stdout.strip() or reader.stderr)
"""


def can_trace_any_process() -> bool:
    with open("/proc/self/status") as fh:
        effective = next(line for line in fh if line.startswith("CapEff:"))
    return bool(int(effective.split()[1], 16) & (1 << 19))


@linux_only
@pytest.mark.parametrize("mode, expected", [("dumpable", "secret"), ("undumpable", "PermissionError")])
def test_children_cannot_read_an_undumpable_parent_environment(mode, expected):
    if expected == "PermissionError" and can_trace_any_process():
        pytest.skip("CAP_SYS_PTRACE bypasses the dumpable flag")
    environment = {**os.environ, "PLANET_TEST_SECRET": "s3cr3t"}
    completed = subprocess.run(
        [sys.executable, "-c", PARENT, mode, READ_PARENT_ENVIRON],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    assert completed.stdout.strip() == expected


ENVIRON_PROBE = """#import os
#try
#silent open('/proc/%d/environ' % os.getppid(), 'rb').read()
#set $outcome = 'readable'
#except Exception as e
#set $outcome = type(e).__name__
#end try
echo $outcome > '$out'"""


@linux_only
def test_templates_cannot_read_the_stager_environment(s3, layout, tmp_path):
    if can_trace_any_process():
        pytest.skip("CAP_SYS_PTRACE bypasses the dumpable flag")
    s3.put("jobs/env1/manifest.json", json.dumps(names_job(s3, tmp_path, "env1", ENVIRON_PROBE)).encode())
    environment = {key: value for key, value in os.environ.items() if key != manifest_module.MANIFEST_FILE_ENV} | {
        manifest_module.MANIFEST_URL_ENV: s3.url("jobs/env1/manifest.json"),
        "PLANET_TERMINATION_LOG": str(tmp_path / "termination-log"),
    }
    completed = subprocess.run(
        [sys.executable, "-m", "planet_runtime", "in"], env=environment, capture_output=True, text=True, timeout=300
    )
    prepare = s3.json("jobs/env1/prepare.json")
    assert completed.returncode == 0, (prepare["errors"], completed.stderr[-2000:])
    assert prepare["command_line"].startswith("echo PermissionError > "), prepare["command_line"]


DAEMON = "import sys, time; open(sys.argv[1], 'w').write('started'); time.sleep(2); open(sys.argv[2], 'w').write('x')"

# Leaves files on the stager volume and a daemon that overwrites the state once stage-in has written it.
TAMPERING_TEMPLATE = f"""#import os, subprocess, sys, time
#set $stager = os.environ['PLANET_STAGER_ROOT']
#set $marker = os.path.join(os.environ['PLANET_ROOT'], 'daemon')
#silent open(os.path.join($stager, 'planted'), 'w').write('x')
#silent os.makedirs(os.path.join($stager, 'home', 'locked'), exist_ok=True)
#silent os.chmod(os.path.join($stager, 'home'), 0)
#if not os.path.exists($marker)
#silent subprocess.Popen([sys.executable, '-c', "{DAEMON}", $marker, os.path.join($stager, 'stage-in.json')], start_new_session=True)
#end if
#silent [time.sleep(0.05) for _ in range(200) if not os.path.exists($marker)]
echo ok > '$out'"""


@linux_only
def test_template_leftovers_cannot_change_the_stager_state(s3, layout, transfers, tmp_path, monkeypatch):
    write_manifest(tmp_path, names_job(s3, tmp_path, "tamper1", TAMPERING_TEMPLATE), monkeypatch)
    assert stage_in.run(layout, transfers) == 0, s3.json("jobs/tamper1/prepare.json")["errors"]
    assert (layout.root / "daemon").read_text() == "started"
    time.sleep(3)
    assert sorted(path.name for path in layout.stager.iterdir()) == ["cache", "home", "stage-in.json"]
    assert list(layout.stager_home.iterdir()) == []
    state = json.loads(layout.state_file.read_text())
    assert state["manifest"]["job"]["id"] == "tamper1"


def test_stage_out_reads_the_stager_state_and_not_the_shared_volume(s3, layout, transfers, tmp_path, monkeypatch):
    forged = json.dumps({"command_line": "forged", "outputs": {"out": {"filtered": True}}})
    old_place = layout.root / "stager"
    command = f"echo ok > '$out' && mkdir -p '{old_place}' && echo '{forged}' > '{old_place}/stage-in.json'"
    path = write_manifest(tmp_path, names_job(s3, tmp_path, "state1", command), monkeypatch)
    assert stage_in.run(layout, transfers) == 0
    assert layout.root not in layout.state_file.parents
    path.unlink()
    monkeypatch.delenv(manifest_module.MANIFEST_FILE_ENV)

    assert run_tool_container(layout, "state1") == 0
    assert json.loads((old_place / "stage-in.json").read_text())["command_line"] == "forged"
    assert stage_out.run(layout, transfers) == 0
    assert not layout.state_file.exists()
    results = s3.json("jobs/state1/results.json")
    assert results["state"] == "ok"
    assert results["command_line"].startswith("echo ok > ")
    assert results["filtered_outputs"] == []
    assert s3.get(f"datasets/{results['outputs']['out']['uuid']}/data") == b"ok\n"


def test_stage_out_fails_without_the_stager_state(s3, layout, transfers, tmp_path, monkeypatch):
    write_manifest(tmp_path, names_job(s3, tmp_path, "nostate1"), monkeypatch)
    assert stage_out.run(layout, transfers) == 1
    assert not s3.has("jobs/nostate1/results.json")
    termination = json.loads((tmp_path / "termination-log").read_text())
    assert termination["stage"] == "out" and termination["state"] == "error"


def test_stage_in_refuses_a_stager_volume_inside_the_shared_one(s3, tmp_path, transfers, monkeypatch):
    root = tmp_path / "planet"
    monkeypatch.setenv("PLANET_TERMINATION_LOG", str(tmp_path / "termination-log"))
    write_manifest(tmp_path, names_job(s3, tmp_path, "overlap1"), monkeypatch)
    assert stage_in.run(Layout(root, root / "stager"), transfers) == 1
    prepare = s3.json("jobs/overlap1/prepare.json")
    assert "must be separate" in prepare["errors"][0]["message"]


@linux_only
def test_contained_children_kills_orphaned_daemons(tmp_path):
    pid_file = tmp_path / "pid"
    daemon = (
        "import os, sys, time\n"
        "if os.fork(): sys.exit(0)\n"
        "os.setsid()\n"
        "if os.fork(): sys.exit(0)\n"
        "open(sys.argv[1], 'w').write(str(os.getpid()))\n"
        "time.sleep(300)\n"
    )
    with isolation.contained_children():
        subprocess.run([sys.executable, "-c", daemon, str(pid_file)], check=True, timeout=30)
        deadline = time.monotonic() + 10
        while (not pid_file.exists() or not pid_file.read_text()) and time.monotonic() < deadline:
            time.sleep(0.05)
        pid = int(pid_file.read_text())
        os.kill(pid, 0)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_clear_directory_removes_links_without_following_them(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep").write_text("x")
    directory = tmp_path / "stager"
    (directory / "a" / "b").mkdir(parents=True)
    (directory / "a" / "b" / "f").write_text("x")
    (directory / "a").chmod(0)
    (directory / "file").write_text("x")
    (directory / "link").symlink_to(outside)
    (directory / "file-link").symlink_to(outside / "keep")
    isolation.clear_directory(directory)
    assert list(directory.iterdir()) == []
    assert (outside / "keep").read_text() == "x"
