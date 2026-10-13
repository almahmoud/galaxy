"""Generate Planet's built-in toolbox: tool bundles, panel views and tool repository archives.

Usage::

    python -m planet_runtime.generate.toolbox --config planet/toolbox/toolbox.yml --out OUT_DIR

Writes, below ``OUT_DIR``:

- ``static/planet/data/toolbox/bundles/<id>/<version>.json``: one Planet tool bundle per tool
- ``static/planet/data/toolbox/panel.json``: ``GET /api/tool_panels/default``
- ``static/planet/data/toolbox/panel_views/<view id>.json``: ``GET /api/tool_panels/{view}``
- ``static/planet/data/toolbox/panels.json``: ``GET /api/tool_panels``
- ``static/planet/data/toolbox/tools.json``: ``GET /api/tools?in_panel=false``
- ``static/planet/data/toolbox/tools_in_panel.json``: ``GET /api/tools``
- ``static/planet/data/toolbox/tool_tags.json``: ``GET /api/tags/tool_tags``
- ``toolrepos/tools/<id>/<version>/repo.tar`` and ``toolrepos/index.json``: the tool directory
  that ``$__tool_directory__`` points to, without test data

Panels are rendered with Galaxy's own panel, view and filter classes; tools are
represented by their ``ToolPanelEntry`` payloads. DOI citations get their BibTeX from
doi.org (see :mod:`.citations`) unless ``--no-doi`` is given.
"""

import argparse
import hashlib
import io
import logging
import posixpath
import shutil
import tarfile
import tempfile
import urllib.parse
from dataclasses import (
    dataclass,
    field,
)
from pathlib import Path
from typing import Any

import yaml
from galaxy.tool_util.parser import get_tool_source
from galaxy.tool_util.toolbox.base import _filter_for_panel
from galaxy.tool_util.toolbox.entry import (
    ToolPanelEntry,
    ToolShedRepositoryInfo,
)
from galaxy.tool_util.toolbox.panel import (
    panel_item_types,
    ToolPanelElements,
    ToolSection,
    ToolSectionLabel,
)
from galaxy.tool_util.toolbox.views.edam import (
    EdamPanelMode,
    EdamToolPanelView,
)
from galaxy.tool_util.toolbox.views.favorites import (
    MY_TOOLS_PANEL_SECTION_ID,
    MY_TOOLS_PANEL_VIEW_ID,
    MyToolsToolPanelView,
)
from galaxy.tool_util.toolbox.views.interface import (
    ToolBoxRegistry,
    ToolPanelView,
    ToolPanelViewModel,
    ToolPanelViewModelType,
)
from galaxy.util import (
    galaxy_directory,
    parse_xml,
)
from galaxy.util.bunch import Bunch
from galaxy.util.xml_macros import (
    imported_macro_paths,
    raw_xml_tree,
)

from ._common import (
    configure_logging,
    safe_relative_path,
    to_jsonable,
    write_json,
)
from .bundle import build_bundle
from .citations import (
    add_bibtex,
    DoiResolver,
)
from .datatypes import load_registry
from .github import (
    GitHubRepository,
    RepositoryFile,
)

log = logging.getLogger(__name__)

DEFAULT_PANEL_VIEW = "default"
# Galaxy's default ``edam_panel_views``.
EDAM_PANEL_VIEWS = ("operations", "topics")
EXCLUDED_NAMES = ("test-data", ".git", ".hg")
# 1980-01-01, the earliest timestamp every archive format accepts.
ARCHIVE_MTIME = 315532800


class ToolboxError(Exception):
    pass


@dataclass
class PanelTool:
    """The attributes of a ``galaxy.tools.Tool`` that panel views and filters read."""

    id: str
    name: str
    version: str
    hidden: Any
    edam_operations: list[str]
    edam_topics: list[str]
    tool_type: str
    require_login: bool
    entry: dict[str, Any]
    tool_tags: list[str] = field(default_factory=list)
    lineage: Any = None

    def allow_user_access(self, user, attempting_access: bool = True) -> bool:
        return True


@dataclass
class LoadedTool:
    bundle: dict[str, Any]
    repo_tar: bytes | None


