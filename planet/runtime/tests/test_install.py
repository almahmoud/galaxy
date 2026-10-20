import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import threading
import urllib.request
from http.server import (
    BaseHTTPRequestHandler,
    ThreadingHTTPServer,
)
from pathlib import Path

import pytest
from conftest import (
    validate,
    write_manifest,
)
from galaxy.util import galaxy_directory

from planet_runtime import (
    install,
    install_worker,
    repositories,
)

DEMO = Path(__file__).parent / "data" / "install" / "demo"
BUNDLE_SCHEMA = Path(galaxy_directory()) / "planet" / "toolbox" / "tool-bundle.schema.json"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
SECTION = {"id": "planet_installed", "name": "Installed tools"}


def hg(*args: str, cwd: Path) -> str:
    environment = repositories.hg_environment(cwd.parent)
    environment["HGUSER"] = "Planet Tests <tests@example.org>"
    return subprocess.run(["hg", *args], cwd=cwd, env=environment, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def toolshed_repository(tmp_path, monkeypatch):
    """The demo repository as an hg repository with two changesets; the second raises concat_demo to 1.1."""
    path = tmp_path / "hg-demo"
    shutil.copytree(DEMO, path)
    (path / "concat.sh").chmod(0o755)
    hg("init", cwd=path)
    hg("add", "--quiet", cwd=path)
    hg("commit", "--date", "0 0", "--message", "First", cwd=path)
    first = hg("log", "--rev", "tip", "--template", "{node}", cwd=path)
    macros = path / "macros.xml"
    macros.write_text(macros.read_text().replace(">1.0<", ">1.1<"))
    hg("commit", "--date", "1 0", "--message", "Second", cwd=path)
    monkeypatch.setattr(repositories, "toolshed_clone_url", lambda source: str(path))
    return first


def toolshed_source(revision: str) -> dict:
    return {
        "type": "toolshed",
        "tool_shed_url": "https://toolshed.g2.bx.psu.edu",
        "owner": "planet",
        "name": "demo",
        "changeset_revision": revision,
    }


def install_manifest(s3, source: dict, slots: int = 8, job_id: str = "a1b2c3d4e5f60718") -> dict:
    def keyed(name: str, n: int) -> dict:
        key = f"tools/installs/{job_id}/{n}/{name}"
        return {"key": key, "request": s3.request(key)}

    return {
        "protocol": 1,
        "kind": "tool_install",
        "job": {"id": job_id, "attempt": 1},
        "install": {
            "source": source,
            "panel_section": SECTION,
            "slots": [{"bundle": keyed("bundle.json", n), "repo_tar": keyed("repo.tar", n)} for n in range(slots)],
        },
        "job_files": {"results": s3.request(f"jobs/{job_id}/a1/results.json")},
        "user": {"email": "user@example.org", "username": "user"},
    }


def run_install(s3, layout, transfers, tmp_path, monkeypatch, manifest: dict) -> dict:
    validate(manifest, "manifest")
    write_manifest(tmp_path, manifest, monkeypatch)
    assert install.run(layout, transfers) == 0
    results = s3.json(f"jobs/{manifest['job']['id']}/a1/results.json")
    validate(results, "results")
    assert not (layout.root / "install").exists()
    return results


def tools_by_file(results: dict) -> dict:
    return {Path(entry["path"]).name: entry for entry in results["tools"]}


def archive_members(data: bytes) -> dict[str, tarfile.TarInfo]:
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        return {member.name: member for member in tar.getmembers()}


def test_toolshed_install_publishes_runnable_tools_and_explains_the_others(
    s3, layout, transfers, tmp_path, monkeypatch, toolshed_repository
):
    jsonschema = pytest.importorskip("jsonschema")
    revision = toolshed_repository[:12]
    manifest = install_manifest(s3, toolshed_source(revision))
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, manifest)

    assert results["state"] == "ok"
    assert results["install"]["revision"] == toolshed_repository
    assert results["install"]["repository_url"] == "https://toolshed.g2.bx.psu.edu/repos/planet/demo"
    tools = tools_by_file(results)
    assert sorted(tools) == ["app.xml", "broken.xml", "coded.xml", "concat.xml", "fetch_demo.xml", "reverse.xml"]
    assert {name: entry["state"] for name, entry in tools.items()} == {
        "app.xml": "rejected",
        "broken.xml": "failed",
        "coded.xml": "rejected",
        "concat.xml": "installed",
        "fetch_demo.xml": "rejected",
        "reverse.xml": "installed",
    }
    assert "Data managers are not supported" in tools["fetch_demo.xml"]["errors"][0]
    assert "code file hooks.py" in tools["coded.xml"]["errors"][0]
    assert "$__app__" in tools["app.xml"]["errors"][0]
    assert "newer than" in tools["broken.xml"]["errors"][0]

    concat = tools["concat.xml"]
    # The second changeset raised the version; the requested one is installed.
    assert concat["id"] == "toolshed.g2.bx.psu.edu/repos/planet/demo/concat_demo/1.0+galaxy0"
    assert (concat["slot"], tools["reverse.xml"]["slot"]) == (0, 1)
    bundle_bytes = s3.get("tools/installs/a1b2c3d4e5f60718/0/bundle.json")
    archive = s3.get("tools/installs/a1b2c3d4e5f60718/0/repo.tar")
    assert concat["bundle"]["size"] == len(bundle_bytes)
    assert concat["repo_tar"]["size"] == len(archive)
    assert concat["bundle"]["sha256"] == hashlib.sha256(bundle_bytes).hexdigest()
    bundle = json.loads(bundle_bytes)
    assert not list(jsonschema.Draft202012Validator(json.loads(BUNDLE_SCHEMA.read_text())).iter_errors(bundle))
    assert bundle["old_id"] == "concat_demo" and bundle["version"] == "1.0+galaxy0"
    assert [(item["name"], item["version"]) for item in bundle["requirements"]] == [("coreutils", "9.5")]
    assert bundle["tool_shed_repository"] == {
        "name": "demo",
        "owner": "planet",
        "changeset_revision": revision,
        "tool_shed": "toolshed.g2.bx.psu.edu",
    }
    assert bundle["source"] == {
        "repository": "https://toolshed.g2.bx.psu.edu/repos/planet/demo",
        "commit": toolshed_repository,
        "path": "concat.xml",
        "tool_file": "concat.xml",
        "repo_tar": {
            "path": "tools/installs/a1b2c3d4e5f60718/0/repo.tar",
            "sha256": hashlib.sha256(archive).hexdigest(),
            "size": len(archive),
        },
    }
    assert bundle["panel_entry"]["panel_section_id"] == "planet_installed"
    assert bundle["panel_entry"]["panel_section_name"] == "Installed tools"
    assert bundle["panel_entry"]["tool_shed_repository"]["owner"] == "planet"
    assert bundle["data_tables"][0]["name"] == "demo_genomes"
    assert bundle["data_tables"][0]["files"][0]["entries"] == [["hg38", "Human (hg38)", "/data/hg38.fa"]]
    members = archive_members(archive)
    assert "concat.sh" in members and members["concat.sh"].mode == 0o755
    assert "macros.xml" in members and "sub/reverse.xml" in members
    assert not [name for name in members if "test-data" in name or name.startswith(".hg")]

    reverse = json.loads(s3.get("tools/installs/a1b2c3d4e5f60718/1/bundle.json"))
    assert reverse["tool_dir"] == "sub" and reverse["source"]["path"] == "sub/reverse.xml"
    assert reverse["containers"][0]["identifier"] == "busybox:1.37"
    assert set(archive_members(s3.get("tools/installs/a1b2c3d4e5f60718/1/repo.tar"))) == {"reverse.xml"}
    assert not s3.has("tools/installs/a1b2c3d4e5f60718/2/bundle.json")

    messages = [message["desc"] for message in results["job_messages"]]
    assert any(message.startswith("data_manager/fetch_demo.xml: Data managers") for message in messages)
    assert "Installed concat_demo 1.0+galaxy0 from concat.xml" in results["job_stdout"]["text"]
    assert "Not installed: coded_demo 1.0 from coded.xml" in results["job_stdout"]["text"]


