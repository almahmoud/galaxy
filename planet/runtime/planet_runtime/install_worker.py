"""Child process of ``planet-stager install`` that parses a repository's tools with Galaxy's tool parser.

Tool XML is untrusted: this process gets no presigned request and an environment without
``PLANET_MANIFEST_URL``, and the stager is not dumpable (see ``isolation``). It reads a JSON request on stdin,
writes the bundle and directory archive of every tool Planet can run to ``<out>/<slot>/``, and prints one
JSON report as its last line of output.
"""

import hashlib
import json
import os
import posixpath
import sys
from pathlib import (
    Path,
    PurePosixPath,
)
from typing import Any

RESULT_PREFIX = "planet-install-result:"
# Tool directory archives larger than this are refused.
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
# Links followed below one tool directory.
MAX_LINK_DEPTH = 8
# Tool types Planet runs; the others run inside Galaxy's own process.
SUPPORTED_TOOL_TYPES = frozenset({"default"})
TOOL_TYPE_REASONS = {
    "manage_data": "Data managers are not supported: they write Galaxy's reference data tables.",
    "data_source": "Data source tools are not supported: they need a Galaxy server that the external site sends data to.",
    "data_source_async": "Data source tools are not supported: they need a Galaxy server that the external site sends data to.",
    "interactive": "Interactive tools are not supported.",
}


def unsupported(bundle: dict[str, Any]) -> list[str]:
    """Why Planet cannot run the tool of ``bundle``; empty when it can.

    A tool without a container is not refused: its image is resolved from its requirements when it runs.
    """
    reasons = []
    tool_type = bundle.get("tool_type") or "default"
    if tool_type not in SUPPORTED_TOOL_TYPES:
        reasons.append(
            TOOL_TYPE_REASONS.get(
                tool_type,
                f"Tools of type {tool_type} are not supported: Galaxy runs them in its own Python environment.",
            )
        )
    for code in bundle.get("code") or []:
        reasons.append(f"It needs Galaxy's Python environment to run its code file {code.get('file')}.")
    for name in _dynamic_option_parameters(bundle.get("inputs") or []):
        reasons.append(f"It needs Galaxy's Python environment to compute the options of parameter {name}.")
    if any("__app__" in text for text in _templates(bundle)):
        reasons.append("Its templates use $__app__, Galaxy's application object, which Planet jobs do not have.")
    return reasons


def _dynamic_option_parameters(inputs: list[dict[str, Any]], prefix: str = "") -> list[str]:
    names = []
    for item in inputs:
        name = f"{prefix}{item.get('name')}"
        if item.get("dynamic_options"):
            names.append(name)
        for nested in (item.get("inputs"), *(case.get("inputs") for case in item.get("cases") or [])):
            names.extend(_dynamic_option_parameters(nested or [], f"{name}|"))
        if test_param := item.get("test_param"):
            names.extend(_dynamic_option_parameters([test_param], f"{name}|"))
    return names


def _templates(bundle: dict[str, Any]) -> list[str]:
    """Cheetah templates of the bundle: command, version command, config files, environment and macros."""
    return [
        str((bundle.get("command") or {}).get("text") or ""),
        str((bundle.get("version_command") or {}).get("command") or ""),
        json.dumps(bundle.get("configfiles") or {}),
        json.dumps(bundle.get("environment_variables") or []),
        json.dumps(bundle.get("template_macro_params") or {}),
    ]


def _inside(path: Path, root: Path) -> bool:
    resolved = path.resolve()
    return resolved == root or root in resolved.parents


def discover(root: Path, excluded_names: frozenset[str]) -> list[str]:
    """Tool XML files below ``root``, as sorted paths relative to it. Links are not followed."""
    from galaxy.tool_util.loader_directory import looks_like_a_tool_xml

    found = []
    for directory, subdirectories, files in os.walk(root, followlinks=False):
        subdirectories[:] = sorted(name for name in subdirectories if name not in excluded_names)
        for name in files:
            path = Path(directory) / name
            if name.endswith(".xml") and not path.is_symlink() and looks_like_a_tool_xml(str(path)):
                found.append(path.relative_to(root).as_posix())
    return sorted(found)