class _Registry(ToolBoxRegistry):
    def __init__(self, tools: dict[str, PanelTool]):
        self._tools = tools

    def has_tool(self, tool_id: str) -> bool:
        return tool_id in self._tools

    def get_tool(self, tool_id: str):
        return self._tools.get(tool_id)

    def get_workflow(self, id: str):
        raise KeyError(id)

    def add_tool_to_tool_panel_view(self, tool, tool_panel_component) -> None:
        if tool.hidden:
            return
        elems = tool_panel_component.elems if isinstance(tool_panel_component, ToolSection) else tool_panel_component
        if not elems.has_tool_with_id(tool.id):
            elems.append_tool(tool)


class _DefaultToolPanelView(ToolPanelView):
    """``DefaultToolPanelView`` from ``AbstractToolBox.__init__``."""

    def __init__(self, panel: ToolPanelElements):
        self._panel = panel

    def apply_view(self, base_tool_panel, toolbox_registry):
        return self._panel

    def to_model(self) -> ToolPanelViewModel:
        return ToolPanelViewModel(
            id=DEFAULT_PANEL_VIEW,
            name="Full Tool Panel",
            description=(
                "Galaxy's fully configured toolbox panel with all sections, tools, and configured workflows loaded."
            ),
            # Galaxy reports the metaclass name of its local view class here.
            model_class=type(ToolPanelView).__name__,
            view_type=ToolPanelViewModelType.default_type,
            searchable=True,
        )


class _EntrySource:
    """Answers ``get_tool_to_dict`` for ``ToolSection.to_dict`` with the precomputed entries."""

    def get_tool_to_dict(self, trans, tool, tool_help: bool = False) -> dict[str, Any]:
        return tool.entry


# --- loading tools ------------------------------------------------------------------------


def _shed_repository(stage_dir: Path, tool_id: str, entry: dict[str, Any]) -> tuple[str, str]:
    owner = entry.get("owner")
    name = entry.get("name")
    shed_yml = stage_dir / ".shed.yml"
    if (owner is None or name is None) and shed_yml.exists():
        shed = yaml.safe_load(shed_yml.read_text()) or {}
        owner = owner or shed.get("owner")
        template = (shed.get("auto_tool_repositories") or {}).get("name_template")
        if name is None and template:
            if template.replace(" ", "") != "{{tool_id}}":
                raise ToolboxError(f"Unsupported auto_tool_repositories name_template {template!r}")
            name = tool_id
        name = name or shed.get("name")
    if not owner or not name:
        raise ToolboxError(f"Cannot determine the Tool Shed repository for {tool_id}; set owner and name")
    return owner, name


def _stage(stage_root: Path, relative: str, content: bytes) -> Path:
    normalized = posixpath.normpath(relative)
    if normalized.startswith(("/", "../")) or normalized in (".", "..") or "\0" in normalized:
        raise ToolboxError(f"Refusing to stage {relative!r} outside the work directory")
    target = stage_root / normalized
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return target


def _stage_imports(repo: GitHubRepository, stage_root: Path, xml_relative: str, seen: set[str]) -> None:
    """Fetch macro files a tool imports from outside its own directory."""
    if xml_relative in seen:
        return
    seen.add(xml_relative)
    root = raw_xml_tree(stage_root / xml_relative).getroot()
    for imported in imported_macro_paths(root):
        relative = posixpath.normpath(posixpath.join(posixpath.dirname(xml_relative), imported))
        if not (stage_root / relative).exists():
            _stage(stage_root, relative, repo.read_file(relative))
        _stage_imports(repo, stage_root, relative, seen)


def _data_tables(stage_dir: Path, files: dict[str, RepositoryFile]) -> list[dict[str, Any]]:
    """Tables from the directory's tool_data_table_conf.xml.sample with their .loc.sample entries."""
    conf = stage_dir / "tool_data_table_conf.xml.sample"
    if not conf.exists():
        return []
    samples = {posixpath.basename(path): path for path in files if path.endswith(".loc.sample")}
    tables = []
    for table_elem in parse_xml(str(conf)).getroot().iter("table"):
        columns_elem = table_elem.find("columns")
        columns = [c.strip() for c in (columns_elem.text or "").split(",")] if columns_elem is not None else []
        comment_char = table_elem.get("comment_char", "#")
        loc_files = []
        for file_elem in table_elem.findall("file"):
            path = file_elem.get("path") or file_elem.get("from_config") or ""
            sample = samples.get(posixpath.basename(path) + ".sample")
            entries = []
            if sample is not None:
                for line in files[sample].content.decode("utf-8", errors="replace").splitlines():
                    if line.strip() and not line.startswith(comment_char):
                        entries.append(line.split("\t"))
            loc_files.append({"path": path, "sample": sample, "entries": entries})
        tables.append(
            {
                "name": table_elem.get("name"),
                "comment_char": comment_char,
                "allow_duplicate_entries": table_elem.get("allow_duplicate_entries", "True").lower() == "true",
                "columns": columns,
                "files": loc_files,
            }
        )
    return tables


