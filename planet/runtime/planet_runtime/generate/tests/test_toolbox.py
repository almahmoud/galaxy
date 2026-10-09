import io
import tarfile

import pytest
from galaxy.tool_util.toolbox.panel import (
    ToolPanelElements,
    ToolSection,
    ToolSectionLabel,
)

from planet_runtime.generate._common import safe_relative_path
from planet_runtime.generate.github import RepositoryFile
from planet_runtime.generate.toolbox import (
    _repo_tar,
    _shed_repository,
    _stage,
    panel_entry,
    PanelTool,
    to_panel_view,
    ToolboxError,
)


def _bundle(tool_id: str, hidden="") -> dict:
    return {
        "model_class": "Tool",
        "id": tool_id,
        "name": tool_id.upper(),
        "version": "1.0",
        "versions": ["1.0"],
        "description": "",
        "icon": None,
        "edam_operations": [],
        "edam_topics": [],
        "hidden": hidden,
        "is_workflow_compatible": True,
        "xrefs": [],
        "has_parameters": True,
        "form_style": "regular",
        "tool_shed_repository": None,
    }


def _panel_tool(tool_id: str, hidden="") -> PanelTool:
    bundle = _bundle(tool_id, hidden)
    entry = panel_entry(bundle, "sec", "Section", [])
    return PanelTool(tool_id, bundle["name"], "1.0", hidden, [], [], "default", False, entry)


def test_repo_tar_is_deterministic():
    files = {"b.xml": RepositoryFile(b"b", False), "sub/run.sh": RepositoryFile(b"#!", True)}
    first = _repo_tar(files)
    assert first == _repo_tar(dict(reversed(list(files.items()))))
    with tarfile.open(fileobj=io.BytesIO(first)) as tar:
        members = {m.name: m for m in tar.getmembers()}
    assert list(members) == ["sub", "b.xml", "sub/run.sh"]
    assert members["sub/run.sh"].mode == 0o755
    assert members["b.xml"].mode == 0o644


def test_panel_entry_shape():
    bundle = _bundle("toolshed.g2.bx.psu.edu/repos/iuc/x/x/1.0+galaxy0")
    bundle["tool_shed_repository"] = {
        "name": "x",
        "owner": "iuc",
        "changeset_revision": None,
        "tool_shed": "toolshed.g2.bx.psu.edu",
    }
    entry = panel_entry(bundle, "sec", "Section", [])
    assert entry["link"] == "/tool_runner?tool_id=toolshed.g2.bx.psu.edu%2Frepos%2Fiuc%2Fx%2Fx%2F1.0%2Bgalaxy0"
    assert entry["panel_section_id"] == "sec"
    assert entry["tool_shed_repository"]["owner"] == "iuc"
    assert "uuid" not in entry and "config_file" not in entry


def test_panel_view_drops_hidden_tools_and_empty_labels():
    section = ToolSection({"id": "sec", "name": "Section", "version": ""})
    section.elems["label_empty"] = ToolSectionLabel({"type": "label", "id": "empty", "text": "Empty"})
    section.elems.append_tool(_panel_tool("hidden_tool", hidden=True))
    section.elems["label_full"] = ToolSectionLabel({"type": "label", "id": "full", "text": "Full"})
    section.elems.append_tool(_panel_tool("visible"))
    panel = ToolPanelElements()
    panel["sec"] = section
    empty = ToolSection({"id": "empty_section", "name": "Nothing", "version": ""})
    empty.elems.append_tool(_panel_tool("other_hidden", hidden=True))
    panel["empty_section"] = empty

    view = to_panel_view("default", panel)
    assert list(view) == ["sec"]
    assert view["sec"]["tools"] == [
        {
            "model_class": "ToolSectionLabel",
            "id": "full",
            "text": "Full",
            "version": "",
            "description": None,
            "links": None,
        },
        "visible",
    ]


def test_shed_repository_from_shed_yml(tmp_path):
    (tmp_path / ".shed.yml").write_text('owner: iuc\nauto_tool_repositories:\n  name_template: "{{ tool_id }}"\n')
    assert _shed_repository(tmp_path, "datamash_ops", {}) == ("iuc", "datamash_ops")
    (tmp_path / ".shed.yml").write_text("owner: devteam\nname: samtools_sort\n")
    assert _shed_repository(tmp_path, "samtools_sort", {}) == ("devteam", "samtools_sort")
    assert _shed_repository(tmp_path, "x", {"owner": "me", "name": "mine"}) == ("me", "mine")
    (tmp_path / ".shed.yml").write_text("categories: []\n")
    with pytest.raises(ToolboxError):
        _shed_repository(tmp_path, "x", {})


@pytest.mark.parametrize("bad", ["../x", "a/../b", "a//b", "a b", "a%2Fb", ""])
def test_safe_relative_path_rejects(bad):
    with pytest.raises(ValueError):
        safe_relative_path(bad)


def test_safe_relative_path_splits_guids():
    path = safe_relative_path("toolshed.g2.bx.psu.edu/repos/iuc/x/x/1.0+galaxy0", "1.0+galaxy0")
    assert path.parts[0] == "toolshed.g2.bx.psu.edu" and path.parts[-1] == "1.0+galaxy0"


@pytest.mark.parametrize("relative", ["../escape.txt", "/abs.txt", "a/../../b"])
def test_stage_refuses_paths_outside_work_dir(tmp_path, relative):
    with pytest.raises(ToolboxError):
        _stage(tmp_path, relative, b"x")


def test_stage_accepts_unusual_file_names(tmp_path):
    assert _stage(tmp_path, "tools/t/My File (1).txt", b"x").read_bytes() == b"x"