def test_unknown_changeset_fails_the_job(s3, layout, transfers, tmp_path, monkeypatch, toolshed_repository):
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, toolshed_source("f" * 12)))
    assert results["state"] == "error"
    assert results["tools"] == []
    assert "unknown revision" in results["errors"][0].lower()
    assert results["job_messages"][-1]["desc"] == results["errors"][0]
    assert not [key for key in s3.objects if "/tools/installs/" in key]


def test_tools_beyond_the_slots_are_not_installed(s3, layout, transfers, tmp_path, monkeypatch, toolshed_repository):
    manifest = install_manifest(s3, toolshed_source(toolshed_repository), slots=1)
    tools = tools_by_file(run_install(s3, layout, transfers, tmp_path, monkeypatch, manifest))
    assert tools["concat.xml"]["state"] == "installed"
    assert tools["reverse.xml"]["state"] == "failed"
    assert tools["reverse.xml"]["errors"] == ["The installation has room for 1 tools."]


def github_archive(files: dict[str, bytes], commit: str = COMMIT, top: str = f"demo-{COMMIT}") -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": commit}) as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(content)
            info.mode = 0o755 if name.endswith(".sh") else 0o644
            tar.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def demo_files(prefix: str) -> dict[str, bytes]:
    return {
        f"{prefix}{path.relative_to(DEMO).as_posix()}": path.read_bytes()
        for path in sorted(DEMO.rglob("*"))
        if path.is_file()
    }