def _repo_tar(files: dict[str, RepositoryFile]) -> bytes:
    """Deterministic tar of the tool directory."""
    buffer = io.BytesIO()
    expanded: set[str] = set()
    for path in files:
        parts = path.split("/")[:-1]
        expanded.update("/".join(parts[: i + 1]) for i in range(len(parts)))
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for directory in sorted(expanded):
            info = tarfile.TarInfo(directory)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.mtime = ARCHIVE_MTIME
            tar.addfile(info)
        for path in sorted(files):
            repository_file = files[path]
            info = tarfile.TarInfo(path)
            info.size = len(repository_file.content)
            info.mode = 0o755 if repository_file.executable else 0o644
            info.mtime = ARCHIVE_MTIME
            tar.addfile(info, io.BytesIO(repository_file.content))
    return buffer.getvalue()


def load_repository_tool(
    repo: GitHubRepository, config: dict[str, Any], entry: dict[str, Any], work_dir: Path, registry
) -> LoadedTool:
    xml_relative = posixpath.normpath(entry["path"])
    tool_dir = posixpath.dirname(xml_relative)
    files = repo.read_directory(tool_dir, exclude=EXCLUDED_NAMES)
    if posixpath.basename(xml_relative) not in files:
        raise ToolboxError(f"{xml_relative} not found at {repo.commit}")
    for relative, repository_file in files.items():
        _stage(work_dir, f"{tool_dir}/{relative}", repository_file.content)
    _stage_imports(repo, work_dir, xml_relative, set())
    tool_source = get_tool_source(config_file=str(work_dir / xml_relative))
    old_id = tool_source.parse_id()
    version = tool_source.parse_version()
    if not old_id or not version:
        raise ToolboxError(f"{xml_relative} has no id or version")
    owner, name = _shed_repository(work_dir / tool_dir, old_id, entry)
    tool_shed = config["tool_shed"]
    guid = f"{tool_shed}/repos/{owner}/{name}/{old_id}/{version}"
    repo_tar = _repo_tar(files)
    repo_tar_path = Path("tools") / safe_relative_path(guid, version) / "repo.tar"
    bundle = build_bundle(
        tool_source,
        tool_id=guid,
        tool_dir=tool_dir,
        tool_shed_repository={"name": name, "owner": owner, "changeset_revision": None, "tool_shed": tool_shed},
        source={
            "repository": f"https://github.com/{repo.repository}",
            "commit": repo.commit,
            "path": xml_relative,
            "tool_file": posixpath.basename(xml_relative),
            "repo_tar": {
                "path": repo_tar_path.as_posix(),
                "sha256": hashlib.sha256(repo_tar).hexdigest(),
                "size": len(repo_tar),
            },
        },
        datatypes_registry=registry,
        data_tables=_data_tables(work_dir / tool_dir, files),
    )
    return LoadedTool(bundle, repo_tar)


def load_galaxy_tool(galaxy_root: Path, entry: dict[str, Any], registry) -> LoadedTool:
    relative = posixpath.normpath(entry["galaxy"])
    path = galaxy_root / safe_relative_path(relative)
    tool_source = get_tool_source(config_file=str(path))
    bundle = build_bundle(
        tool_source,
        tool_dir=posixpath.dirname(relative),
        source={"repository": None, "commit": None, "path": relative, "tool_file": path.name, "repo_tar": None},
        datatypes_registry=registry,
    )
    return LoadedTool(bundle, None)


# --- panel --------------------------------------------------------------------------------


