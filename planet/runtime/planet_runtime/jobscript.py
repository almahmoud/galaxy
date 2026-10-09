"""The tool container's scripts: Galaxy's job script, ``tool_script.sh`` and the ``run-tool`` wrapper.

The job script is rendered from Galaxy's ``DEFAULT_JOB_FILE_TEMPLATE.sh`` and
the command is composed like ``galaxy.jobs.command_factory.build_command`` does
for the Kubernetes runner: the tool command is externalized into
``tool_script.sh``, stdout and stderr are streamed through ``tee`` into
``outputs/tool_stdout`` and ``outputs/tool_stderr``, the exit code is written to
``galaxy_<id>.ec`` and ``from_work_dir`` outputs are copied afterwards.
"""

import os
import re
import shlex
from collections.abc import (
    Iterable,
    Mapping,
)
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from string import Template
from typing import Any

from planet_runtime import galaxy_env
from planet_runtime.layout import Layout

DEFAULT_SHELL = "/bin/bash"
WALLTIME_GRACE_SECONDS = 30

INTEGRITY_INJECTION = """
# The following block can be used by the job system
# to ensure this script is runnable before actually attempting
# to run it.
if [ -n "$ABC_TEST_JOB_SCRIPT_INTEGRITY_XYZ" ]; then
    exit 42
fi
"""

PREPARE_DIRS_TEMPLATE = """for dir in working outputs configs; do
    mkdir -p "{working_directory}/$dir"
    if [ -d "{working_directory}/_$dir" ]; then
        rm -rf "{working_directory}/$dir"; cp -R "{working_directory}/_$dir" "{working_directory}/$dir"
    else
        cp -R "{working_directory}/$dir" "{working_directory}/_$dir"
    fi
done
"""

TRAP_KILL_CONTAINER = "trap _on_exit EXIT"


def _template(name: str) -> str:
    return (galaxy_env.job_script_templates() / name).read_text()


def env_to_statement(env: Mapping[str, Any]) -> str:
    """``galaxy.jobs.runners.util.env.env_to_statement``."""

    def escape(value: str) -> str:
        if not env.get("raw", False):
            value = '"' + value.replace('"', '\\"') + '"'
        return value

    if source_file := env.get("file"):
        return f". {escape(source_file)}"
    if execute := env.get("execute"):
        return execute
    return f"{env['name']}={escape(env['value'])}; export {env['name']}"


class CommandsBuilder:
    """``galaxy.jobs.command_factory.CommandsBuilder``."""

    def __init__(self, initial_command: str = ""):
        self.commands = (initial_command or "").rstrip("; ")
        self.return_code_captured = False

    def prepend_command(self, command: str, sep: str = ";") -> "CommandsBuilder":
        if command:
            self.commands = f"{command}{sep} {self.commands}"
        return self

    def append_command(self, command: str, sep: str = ";") -> "CommandsBuilder":
        if command:
            self.commands = f"{self.commands}{sep} {command}"
        return self

    def append_commands(self, commands: Iterable[str]) -> None:
        self.append_command("; ".join(c for c in commands if c))

    def capture_stdout_stderr(self, stdout_file: str, stderr_file: str) -> None:
        trap_command = """trap 'rm -f "$__out" "$__err"' EXIT"""
        if TRAP_KILL_CONTAINER in self.commands:
            self.commands = self.commands.replace(TRAP_KILL_CONTAINER, "")
            trap_command = """trap 'rm -f "$__out" "$__err"; _on_exit' EXIT"""
        self.prepend_command(
            f"""__out="${{TMPDIR:-.}}/out.$$" __err="${{TMPDIR:-.}}/err.$$"
mkfifo "$__out" "$__err"
{trap_command}
tee -a '{stdout_file}' < "$__out" &
tee -a '{stderr_file}' < "$__err" >&2 &""",
            sep="",
        )
        self.append_command('> "$__out" 2> "$__err"', sep="")

    def capture_return_code(self, exit_code_path: str) -> None:
        self.append_command("return_code=$?")
        self.append_command(f"echo $return_code > {exit_code_path}")
        self.return_code_captured = True

    def build(self) -> str:
        if self.return_code_captured:
            self.append_command('sh -c "exit $return_code"')
        return self.commands


def _quote_preserving_globs(path: str) -> str:
    return "".join(part if part in ("*", "?") else shlex.quote(part) for part in re.split(r"([*?])", path) if part)


def copy_if_exists_command(source_file: str, destination: str) -> str:
    """``command_factory.__copy_if_exists_command``."""
    is_directory = destination.endswith("_files")
    test_flag = "-d" if is_directory else "-f"
    recursive_flag = " -r" if is_directory else ""
    source_file = _quote_preserving_globs(source_file)
    destination = shlex.quote(destination)
    delete_destination_dir = f" rmdir {destination}; " if is_directory else ""
    return (
        f"\nif [ {test_flag} {source_file} -a {test_flag} {destination} ] ; then{delete_destination_dir}"
        f" cp{recursive_flag} {source_file} {destination} ; fi"
    )


