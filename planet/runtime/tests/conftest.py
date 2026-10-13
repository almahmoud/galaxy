import base64
import hashlib
import json
import os
import subprocess
import threading
import uuid
from http.server import (
    BaseHTTPRequestHandler,
    ThreadingHTTPServer,
)
from pathlib import Path
from typing import Any

import pytest

from planet_runtime.layout import Layout
from planet_runtime.transfer import (
    RetryPolicy,
    Transfers,
)

SCHEMAS = Path(os.environ.get("PLANET_SCHEMAS", Path(__file__).parents[1] / "schemas"))


class FakeS3:
    """Minimal presigned-URL object store: GET and PUT by path, query string ignored."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.headers: dict[str, dict[str, str]] = {}
        self.failures: dict[str, int] = {}
        self.requests: list[tuple[str, str]] = []
        store = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _key(self) -> str:
                return self.path.split("?", 1)[0].lstrip("/")

            def _fail(self) -> bool:
                key = self._key()
                if store.failures.get(key, 0) > 0:
                    store.failures[key] -= 1
                    self.send_response(503)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return True
                return False

            def do_GET(self):
                store.requests.append(("GET", self._key()))
                if self._fail():
                    return
                body = store.objects.get(self._key())
                if body is None:
                    payload = b"<Error><Code>NoSuchKey</Code></Error>"
                    self.send_response(404)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_PUT(self):
                store.requests.append(("PUT", self._key()))
                if "Transfer-Encoding" in self.headers or "Content-Length" not in self.headers:
                    self.send_response(411)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = self.rfile.read(int(self.headers["Content-Length"]))
                if self._fail():
                    return
                if md5 := self.headers.get("Content-MD5"):
                    if base64.b64encode(hashlib.md5(body).digest()).decode() != md5:
                        self.send_response(400)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                store.objects[self._key()] = body
                store.headers[self._key()] = dict(self.headers)
                self.send_response(200)
                self.send_header("ETag", f'"{hashlib.md5(body).hexdigest()}"')
                self.send_header("Content-Length", "0")
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def url(self, key: str) -> str:
        return f"{self.base}/bucket/{key}?X-Amz-Signature=test"

    def request(self, key: str) -> dict[str, Any]:
        return {"url": self.url(key)}

    def get(self, key: str) -> bytes:
        return self.objects[f"bucket/{key}"]

    def has(self, key: str) -> bool:
        return f"bucket/{key}" in self.objects

    def put(self, key: str, body: bytes) -> None:
        self.objects[f"bucket/{key}"] = body

    def json(self, key: str) -> Any:
        return json.loads(self.get(key))


@pytest.fixture
def s3():
    store = FakeS3()
    store.thread.start()
    yield store
    store.server.shutdown()


@pytest.fixture
def layout(tmp_path, monkeypatch) -> Layout:
    root = tmp_path / "planet"
    root.mkdir()
    monkeypatch.setenv("PLANET_ROOT", str(root))
    monkeypatch.setenv("PLANET_TERMINATION_LOG", str(tmp_path / "termination-log"))
    monkeypatch.setenv("HOME", str(tmp_path))
    return Layout(root)


@pytest.fixture
def transfers() -> Transfers:
    return Transfers(RetryPolicy(max_elapsed=5.0, base_delay=0.01, max_delay=0.05), timeout=10.0)


def new_uuid() -> str:
    return str(uuid.uuid4())


def dataset_targets(
    s3: FakeS3, uuid_: str, metadata_files: int = 2, multipart_parts: int = 0, extra_objects: int = 0
) -> dict[str, Any]:
    targets: dict[str, Any] = {
        "uuid": uuid_,
        "data": {"put": s3.request(f"datasets/{uuid_}/data")},
        "meta": s3.request(f"datasets/{uuid_}/meta.json"),
        "extra": s3.request(f"datasets/{uuid_}/extra.tar"),
        "extra_index": s3.request(f"datasets/{uuid_}/extra.json"),
        "sanitized": s3.request(f"datasets/{uuid_}/sanitized.html"),
        "metadata_files": [s3.request(f"datasets/{uuid_}/meta/{i}") for i in range(metadata_files)],
    }
    if extra_objects:
        targets["extra_objects"] = [
            {"key": f"datasets/{uuid_}/extra/{i}", "request": s3.request(f"datasets/{uuid_}/extra/{i}")}
            for i in range(extra_objects)
        ]
    if multipart_parts:
        targets["data"]["multipart"] = {
            "parts": [s3.request(f"datasets/{uuid_}/parts/{i + 1}") for i in range(multipart_parts)]
        }
    return targets


def job_files(s3: FakeS3, job_id: str) -> dict[str, Any]:
    return {
        "prepare": s3.request(f"jobs/{job_id}/prepare.json"),
        "results": s3.request(f"jobs/{job_id}/results.json"),
        "stdout": s3.request(f"jobs/{job_id}/stdout"),
        "stderr": s3.request(f"jobs/{job_id}/stderr"),
    }


def write_manifest(tmp_path: Path, manifest: dict[str, Any], monkeypatch) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    monkeypatch.setenv("PLANET_MANIFEST_FILE", str(path))
    monkeypatch.delenv("PLANET_MANIFEST_URL", raising=False)
    return path


def run_tool_container(layout: Layout, id_tag: str, shell: str = "/bin/sh") -> int:
    """Stand-in for the tool container: holds the FIFO, runs the job script, records rc."""
    script = (
        f'exec 9<>"{layout.alive}"; : > "{layout.started}"; '
        f'{shell} "{layout.job_script(id_tag)}"; echo $? > "{layout.rc}"'
    )
    subprocess.run(["/bin/sh", "-c", script], cwd=layout.root, timeout=120, check=True)
    return int(layout.rc.read_text())


def schema(name: str) -> dict[str, Any]:
    return json.loads((SCHEMAS / f"{name}.schema.json").read_text())


def validate(document: Any, name: str) -> None:
    import jsonschema

    validator_class = jsonschema.validators.validator_for(schema(name))
    validator = validator_class(schema(name), registry=_registry())
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.path))
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors[:10])


def _registry():
    from referencing import (
        Registry,
        Resource,
    )

    resources = []
    for path in SCHEMAS.glob("*.schema.json"):
        contents = json.loads(path.read_text())
        resources.append((contents["$id"], Resource.from_contents(contents)))
    return Registry().with_resources(resources)


def parse_tool(xml: str, tmp_path: Path) -> dict[str, Any]:
    """Tool fields of a manifest, produced by Galaxy's tool parser like the bundle generator does."""
    from galaxy.tool_util.parser import get_tool_source

    path = tmp_path / "tool.xml"
    path.write_text(xml)
    source = get_tool_source(str(path))
    outputs, collections = source.parse_outputs(None)
    exit_codes, regexes = source.parse_stdio()
    return {
        "id": source.parse_id(),
        "name": source.parse_name(),
        "version": source.parse_version(),
        "profile": source.parse_profile(),
        "command": source.parse_command(),
        "outputs": {name: output.to_dict() for name, output in {**outputs, **collections}.items()},
        "stdio": {"exit_codes": [c.to_dict() for c in exit_codes], "regexes": [r.to_dict() for r in regexes]},
        "home_target": source.parse_home_target(),
        "tmp_directory_vars": source.parse_tmp_directory_vars(),
    }


def write_bam(path: Path) -> None:
    import pysam

    header = {"HD": {"VN": "1.6", "SO": "coordinate"}, "SQ": [{"SN": "chr1", "LN": 1000}]}
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i in range(3):
            segment = pysam.AlignedSegment()
            segment.query_name = f"read{i}"
            segment.query_sequence = "ACGT" * 5
            segment.flag = 0
            segment.reference_id = 0
            segment.reference_start = 10 * i
            segment.mapping_quality = 60
            segment.cigartuples = [(0, 20)]
            segment.query_qualities = pysam.qualitystring_to_array("I" * 20)
            out.write(segment)