def panel_entry(bundle: dict[str, Any], section_id: str, section_name: str, labels: list[str]) -> dict[str, Any]:
    """``Tool.to_panel_entry`` for a bundle."""
    kwargs: dict[str, Any] = {
        "model_class": bundle["model_class"],
        "id": bundle["id"],
        "name": bundle["name"],
        "version": bundle["version"],
        "description": bundle["description"],
        "labels": labels,
        "icon": bundle["icon"],
        "edam_operations": bundle["edam_operations"],
        "edam_topics": bundle["edam_topics"],
        "hidden": bundle["hidden"],
        "is_workflow_compatible": bundle["is_workflow_compatible"],
        "xrefs": bundle["xrefs"],
        "versions": bundle["versions"],
        "hidden_versions": [],
        "link": "/tool_runner?" + urllib.parse.urlencode({"tool_id": bundle["id"]}),
        "has_parameters": bundle["has_parameters"],
        "panel_section_id": section_id,
        "panel_section_name": section_name,
        "form_style": bundle["form_style"],
    }
    if repository := bundle.get("tool_shed_repository"):
        kwargs["tool_shed_repository"] = ToolShedRepositoryInfo(**repository)
    return ToolPanelEntry(**kwargs).model_dump(mode="json", exclude_unset=True)


def _filters() -> dict[str, list]:
    # FilterFactory.default_filters for a user who may access every tool.
    def _not_hidden(context, tool) -> bool:
        return not tool.hidden

    return {"tool": [_not_hidden], "section": [], "label": []}


def _panel_contents(view_id: str, rendered: ToolPanelElements):
    """``AbstractToolBox.tool_panel_contents``."""
    context = Bunch(toolbox=None, trans=None)
    filters = _filters()
    for _, item_type, elt in rendered.panel_items_iter():
        if (
            view_id == MY_TOOLS_PANEL_VIEW_ID
            and item_type == panel_item_types.SECTION
            and getattr(elt, "id", None) == MY_TOOLS_PANEL_SECTION_ID
        ):
            yield elt
            continue
        elt = _filter_for_panel(elt, item_type, filters, context)
        if elt:
            yield elt


def to_panel_view(view_id: str, rendered: ToolPanelElements) -> dict[str, Any]:
    """``AbstractToolBox.to_panel_view``."""
    contents: dict[str, Any] = {}
    for elt in _panel_contents(view_id, rendered):
        if hasattr(elt, "tool_type"):
            contents[elt.id] = elt.entry
        else:
            contents[elt.id] = elt.to_dict(trans=None, tool_help=False, toolbox=_EntrySource(), only_ids=True)
    return to_jsonable(contents)


def to_dict_in_panel(rendered: ToolPanelElements) -> list[dict[str, Any]]:
    """``AbstractToolBox.to_dict(in_panel=True)`` for the default view."""
    result = []
    for elt in _panel_contents(DEFAULT_PANEL_VIEW, rendered):
        if hasattr(elt, "tool_type"):
            result.append(elt.entry)
        else:
            result.append(elt.to_dict(trans=None, tool_help=False, toolbox=_EntrySource()))
    return to_jsonable(result)


# --- driver -------------------------------------------------------------------------------


