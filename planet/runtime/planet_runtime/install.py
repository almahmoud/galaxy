"""``planet-stager install``: installs the tools of a Tool Shed or GitHub repository (kind ``tool_install``).

The repository is fetched (``repositories``), its tools are parsed with Galaxy's tool parser in a child process
that never sees a presigned request (``install_worker``), and the bundle and directory archive of every tool
Planet can run are uploaded to the next slot of ``install.slots``. ``results.json`` lists every tool file found,
installed or not, with the reasons.
"""

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from galaxy.tool_util.parser.stdio import StdioErrorLevel
from galaxy.util import shrink_and_unicodify

from planet_runtime import (
    isolation,
    manifest as manifest_module,
    repositories,
    termination,
)
from planet_runtime.documents import (
    base_results,
    internal_message,
    publish_results,
)
from planet_runtime.install_worker import RESULT_PREFIX
from planet_runtime.layout import Layout
from planet_runtime.redact import (
    error_message,
    redact,
)
from planet_runtime.transfer import (
    PresignedRequest,
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)

WORKER_TIMEOUT_SECONDS = 900
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_REPORT_ERRORS = 20
DEFAULT_PANEL_SECTION = {"id": "planet_installed", "name": "Installed tools"}


class InstallError(Exception):
    pass


def tool_message(path: str, text: str) -> dict[str, Any]:
    return {"type": "internal", "desc": f"{path}: {text}", "code_desc": None, "error_level": StdioErrorLevel.WARNING}


