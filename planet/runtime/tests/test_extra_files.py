"""Extra files: the tar with its index, and each file as its own object from the URL pool."""

import pytest
from conftest import validate

from planet_runtime import (
    manifest as manifest_module,
    results as results_module,
)
from planet_runtime.results import (
    build_extra_tar,
    DatasetUploader,
    ExtraObject,
)
from planet_runtime.transfer import (
    PresignedRequest,
    RetryPolicy,
    Transfers,
)


@pytest.fixture
def extra_dir(tmp_path):
    directory = tmp_path / "dataset_files"
    (directory / "img").mkdir(parents=True)
    (directory / "index.html").write_text('<img src="img/a.png">')
    (directory / "img" / "a.png").write_bytes(b"png")
    (directory / "img" / "b.png").write_bytes(b"other")
    (directory / "img" / "link.png").symlink_to("a.png")
    return directory


def pool(s3, size: int, uuid: str = "u") -> list[ExtraObject]:
    return [
        ExtraObject(f"datasets/{uuid}/extra/{i}", PresignedRequest(s3.url(f"datasets/{uuid}/extra/{i}")))
        for i in range(size)
    ]


def files(index):
    return {entry["path"]: entry for entry in index["entries"] if entry["type"] == "file"}


def test_every_file_is_stored_in_index_order(s3, transfers, tmp_path, extra_dir):
    index = build_extra_tar(extra_dir, tmp_path / "extra.tar")
    uploader = DatasetUploader(transfers, tmp_path, tmp_path)
    assert uploader.upload_extra_objects(extra_dir, index, pool(s3, 4)) == []
    entries = files(index)
    assert list(entries) == ["index.html", "img/a.png", "img/b.png"]
    assert [entry["key"] for entry in entries.values()] == [
        "datasets/u/extra/0",
        "datasets/u/extra/1",
        "datasets/u/extra/2",
    ]
    assert s3.get("datasets/u/extra/0") == b'<img src="img/a.png">'
    assert s3.get("datasets/u/extra/1") == b"png"
    assert not s3.has("datasets/u/extra/3")
    link = next(entry for entry in index["entries"] if entry["path"] == "img/link.png")
    assert link == {"path": "img/link.png", "type": "symlink", "target": "a.png"}


def test_small_pool_keeps_the_tar_only(s3, transfers, tmp_path, extra_dir):
    index = build_extra_tar(extra_dir, tmp_path / "extra.tar")
    warnings = DatasetUploader(transfers, tmp_path, tmp_path).upload_extra_objects(extra_dir, index, pool(s3, 2))
    assert warnings == ["3 extra files exceed the 2 extra object URLs given; extra files are only stored in extra.tar"]
    assert not any("key" in entry for entry in index["entries"])
    assert not any(key.startswith("bucket/datasets/u/extra/") for key in s3.objects)


def test_no_pool_stores_nothing_separately(s3, transfers, tmp_path, extra_dir):
    index = build_extra_tar(extra_dir, tmp_path / "extra.tar")
    assert DatasetUploader(transfers, tmp_path, tmp_path).upload_extra_objects(extra_dir, index, []) == []
    assert not any("key" in entry for entry in index["entries"])


def test_files_too_large_for_one_put_stay_in_the_tar(s3, transfers, tmp_path, extra_dir, monkeypatch):
    monkeypatch.setattr(results_module, "SINGLE_PUT_LIMIT", 4)
    index = build_extra_tar(extra_dir, tmp_path / "extra.tar")
    warnings = DatasetUploader(transfers, tmp_path, tmp_path).upload_extra_objects(extra_dir, index, pool(s3, 1))
    assert len(warnings) == 2 and "'index.html'" in warnings[0] and "'img/b.png'" in warnings[1]
    entries = files(index)
    assert entries["img/a.png"]["key"] == "datasets/u/extra/0"
    assert "key" not in entries["img/b.png"] and "key" not in entries["index.html"]


