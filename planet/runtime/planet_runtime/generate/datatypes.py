"""Generate the ``/api/datatypes*`` payloads from Galaxy's datatype registry.

Usage::

    python -m planet_runtime.generate.datatypes OUT_DIR [--visualization-plugins NAMES]

Every file holds exactly what the corresponding Galaxy route returns for a server
configured with ``datatypes_conf.xml.sample``. Galaxy only registers converters once a
toolbox is loaded, so converter tools are registered here from their tool sources.
"""

import argparse
import logging
import os
from pathlib import Path
from typing import Any

from galaxy.datatypes._schema import (
    DatatypeConverterList,
    DatatypeDetails,
    DatatypesCombinedMap,
    DatatypesEDAMDetailsDict,
    DatatypesMap,
    DatatypeVisualizationMappingsList,
)
from galaxy.datatypes.registry import Registry
from galaxy.managers.datatypes import (
    get_preferred_visualization,
    view_converters,
    view_edam_data,
    view_edam_formats,
    view_index,
    view_mapping,
    view_sniffers,
    view_visualization_mappings,
)
from galaxy.tool_util.parser import get_tool_source
from galaxy.util import galaxy_directory
from galaxy.util.bunch import Bunch

from ._common import (
    api_json,
    configure_logging,
    to_jsonable,
    write_json,
)

log = logging.getLogger(__name__)

SAMPLE_CONFIG = os.path.join("lib", "galaxy", "config", "sample", "datatypes_conf.xml.sample")


class _ConverterTool:
    """The part of a converter ``Tool`` that the registry and the datatypes API read."""

    def __init__(self, tool_id: str):
        self.id = tool_id

    def __repr__(self) -> str:
        return f"ConverterTool({self.id})"


def load_registry(root: str | None = None, config: str | None = None) -> Registry:
    """Load the datatype registry the way ``GalaxyManagerApplication`` does and register converters."""
    root = root or galaxy_directory()
    config = config or os.path.join(root, SAMPLE_CONFIG)
    registry = Registry(Bunch(sniff_compressed_dynamic_datatypes_default=True, edam_toolbox_ontology_path=None))
    registry.load_datatypes(root, config, override=True, use_display_applications=True, use_converters=True)
    if not registry.edam:
        raise RuntimeError("EDAM ontology unavailable; install the edam-ontology package pinned by Galaxy.")
    _register_converters(registry)
    return registry


def _register_converters(registry: Registry) -> None:
    tool_ids: dict[str, str] = {}
    for tool_config, source, target in registry.converters:
        path = os.path.join(registry.converters_path, tool_config)
        if path not in tool_ids:
            tool_id = get_tool_source(config_file=path).parse_id()
            if not tool_id:
                raise ValueError(f"Converter {path} has no tool id")
            tool_ids[path] = tool_id
        registry._register_converter_tool(_ConverterTool(tool_ids[path]), source, target)
    registry._converters_by_datatype = {}


def datatype_details(registry: Registry, extension: str, visualization_plugins: set[str]) -> dict[str, Any]:
    """Mirror ``FastAPIDatatypes.show`` (``GET /api/datatypes/{datatype}``)."""
    dt_object = registry.get_datatype_by_extension(extension)
    assert dt_object is not None
    result: dict[str, Any] = {
        "extension": extension,
        "description": getattr(dt_object, "description", None),
        "display_in_upload": extension in registry.upload_file_formats,
        "mimetype": registry.get_mimetype_by_extension(extension),
        "is_binary": getattr(dt_object, "is_binary", False),
        "display_behavior": (dt_object.get_display_behavior() if hasattr(dt_object, "get_display_behavior") else None),
    }
    composite_files = getattr(dt_object, "composite_files", None)
    if composite_files:
        result["composite_files"] = [{"name": k, **v.dict()} for k, v in composite_files.items()]
    if edam_format := registry.edam_formats.get(extension):
        result["edam_format"] = edam_format
    if edam_data := registry.edam_data.get(extension):
        result["edam_data"] = edam_data
    if converters := registry.get_converters_by_datatype(extension):
        result["converters"] = list(converters.keys())
    preferred = get_preferred_visualization(registry, extension)
    if preferred and preferred["visualization"] in visualization_plugins:
        result["preferred_visualization"] = {"visualization": preferred["visualization"]}
    return to_jsonable(result)