@dataclass
class WorkDirOutput:
    from_work_dir: str
    destination: str


def work_dir_outputs(layout: Layout, outputs: Iterable[tuple[Mapping[str, Any], str]]) -> list[WorkDirOutput]:
    """``BaseJobRunner.get_work_dir_outputs`` for ``(tool output definition, dataset uuid)`` pairs."""
    pairs: list[WorkDirOutput] = []
    working = os.path.abspath(layout.working)
    for definition, uuid in outputs:
        from_work_dir = definition.get("from_work_dir")
        if not from_work_dir:
            continue
        source_file = os.path.join(working, from_work_dir)
        if not os.path.normpath(source_file).startswith(f"{working}{os.sep}"):
            continue
        if definition.get("precreate_directory"):
            destination = str(layout.output_extra_files(uuid))
        else:
            destination = str(layout.output_path(uuid))
        pairs.append(WorkDirOutput(source_file, destination))
    return pairs


def tool_script(command_line: str, shell: str, strict_shell: bool) -> str:
    set_e = "set -e\n" if strict_shell else ""
    return f"#!{shell}\n{INTEGRITY_INJECTION}{set_e}{command_line}"


def build_command(
    layout: Layout,
    command_line: str,
    shell: str,
    id_tag: str,
    copies: Iterable[WorkDirOutput],
) -> str:
    """The job script's ``$command``: tool script with captured streams, exit code and work dir copies."""
    builder = CommandsBuilder(f"{shell} {layout.tool_script}")
    builder.capture_stdout_stderr("../outputs/tool_stdout", "../outputs/tool_stderr")
    builder.prepend_command("cd working")
    builder.capture_return_code(str(layout.exit_code_file(id_tag)))
    builder.append_commands(copy_if_exists_command(copy.from_work_dir, copy.destination) for copy in copies)
    return builder.build()


def tmp_dir_creation_statement(layout: Layout) -> str:
    working_directory = layout.job
    return (
        f"""$([ ! -e '{working_directory}/tmp' ] || mv '{working_directory}/tmp' '{working_directory}'/tmp.$(date +%Y%m%d-%H%M%S) ; """
        f"""mkdir '{working_directory}/tmp'; echo '{working_directory}/tmp')"""
    )


def job_script(
    layout: Layout,
    command: str,
    shell: str,
    environment_variables: Iterable[Mapping[str, Any]],
    preserve_python_environment: bool = False,
) -> str:
    """``galaxy.jobs.runners.util.job_script.job_script`` with the Kubernetes runner's options."""
    working_directory = str(layout.job)
    params: dict[str, Any] = {
        "galaxy_lib": None,
        "galaxy_virtual_env": None,
        "headers": "",
        "env_setup_commands": "\n".join(["", *(env_to_statement(env) for env in environment_variables)]),
        "slots_statement": _template("CLUSTER_SLOTS_STATEMENT.sh"),
        "instrument_pre_commands": "",
        "instrument_post_commands": "",
        "integrity_injection": INTEGRITY_INJECTION,
        "shell": shell,
        "preserve_python_environment": preserve_python_environment,
        "tmp_dir_creation_statement": tmp_dir_creation_statement(layout),
        "prepare_dirs_statement": PREPARE_DIRS_TEMPLATE.format(working_directory=working_directory),
        "memory_statement": Template(_template("MEMORY_STATEMENT_TEMPLATE.sh")).safe_substitute(
            metadata_directory=working_directory
        ),
        "home_directory": str(layout.home),
        "working_directory": working_directory,
        "command": command,
    }
    return Template(_template("DEFAULT_JOB_FILE_TEMPLATE.sh")).safe_substitute(
        {key: "None" if value is None else str(value) for key, value in params.items()}
    )


def run_tool_script(
    layout: Layout, id_tag: str, shell: str, walltime_seconds: int, slots: int, memory_mb: int | None
) -> str:
    text = resources.files("planet_runtime").joinpath("data/run-tool.sh").read_text()
    return Template(text).substitute(
        ctl=shlex.quote(str(layout.ctl)),
        shell=shlex.quote(shell),
        job_script=shlex.quote(str(layout.job_script(id_tag))),
        walltime=int(walltime_seconds),
        grace=WALLTIME_GRACE_SECONDS,
        slots=int(slots),
        memory_mb=int(memory_mb) if memory_mb else "",
    )


def write_executable(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)
    path.chmod(0o755)