@pytest.fixture
def codeload(s3, monkeypatch):
    monkeypatch.setattr(repositories, "CODELOAD_BASE", f"{s3.base}/bucket/codeload")

    def publish(archive: bytes, repository: str = "planet/demo", commit: str = COMMIT) -> None:
        s3.put(f"codeload/{repository}/tar.gz/{commit}", archive)

    return publish


def github_source(path: str = "tools/demo", ref: str = COMMIT) -> dict:
    return {"type": "github", "repository": "planet/demo", "ref": ref, "path": path}


def test_github_install_reads_the_requested_directory(s3, layout, transfers, tmp_path, monkeypatch, codeload):
    codeload(github_archive({**demo_files("tools/demo/"), "tools/other/other.xml": (DEMO / "coded.xml").read_bytes()}))
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source()))
    assert results["state"] == "ok"
    assert results["install"]["repository_url"] == "https://github.com/planet/demo"
    tools = tools_by_file(results)
    assert "other.xml" not in tools
    assert tools["concat.xml"]["path"] == "tools/demo/concat.xml"
    assert tools["concat.xml"]["id"] == "github.com/repos/planet/demo/concat_demo/1.0+galaxy0"
    bundle = s3.json("tools/installs/a1b2c3d4e5f60718/0/bundle.json")
    assert bundle["tool_shed_repository"] is None
    assert bundle["source"]["commit"] == COMMIT and bundle["tool_dir"] == "tools/demo"
    assert "concat.sh" in archive_members(s3.get("tools/installs/a1b2c3d4e5f60718/0/repo.tar"))


def test_github_archive_of_another_commit_is_refused(s3, layout, transfers, tmp_path, monkeypatch, codeload):
    codeload(github_archive(demo_files("tools/demo/"), commit="f" * 40))
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source()))
    assert results["state"] == "error"
    assert "is for commit 'ffff" in results["errors"][0]


def test_github_archive_must_be_the_named_repositorys(s3, layout, transfers, tmp_path, monkeypatch, codeload):
    # codeload names the top-level directory after the repository it serves.
    codeload(github_archive(demo_files("tools/demo/"), top=f"other-{COMMIT}"))
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source()))
    assert results["state"] == "error"
    assert f"is in 'other-{COMMIT}', not in 'demo-{COMMIT}'" in results["errors"][0]
    codeload(github_archive(demo_files("tools/demo/"), top=f"Demo-{COMMIT}"))
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source()))
    assert results["state"] == "ok"


@pytest.fixture
def redirecting_codeload(monkeypatch):
    """A codeload that redirects planet/demo to someone/demo, which serves the demo archive."""
    archive = github_archive(demo_files("tools/demo/"))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path.startswith("/planet/demo/"):
                self.send_response(302)
                self.send_header("Location", self.path.replace("/planet/demo/", "/someone/demo/", 1))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(archive)))
            self.end_headers()
            self.wfile.write(archive)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(repositories, "CODELOAD_BASE", f"http://127.0.0.1:{server.server_address[1]}")
    yield
    server.shutdown()


def test_github_redirects_to_another_repository_are_refused(
    s3, layout, transfers, tmp_path, monkeypatch, redirecting_codeload
):
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source()))
    assert results["state"] == "error"
    assert "was redirected to http://127.0.0.1:" in results["errors"][0]
    assert "/someone/demo/tar.gz/" in results["errors"][0]


def test_github_missing_commit_or_directory(s3, layout, transfers, tmp_path, monkeypatch, codeload):
    missing = run_install(
        s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source(ref="e" * 40))
    )
    assert missing["state"] == "error" and "HTTP 404" in missing["errors"][0]
    codeload(github_archive(demo_files("tools/demo/")))
    no_directory = run_install(
        s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source(path="tools/absent"))
    )
    assert no_directory["state"] == "error" and "has no directory 'tools/absent'" in no_directory["errors"][0]


