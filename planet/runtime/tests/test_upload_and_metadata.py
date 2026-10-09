import gzip

from conftest import (
    dataset_targets,
    job_files,
    new_uuid,
    validate,
    write_bam,
    write_manifest,
)

from planet_runtime import (
    set_metadata,
    upload,
)


def upload_manifest(s3, outputs, elements, files, slots=0, targets=None):
    return {
        "protocol": 1,
        "kind": "upload",
        "job": {"id": "upload1", "attempt": 1},
        "upload": {
            "request": {
                "targets": targets or [{"destination": {"type": "hdas"}, "elements": elements}],
                "check_content": True,
                "auto_decompress": True,
            },
            "files": files,
        },
        "outputs": outputs,
        "slots": [dataset_targets(s3, new_uuid()) for _ in range(slots)],
        "job_files": job_files(s3, "upload1"),
    }


def test_upload_sniffs_sets_metadata_and_reports_element_errors(s3, layout, transfers, tmp_path, monkeypatch):
    s3.put("uploads/u1", gzip.compress(b"@r1\nACGT\n+\nIIII\n@r2\nGGCC\n+\nIIII\n"))
    s3.put("uploads/u2", b"chr1 10 20\r\nchr2 30 40\r\n")
    s3.put("uploads/u3", b"<html><script>alert(1)</script></html>\n")
    outputs = [
        {"name": f"o{i}", "object_id": i, "uuid": new_uuid(), "ext": "auto", **dataset_targets(s3, new_uuid())}
        for i in range(1, 5)
    ]
    for output in outputs:
        output.update(dataset_targets(s3, output["uuid"]))
    elements = [
        {"src": "planet", "file": "u1", "name": "reads.fastq.gz", "ext": "auto", "dbkey": "?", "object_id": 1},
        {
            "src": "planet",
            "file": "u2",
            "name": "a.txt",
            "ext": "auto",
            "dbkey": "hg19",
            "object_id": 2,
            "space_to_tab": True,
            "to_posix_lines": True,
        },
        {
            "src": "pasted",
            "paste_content": "x\ty\n1\t2\n",
            "name": "pasted",
            "ext": "auto",
            "dbkey": "?",
            "object_id": 3,
        },
        {"src": "planet", "file": "u3", "name": "page.txt", "ext": "auto", "dbkey": "?", "object_id": 4},
    ]
    files = {
        key: {"request": s3.request(f"uploads/{key}"), "size": len(s3.get(f"uploads/{key}"))}
        for key in ("u1", "u2", "u3")
    }
    manifest = upload_manifest(s3, outputs, elements, files)
    validate(manifest, "manifest")
    write_manifest(tmp_path, manifest, monkeypatch)

    assert upload.run(layout, transfers) == 0
    results = s3.json("jobs/upload1/results.json")
    validate(results, "results")
    by_name = results["outputs"]
    reads = by_name["o1"]
    assert reads["ext"] == "fastqsanger.gz"
    assert reads["state"] == "ok"
    assert reads["info"] == "uploaded fastqsanger.gz file"
    assert s3.get(f"datasets/{reads['uuid']}/data") == s3.get("uploads/u1")

    bed = by_name["o2"]
    assert bed["ext"] == "bed"
    assert bed["dbkey"] == "hg19"
    assert bed["metadata"]["columns"] == 3
    assert s3.get(f"datasets/{bed['uuid']}/data") == b"chr1\t10\t20\nchr2\t30\t40\n"

    pasted = by_name["o3"]
    assert pasted["ext"] == "tabular"
    assert pasted["metadata"]["columns"] == 2

    html = by_name["o4"]
    assert html["state"] == "error"
    assert "HTML" in html["info"]


def test_upload_to_collection_uses_slots(s3, layout, transfers, tmp_path, monkeypatch):
    targets = [
        {
            "destination": {"type": "hdca"},
            "name": "pair",
            "collection_type": "list",
            "elements": [
                {"src": "pasted", "paste_content": "a\n", "name": "first", "ext": "txt"},
                {"src": "pasted", "paste_content": "b\n", "name": "second", "ext": "txt"},
            ],
        }
    ]
    manifest = upload_manifest(s3, [], [], {}, slots=3, targets=targets)
    write_manifest(tmp_path, manifest, monkeypatch)
    assert upload.run(layout, transfers) == 0
    results = s3.json("jobs/upload1/results.json")
    validate(results, "results")
    collection = results["output_collections"]["pair"]
    assert [e["element_identifier"] for e in collection["elements"]] == ["first", "second"]
    second = results["discovered"][collection["elements"][1]["slot"]]
    assert s3.get(f"datasets/{second['uuid']}/data") == b"b\n"


def test_set_metadata_detects_datatype_and_writes_metadata_files(s3, layout, transfers, tmp_path, monkeypatch):
    bam_path = tmp_path / "x.bam"
    write_bam(bam_path)
    bam_uuid = new_uuid()
    s3.put(f"datasets/{bam_uuid}/data", bam_path.read_bytes())
    manifest = {
        "protocol": 1,
        "kind": "set_metadata",
        "job": {"id": "meta1"},
        "inputs": {
            "d1": {
                "uuid": bam_uuid,
                "name": "x",
                "ext": "data",
                "data": s3.request(f"datasets/{bam_uuid}/data"),
                "metadata": {},
            }
        },
        "outputs": [{"name": "d1", **dataset_targets(s3, bam_uuid)}],
        "set_metadata": {"datasets": [{"input": "d1", "output": "d1", "detect": True, "overwrite": True}]},
        "job_files": job_files(s3, "meta1"),
    }
    validate(manifest, "manifest")
    write_manifest(tmp_path, manifest, monkeypatch)
    assert set_metadata.run(layout, transfers) == 0
    results = s3.json("jobs/meta1/results.json")
    validate(results, "results")
    record = results["outputs"]["d1"]
    assert record["ext"] == "bam"
    assert record["state"] == "ok"
    assert record["metadata"]["reference_names"] == ["chr1"]
    assert "bam_index" in record["metadata_files"]
    assert "data" not in record
    assert s3.json(f"datasets/{bam_uuid}/meta.json") == record
