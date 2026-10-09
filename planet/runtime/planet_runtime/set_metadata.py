"""``planet-stager set-metadata``: Galaxy's ``__SET_METADATA__`` job.

For every entry of ``set_metadata.datasets`` the input is optionally re-sniffed
(auto-detect) or given a new datatype, then ``set_meta`` and ``set_peek`` run
and the dataset's ``meta.json`` and metadata files are rewritten. Data is not
re-uploaded.
"""

import logging
from typing import Any

from galaxy.datatypes import sniff
from galaxy.model.metadata import MetadataTempFile

from planet_runtime import (
    datasets,
    galaxy_env,
    manifest as manifest_module,
    termination,
)
from planet_runtime.finishing import set_metadata_on
from planet_runtime.layout import Layout
from planet_runtime.results import (
    DatasetTargets,
    DatasetUploader,
)
from planet_runtime.stage_in import (
    fetch_inputs,
    prepare_layout,
)
from planet_runtime.stage_out import (
    base_results,
    internal_message,
    publish_results,
)
from planet_runtime.transfer import (
    TransferError,
    Transfers,
)

log = logging.getLogger(__name__)


def run(layout: Layout, transfers: Transfers) -> int:
    started = termination.utcnow()
    try:
        manifest = manifest_module.load(transfers)
        manifest_module.check(manifest, "set_metadata")
    except (TransferError, manifest_module.ManifestError) as e:
        log.error("Cannot load the manifest: %s", e)
        termination.write({"stage": "set-metadata", "state": "error", "results": "failed", "error": str(e)})
        return 1

    prepare_layout(layout)
    registry = galaxy_env.registry()
    MetadataTempFile.tmp_dir = str(layout.metadata)
    max_size = int(manifest_module.limits(manifest).get("max_metadata_value_size") or 0)
    targets = {record["name"]: DatasetTargets.parse(record) for record in manifest.get("outputs") or []}
    uploader = DatasetUploader(transfers, layout.stager, layout.root)
    errors: list[str] = []
    outputs: dict[str, Any] = {}
    state = "ok"
    try:
        fetch_inputs(transfers, layout, manifest.get("inputs") or {})
        for entry in (manifest.get("set_metadata") or {}).get("datasets") or []:
            record = manifest["inputs"][entry["input"]]
            hda = datasets.make_input_hda(layout, record)
            if entry.get("detect"):
                extension = sniff.guess_ext(str(layout.input_path(record["uuid"])), registry.sniff_order)
            else:
                extension = entry.get("ext")
            if extension and extension != hda.extension:
                registry.change_datatype(hda, extension)
            metadata_ok = True
            try:
                set_metadata_on(hda, {}, layout, max_size, overwrite=bool(entry.get("overwrite", False)))
            except Exception:
                log.exception("Setting metadata failed for %s", record["uuid"])
                metadata_ok = False
            try:
                hda.set_peek()
            except Exception:
                log.exception("Setting peek failed for %s", record["uuid"])
            dataset_state = "ok" if metadata_ok else "failed_metadata"
            outputs[entry["output"]] = uploader.upload(hda, targets[entry["output"]], dataset_state, upload_data=False)
    except (TransferError, KeyError, OSError) as e:
        log.error("Setting metadata failed: %s", e)
        errors.append(str(e))
        state = "error"

    results = base_results(manifest, "set_metadata", state)
    results.update(
        job_messages=[internal_message(message) for message in errors],
        job_stderr={"text": "\n".join(errors), "size": len("\n".join(errors).encode())},
        outputs=outputs,
        errors=errors,
        timings={"stage_out_start": started, "stage_out_end": termination.utcnow()},
    )
    uploaded = publish_results(transfers, manifest, results)
    termination.write(
        {
            "stage": "set-metadata",
            "state": state,
            "results": "uploaded" if uploaded else "failed",
            **({"error": errors[0]} if errors else {}),
        }
    )
    return 0 if state == "ok" and uploaded else 1