def generate(
    config_path: Path, out_dir: Path, cache_dir: Path, galaxy_root: Path, doi_resolver: DoiResolver | None = None
) -> dict[str, Any]:
    config = yaml.safe_load(config_path.read_text())
    registry = load_registry(str(galaxy_root))
    repo = GitHubRepository(config["repository"], config["commit"], cache_dir)
    data_dir = out_dir / "static" / "planet" / "data" / "toolbox"
    repos_dir = out_dir / "toolrepos"
    for stale in (data_dir, repos_dir):
        if stale.exists():
            shutil.rmtree(stale)

    tools: dict[str, PanelTool] = {}
    base_panel = ToolPanelElements()
    bundle_sizes: dict[str, int] = {}
    repo_index: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="planet-toolbox-") as tmp:
        for section_config in config["sections"]:
            section = ToolSection({"id": section_config["id"], "name": section_config["name"], "version": ""})
            for index, item in enumerate(section_config["tools"]):
                if "label" in item:
                    label_id = item.get("id") or f"{section.id}_label_{index}"
                    section.elems[f"label_{label_id}"] = ToolSectionLabel(
                        {"type": "label", "id": label_id, "text": item["label"]}
                    )
                    continue
                if "galaxy" in item:
                    loaded = load_galaxy_tool(galaxy_root, item, registry)
                else:
                    loaded = load_repository_tool(repo, config, item, Path(tmp) / f"{len(tools)}", registry)
                bundle = loaded.bundle
                if bundle["id"] in tools:
                    raise ToolboxError(f"Tool {bundle['id']} is listed twice")
                if bundle["tool_type"] != "default":
                    log.warning("%s has tool_type %s, which Planet cannot run", bundle["id"], bundle["tool_type"])
                labels = list(item.get("labels") or [])
                bundle["panel_entry"] = panel_entry(bundle, section.id, section.name, labels)
                tool = PanelTool(
                    id=bundle["id"],
                    name=bundle["name"],
                    version=bundle["version"],
                    hidden=bundle["hidden"],
                    edam_operations=bundle["edam_operations"],
                    edam_topics=bundle["edam_topics"],
                    tool_type=bundle["tool_type"],
                    require_login=bundle["require_login"],
                    entry=bundle["panel_entry"],
                    tool_tags=bundle["tool_tags"],
                )
                tools[tool.id] = tool
                if not tool.hidden:
                    section.elems.append_tool(tool)
                base_panel.record_section_for_tool_id(tool.id, section.id, section.name)

                relative = safe_relative_path(bundle["id"], bundle["version"])
                bundle_path = data_dir / "bundles" / relative.parent / f"{relative.name}.json"
                if doi_resolver is not None:
                    add_bibtex(bundle, doi_resolver)
                bundle_sizes[bundle["id"]] = write_json(bundle_path, bundle)
                if loaded.repo_tar is not None:
                    repo_tar = bundle["source"]["repo_tar"]
                    target = repos_dir / repo_tar["path"]
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(loaded.repo_tar)
                    repo_index.append({"id": bundle["id"], "version": bundle["version"], **repo_tar})
                log.info("bundled %s (%d bytes)", bundle["id"], bundle_sizes[bundle["id"]])
            base_panel[section.id] = section

    toolbox_registry = _Registry(tools)
    views: list[ToolPanelView] = [_DefaultToolPanelView(base_panel), MyToolsToolPanelView()]
    views.extend(EdamToolPanelView(registry.edam, mode=EdamPanelMode[mode]) for mode in EDAM_PANEL_VIEWS)
    models = {}
    sizes: dict[str, int] = {}
    for view in views:
        model = view.to_model()
        models[model.id] = model.model_dump(mode="json")
        rendered = view.apply_view(base_panel, toolbox_registry)
        payload = to_panel_view(model.id, rendered)
        if model.id == DEFAULT_PANEL_VIEW:
            sizes["panel.json"] = write_json(data_dir / "panel.json", payload)
        sizes[f"panel_views/{model.id}.json"] = write_json(data_dir / "panel_views" / f"{model.id}.json", payload)
    sizes["panels.json"] = write_json(
        data_dir / "panels.json", {"default_panel_view": DEFAULT_PANEL_VIEW, "views": models}
    )
    visible = [tool.entry for tool in tools.values() if not tool.hidden]
    sizes["tools.json"] = write_json(data_dir / "tools.json", visible)
    sizes["tools_in_panel.json"] = write_json(data_dir / "tools_in_panel.json", to_dict_in_panel(base_panel))
    sizes["tool_tags.json"] = write_json(
        data_dir / "tool_tags.json", {tool.id: tool.tool_tags for tool in tools.values() if tool.tool_tags}
    )
    write_json(repos_dir / "index.json", repo_index)
    return {
        "tools": len(tools),
        "bundle_bytes": sum(bundle_sizes.values()),
        "largest_bundle": max(bundle_sizes.items(), key=lambda kv: kv[1]) if bundle_sizes else None,
        "panel_bytes": sum(sizes.values()),
        "repo_tars": len(repo_index),
        "repo_tar_bytes": sum(r["size"] for r in repo_index),
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", type=Path, required=True, help="toolbox.yml")
    parser.add_argument("--out", type=Path, required=True, help="generated output root (planet/build/generated)")
    parser.add_argument("--cache", type=Path, help="download cache (default: <out>/../cache/github)")
    parser.add_argument("--galaxy-root", type=Path, help="Galaxy checkout (default: the one providing galaxy)")
    parser.add_argument("--doi-cache", type=Path, help="BibTeX cache (default: <out>/../cache/doi)")
    parser.add_argument("--no-doi", action="store_true", help="do not resolve DOI citations to BibTeX")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    configure_logging(args.verbose)
    galaxy_root = args.galaxy_root or Path(galaxy_directory())
    cache_dir = args.cache or args.out.parent / "cache" / "github"
    doi_resolver = None if args.no_doi else DoiResolver(args.doi_cache or args.out.parent / "cache" / "doi")
    summary = generate(args.config, args.out, cache_dir, galaxy_root, doi_resolver)
    log.info("toolbox: %s", summary)


if __name__ == "__main__":
    main()