def test_macro_imports_must_stay_inside_the_repository(s3, layout, transfers, tmp_path, monkeypatch, codeload):
    escaping = (DEMO / "sub" / "reverse.xml").read_text().replace("../macros.xml", "../../../../etc/macros.xml")
    codeload(github_archive({"tools/demo/reverse.xml": escaping.encode()}))
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, github_source()))
    (entry,) = results["tools"]
    assert entry["state"] == "failed"
    assert entry["errors"] == ["It imports macros from ../../../../etc/macros.xml, outside the repository."]
    assert results["state"] == "error"


def test_worker_gets_no_manifest_location(s3, layout, transfers, tmp_path, monkeypatch, toolshed_repository):
    seen = {}
    real_run = subprocess.run

    def spy(command, **kwargs):
        if command[-1] == "planet_runtime.install_worker":
            seen.update(kwargs["env"])
            seen["command"] = command
            seen["cwd"] = sorted(Path(kwargs["cwd"]).iterdir())
        return real_run(command, **kwargs)

    manifest = install_manifest(s3, toolshed_source(toolshed_repository))
    monkeypatch.setattr(install.subprocess, "run", spy)
    monkeypatch.setattr(install.manifest_module, "load", lambda transfers: manifest)
    monkeypatch.setenv("PLANET_MANIFEST_URL", "https://bucket.example/manifest.json?X-Amz-Signature=abc")
    monkeypatch.setenv("PLANET_MANIFEST_FILE", str(tmp_path / "manifest.json"))
    assert install.run(layout, transfers) == 0
    assert s3.json(f"jobs/{manifest['job']['id']}/a1/results.json")["state"] == "ok"
    assert seen and "PLANET_MANIFEST_URL" not in seen and "PLANET_MANIFEST_FILE" not in seen
    assert seen["command"][1:3] == ["-I", "-B"] and seen["cwd"] == []
    hg_environment = repositories.hg_environment(tmp_path)
    assert hg_environment["HGRCPATH"] == "" and not [key for key in hg_environment if key.startswith("PLANET")]


def test_worker_does_not_import_modules_from_its_directory(layout, tmp_path):
    neutral = tmp_path / "neutral"
    neutral.mkdir()
    marker = tmp_path / "imported"
    (neutral / "json.py").write_text(f"open({str(marker)!r}, 'w').close()\nraise SystemExit('planted json imported')\n")
    with pytest.raises(install.InstallError, match="KeyError: 'repository_root'"):
        install.run_worker({}, layout, neutral)
    assert not marker.exists()


def test_only_the_browsers_tool_sheds_are_cloned():
    test_shed = {**toolshed_source("a" * 12), "tool_shed_url": "https://testtoolshed.g2.bx.psu.edu/"}
    assert repositories.parse_source(test_shed)["tool_shed_url"] == "https://testtoolshed.g2.bx.psu.edu"
    with pytest.raises(repositories.RepositoryError, match="can only be installed from"):
        repositories.parse_source({**toolshed_source("a" * 12), "tool_shed_url": "https://toolshed.example"})


@pytest.mark.parametrize(
    "source, message",
    [
        ({**toolshed_source("a" * 12), "tool_shed_url": "ssh://toolshed.g2.bx.psu.edu"}, "must be https"),
        ({**toolshed_source("a" * 12), "tool_shed_url": "http://toolshed.g2.bx.psu.edu"}, "must be https"),
        ({**toolshed_source("a" * 12), "tool_shed_url": "https://user:pw@toolshed.example"}, "must be https"),
        ({**toolshed_source("a" * 12), "tool_shed_url": "https://toolshed.example/x?y"}, "must be https"),
        ({**toolshed_source("a" * 12), "owner": "a/b"}, "valid owner"),
        (toolshed_source("tip"), "hexadecimal"),
        ({**github_source(), "ref": "main"}, "full commit SHA"),
        ({**github_source(), "repository": "planet"}, "<owner>/<name>"),
        ({**github_source(), "path": "tools/../.."}, "not a directory inside"),
        ({**github_source(), "path": ".github"}, "not a directory inside"),
        ({"type": "svn"}, "Unknown install source"),
    ],
)
def test_sources_are_checked(source, message):
    with pytest.raises(repositories.RepositoryError, match=message):
        repositories.parse_source(source)


