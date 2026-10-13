import hashlib
import io
import json
import subprocess
import tarfile
import time

import pytest
from conftest import SCHEMAS

from planet_runtime import (
    results as results_module,
    stage_in,
    termination,
)
from planet_runtime.results import (
    DatasetTargets,
    DatasetUploader,
)
from planet_runtime.stage_in import prepare_layout
from planet_runtime.stage_out import (
    tool_exit,
    wait_for_tool,
)
from planet_runtime.transfer import (
    PresignedRequest,
    TransferError,
)


def test_put_retries_transient_errors_and_sends_length_and_md5(s3, transfers, tmp_path):
    path = tmp_path / "data"
    path.write_bytes(b"x" * 1000)
    s3.failures["bucket/k1"] = 2
    etag = transfers.put_file(PresignedRequest(s3.url("k1")), path)
    assert etag.strip('"') == hashlib.md5(b"x" * 1000).hexdigest()
    assert s3.get("k1") == b"x" * 1000
    headers = {key.lower(): value for key, value in s3.headers["bucket/k1"].items()}
    assert headers["content-length"] == "1000"
    assert "content-md5" in headers
    assert headers["content-type"] == "application/octet-stream"


def test_client_errors_are_not_retried(s3, transfers, tmp_path):
    with pytest.raises(TransferError) as error:
        transfers.get_bytes(PresignedRequest(s3.url("missing")))
    assert error.value.status == 404
    assert error.value.code == "NoSuchKey"
    assert s3.requests.count(("GET", "bucket/missing")) == 1
    assert "X-Amz-Signature" not in str(error.value)


def test_multipart_upload_uses_uniform_parts(s3, transfers, tmp_path, monkeypatch):
    monkeypatch.setattr(results_module, "SINGLE_PUT_LIMIT", 1000)
    monkeypatch.setattr(results_module, "MIN_PART_SIZE", 100)
    path = tmp_path / "big"
    payload = bytes(range(256)) * 10
    path.write_bytes(payload)
    targets = DatasetTargets(
        put=PresignedRequest(s3.url("big/data")),
        parts=[PresignedRequest(s3.url(f"big/part{i}")) for i in range(1, 5)],
    )
    record = DatasetUploader(transfers, tmp_path, tmp_path).upload_data(path, targets)
    assert record["mode"] == "multipart"
    assert record["part_size"] == 640
    assert [p["size"] for p in record["parts"]] == [640, 640, 640, 640]
    assert b"".join(s3.get(f"big/part{i}") for i in range(1, 5)) == payload
    assert not s3.has("big/data")

    small = tmp_path / "small"
    small.write_bytes(b"abc")
    assert DatasetUploader(transfers, tmp_path, tmp_path).upload_data(small, targets)["mode"] == "put"


def test_multipart_without_enough_parts_fails(s3, transfers, tmp_path, monkeypatch):
    monkeypatch.setattr(results_module, "SINGLE_PUT_LIMIT", 10)
    monkeypatch.setattr(results_module, "MIN_PART_SIZE", 10)
    monkeypatch.setattr(results_module, "MAX_PART_SIZE", 50)
    path = tmp_path / "big"
    path.write_bytes(b"x" * 100)
    targets = DatasetTargets(parts=[PresignedRequest(s3.url("p1"))])
    with pytest.raises(TransferError):
        DatasetUploader(transfers, tmp_path, tmp_path).upload_data(path, targets)


def test_termination_message_fits_in_4k():
    data = termination.encode({"stage": "out", "state": "error", "error": "x" * 10000})
    assert len(data) <= termination.MAX_BYTES
    assert json.loads(data)["error"].startswith("xxx")


def test_wait_for_tool_outlives_background_processes(layout):
    prepare_layout(layout)
    started = time.monotonic()
    subprocess.Popen(
        ["/bin/sh", "-c", f'exec 9<>"{layout.alive}"; : > "{layout.started}"; (sleep 2) & echo 0 > "{layout.rc}"'],
    ).wait()
    assert wait_for_tool(layout) is True
    assert time.monotonic() - started >= 1.5
    exit_info = tool_exit(layout, "none")
    assert exit_info.termination == "normal" and exit_info.exit_code == 0


def test_wait_for_tool_start_timeout(layout):
    prepare_layout(layout)
    assert wait_for_tool(layout, start_timeout=0.5) is False
    assert tool_exit(layout, "none", start_timeout=0.5).termination == "not_started"


@pytest.mark.parametrize("name", ["manifest", "prepare", "results"])
def test_schemas_are_valid(name):
    import jsonschema

    schema = json.loads((SCHEMAS / f"{name}.schema.json").read_text())
    jsonschema.validators.validator_for(schema).check_schema(schema)


def _tar(members: dict[str, bytes]) -> bytes:
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        for name, payload in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    return archive.getvalue()


def test_tool_archive_digest_defaults_to_the_bundle_repo_tar(s3, layout, transfers):
    archive = _tar({"macros.xml": b"<macros/>"})
    s3.put("tools/t/repo.tar", archive)
    prepare_layout(layout)
    tool = {"archive": {"request": s3.request("tools/t/repo.tar")}, "source": {"repo_tar": {"sha256": "0" * 64}}}
    with pytest.raises(stage_in.StageInError, match="checksum"):
        stage_in.fetch_tool_directory(transfers, layout, tool)
    tool["source"]["repo_tar"]["sha256"] = hashlib.sha256(archive).hexdigest()
    stage_in.fetch_tool_directory(transfers, layout, tool)
    assert (layout.tool_directory / "macros.xml").read_bytes() == b"<macros/>"


def test_tool_archive_members_cannot_leave_the_tool_directory(s3, layout, transfers):
    s3.put("tools/t/repo.tar", _tar({"../escaped.txt": b"x"}))
    prepare_layout(layout)
    with pytest.raises(tarfile.FilterError):
        stage_in.fetch_tool_directory(transfers, layout, {"archive": {"request": s3.request("tools/t/repo.tar")}})
    assert not (layout.root / "escaped.txt").exists()