def directory_files(directory: Path, repository_root: Path, excluded_names: frozenset[str]):
    """Files below a tool directory keyed by relative path, with links resolved inside the repository.

    Links that leave the repository are left out, as planemo leaves them out of Tool Shed uploads.
    Returns the files and the relative paths left out.
    """
    from planet_runtime.generate.github import RepositoryFile

    files: dict[str, RepositoryFile] = {}
    left_out: list[str] = []
    total = 0

    def walk(current: Path, prefix: str, links: int, ancestors: frozenset[Path]) -> None:
        nonlocal total
        for entry in sorted(os.scandir(current), key=lambda e: e.name):
            if entry.name in excluded_names:
                continue
            path = Path(entry.path)
            relative = f"{prefix}{entry.name}"
            linked = entry.is_symlink()
            if linked and (
                not _inside(path, repository_root) or links >= MAX_LINK_DEPTH or path.resolve() in ancestors
            ):
                left_out.append(relative)
            elif path.is_dir():
                walk(path, f"{relative}/", links + 1 if linked else links, ancestors | {path.resolve()})
            elif path.is_file():
                content = path.read_bytes()
                total += len(content)
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError(f"Its directory is larger than {MAX_ARCHIVE_BYTES} bytes without test data.")
                files[relative] = RepositoryFile(content, os.access(path, os.X_OK))

    walk(directory, "", 0, frozenset({directory.resolve()}))
    return files, left_out


def _check_imports(xml_path: Path, repository_root: Path, seen: set[Path]) -> None:
    """Refuse macro imports that resolve outside the repository."""
    from galaxy.util.xml_macros import (
        imported_macro_paths,
        raw_xml_tree,
    )

    if xml_path in seen:
        return
    seen.add(xml_path)
    for imported in imported_macro_paths(raw_xml_tree(str(xml_path)).getroot()):
        path = xml_path.parent / imported
        if not _inside(path, repository_root):
            raise ValueError(f"It imports macros from {imported}, outside the repository.")
        if path.is_file():
            _check_imports(path.resolve(), repository_root, seen)


def _digest(path: Path) -> dict[str, Any]:
    return {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "size": path.stat().st_size}


