import pytest
from conftest import (
    new_uuid,
    run_tool_container,
    write_manifest,
)

from planet_runtime import stage_in
from planet_runtime.jobscript import (
    copy_if_exists_command,
    env_to_statement,
)


def manifest_for(command, outputs, tool_outputs, profile="21.01", shell="/bin/sh"):
    return {
        "protocol": 1,
        "kind": "tool",
        "job": {
            "id": "jobscript1",
            "attempt": 1,
            "walltime_seconds": 60,
            "slots": 3,
            "memory_mb": 2048,
            "shell": shell,
        },
        "tool": {
            "id": "script_tool",
            "version": "1.0.0",
            "name": "Script Tool",
            "profile": profile,
            "command": command,
            "inputs": [],
            "outputs": tool_outputs,
        },
        "params": {},
        "inputs": {},
        "outputs": outputs,
    }


def test_env_to_statement():
    assert env_to_statement({"name": "X", "value": "Y"}) == 'X="Y"; export X'
    assert env_to_statement({"name": "X", "value": "Y", "raw": True}) == "X=Y; export X"
    assert env_to_statement({"name": "X", "value": '"A","B"'}) == 'X="\\"A\\",\\"B\\""; export X'


def test_copy_if_exists_command_keeps_globs():
    assert copy_if_exists_command("/w/out_*.txt", "/o/dataset_1.dat") == (
        "\nif [ -f /w/out_*.txt -a -f /o/dataset_1.dat ] ; then cp /w/out_*.txt /o/dataset_1.dat ; fi"
    )
    assert copy_if_exists_command("/w/my dir", "/o/dataset_1_files") == (
        "\nif [ -d '/w/my dir' -a -d /o/dataset_1_files ] ; then rmdir /o/dataset_1_files;  cp -r '/w/my dir' "
        "/o/dataset_1_files ; fi"
    )


@pytest.mark.parametrize("shell", ["/bin/sh", "/bin/bash"])
def test_job_script_runs_tool_and_captures_streams(layout, transfers, tmp_path, monkeypatch, shell):
    table, globbed, report = new_uuid(), new_uuid(), new_uuid()
    command = (
        "echo hello; echo oops >&2; printf 'a\\tb\\n' > result.tsv; echo g > out_1.txt; "
        "mkdir report && echo '<p>x</p>' > report/index.html; echo \"\\$HOME|\\$GALAXY_SLOTS|\\$GALAXY_MEMORY_MB\" > env.txt; exit 3"
    )
    tool_outputs = {
        "table": {"model_class": "ToolOutput", "name": "table", "format": "tabular", "from_work_dir": "result.tsv"},
        "globbed": {"model_class": "ToolOutput", "name": "globbed", "format": "txt", "from_work_dir": "out_*.txt"},
        "report": {
            "model_class": "ToolOutput",
            "name": "report",
            "format": "html",
            "from_work_dir": "report",
            "precreate_directory": True,
        },
    }
    outputs = [
        {"name": "table", "uuid": table},
        {"name": "globbed", "uuid": globbed},
        {"name": "report", "uuid": report},
    ]
    write_manifest(tmp_path, manifest_for(command, outputs, tool_outputs, shell=shell), monkeypatch)
    assert stage_in.run(layout, transfers) == 0

    script = layout.job_script("jobscript1").read_text()
    assert script.startswith(f"#!{shell}\n")
    assert f"cd {layout.job}" in script
    assert "export GALAXY_SLOTS" in script
    assert "tee -a '../outputs/tool_stdout'" in script
    assert f"echo $return_code > {layout.exit_code_file('jobscript1')}" in script
    assert 'HOME="$_GALAXY_JOB_HOME_DIR"; export HOME' in script
    run_tool = layout.run_tool.read_text()
    assert "PLANET_WALLTIME_SECONDS:-60" in run_tool and ': "${GALAXY_SLOTS:=3}"' in run_tool

    monkeypatch.setenv("GALAXY_SLOTS", "3")
    monkeypatch.setenv("GALAXY_MEMORY_MB", "2048")
    assert run_tool_container(layout, "jobscript1", shell) == 3
    assert layout.exit_code_file("jobscript1").read_text().strip() == "3"
    assert (layout.outputs / "tool_stdout").read_text() == "hello\n"
    assert (layout.outputs / "tool_stderr").read_text() == "oops\n"
    assert layout.output_path(table).read_text() == "a\tb\n"
    assert layout.output_path(globbed).read_text() == "g\n"
    assert (layout.output_extra_files(report) / "index.html").read_text() == "<p>x</p>\n"
    assert (layout.working / "env.txt").read_text() == f"{layout.home}|3|2048\n"
    assert (layout.job / "_working").is_dir()
