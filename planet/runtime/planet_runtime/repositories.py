"""The repository a tool installation reads: a Tool Shed changeset cloned with ``hg``, or a GitHub commit.

Both end up as a tar that is extracted with the ``data`` filter of :mod:`tarfile`, without test data and
version control files and within size limits. ``hg`` runs without any configuration file, with subrepositories
disabled and without the manifest URL in its environment. The changeset ``hg`` checked out must start with the
requested revision. Only the Tool Sheds the browser installs from (``TOOL_SHEDS``) are cloned.

A GitHub archive comes from ``codeload.github.com/<owner>/<name>/tar.gz/<commit>``. The pod checks that no
redirect led elsewhere, that the archive's top-level directory is ``<name>-<commit>`` and that its pax header,
which ``git archive`` writes, names the requested commit. That proves GitHub served this commit as the archive
of ``<owner>/<name>``. It does not prove that the commit belongs to that repository: codeload serves the commits
of a whole fork network under the name of each repository in it. The browser checks that the commit is on a
branch or tag of the repository with GitHub's API before it creates the installation.
"""

import logging
import os
import posixpath
import re
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import (
    Path,
    PurePosixPath,
)
from typing import Any

from planet_runtime import __version__
from planet_runtime.redact import redact
from planet_runtime.transfer import (
    RetryPolicy,
    TransferError,
)

log = logging.getLogger(__name__)