def build(request: dict[str, Any]) -> dict[str, Any]:
    """Parse every tool of the request's repository; see ``planet-stager install``."""
    from galaxy.tool_util.parser import get_tool_source
    from galaxy.tool_util.parser.util import (
        parse_profile_version,
        parse_tool_version_with_defaults,
    )
    from galaxy.util.xml_macros import raw_xml_tree
    from packaging.version import Version

    from planet_runtime.generate._common import (
        safe_relative_path,
        write_json,
    )
    from planet_runtime.generate.bundle import (
        build_bundle,
        BundleError,
    )
    from planet_runtime.generate.datatypes import load_registry
    from planet_runtime.generate.toolbox import (
        _data_tables,
        _repo_tar,
        panel_entry,
    )

    repository_root = Path(request["repository_root"]).resolve()
    root = Path(request["root"]).resolve()
    out = Path(request["out"])
    prefix = request["prefix"]
    excluded_names = frozenset(request["excluded_names"])
    section = request["panel_section"]
    archive_keys: list[str] = request["archive_keys"]
    registry = load_registry()
    tools: list[dict[str, Any]] = []
    ids: set[str] = set()
    # Tools are visited in path order, so the tools of one directory share its archive.
    archived: tuple[str, dict[str, Any], list[str], bytes] | None = None
    for relative in discover(root, excluded_names):
        xml_path = root / relative
        repository_path = posixpath.join(prefix, relative) if prefix else relative
        entry: dict[str, Any] = {
            "path": repository_path,
            "id": None,
            "old_id": None,
            "version": None,
            "name": None,
            "description": None,
            "state": "failed",
            "slot": None,
            "bundle": None,
            "repo_tar": None,
            "errors": [],
            "warnings": [],
        }
        try:
            if raw_xml_tree(str(xml_path)).getroot().tag != "tool":
                continue
        except Exception as e:
            entry["errors"].append(f"It is not valid XML: {e}")
            tools.append(entry)
            continue
        tools.append(entry)
        try:
            _check_imports(xml_path.resolve(), repository_root, set())
            tool_source = get_tool_source(config_file=str(xml_path))
            old_id = tool_source.parse_id()
            if not old_id:
                raise ValueError("It has no id.")
            version = parse_tool_version_with_defaults(
                old_id, tool_source, Version(str(parse_profile_version(tool_source)))
            )
            guid = f"{request['guid_prefix']}/{old_id}/{version}"
            safe_relative_path(guid, version)
            entry.update(id=guid, old_id=old_id, version=version)
            if guid in ids:
                raise ValueError(f"Another file of the repository also defines {old_id} {version}.")
            ids.add(guid)
            tool_dir = PurePosixPath(repository_path).parent.as_posix()
            tool_dir = "" if tool_dir == "." else tool_dir
            directory = repository_root / tool_dir if tool_dir else repository_root
            if archived is None or archived[0] != tool_dir:
                files, left_out = directory_files(directory, repository_root, excluded_names)
                archived = (tool_dir, files, left_out, _repo_tar(files))
            _, files, left_out, repo_tar = archived
            entry["warnings"].extend(
                f"{path} is left out of the tool archive: it leads outside the repository." for path in left_out
            )
            slot = sum(1 for tool in tools if tool["slot"] is not None)
            archive_key = archive_keys[slot] if slot < len(archive_keys) else ""
            bundle = build_bundle(
                tool_source,
                tool_id=guid,
                tool_dir=tool_dir,
                tool_shed_repository=request["tool_shed_repository"],
                source={
                    "repository": request["repository_url"],
                    "commit": request["revision"],
                    "path": repository_path,
                    "tool_file": PurePosixPath(repository_path).name,
                    "repo_tar": None,
                },
                datatypes_registry=registry,
                data_tables=_data_tables(directory, files),
            )
            entry.update(name=bundle["name"], description=bundle["description"])
            reasons = unsupported(bundle)
            if reasons:
                entry.update(state="rejected", errors=reasons)
                continue
            if not bundle["containers"] and not any(
                item.get("type") == "package" for item in bundle["requirements"] or []
            ):
                entry["warnings"].append(
                    "It names no container and no package requirement, so no image can be found for it."
                )
            if slot >= len(archive_keys):
                raise ValueError(f"The installation has room for {len(archive_keys)} tools.")
            bundle["source"]["repo_tar"] = {
                "path": archive_key,
                "sha256": hashlib.sha256(repo_tar).hexdigest(),
                "size": len(repo_tar),
            }
            bundle["panel_entry"] = panel_entry(bundle, section["id"], section["name"], [])
            slot_dir = out / str(slot)
            slot_dir.mkdir(parents=True, exist_ok=True)
            (slot_dir / "repo.tar").write_bytes(repo_tar)
            write_json(slot_dir / "bundle.json", bundle)
            entry.update(
                state="installed",
                slot=slot,
                bundle=_digest(slot_dir / "bundle.json"),
                repo_tar={"sha256": bundle["source"]["repo_tar"]["sha256"], "size": len(repo_tar)},
            )
        except Exception as e:
            entry["state"] = "failed"
            entry["errors"].append(str(e) if isinstance(e, ValueError | BundleError) else f"{type(e).__name__}: {e}")
    return {"tools": tools}


def main() -> int:
    request = json.load(sys.stdin)
    try:
        result: dict[str, Any] = {"ok": True, **build(request)}
    except Exception as e:
        result = {"ok": False, "message": f"{type(e).__name__}: {e}"}
    sys.stdout.write("\n" + RESULT_PREFIX + json.dumps(result, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    from planet_runtime.cli import exit_now

    exit_now(main())