def run_worker(request: Mapping[str, Any], layout: Layout, cwd: Path) -> dict[str, Any]:
    """Run ``install_worker`` with an environment without the manifest and return its report.

    The worker runs isolated (``-I``: no ``PYTHON*`` variables, user site or current directory on its path) in
    ``cwd``, which must be an empty directory outside the repository.
    """
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in (manifest_module.MANIFEST_URL_ENV, manifest_module.MANIFEST_FILE_ENV)
    }
    environment["HOME"] = str(layout.stager_home)
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "planet_runtime.install_worker"],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            env=environment,
            cwd=cwd,
            timeout=WORKER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise InstallError(
            f"Reading the repository's tools did not finish within {WORKER_TIMEOUT_SECONDS} seconds"
        ) from None
    for line in reversed(completed.stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            report = json.loads(line[len(RESULT_PREFIX) :])
            break
    else:
        detail = completed.stderr.strip().splitlines()[-1:] or [f"exit code {completed.returncode}"]
        raise InstallError(f"Reading the repository's tools failed: {detail[0]}")
    if not report.get("ok"):
        raise InstallError(f"Reading the repository's tools failed: {report.get('message')}")
    return report


def check_slots(install: Mapping[str, Any]) -> list[dict[str, Any]]:
    slots = install.get("slots")
    if not isinstance(slots, list):
        raise manifest_module.ManifestError("install.slots must be a list")
    for index, slot in enumerate(slots):
        for name in ("bundle", "repo_tar"):
            target = slot.get(name) if isinstance(slot, Mapping) else None
            if not isinstance(target, Mapping) or not isinstance(target.get("key"), str) or not target.get("request"):
                raise manifest_module.ManifestError(f"install.slots[{index}].{name} needs a key and a request")
    return slots


def _digest(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "size": path.stat().st_size}


def publish_tool(entry: dict[str, Any], out: Path, slots: list[dict[str, Any]], transfers: Transfers) -> None:
    """Check the worker's files for one installed tool and upload them to its slot."""
    slot = entry.get("slot")
    if not isinstance(slot, int) or not 0 <= slot < len(slots):
        raise InstallError("The tool has no slot")
    directory = out / str(slot)
    bundle_path = directory / "bundle.json"
    archive_path = directory / "repo.tar"
    for path in (bundle_path, archive_path):
        if path.is_symlink() or not path.is_file():
            raise InstallError(f"{path.name} was not written")
    if bundle_path.stat().st_size > MAX_BUNDLE_BYTES:
        raise InstallError(f"Its bundle is larger than {MAX_BUNDLE_BYTES} bytes")
    bundle = json.loads(bundle_path.read_bytes())
    archive = _digest(archive_path)
    repo_tar = (bundle.get("source") or {}).get("repo_tar") or {}
    if (
        bundle.get("id") != entry.get("id")
        or bundle.get("version") != entry.get("version")
        or repo_tar.get("sha256") != archive["sha256"]
        or repo_tar.get("size") != archive["size"]
        or repo_tar.get("path") != slots[slot]["repo_tar"]["key"]
    ):
        raise InstallError("Its bundle does not match its archive")
    transfers.put_file(
        PresignedRequest.parse(slots[slot]["repo_tar"]["request"]), archive_path, content_type="application/x-tar"
    )
    transfers.put_file(
        PresignedRequest.parse(slots[slot]["bundle"]["request"]), bundle_path, content_type="application/json"
    )
    entry["bundle"] = _digest(bundle_path)
    entry["repo_tar"] = archive


def stream(text: str) -> dict[str, Any]:
    """A ``{text, size}`` stream of ``results.json``, its text shortened like Galaxy's ``set_streams``."""
    return {"text": shrink_and_unicodify(text), "size": len(text.encode())}


def summary_lines(tools: list[dict[str, Any]]) -> list[str]:
    lines = []
    for entry in tools:
        label = f"{entry.get('old_id') or entry['path']} {entry.get('version') or ''}".strip()
        if entry["state"] == "installed":
            lines.append(f"Installed {label} from {entry['path']}")
        else:
            reasons = "; ".join(entry["errors"]) or "unknown error"
            lines.append(f"Not installed: {label} from {entry['path']}: {reasons}")
        lines.extend(f"  Warning: {warning}" for warning in entry["warnings"])
    return lines


def install(manifest: Mapping[str, Any], layout: Layout, transfers: Transfers, results: dict[str, Any]) -> None:
    """Fetch, parse and publish; fills ``results`` (``tools``, ``install``, ``state``)."""
    install_section = manifest.get("install") or {}
    slots = check_slots(install_section)
    source = repositories.parse_source(install_section.get("source"))
    section = install_section.get("panel_section") or DEFAULT_PANEL_SECTION
    work = layout.root / "install"
    results["install"] = {"source": source, "repository_url": None, "revision": None, "warnings": []}
    with isolation.contained_children():
        checkout = repositories.fetch(source, work / "repository", transfers.retry)
        results["install"].update(
            repository_url=checkout.repository_url, revision=checkout.revision, warnings=list(checkout.warnings)
        )
        out = work / "tools"
        out.mkdir(parents=True)
        neutral = work / "worker"
        neutral.mkdir()
        report = run_worker(
            {
                "repository_root": str(checkout.repository_root),
                "root": str(checkout.root),
                "prefix": checkout.prefix,
                "out": str(out),
                "repository_url": checkout.repository_url,
                "revision": checkout.revision,
                "guid_prefix": checkout.guid_prefix,
                "tool_shed_repository": checkout.tool_shed_repository,
                "excluded_names": sorted(repositories.EXCLUDED_NAMES),
                "panel_section": {"id": str(section.get("id")), "name": str(section.get("name"))},
                "archive_keys": [slot["repo_tar"]["key"] for slot in slots],
            },
            layout,
            neutral,
        )
    tools: list[dict[str, Any]] = report.get("tools") or []
    for entry in tools:
        if entry.get("state") != "installed":
            continue
        try:
            publish_tool(entry, out, slots, transfers)
        except (InstallError, TransferError, OSError, ValueError) as e:
            entry.update(state="failed", slot=None, bundle=None, repo_tar=None)
            entry["errors"].append(redact(f"Storing its files failed: {e}"))
    results["tools"] = tools
    installed = [entry for entry in tools if entry["state"] == "installed"]
    results["state"] = "ok" if installed else "error"
    results["job_messages"].extend(
        tool_message(entry["path"], error) for entry in tools for error in entry["errors"][:MAX_REPORT_ERRORS]
    )
    if not tools:
        results["job_messages"].append(internal_message("The repository has no Galaxy tool."))
    elif not installed:
        results["job_messages"].append(internal_message("No tool of the repository can be installed."))
    stdout = "\n".join([*summary_lines(tools), *(f"Warning: {w}" for w in checkout.warnings)])
    results["job_stdout"] = stream(stdout)


def run(layout: Layout, transfers: Transfers) -> int:
    started = termination.utcnow()
    try:
        manifest = manifest_module.load(transfers)
        manifest_module.check(manifest, "tool_install")
    except (TransferError, manifest_module.ManifestError) as e:
        log.error("Cannot load the manifest: %s", e)
        termination.write({"stage": "install", "state": "error", "results": "failed", "error": str(e)})
        return 1

    for directory in layout.stager_directories():
        directory.mkdir(parents=True, exist_ok=True)
    work = layout.root / "install"
    if work.exists():
        shutil.rmtree(work)
    results = base_results(manifest, "tool_install", "error")
    results["tools"] = []
    errors: list[str] = results["errors"]
    try:
        install(manifest, layout, transfers, results)
    except (repositories.RepositoryError, InstallError, manifest_module.ManifestError) as e:
        errors.append(redact(str(e)))
    except Exception as e:
        log.exception("Installing the tools failed")
        errors.append(error_message(e))
    if errors:
        results["state"] = "error"
        results["job_messages"].append(internal_message(errors[0]))
        results["job_stderr"] = stream("\n".join(errors))
    results["timings"] = {"stage_out_start": started, "stage_out_end": termination.utcnow()}
    uploaded = publish_results(transfers, manifest, results)
    shutil.rmtree(work, ignore_errors=True)
    termination.write(
        {
            "stage": "install",
            "state": results["state"],
            "results": "uploaded" if uploaded else "failed",
            "installed": sum(1 for entry in results["tools"] if entry["state"] == "installed"),
            **({"error": errors[0]} if errors else {}),
        }
    )
    return 0 if uploaded else 1
