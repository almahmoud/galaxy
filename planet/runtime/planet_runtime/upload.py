"""``planet-stager upload``: Galaxy's data fetch followed by Galaxy's finishing of the fetched datasets.

The request is the body of ``POST /api/tools/fetch``. Elements with
``"src": "planet"`` name an entry of ``upload.files`` (an object in the
bucket); they are downloaded and rewritten to ``"src": "path"`` before
``data_fetch.do_fetch`` runs, as Galaxy rewrites uploaded files.
"""

import copy
import json
import logging
from collections.abc import Mapping
from typing import Any

import galaxy.model as model
from galaxy.job_execution.output_collect import collect_dynamic_outputs
from galaxy.model.metadata import MetadataTempFile
from galaxy.tool_util.provided_metadata import parse_tool_provided_metadata

from planet_runtime import (
    datasets,
    galaxy_env,
    manifest as manifest_module,
    termination,
)
from planet_runtime.finishing import (
    check_slot_pool,
    DiscoveredDataset,
    FinishResult,
    PlanetJobContext,
)
from planet_runtime.layout import Layout
from planet_runtime.redact import (
    error_message,
    redact,
)
from planet_runtime.results import DatasetUploader
from planet_runtime.stage_in import prepare_layout
from planet_runtime.stage_out import (
    base_results,
    internal_message,
    publish_datasets,
    publish_results,
)
from planet_runtime.transfer import (
    PresignedRequest,
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)


def rewrite_request(request: Any, files: Mapping[str, Any], layout: Layout, transfers: Transfers) -> Any:
    """Download ``src: planet`` elements and point them at the local copies."""
    if isinstance(request, list):
        return [rewrite_request(item, files, layout, transfers) for item in request]
    if not isinstance(request, Mapping):
        return request
    rewritten = {key: rewrite_request(value, files, layout, transfers) for key, value in request.items()}
    if rewritten.get("src") == "planet":
        key = str(rewritten.pop("file"))
        entry = files[key]
        path = layout.uploads / f"upload_{len(list(layout.uploads.glob('upload_*')))}"
        transfers.download(PresignedRequest.parse(entry["request"]), path, expected_size=entry.get("size"))
        rewritten["src"] = "path"
        rewritten["path"] = str(path)
    return rewritten


def run(layout: Layout, transfers: Transfers) -> int:
    started = termination.utcnow()
    try:
        manifest = manifest_module.load(transfers)
        manifest_module.check(manifest, "upload")
    except (TransferError, manifest_module.ManifestError) as e:
        log.error("Cannot load the manifest: %s", e)
        termination.write({"stage": "upload", "state": "error", "results": "failed", "error": str(e)})
        return 1

    prepare_layout(layout)
    layout.uploads.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    registry = galaxy_env.registry()
    object_store = datasets.object_store(layout)
    MetadataTempFile.tmp_dir = str(layout.metadata)

    outputs: dict[str, model.HistoryDatasetAssociation] = {}
    by_object_id: dict[Any, model.HistoryDatasetAssociation] = {}
    for record in manifest.get("outputs") or []:
        hda = datasets.make_hda(record, None, extension=record.get("ext") or "auto", state="queued")
        outputs[record["name"]] = hda
        if record.get("object_id") is not None:
            by_object_id[record["object_id"]] = hda

    state = "ok"
    job_messages: list[dict[str, Any]] = []
    upload = manifest.get("upload") or {}
    try:
        request = rewrite_request(
            copy.deepcopy(upload.get("request") or {}), upload.get("files") or {}, layout, transfers
        )
        request_path = layout.job / "request.json"
        request_path.write_text(json.dumps(request))
        galaxy_env.data_fetch().do_fetch(str(request_path), working_directory=str(layout.working), registry=registry)
        tool_provided_metadata = parse_tool_provided_metadata(
            str(layout.working / "galaxy.json"), provided_metadata_style="default"
        )
        slots = len(manifest.get("slots") or [])
        job_context = PlanetJobContext(
            layout,
            object_store,
            tool_provided_metadata,
            "ok",
            float("inf"),
            manifest_module.id_tag(manifest),
            {},
            existing_hdas=by_object_id,
        )
        hdcas: dict[str, Any] = {}
        collect_dynamic_outputs(job_context, hdcas)
        check_slot_pool(job_context, slots)
        for hda in outputs.values():
            if hda.state == "queued":
                hda.state = "error"
                hda.info = "The upload produced no dataset for this output."
        discovered = [DiscoveredDataset(hda) for hda in job_context.created]
        collections = hdcas
    except TransferError as e:
        log.error("Upload failed: %s", e)
        errors.append(redact(str(e)))
        state = "error"
        discovered, collections = [], {}
    except Exception as e:
        log.exception("Upload failed")
        errors.append(error_message(e))
        state = "error"
        discovered, collections = [], {}
    if state == "error":
        for hda in outputs.values():
            hda.state = "error"
            hda.info = hda.info or (errors[0] if errors else "Upload failed")
        job_messages.append(internal_message(errors[0] if errors else "Upload failed"))

    result = FinishResult(
        state=state,
        exit_code=None,
        termination="normal",
        job_messages=job_messages,
        tool_stdout="",
        tool_stderr="",
        job_stderr="\n".join(errors),
        command_version=None,
        outputs=outputs,
        discovered=discovered,
        collections=collections,
        failed_metadata={
            id(hda)
            for hda in [*outputs.values(), *(d.hda for d in discovered)]
            if hda.state == model.HistoryDatasetAssociation.states.FAILED_METADATA
        },
    )
    results = base_results(manifest, "upload", state)
    results.update(
        job_messages=job_messages,
        job_stderr={"text": "\n".join(errors), "size": len("\n".join(errors).encode())},
        errors=errors,
    )
    ok = True
    try:
        results["outputs"], results["discovered"], results["output_collections"] = publish_datasets(
            manifest, DatasetUploader(transfers, layout.stager, layout.root), result, errors
        )
    except TransferError as e:
        ok = False
        results["state"] = "error"
        errors.append(redact(str(e)))
    results["timings"] = {"stage_out_start": started, "stage_out_end": termination.utcnow()}
    uploaded = publish_results(transfers, manifest, results)
    termination.write(
        {
            "stage": "upload",
            "state": results["state"],
            "results": "uploaded" if uploaded else "failed",
            **({"error": errors[0]} if errors else {}),
        }
    )
    return 0 if ok and uploaded else 1
