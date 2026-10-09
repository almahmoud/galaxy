"""HTTP transfers against presigned S3 URLs, using only the standard library.

Uploads always send ``Content-Length`` (S3-compatible servers reject chunked
PUTs). URLs carry signatures, so they are never logged; ``describe`` strips the
query string.
"""

import base64
import hashlib
import logging
import os
import random
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import (
    Callable,
    Mapping,
)
from dataclasses import (
    dataclass,
    field,
)
from pathlib import Path
from typing import (
    Any,
    BinaryIO,
    TypeVar,
)

log = logging.getLogger(__name__)

T = TypeVar("T")

BLOCK_SIZE = 1024 * 1024
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
RETRYABLE_CODES = frozenset({"RequestTimeout", "SlowDown", "InternalError", "ServiceUnavailable"})


class TransferError(Exception):
    def __init__(self, message: str, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status in RETRYABLE_STATUS or self.code in RETRYABLE_CODES


@dataclass(frozen=True)
class PresignedRequest:
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def parse(cls, value: Mapping[str, Any] | str) -> "PresignedRequest":
        if isinstance(value, str):
            return cls(value)
        return cls(str(value["url"]), dict(value.get("headers") or {}))

    def describe(self) -> str:
        return describe(self.url)


@dataclass
class RetryPolicy:
    """Exponential backoff with full jitter, bounded by total elapsed time."""

    max_elapsed: float = 1800.0
    base_delay: float = 1.0
    max_delay: float = 60.0
    sleep: Callable[[float], None] = time.sleep

    def run(self, action: Callable[[], T], what: str) -> T:
        started = time.monotonic()
        attempt = 0
        while True:
            attempt += 1
            try:
                return action()
            except TransferError as e:
                elapsed = time.monotonic() - started
                if not e.retryable or elapsed >= self.max_elapsed:
                    raise
                delay = random.uniform(0, min(self.max_delay, self.base_delay * 2 ** (attempt - 1)))
                delay = min(delay, max(0.0, self.max_elapsed - elapsed))
                log.warning("%s failed (attempt %d: %s); retrying in %.1fs", what, attempt, e, delay)
                self.sleep(delay)


def describe(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


class _BlockReader:
    """File window that hands ``http.client`` large blocks regardless of its request size."""

    def __init__(self, fh: BinaryIO, length: int):
        self._fh = fh
        self._remaining = length

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        chunk = self._fh.read(min(BLOCK_SIZE, self._remaining))
        self._remaining -= len(chunk)
        return chunk


def _s3_error_code(body: bytes) -> str | None:
    start = body.find(b"<Code>")
    end = body.find(b"</Code>")
    if start != -1 and end > start:
        return body[start + 6 : end].decode("utf-8", "replace")
    return None


def _open(request: urllib.request.Request, timeout: float):
    what = f"{request.get_method()} {describe(request.full_url)}"
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as e:
        body = e.read(4096) if e.fp else b""
        code = _s3_error_code(body)
        raise TransferError(f"{what}: HTTP {e.code}{f' {code}' if code else ''}", status=e.code, code=code) from None
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise TransferError(f"{what}: {reason}") from None


class Transfers:
    def __init__(self, retry: RetryPolicy | None = None, timeout: float = 120.0, content_md5: bool = True):
        self.retry = retry or RetryPolicy()
        self.timeout = timeout
        self.content_md5 = content_md5

    def get_bytes(self, target: PresignedRequest, limit: int | None = None) -> bytes:
        def action() -> bytes:
            request = urllib.request.Request(target.url, headers=dict(target.headers), method="GET")
            with _open(request, self.timeout) as response:
                data = response.read(limit + 1 if limit is not None else -1)
            if limit is not None and len(data) > limit:
                raise TransferError(f"GET {target.describe()}: response larger than {limit} bytes", status=413)
            return data

        return self.retry.run(action, f"download {target.describe()}")

    def download(self, target: PresignedRequest, destination: Path, expected_size: int | None = None) -> int:
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(destination.name + ".part")

        def action() -> int:
            request = urllib.request.Request(target.url, headers=dict(target.headers), method="GET")
            with _open(request, self.timeout) as response, open(partial, "wb") as out:
                try:
                    shutil.copyfileobj(response, out, BLOCK_SIZE)
                except OSError as e:
                    raise TransferError(f"GET {target.describe()}: {e}") from None
            size = partial.stat().st_size
            if expected_size is not None and size != expected_size:
                raise TransferError(f"GET {target.describe()}: received {size} bytes, expected {expected_size}")
            os.replace(partial, destination)
            return size

        return self.retry.run(action, f"download {target.describe()}")

    def put_bytes(self, target: PresignedRequest, data: bytes, content_type: str | None = None) -> str | None:
        def action() -> str | None:
            headers = self._headers(target, len(data), content_type, _md5(data) if self.content_md5 else None)
            request = urllib.request.Request(target.url, data=data, headers=headers, method="PUT")
            with _open(request, self.timeout) as response:
                response.read()
                return response.headers.get("ETag")

        return self.retry.run(action, f"upload {target.describe()}")

    def put_file(
        self,
        target: PresignedRequest,
        path: Path,
        offset: int = 0,
        length: int | None = None,
        content_type: str | None = None,
    ) -> str | None:
        """PUT a file, or the window ``[offset, offset + length)`` of it; returns the ETag."""
        if length is None:
            length = path.stat().st_size - offset
        digest = _file_md5(path, offset, length) if self.content_md5 else None

        def action() -> str | None:
            headers = self._headers(target, length, content_type, digest)
            with open(path, "rb") as fh:
                fh.seek(offset)
                request = urllib.request.Request(
                    target.url, data=_BlockReader(fh, length), headers=headers, method="PUT"
                )
                with _open(request, self.timeout) as response:
                    response.read()
                    return response.headers.get("ETag")

        return self.retry.run(action, f"upload {target.describe()}")

    @staticmethod
    def _headers(target: PresignedRequest, length: int, content_type: str | None, md5: str | None) -> dict[str, str]:
        # urllib would otherwise send application/x-www-form-urlencoded, which S3 stores with the object.
        headers = {"Content-Length": str(length), "Content-Type": content_type or "application/octet-stream"}
        if md5:
            headers["Content-MD5"] = md5
        headers.update(target.headers)
        return headers


def _md5(data: bytes) -> str:
    return base64.b64encode(hashlib.md5(data, usedforsecurity=False).digest()).decode("ascii")


def _file_md5(path: Path, offset: int, length: int) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as fh:
        fh.seek(offset)
        remaining = length
        while remaining > 0:
            chunk = fh.read(min(BLOCK_SIZE, remaining))
            if not chunk:
                break
            digest.update(chunk)
            remaining -= len(chunk)
    return base64.b64encode(digest.digest()).decode("ascii")
