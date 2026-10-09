import json

import pytest

from planet_runtime.generate.github import (
    git_blob_sha,
    GitHubError,
    GitHubRepository,
)

COMMIT = "a" * 40


class FakeGitHub(GitHubRepository):
    """Serves an in-memory repository: trees by sha, blobs by path."""

    def __init__(self, tmp_path, trees, blobs, tamper=False):
        super().__init__("owner/repo", COMMIT, tmp_path / "cache")
        self.fake_trees = trees
        self.fake_blobs = blobs
        self.tamper = tamper
        self.requests: list[str] = []

    def _get(self, url, api):
        self.requests.append(url)
        if api:
            return json.dumps(self.fake_trees[url.rsplit("/", 1)[1]]).encode()
        path = url.split(f"/{COMMIT}/", 1)[1]
        content = self.fake_blobs[path]
        return content + b"x" if self.tamper else content


def _repo(tmp_path, tamper=False):
    files = {
        "tools/t/tool.xml": b"<tool/>",
        "tools/t/run.sh": b"#!/bin/sh\n",
        "tools/t/macros.xml": b"../macros.xml",
        "tools/t/test-data/big.txt": b"data",
        "tools/macros.xml": b"<macros/>",
    }
    sha = {path: git_blob_sha(content) for path, content in files.items()}
    trees = {
        COMMIT: {"sha": "root", "tree": [{"path": "tools", "mode": "040000", "type": "tree", "sha": "tools"}]},
        "tools": {
            "sha": "tools",
            "tree": [
                {"path": "t", "mode": "040000", "type": "tree", "sha": "t"},
                {"path": "macros.xml", "mode": "100644", "type": "blob", "sha": sha["tools/macros.xml"]},
            ],
        },
        "t": {
            "sha": "t",
            "tree": [
                {"path": "tool.xml", "mode": "100644", "type": "blob", "sha": sha["tools/t/tool.xml"]},
                {"path": "run.sh", "mode": "100755", "type": "blob", "sha": sha["tools/t/run.sh"]},
                {"path": "macros.xml", "mode": "120000", "type": "blob", "sha": sha["tools/t/macros.xml"]},
                {"path": "test-data", "mode": "040000", "type": "tree", "sha": "td"},
            ],
        },
    }
    return FakeGitHub(tmp_path, trees, files, tamper)


def test_read_directory_dereferences_links_and_excludes(tmp_path):
    repo = _repo(tmp_path)
    files = repo.read_directory("tools/t", exclude=("test-data",))
    assert sorted(files) == ["macros.xml", "run.sh", "tool.xml"]
    assert files["macros.xml"].content == b"<macros/>"
    assert files["run.sh"].executable is True
    assert files["tool.xml"].executable is False


def test_cache_avoids_second_download(tmp_path):
    _repo(tmp_path).read_directory("tools/t", exclude=("test-data",))
    second = _repo(tmp_path)
    second.read_directory("tools/t", exclude=("test-data",))
    assert second.requests == []


def test_content_must_match_blob_sha(tmp_path):
    with pytest.raises(GitHubError, match="does not match"):
        _repo(tmp_path, tamper=True).read_file("tools/t/tool.xml")


@pytest.mark.parametrize("path", ["../etc/passwd", "/", "tools/../../x"])
def test_paths_outside_repository_are_refused(tmp_path, path):
    with pytest.raises(GitHubError):
        _repo(tmp_path).entry(path)


def test_rejects_non_sha_commit(tmp_path):
    with pytest.raises(ValueError):
        GitHubRepository("owner/repo", "main", tmp_path)
