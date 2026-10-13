import json

import pytest

pytest.importorskip("edam_ontology")


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    from planet_runtime.generate.datatypes import (
        generate,
        load_registry,
    )

    registry = load_registry()
    out = tmp_path_factory.mktemp("datatypes")
    generate(out, registry, {"igv"})
    return registry, {path.name: json.loads(path.read_text()) for path in out.iterdir()}


def test_index_variants(generated):
    registry, files = generated
    assert files["extensions.json"] == registry.upload_file_formats
    assert files["index.json"] == files["upload.json"]
    assert all(d["display_in_upload"] for d in files["index.json"])
    assert len(files["index_all.json"]) == len(registry.datatype_info_dicts)
    assert set(files["index.json"][0]) == {
        "extension",
        "description",
        "description_url",
        "display_in_upload",
        "composite_files",
        "upload_warning",
        "display_behavior",
    }
    assert files["types_and_mapping.json"]["datatypes"] == files["extensions.json"]
    assert files["types_and_mapping_all.json"]["datatypes_mapping"] == files["mapping.json"]


def test_converters_carry_tool_ids(generated):
    _, files = generated
    by_pair = {(c["source"], c["target"]): c["tool_id"] for c in files["converters.json"]}
    assert by_pair[("bam", "bai")] == "CONVERTER_Bam_Bai_0"
    assert all(c["tool_id"] for c in files["converters.json"])


def test_details_cover_every_extension(generated):
    registry, files = generated
    details = files["details.json"]
    assert set(details) == set(registry.datatypes_by_extension)
    assert details["bam"]["preferred_visualization"] == {"visualization": "igv"}
    assert "preferred_visualization" not in details["h5"]
    assert "bai" in details["bam"]["converters"]
    assert files["visualizations.json"]["bam"] == [{"datatype": "bam", "visualization": "igv"}]
    assert files["visualizations.json"]["txt"] == []


def test_edam_details_have_labels(generated):
    _, files = generated
    detail = files["edam_formats_detailed.json"]["bam"]
    assert detail["prefix_IRI"] == files["edam_formats.json"]["bam"]
    assert detail["label"] == "BAM"