def generate(out_dir: Path, registry: Registry, visualization_plugins: set[str]) -> dict[str, int]:
    """Write every datatype payload into ``out_dir`` and return file sizes by name."""
    index_annotation = list[DatatypeDetails] | list[str]
    edam_annotation = dict[str, str]
    payloads: dict[str, Any] = {
        # GET /api/datatypes (defaults: extension_only=true, upload_only=true)
        "extensions.json": api_json(index_annotation, view_index(registry, True, True)),
        # GET /api/datatypes?extension_only=false
        "index.json": api_json(index_annotation, view_index(registry, False, True)),
        "upload.json": api_json(index_annotation, view_index(registry, False, True)),
        # GET /api/datatypes?extension_only=false&upload_only=false
        "index_all.json": api_json(index_annotation, view_index(registry, False, False)),
        # GET /api/datatypes?upload_only=false
        "extensions_all.json": api_json(index_annotation, view_index(registry, True, False)),
        "mapping.json": api_json(DatatypesMap, view_mapping(registry)),
        # GET /api/datatypes/types_and_mapping (upload_only=true and upload_only=false)
        "types_and_mapping.json": api_json(
            DatatypesCombinedMap,
            DatatypesCombinedMap(datatypes=view_index(registry, True, True), datatypes_mapping=view_mapping(registry)),
        ),
        "types_and_mapping_all.json": api_json(
            DatatypesCombinedMap,
            DatatypesCombinedMap(datatypes=view_index(registry, True, False), datatypes_mapping=view_mapping(registry)),
        ),
        "sniffers.json": api_json(list[str], view_sniffers(registry)),
        "converters.json": api_json(DatatypeConverterList, view_converters(registry)),
        "edam_formats.json": api_json(edam_annotation, view_edam_formats(registry)),
        "edam_formats_detailed.json": api_json(DatatypesEDAMDetailsDict, view_edam_formats(registry, True)),
        "edam_data.json": api_json(edam_annotation, view_edam_data(registry)),
        "edam_data_detailed.json": api_json(DatatypesEDAMDetailsDict, view_edam_data(registry, True)),
        "details.json": {
            ext: datatype_details(registry, ext, visualization_plugins) for ext in registry.datatypes_by_extension
        },
        # GET /api/datatypes/{datatype}/visualizations; Galaxy answers [] for every other extension.
        "visualizations.json": {
            ext: api_json(DatatypeVisualizationMappingsList, view_visualization_mappings(registry, ext))
            for ext in registry.datatypes_by_extension
        },
    }
    return {name: write_json(out_dir / name, payload) for name, payload in payloads.items()}


def _visualization_plugins(value: str | None) -> set[str]:
    if not value:
        return set()
    path = Path(value)
    if path.is_file():
        import yaml

        with path.open() as fh:
            return set((yaml.safe_load(fh) or {}).keys())
    return {name.strip() for name in value.split(",") if name.strip()}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir", type=Path, help="directory that receives the datatypes/*.json files")
    parser.add_argument("--galaxy-root", help="Galaxy checkout (default: the one providing the galaxy package)")
    parser.add_argument("--datatypes-config", help="datatypes_conf.xml (default: the sample shipped with Galaxy)")
    parser.add_argument(
        "--visualization-plugins",
        help="comma-separated plugin names, or a visualizations.yml, that the deployment serves; "
        "details.json only names a preferred visualization when its plugin is listed",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    configure_logging(args.verbose)
    registry = load_registry(args.galaxy_root, args.datatypes_config)
    sizes = generate(args.out_dir, registry, _visualization_plugins(args.visualization_plugins))
    log.info(
        "datatypes: %d extensions, %d upload extensions, %d converters, %d sniffers, %d bytes in %d files",
        len(registry.datatypes_by_extension),
        len(registry.upload_file_formats),
        sum(len(t) for t in registry.datatype_converters.values()),
        len(view_sniffers(registry)),
        sum(sizes.values()),
        len(sizes),
    )


if __name__ == "__main__":
    main()