def test_extract_keeps_regular_members_inside_the_destination(tmp_path):
    archive = tmp_path / "a.tar"
    with tarfile.open(archive, "w") as tar:
        for name, kind, target in [
            ("top/ok.txt", tarfile.REGTYPE, ""),
            ("top/test-data/big.bin", tarfile.REGTYPE, ""),
            ("top/.hg/store", tarfile.REGTYPE, ""),
            ("top/abs", tarfile.SYMTYPE, "/etc/passwd"),
            ("top/up", tarfile.SYMTYPE, "../../outside"),
            ("top/in", tarfile.SYMTYPE, "ok.txt"),
            ("top/fifo", tarfile.FIFOTYPE, ""),
        ]:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.linkname = target
            data = b"x" if kind == tarfile.REGTYPE else b""
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    destination = tmp_path / "out"
    _, warnings = repositories.extract(archive, destination)
    assert sorted(p.name for p in destination.iterdir()) == ["in", "ok.txt"]
    assert (destination / "in").is_symlink()
    assert len(warnings) == 3 and all(w.startswith("Left out ") for w in warnings)


def test_extract_limits(tmp_path):
    archive = tmp_path / "a.tar"
    with tarfile.open(archive, "w") as tar:
        for name in ("top/a", "top/b", "other/c"):
            info = tarfile.TarInfo(name)
            info.size = 4
            tar.addfile(info, io.BytesIO(b"1234"))
    with pytest.raises(repositories.RepositoryError, match="larger than 6 bytes"):
        repositories.extract(archive, tmp_path / "1", max_bytes=6)
    with pytest.raises(repositories.RepositoryError, match="more than 1 files"):
        repositories.extract(archive, tmp_path / "2", max_members=1)
    with pytest.raises(repositories.RepositoryError, match="single top-level directory"):
        repositories.extract(archive, tmp_path / "3")


def test_directory_files_leave_out_links_out_of_the_repository(tmp_path):
    repository = tmp_path / "repository"
    (repository / "tool" / "test-data").mkdir(parents=True)
    (repository / "shared").mkdir()
    (repository / "shared" / "lib.sh").write_text("echo")
    (repository / "tool" / "run.sh").write_text("echo")
    (repository / "tool" / "test-data" / "x").write_text("x")
    (repository / "tool" / "lib").symlink_to("../shared")
    (repository / "tool" / "loop").symlink_to(".")
    (repository / "tool" / "passwd").symlink_to("/etc/passwd")
    files, left_out = install_worker.directory_files(
        repository / "tool", repository.resolve(), repositories.EXCLUDED_NAMES
    )
    assert "run.sh" in files and "lib/lib.sh" in files and "passwd" not in files
    assert not [name for name in files if "test-data" in name]
    assert sorted(left_out) == ["loop", "passwd"]


def test_unsupported_tools():
    def bundle(**fields):
        return {"tool_type": "default", "code": [], "inputs": [], "command": {"text": "cat $x"}, **fields}

    assert install_worker.unsupported(bundle()) == []
    assert "Interactive tools" in install_worker.unsupported(bundle(tool_type="interactive"))[0]
    assert "type expression" in install_worker.unsupported(bundle(tool_type="expression"))[0]
    nested = [
        {
            "name": "c",
            "test_param": {"name": "t"},
            "cases": [{"value": "a", "inputs": [{"name": "s", "dynamic_options": "load(x)"}]}],
        }
    ]
    assert install_worker.unsupported(bundle(inputs=nested)) == [
        "It needs Galaxy's Python environment to compute the options of parameter c|s."
    ]
    assert install_worker.unsupported(bundle(environment_variables=[{"name": "X", "template": "$__app__.x"}]))


@pytest.mark.skipif(
    not os.environ.get("PLANET_NETWORK_TESTS"), reason="set PLANET_NETWORK_TESTS=1 to reach the Tool Shed"
)
def test_install_from_the_main_tool_shed(s3, layout, transfers, tmp_path, monkeypatch):
    api = (
        "https://toolshed.g2.bx.psu.edu/api/repositories/get_ordered_installable_revisions?owner=iuc&name=datamash_ops"
    )
    with urllib.request.urlopen(api, timeout=60) as response:
        revision = json.load(response)[-1]
    source = {**toolshed_source(revision), "owner": "iuc", "name": "datamash_ops"}
    results = run_install(s3, layout, transfers, tmp_path, monkeypatch, install_manifest(s3, source))
    assert results["state"] == "ok"
    assert any(entry["old_id"] == "datamash_ops" for entry in results["tools"] if entry["state"] == "installed")


def test_streams_are_shortened_like_galaxy():
    record = install.stream("x" * 100_000)
    assert record["size"] == 100_000
    assert len(record["text"]) <= 32 * 1024 + 10
