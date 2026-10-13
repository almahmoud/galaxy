"""Removal of presigned-request credentials from text the stagers log or report.

The patterns match the browser's (``client/src/planet/jobs/redact.ts``): the
query of every URL that carries SigV4 parameters, and stray ``X-Amz-*``
parameters or ``Signature=`` values outside a URL.
"""

import logging
import re
from typing import Any

REDACTED = "[redacted]"

_URL = re.compile(r"\b(https?://[^\s?#\"'<>]*)\?([^\s\"'<>]*)", re.IGNORECASE)
_SIGNED_QUERY = re.compile(r"x-amz-|signature=|awsaccesskeyid=", re.IGNORECASE)
_AMZ_PARAMETER = re.compile(r"\b(x-amz-[a-z0-9-]+)(=|%3d)[^&\s\"'<>]*", re.IGNORECASE)
_SIGNATURE_VALUE = re.compile(r"\b(signature)(=|%3d)[0-9a-f]{16,}", re.IGNORECASE)


def _url(match: re.Match[str]) -> str:
    return f"{match.group(1)}?{REDACTED}" if _SIGNED_QUERY.search(match.group(2)) else match.group(0)


def redact(text: str) -> str:
    """``text`` with the credentials of presigned requests replaced by ``[redacted]``."""
    if not text:
        return text
    text = _URL.sub(_url, text)
    text = _AMZ_PARAMETER.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)
    return _SIGNATURE_VALUE.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)


def redact_value(value: Any) -> Any:
    """``redact`` applied to every string inside lists and dictionaries."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {key: redact_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(item) for item in value]
    return value


def error_message(error: BaseException) -> str:
    return redact(f"{type(error).__name__}: {error}")


class RedactingFormatter(logging.Formatter):
    """Formats records, including exception tracebacks, without presigned-request credentials."""

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))