CODELOAD_BASE = "https://codeload.github.com"
# The browser's list (client/src/planet/install/source.ts).
TOOL_SHEDS = frozenset({"toolshed.g2.bx.psu.edu", "testtoolshed.g2.bx.psu.edu"})
USER_AGENT = f"planet-stager/{__version__}"
# Directories and files left out of extracted repositories and tool archives.
EXCLUDED_NAMES = frozenset({"test-data", ".hg", ".git", ".hgtags", ".hgsub", ".hgsubstate", ".hg_archival.txt"})
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
MAX_MEMBERS = 100_000
HG_TIMEOUT_SECONDS = 900
CLONE_ATTEMPTS = 3
MAX_ERROR_CHARS = 2000

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
_CHANGESET = re.compile(r"^[0-9a-f]{12,40}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_HOST = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class RepositoryError(Exception):
    pass


@dataclass(frozen=True)
class Checkout:
    """An extracted repository and what identifies it."""

    repository_root: Path
    # Where tools are looked for: the repository root, or the requested path of a GitHub repository.
    root: Path
    # ``root`` relative to ``repository_root`` ("" for the root itself).
    prefix: str
    repository_url: str
    # Full changeset id or commit SHA.
    revision: str
    # GUID prefix of the tools: ``<tool shed>/repos/<owner>/<name>`` or ``github.com/repos/<owner>/<repository>``.
    guid_prefix: str
    tool_shed_repository: dict[str, Any] | None
    warnings: tuple[str, ...] = ()


def parse_source(value: Any) -> dict[str, Any]:
    """The install source of the manifest, checked and normalized."""
    if not isinstance(value, dict):
        raise RepositoryError("The install source must be an object")
    kind = value.get("type")
    if kind == "toolshed":
        url = str(value.get("tool_shed_url") or "").rstrip("/")
        parsed = urllib.parse.urlsplit(url)
        host = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or not _HOST.match(host)
            or parsed.port is not None
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise RepositoryError(f"Tool Shed URL {url!r} must be https://<host>")
        if host not in TOOL_SHEDS:
            raise RepositoryError(f"Tools can only be installed from {' or '.join(sorted(TOOL_SHEDS))}, not {host}")
        source = {
            "type": "toolshed",
            "tool_shed_url": f"https://{host}",
            "owner": str(value.get("owner") or ""),
            "name": str(value.get("name") or ""),
            "changeset_revision": str(value.get("changeset_revision") or "").lower(),
        }
        if not _NAME.match(source["owner"]) or not _NAME.match(source["name"]):
            raise RepositoryError("The Tool Shed repository needs a valid owner and name")
        if not _CHANGESET.match(source["changeset_revision"]):
            raise RepositoryError("changeset_revision must be 12 to 40 hexadecimal digits")
        return source
    if kind == "github":
        repository = str(value.get("repository") or "")
        owner, _, name = repository.partition("/")
        if not _NAME.match(owner) or not _NAME.match(name):
            raise RepositoryError("repository must be <owner>/<name>")
        ref = str(value.get("ref") or "").lower()
        if not _COMMIT.match(ref):
            raise RepositoryError("ref must be a full commit SHA")
        return {"type": "github", "repository": repository, "ref": ref, "path": normalize_path(value.get("path"))}
    raise RepositoryError(f"Unknown install source type {kind!r}")


def normalize_path(value: Any) -> str:
    """A relative directory inside the repository, "" for its root."""
    text = str(value or "").strip().strip("/")
    if not text:
        return ""
    normalized = posixpath.normpath(text)
    parts = PurePosixPath(normalized).parts
    if normalized.startswith("/") or ".." in parts or any(part.startswith(".") for part in parts) or "\0" in text:
        raise RepositoryError(f"Path {value!r} is not a directory inside the repository")
    return normalized


def toolshed_clone_url(source: dict[str, Any]) -> str:
    """What ``hg clone`` reads: the repository's page on the Tool Shed, which speaks the hg wire protocol."""
    return f"{source['tool_shed_url']}/repos/{source['owner']}/{source['name']}"


def codeload_url(source: dict[str, Any]) -> str:
    return f"{CODELOAD_BASE}/{source['repository']}/tar.gz/{source['ref']}"


def fetch(source: dict[str, Any], work: Path, retry: RetryPolicy) -> Checkout:
    """Fetch and extract ``source`` (from :func:`parse_source`) below ``work``."""
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    if source["type"] == "toolshed":
        return _fetch_toolshed(source, work)
    return _fetch_github(source, work, retry)


# --- Tool Shed ----------------------------------------------------------------------------------------------


def hg_environment(home: Path) -> dict[str, str]:
    """Environment of ``hg``: no configuration files (an empty ``HGRCPATH``), plain output, nothing else."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "HGRCPATH": "",
        "HGPLAIN": "1",
        "HGENCODING": "utf-8",
    }


def _hg(args: list[str], home: Path, timeout: float = HG_TIMEOUT_SECONDS) -> str:
    command = [
        "hg",
        "--config",
        "subrepos.allowed=false",
        "--config",
        "ui.archivemeta=false",
        *args,
    ]
    try:
        completed = subprocess.run(
            command,
            env=hg_environment(home),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise RepositoryError(f"hg {args[0]} did not finish within {int(timeout)} seconds") from None
    except FileNotFoundError:
        raise RepositoryError("hg is not installed in this image") from None
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise RepositoryError(redact(f"hg {args[0]} failed: {' '.join(detail[-3:])}"[:MAX_ERROR_CHARS]))
    return completed.stdout


def _fetch_toolshed(source: dict[str, Any], work: Path) -> Checkout:
    home = work / "home"
    home.mkdir()
    clone = work / "clone"
    revision = source["changeset_revision"]
    url = toolshed_clone_url(source)
    repository_url = f"{source['tool_shed_url']}/repos/{source['owner']}/{source['name']}"
    error: RepositoryError | None = None
    for attempt in range(CLONE_ATTEMPTS):
        if clone.exists():
            shutil.rmtree(clone)
        try:
            _hg(["clone", "--noupdate", "--rev", revision, "--", url, str(clone)], home)
            error = None
            break
        except RepositoryError as e:
            error = e
            if "unknown revision" in str(e).lower():
                break
            log.warning("Cloning %s failed (attempt %d): %s", repository_url, attempt + 1, e)
    if error is not None:
        raise RepositoryError(f"Cloning {repository_url} at {revision} failed. {error}")
    node = _hg(["--repository", str(clone), "log", "--rev", revision, "--template", "{node}"], home).strip()
    if not _COMMIT.match(node) or not node.startswith(revision):
        raise RepositoryError(f"The clone of {repository_url} has changeset {node!r}, not {revision}")
    archive = work / "repository.tar"
    _hg(
        ["--repository", str(clone), "archive", "--rev", node, "--type", "tar", "--prefix", "repository", str(archive)],
        home,
    )
    shutil.rmtree(clone)
    root = work / "repository"
    _, warnings = extract(archive, root)
    archive.unlink()
    host = source["tool_shed_url"].removeprefix("https://")
    return Checkout(
        repository_root=root,
        root=root,
        prefix="",
        repository_url=repository_url,
        revision=node,
        guid_prefix=f"{host}/repos/{source['owner']}/{source['name']}",
        tool_shed_repository={
            "name": source["name"],
            "owner": source["owner"],
            "changeset_revision": revision,
            "tool_shed": host,
        },
        warnings=tuple(warnings),
    )


# --- GitHub -------------------------------------------------------------------------------------------------


def download(
    url: str, destination: Path, retry: RetryPolicy, limit: int = MAX_ARCHIVE_BYTES, prefix: str | None = None
) -> int:
    """GET ``url`` into ``destination``, refusing more than ``limit`` bytes and, with ``prefix``, redirects to URLs
    that do not start with it (compared without case)."""

    scheme = urllib.parse.urlsplit(url).scheme

    def action() -> int:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        size = 0
        try:
            with urllib.request.urlopen(request, timeout=120) as response, open(destination, "wb") as out:
                final = response.geturl()
                if urllib.parse.urlsplit(final).scheme != scheme:
                    raise TransferError(f"GET {url} was redirected to another scheme", status=400)
                if prefix is not None and not final.lower().startswith(prefix.lower()):
                    raise TransferError(f"GET {url} was redirected to {redact(final)}", status=400)
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise TransferError(f"GET {url}: the archive is larger than {limit} bytes", status=413)
                    out.write(chunk)
        except urllib.error.HTTPError as e:
            raise TransferError(f"GET {url} failed with HTTP {e.code}", status=e.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise TransferError(f"GET {url} failed: {getattr(e, 'reason', e)}") from None
        return size

    return retry.run(action, f"download {url}")


def _fetch_github(source: dict[str, Any], work: Path, retry: RetryPolicy) -> Checkout:
    archive = work / "repository.tar.gz"
    url = codeload_url(source)
    owner, _, name = source["repository"].partition("/")
    try:
        download(url, archive, retry, prefix=f"{CODELOAD_BASE}/{owner}/{name}/")
    except TransferError as e:
        raise RepositoryError(str(e)) from None
    root = work / "repository"
    # codeload names the directory <repository>-<ref>.
    headers, warnings = extract(archive, root, expected_top=f"{name}-{source['ref']}")
    archive.unlink()
    if headers.get("comment") != source["ref"]:
        raise RepositoryError(
            f"The archive of {source['repository']} is for commit {headers.get('comment')!r}, not {source['ref']}"
        )
    prefix = source["path"]
    tools_root = root / prefix if prefix else root
    if not tools_root.is_dir() or tools_root.is_symlink():
        raise RepositoryError(f"{source['repository']} has no directory {prefix!r} at {source['ref']}")
    return Checkout(
        repository_root=root,
        root=tools_root,
        prefix=prefix,
        repository_url=f"https://github.com/{source['repository']}",
        revision=source["ref"],
        guid_prefix=f"github.com/repos/{owner}/{name}",
        tool_shed_repository=None,
        warnings=tuple(warnings),
    )


# --- archives -----------------------------------------------------------------------------------------------


def excluded(relative: str) -> bool:
    return any(part in EXCLUDED_NAMES for part in PurePosixPath(relative).parts)


def extract(
    archive: Path,
    destination: Path,
    max_bytes: int = MAX_EXTRACTED_BYTES,
    max_members: int = MAX_MEMBERS,
    expected_top: str | None = None,
) -> tuple[dict[str, str], list[str]]:
    """Extract a tar with one top-level directory into ``destination``, without that directory.

    With ``expected_top``, that directory must have this name (compared without case). Returns the archive's global pax
    headers and warnings for members left out: hard links, special files and links the ``data`` filter refuses.
    """
    destination.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []
    top: str | None = None
    total = 0
    count = 0
    try:
        with tarfile.open(archive, mode="r|*") as tar:
            headers = dict(tar.pax_headers)
            for member in tar:
                parts = PurePosixPath(posixpath.normpath(member.name)).parts
                if not parts or parts == (".",):
                    continue
                if top is None:
                    if expected_top is not None and parts[0].lower() != expected_top.lower():
                        raise RepositoryError(f"The repository archive is in {parts[0]!r}, not in {expected_top!r}")
                    top = parts[0]
                if parts[0] != top or parts[0] in ("/", ".."):
                    raise RepositoryError("The repository archive does not have a single top-level directory")
                relative = "/".join(parts[1:])
                if not relative or excluded(relative):
                    continue
                if not (member.isfile() or member.isdir() or member.issym()):
                    warnings.append(f"Left out {relative}: only files, directories and symbolic links are kept")
                    continue
                count += 1
                total += member.size if member.isfile() else 0
                if count > max_members:
                    raise RepositoryError(f"The repository has more than {max_members} files")
                if total > max_bytes:
                    raise RepositoryError(f"The repository is larger than {max_bytes} bytes without test data")
                renamed = member.replace(name=relative, deep=False)
                try:
                    if member.isdir():
                        # Created writable, whatever mode the archive gives, so its files can be extracted.
                        tarfile.data_filter(renamed, str(destination))
                        (destination / relative).mkdir(parents=True, exist_ok=True)
                    else:
                        tar.extract(renamed, destination, filter="data")
                except tarfile.FilterError as e:
                    warnings.append(f"Left out {relative}: {e}")
    except (tarfile.TarError, EOFError, OSError) as e:
        raise RepositoryError(f"The repository archive cannot be read: {e}") from None
    if top is None:
        raise RepositoryError("The repository archive is empty")
    return headers, warnings
