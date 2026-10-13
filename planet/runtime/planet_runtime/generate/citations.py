"""Resolve DOI citations of tool bundles to BibTeX when the toolbox is generated.

Galaxy fetches ``https://doi.org/<doi>`` with ``Accept: application/x-bibtex`` when a
tool's citations are requested. Resolving here means the browser does not have to ask
doi.org, which would tell it which tools the user opens. Answers are cached on disk by
DOI; a DOI that cannot be resolved keeps no ``bibtex`` and is left to the client.
"""

import hashlib
import logging
import os
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DOI_BASE = "https://doi.org/"
USER_AGENT = "planet-generate"
MAX_BIBTEX_BYTES = 64 * 1024


class DoiResolver:
    def __init__(self, cache_dir: str | os.PathLike, timeout: float = 30.0):
        self.cache_dir = Path(cache_dir)
        self.timeout = timeout

    def _cache_path(self, doi: str) -> Path:
        return self.cache_dir / f"{hashlib.sha256(doi.lower().encode()).hexdigest()}.bib"

    def _fetch(self, doi: str) -> str:
        request = urllib.request.Request(
            DOI_BASE + urllib.parse.quote(doi, safe="/"),
            headers={"Accept": "application/x-bibtex", "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            body = response.read(MAX_BIBTEX_BYTES + 1)
        if len(body) > MAX_BIBTEX_BYTES:
            raise ValueError("response is too large")
        text = body.decode("utf-8")
        if not text.lstrip().startswith("@"):
            raise ValueError("response is not BibTeX")
        return text

    def bibtex(self, doi: str) -> str | None:
        """BibTeX for ``doi``, or None when it cannot be resolved."""
        path = self._cache_path(doi)
        if path.is_file():
            return path.read_text(encoding="utf-8")
        try:
            text = self._fetch(doi)
        except (OSError, ValueError) as e:
            log.warning("No BibTeX for DOI %s: %s", doi, e)
            return None
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
        return text


def add_bibtex(bundle: dict[str, Any], resolver: DoiResolver) -> None:
    """Add ``bibtex`` to the bundle's DOI citations that resolve."""
    for citation in bundle.get("citations") or []:
        doi = (citation.get("content") or "").strip()
        if citation.get("type") == "doi" and doi:
            if (text := resolver.bibtex(doi)) is not None:
                citation["bibtex"] = text
