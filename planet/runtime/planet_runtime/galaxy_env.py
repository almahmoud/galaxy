"""Galaxy code the stager uses from outside Galaxy's installable packages.

``galaxy.tools`` is not part of any Galaxy package. The image carries the
unmodified files the stager needs (``wrappers.py``, ``data_fetch.py``,
``parameters/wrapped_json.py`` and ``parameters/sanitize.py``) from the same
commit as the installed packages, under ``PLANET_GALAXY_LIB``. They are loaded
under their real module names; ``galaxy.tools.parameters.basic`` is replaced by
:mod:`planet_runtime.parameters`, which implements the parameter behaviour the
wrappers rely on. The generators also use ``galaxy.managers.datatypes`` and
``galaxy.managers.dbkeys``, which the image carries the same way.
"""

import functools
import importlib.util
import os
import sys
import types
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from galaxy.datatypes.registry import Registry

GALAXY_LIB_ENV = "PLANET_GALAXY_LIB"
DEFAULT_GALAXY_LIB = "/opt/planet/galaxy/lib"

_VENDORED = (
    ("galaxy.tools.parameters.sanitize", "galaxy/tools/parameters/sanitize.py"),
    ("galaxy.tools.parameters.wrapped_json", "galaxy/tools/parameters/wrapped_json.py"),
)
_WRAPPERS = ("galaxy.tools.wrappers", "galaxy/tools/wrappers.py")
_DATA_FETCH = ("galaxy.tools.data_fetch", "galaxy/tools/data_fetch.py")


@functools.cache
def galaxy_lib() -> Path:
    configured = os.environ.get(GALAXY_LIB_ENV)
    candidates = [Path(configured)] if configured else [Path(DEFAULT_GALAXY_LIB), Path(__file__).parents[3] / "lib"]
    for candidate in candidates:
        if (candidate / _WRAPPERS[1]).is_file():
            return candidate
    raise RuntimeError(f"Galaxy source files not found; set {GALAXY_LIB_ENV}")


def datatypes_conf() -> Path:
    return galaxy_lib() / "galaxy" / "config" / "sample" / "datatypes_conf.xml.sample"


def job_script_templates() -> Path:
    return galaxy_lib() / "galaxy" / "jobs" / "runners" / "util" / "job_script"


@functools.cache
def registry() -> "Registry":
    """Datatypes registry built like Galaxy's metadata script builds it."""
    import galaxy.model
    from galaxy.datatypes.registry import Registry

    datatypes_registry = Registry()
    datatypes_registry.load_datatypes(
        root_dir=str(galaxy_lib().parent),
        config=str(datatypes_conf()),
        use_build_sites=False,
        use_converters=False,
        use_display_applications=False,
    )
    galaxy.model.set_datatypes_registry(datatypes_registry)
    return datatypes_registry


def _package(name: str) -> types.ModuleType:
    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
        parent, _, child = name.rpartition(".")
        if parent:
            setattr(sys.modules[parent], child, module)
    return module


def _load(name: str, relative_path: str) -> types.ModuleType:
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, galaxy_lib() / relative_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[name]
        raise
    parent, _, child = name.rpartition(".")
    setattr(sys.modules[parent], child, module)
    return module


@functools.cache
def install_base() -> None:
    """Make ``galaxy.tools.parameters.sanitize`` and ``wrapped_json`` importable."""
    import galaxy  # noqa: F401

    _package("galaxy.tools")
    _package("galaxy.tools.parameters")
    for name, path in _VENDORED:
        _load(name, path)


@functools.cache
def install() -> None:
    """Make ``galaxy.tools.wrappers`` and its dependencies importable."""
    install_base()
    from planet_runtime import parameters

    basic = types.ModuleType("galaxy.tools.parameters.basic")
    for exported in parameters.__all__:
        setattr(basic, exported, getattr(parameters, exported))
    sys.modules[basic.__name__] = basic
    sys.modules["galaxy.tools.parameters"].basic = basic  # type: ignore[attr-defined]
    _load(*_WRAPPERS)


def data_fetch() -> types.ModuleType:
    install()
    return _load(*_DATA_FETCH)


@functools.cache
def install_managers() -> None:
    """Make the carried ``galaxy.managers`` modules importable when Galaxy's ``lib`` is not on the path."""
    import galaxy  # noqa: F401

    if "galaxy.managers" in sys.modules or importlib.util.find_spec("galaxy.managers") is not None:
        return
    directory = galaxy_lib() / "galaxy" / "managers"
    spec = importlib.util.spec_from_file_location(
        "galaxy.managers", directory / "__init__.py", submodule_search_locations=[str(directory)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    sys.modules["galaxy"].managers = module  # type: ignore[attr-defined]
