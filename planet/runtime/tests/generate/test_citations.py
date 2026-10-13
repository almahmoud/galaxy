import io
import urllib.error

import pytest

from planet_runtime.generate import citations
from planet_runtime.generate.citations import (
    add_bibtex,
    DoiResolver,
)

BIBTEX = (
    "@article{Li_2009, title={The Sequence Alignment/Map format and SAMtools}, doi={10.1093/bioinformatics/btp352}}"
)


@pytest.fixture
def doi_org(monkeypatch):
    """Stand-in for doi.org: answers by DOI path and records the requests."""
    answers: dict[str, bytes | Exception] = {}
    requests = []

    def urlopen(request, timeout):
        requests.append(request)
        answer = answers[request.full_url.removeprefix(citations.DOI_BASE)]
        if isinstance(answer, Exception):
            raise answer
        return io.BytesIO(answer)

    monkeypatch.setattr(citations.urllib.request, "urlopen", urlopen)
    return answers, requests


def test_bibtex_is_fetched_once_and_cached(doi_org, tmp_path):
    answers, requests = doi_org
    answers["10.1093/bioinformatics/btp352"] = BIBTEX.encode()
    resolver = DoiResolver(tmp_path / "doi")
    assert resolver.bibtex("10.1093/bioinformatics/btp352") == BIBTEX
    assert requests[0].get_header("Accept") == "application/x-bibtex"
    assert DoiResolver(tmp_path / "doi").bibtex("10.1093/bioinformatics/btp352") == BIBTEX
    assert len(requests) == 1


def test_unresolved_dois_are_not_cached(doi_org, tmp_path):
    answers, requests = doi_org
    answers["10.1/missing"] = urllib.error.HTTPError("https://doi.org/10.1/missing", 404, "Not Found", {}, None)
    answers["10.1/html"] = b"<html>DOI Not Found</html>"
    answers["10.1/huge"] = b"@misc{" + b"x" * citations.MAX_BIBTEX_BYTES
    resolver = DoiResolver(tmp_path / "doi")
    assert resolver.bibtex("10.1/missing") is None
    assert resolver.bibtex("10.1/html") is None
    assert resolver.bibtex("10.1/huge") is None
    assert not (tmp_path / "doi").exists() or not any((tmp_path / "doi").iterdir())


def test_doi_is_quoted_in_the_url(doi_org, tmp_path):
    answers, requests = doi_org
    answers["10.1002/%28SICI%291097-0258%2819980815%2917%3A15%3C1661%3A%3AAID-SIM968%3E3.0.CO%3B2-2"] = b"@article{x}"
    assert DoiResolver(tmp_path).bibtex("10.1002/(SICI)1097-0258(19980815)17:15<1661::AID-SIM968>3.0.CO;2-2")


def test_add_bibtex_only_touches_resolved_doi_citations(doi_org, tmp_path):
    answers, _ = doi_org
    answers["10.1093/bioinformatics/btp352"] = BIBTEX.encode()
    answers["10.1/missing"] = urllib.error.URLError("offline")
    bundle = {
        "citations": [
            {"type": "doi", "content": " 10.1093/bioinformatics/btp352 "},
            {"type": "doi", "content": "10.1/missing"},
            {"type": "bibtex", "content": "@misc{own}"},
        ]
    }
    add_bibtex(bundle, DoiResolver(tmp_path))
    assert bundle["citations"] == [
        {"type": "doi", "content": " 10.1093/bioinformatics/btp352 ", "bibtex": BIBTEX},
        {"type": "doi", "content": "10.1/missing"},
        {"type": "bibtex", "content": "@misc{own}"},
    ]
