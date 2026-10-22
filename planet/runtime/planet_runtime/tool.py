"""The manifest's ``tool``: a tool bundle (``planet/toolbox/tool-bundle.schema.json``) or its flat form.

:func:`normalize` returns the flat form the stager uses, keeping Galaxy's
semantics: config files in ``Tool._parse_config_files`` order (inputs, templates,
file sources).
"""

from collections.abc import Mapping
from typing import Any


def normalize(tool: Mapping[str, Any]) -> dict[str, Any]:
    flat = dict(tool)
    command = tool.get("command")
    if isinstance(command, Mapping):
        flat["command"] = command.get("text")
        flat["interpreter"] = command.get("interpreter")
        flat["strict_shell"] = bool(command.get("strict", False))

    version_command = tool.get("version_command")
    if isinstance(version_command, Mapping):
        flat["version_command"] = (version_command.get("command") or "").strip() or None
        flat["version_command_interpreter"] = version_command.get("interpreter")

    configfiles = tool.get("configfiles")
    if isinstance(configfiles, Mapping):
        flat["configfiles"] = [
            *(_input_configfile(c) for c in configfiles.get("inputs") or []),
            *(_template_configfile(c) for c in configfiles.get("configfiles") or []),
            *(
                {"type": "files", "name": c.get("name"), "filename": c.get("filename")}
                for c in configfiles.get("file_sources") or []
            ),
        ]

    outputs = tool.get("outputs")
    if isinstance(outputs, list):
        flat["outputs"] = {output["name"]: output for output in outputs}

    provided = tool.get("provided_metadata")
    if isinstance(provided, Mapping):
        flat.setdefault("provided_metadata_file", provided.get("file"))
        flat.setdefault("provided_metadata_style", provided.get("style"))
    return flat


def _input_configfile(config: Mapping[str, Any]) -> dict[str, Any]:
    content = config.get("content") or {}
    return {
        "type": "inputs",
        "name": config.get("name"),
        "filename": config.get("filename"),
        "handle_files": content.get("handle_files") if isinstance(content, Mapping) else None,
    }


def _template_configfile(config: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "type": "configfile",
        "name": config.get("name"),
        "filename": config.get("filename"),
        "content": config.get("content") or "",
        "eval_engine": config.get("eval_engine") or "cheetah",
    }
