"""Read files of a GitHub repository at a fixed commit.

Trees come from the GitHub REST API and file contents from raw.githubusercontent.com.
Both are cached on disk by git object id, and every downloaded blob is checked against
its git object id, so a cache or a download can only ever hold the pinned content.
Symbolic links are dereferenced, which matches how planemo uploads repositories to the
Tool Shed.
"""

import hashlib
import json
import logging
import os
import posixpath
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

API_BASE = "https://api.github.com"
RAW_BASE = "https://raw.githubusercontent.com"
USER_AGENT = "planet-generate"
SYMLINK_MODE = "120000"
MAX_SYMLINK_DEPTH = 8


class GitHubError(Exception):
    pass


@dataclass(frozen=True)
class TreeEntry:
    path: str
    mode: str
    type: str
    sha: str


@dataclass(frozen=True)
class RepositoryFile:
    content: bytes
    executable: bool


def git_blob_sha(content: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()


class GitHubRepository:
    def __init__(self, repository: str, commit: str, cache_dir: str | os.PathLike, timeout: float = 60.0):
        if repository.count("/") != 1 or not all(repository.split("/")):
            raise ValueError(f"Expected owner/name, got {repository!r}")
        if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
            raise ValueError(f"Expected a full commit SHA, got {commit!r}")
        self.repository = repository
        self.commit = commit
        self.cache_dir = Path(cache_dir)
        self.timeout = timeout
        self._trees: dict[str, list[TreeEntry]] = {}
        # Optional, for higher API rate limits in CI. Sent only to api.github.com.
        self._token = os.environ.get("GITHUB_TOKEN")

    # --- HTTP -------------------------------------------------------------------------

    def _get(self, url: str, api: bool) -> bytes:
        headers = {"User-Agent": USER_AGENT}
        if api:
            headers["Accept"] = "application/vnd.github+json"
            headers["X-GitHub-Api-Version"] = "2022-11-28"
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
        delay = 2.0
        for attempt in range(5):
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return response.read()
            except urllib.error.HTTPError as e:
                retryable = e.code in (429, 500, 502, 503, 504) or (
                    e.code == 403 and e.headers.get("x-ratelimit-remaining") == "0"
                )
                if not retryable or attempt == 4:
                    raise GitHubError(f"GET {url} failed with HTTP {e.code}") from None
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 4:
                    raise GitHubError(f"GET {url} failed: {e}") from None
            log.debug("Retrying %s in %.0f s", url, delay)
            time.sleep(delay)
            delay *= 2
        raise AssertionError("unreachable")

    # --- trees ------------------------------------------------------------------------

    def _tree(self, tree_sha: str) -> list[TreeEntry]:
        if tree_sha in self._trees:
            return self._trees[tree_sha]
        cache_file = self.cache_dir / "trees" / f"{tree_sha}.json"
        if cache_file.exists():
            raw = json.loads(cache_file.read_text())
        else:
            owner, name = self.repository.split("/")
            url = f"{API_BASE}/repos/{owner}/{name}/git/trees/{tree_sha}"
            raw = json.loads(self._get(url, api=True))
            if raw.get("truncated"):
                raise GitHubError(f"Tree {tree_sha} listing is truncated")
            if raw.get("sha") != tree_sha and tree_sha != self.commit:
                raise GitHubError(f"Tree {tree_sha} answered with {raw.get('sha')}")
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(raw))
        entries = [TreeEntry(e["path"], e["mode"], e["type"], e["sha"]) for e in raw["tree"]]
        self._trees[tree_sha] = entries
        return entries

    def entry(self, path: str) -> TreeEntry:
        """Return the tree entry for ``path`` (relative to the repository root)."""
        path = _normalize(path)
        current = TreeEntry("", "040000", "tree", self.commit)
        walked: list[str] = []
        for segment in path.split("/"):
            if current.type != "tree":
                raise GitHubError(f"{'/'.join(walked)} is not a directory")
            match = next((e for e in self._tree(current.sha) if e.path == segment), None)
            if match is None:
                raise GitHubError(f"{path} not found in {self.repository}@{self.commit}")
            walked.append(segment)
            current = TreeEntry("/".join(walked), match.mode, match.type, match.sha)
        return current

    def list_directory(self, path: str) -> list[TreeEntry]:
        directory = self.entry(path)
        if directory.type != "tree":
            raise GitHubError(f"{path} is not a directory")
        return [TreeEntry(f"{directory.path}/{e.path}", e.mode, e.type, e.sha) for e in self._tree(directory.sha)]

    # --- blobs ------------------------------------------------------------------------

    def _blob(self, entry: TreeEntry) -> bytes:
        cache_file = self.cache_dir / "blobs" / entry.sha[:2] / entry.sha
        if cache_file.exists():
            content = cache_file.read_bytes()
            if git_blob_sha(content) == entry.sha:
                return content
        quoted = urllib.parse.quote(entry.path)
        content = self._get(f"{RAW_BASE}/{self.repository}/{self.commit}/{quoted}", api=False)
        if git_blob_sha(content) != entry.sha:
            raise GitHubError(f"{entry.path}: content does not match blob {entry.sha}")
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_bytes(content)
        return content

    def resolve(self, path: str) -> TreeEntry:
        """Follow symbolic links until ``path`` names a file or directory."""
        entry = self.entry(path)
        for _ in range(MAX_SYMLINK_DEPTH):
            if entry.mode != SYMLINK_MODE:
                return entry
            target = self._blob(entry).decode("utf-8")
            entry = self.entry(posixpath.join(posixpath.dirname(entry.path), target))
        raise GitHubError(f"Too many symbolic links resolving {path}")

    def read_file(self, path: str) -> bytes:
        entry = self.resolve(path)
        if entry.type != "blob":
            raise GitHubError(f"{path} is not a file")
        return self._blob(entry)

    def read_directory(self, path: str, exclude: tuple[str, ...] = ()) -> dict[str, RepositoryFile]:
        """Return every file below ``path`` keyed by its path relative to ``path``.

        Names in ``exclude`` are skipped at any depth. Links to directories are followed.
        """
        files: dict[str, RepositoryFile] = {}

        def walk(directory: str, prefix: str, depth: int) -> None:
            if depth > MAX_SYMLINK_DEPTH:
                raise GitHubError(f"Directory nesting too deep at {directory}")
            for child in self.list_directory(directory):
                name = posixpath.basename(child.path)
                if name in exclude:
                    continue
                resolved = self.resolve(child.path)
                relative = f"{prefix}{name}"
                if resolved.type == "tree":
                    walk(resolved.path, f"{relative}/", depth + 1 if child.mode == SYMLINK_MODE else depth)
                elif resolved.type == "blob":
                    files[relative] = RepositoryFile(self._blob(resolved), resolved.mode == "100755")

        walk(_normalize(path), "", 0)
        return files


def _normalize(path: str) -> str:
    normalized = posixpath.normpath(path.strip("/"))
    if normalized in ("", ".") or normalized.startswith("../") or normalized == ".." or posixpath.isabs(normalized):
        raise GitHubError(f"Path {path!r} is outside the repository")
    return normalized