def test_failed_object_upload_is_a_warning(s3, tmp_path, extra_dir):
    transfers = Transfers(RetryPolicy(max_elapsed=0.2, base_delay=0.01, max_delay=0.05), timeout=10.0)
    s3.failures["bucket/datasets/u/extra/1"] = 1000
    index = build_extra_tar(extra_dir, tmp_path / "extra.tar")
    warnings = DatasetUploader(transfers, tmp_path, tmp_path).upload_extra_objects(extra_dir, index, pool(s3, 3))
    assert len(warnings) == 1 and warnings[0].startswith("Storing extra files as separate objects failed")
    entries = files(index)
    assert "key" not in entries["img/a.png"]
    assert all(s3.get(entry["key"]) for entry in entries.values() if "key" in entry)


def test_dataset_record_lists_keys_and_warnings(s3, transfers, tmp_path):
    import galaxy.model as model

    from planet_runtime import galaxy_env

    galaxy_env.registry()
    data = tmp_path / "dataset.dat"
    data.write_text("<html><body><img src='a.png'></body></html>\n")
    extra = tmp_path / "dataset_files"
    extra.mkdir()
    (extra / "a.png").write_bytes(b"png")
    (extra / "b.png").write_bytes(b"png2")
    hda = model.HistoryDatasetAssociation(extension="html", create_dataset=True, flush=False)
    hda.dataset.external_filename = str(data)
    hda.dataset.external_extra_files_path = str(extra)
    targets = results_module.DatasetTargets.parse(
        {
            "data": {"put": s3.request("datasets/u/data")},
            "meta": s3.request("datasets/u/meta.json"),
            "extra": s3.request("datasets/u/extra.tar"),
            "extra_index": s3.request("datasets/u/extra.json"),
            "extra_objects": [{"key": "datasets/u/extra/0", "request": s3.request("datasets/u/extra/0")}],
        }
    )
    record = DatasetUploader(transfers, tmp_path, tmp_path).upload(hda, targets, "ok", uuid="u")
    assert record["warnings"] == [
        "2 extra files exceed the 1 extra object URLs given; extra files are only stored in extra.tar"
    ]
    assert s3.json("datasets/u/extra.json") == record["extra_files"]
    assert s3.json("datasets/u/meta.json") == record


def test_manifest_rejects_malformed_pools(s3):
    base = {"protocol": 1, "kind": "upload", "job": {"id": "j1"}}
    uuid = "8a4c7d0e-6a6f-4c36-9a3c-2b2e4f1a9f10"
    request = s3.request("x")
    for pool_entries, message in [
        ([{"request": request}], "requires a key"),
        ([{"key": "datasets/x/extra/0"}], "has no request"),
        ([{"key": "k", "request": request}, {"key": "k", "request": request}], "twice"),
    ]:
        manifest = {**base, "outputs": [{"name": "o", "uuid": uuid, "extra_objects": pool_entries}]}
        with pytest.raises(manifest_module.ManifestError, match=message):
            manifest_module.check(manifest)
        with pytest.raises(manifest_module.ManifestError, match=message):
            manifest_module.check({**base, "slots": [{"uuid": uuid, "extra_objects": pool_entries}]})
    manifest = {**base, "outputs": [{"name": "o", "uuid": uuid, "extra_objects": [{"key": "k", "request": request}]}]}
    manifest_module.check(manifest)


def test_pool_entries_are_hidden_from_templates(s3):
    manifest = {"slots": [], "outputs": [{"name": "o", "extra_objects": [{"key": "k", "request": s3.request("k")}]}]}
    assert manifest_module.without_requests(manifest)["outputs"][0]["extra_objects"] == [{"key": "k", "request": None}]


def test_schema_accepts_pools_and_keyed_entries(s3):
    uuid = "8a4c7d0e-6a6f-4c36-9a3c-2b2e4f1a9f10"
    validate(
        {
            "protocol": 1,
            "kind": "upload",
            "job": {"id": "j1"},
            "upload": {"request": {"targets": []}},
            "outputs": [{"name": "o", "uuid": uuid, "extra_objects": [{"key": "k", "request": s3.request("k")}]}],
            "slots": [{"uuid": uuid, "extra_objects": [{"key": "k", "request": s3.url("k")}]}],
            "job_files": {},
        },
        "manifest",
    )
