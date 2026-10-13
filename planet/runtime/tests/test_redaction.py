"""Presigned-request credentials never reach the stagers' logs, termination messages or error reports."""

import json
import logging
import sys
import warnings

from conftest import (
    job_files,
    write_manifest,
)

from planet_runtime import (
    cli,
    stage_in,
    termination,
)
from planet_runtime.redact import redact

SIGNED = (
    "https://bucket.example.org/jobs/j1/results.json?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Credential=AKIAEXAMPLE%2F20261013%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=" + "ab" * 32
)


def test_redact():
    assert redact(f"PUT {SIGNED} failed") == "PUT https://bucket.example.org/jobs/j1/results.json?[redacted] failed"
    assert redact("see https://example.org/page?q=1&lang=en") == "see https://example.org/page?q=1&lang=en"
    stray = "X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=cafe split X-Amz-Security-Token%3Dsecret"
    assert (
        redact(stray)
        == "X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted] split X-Amz-Security-Token%3D[redacted]"
    )
    assert redact("Signature=" + "0f" * 16) == "Signature=[redacted]"
    assert "AKIAEXAMPLE" not in redact(json.dumps({"url": SIGNED}))


def test_logs_warnings_and_uncaught_exceptions_are_redacted(capsys):
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    try:
        cli.configure_logging("INFO")
        log = logging.getLogger("planet_runtime.test")
        log.info("fetching %s", SIGNED)
        try:
            raise ValueError(f"unknown url type: {SIGNED!r}")
        except ValueError:
            log.exception("failed")
        warnings.warn(f"insecure request to {SIGNED}", stacklevel=1)
        try:
            raise RuntimeError(SIGNED)
        except RuntimeError as e:
            sys.excepthook(type(e), e, e.__traceback__)
    finally:
        logging.captureWarnings(False)
        for handler in list(root.handlers):
            root.removeHandler(handler)
        for handler in handlers:
            root.addHandler(handler)
        root.setLevel(level)
    err = capsys.readouterr().err
    assert err.count("results.json?[redacted]") >= 3
    assert "X-Amz" not in err and "AKIAEXAMPLE" not in err


def test_termination_message_is_redacted():
    data = termination.encode({"stage": "in", "error": f"GET {SIGNED}", "nested": {"detail": [SIGNED]}})
    assert "AKIAEXAMPLE" not in data.decode() and "X-Amz" not in data.decode()
    assert json.loads(data)["error"] == "GET https://bucket.example.org/jobs/j1/results.json?[redacted]"


def test_stage_in_error_reports_are_redacted(s3, layout, transfers, tmp_path, monkeypatch):
    # urllib puts the whole URL into the ValueError of a URL without a scheme.
    manifest = {
        "protocol": 1,
        "kind": "tool",
        "job": {"id": "leak1", "attempt": 1},
        "tool": {
            "id": "t",
            "command": "true",
            "inputs": [],
            "archive": {"request": "bucket/tool.tar?" + SIGNED.split("?", 1)[1]},
        },
        "params": {},
        "inputs": {},
        "outputs": [],
        "job_files": job_files(s3, "leak1"),
    }
    write_manifest(tmp_path, manifest, monkeypatch)
    assert stage_in.run(layout, transfers) == 1
    prepare = s3.json("jobs/leak1/prepare.json")
    assert prepare["errors"][0]["message"].startswith("ValueError: unknown url type")
    reports = json.dumps(prepare) + (tmp_path / "termination-log").read_text()
    assert "X-Amz-Signature=[redacted]" in reports
    assert "AKIAEXAMPLE" not in reports and "abab" not in reports
