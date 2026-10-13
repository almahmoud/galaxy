"""Directory layout of the pod volumes.

All containers mount the shared volume at ``/planet``. The job working
directory follows Galaxy's layout (``working``, ``outputs``, ``configs``,
``metadata``, ``tmp``, ``home``). Only the stager containers mount the stager
volume at ``/planet-stager``.
"""

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ROOT = "/planet"
DEFAULT_STAGER_ROOT = "/planet-stager"


@dataclass(frozen=True)
class Layout:
    root: Path
    # Not mounted in the tool container: stager home, cache, scratch files and stage-in's state.
    stager: Path

    @classmethod
    def from_env(cls) -> "Layout":
        return cls(
            Path(os.environ.get("PLANET_ROOT", DEFAULT_ROOT)),
            Path(os.environ.get("PLANET_STAGER_ROOT", DEFAULT_STAGER_ROOT)),
        )

    @property
    def ctl(self) -> Path:
        return self.root / "ctl"

    @property
    def alive(self) -> Path:
        return self.ctl / "alive"

    @property
    def started(self) -> Path:
        return self.ctl / "started"

    @property
    def rc(self) -> Path:
        return self.ctl / "rc"

    @property
    def walltime_marker(self) -> Path:
        return self.ctl / "walltime"

    @property
    def run_tool(self) -> Path:
        return self.root / "bin" / "run-tool"

    @property
    def job(self) -> Path:
        return self.root / "job"

    @property
    def working(self) -> Path:
        return self.job / "working"

    @property
    def outputs(self) -> Path:
        return self.job / "outputs"

    @property
    def configs(self) -> Path:
        return self.job / "configs"

    @property
    def metadata(self) -> Path:
        return self.job / "metadata"

    @property
    def job_tmp(self) -> Path:
        return self.job / "tmp"

    @property
    def home(self) -> Path:
        return self.job / "home"

    @property
    def registry_xml(self) -> Path:
        return self.job / "registry.xml"

    @property
    def tool_script(self) -> Path:
        return self.job / "tool_script.sh"

    def job_script(self, id_tag: str) -> Path:
        return self.job / f"galaxy_{id_tag}.sh"

    def exit_code_file(self, id_tag: str) -> Path:
        return self.job / f"galaxy_{id_tag}.ec"

    @property
    def inputs(self) -> Path:
        return self.root / "inputs"

    def input_path(self, uuid: str) -> Path:
        return self.inputs / f"dataset_{uuid}.dat"

    def input_extra_files(self, uuid: str) -> Path:
        return self.inputs / f"dataset_{uuid}_files"

    def input_metadata_file(self, uuid: str, name: str) -> Path:
        return self.inputs / "metadata" / f"{uuid}_{name}"

    def output_path(self, uuid: str) -> Path:
        return self.outputs / f"dataset_{uuid}.dat"

    def output_extra_files(self, uuid: str) -> Path:
        return self.outputs / f"dataset_{uuid}_files"

    @property
    def tool_directory(self) -> Path:
        return self.root / "tool"

    @property
    def tool_data(self) -> Path:
        return self.root / "tool-data"

    @property
    def tmp(self) -> Path:
        """Mounted as ``/tmp`` in the tool container."""
        return self.root / "tmp"

    @property
    def state_file(self) -> Path:
        """Stage-in's decisions and the manifest, for stage-out."""
        return self.stager / "stage-in.json"

    @property
    def stager_home(self) -> Path:
        return self.stager / "home"

    @property
    def stager_cache(self) -> Path:
        return self.stager / "cache"

    @property
    def objects(self) -> Path:
        """Object store for datasets discovered after the tool ran."""
        return self.root / "objects"

    @property
    def uploads(self) -> Path:
        return self.root / "uploads"

    def directories(self) -> list[Path]:
        return [
            self.ctl,
            self.run_tool.parent,
            self.working,
            self.outputs,
            self.configs,
            self.metadata,
            self.job_tmp,
            self.home,
            self.inputs,
            self.inputs / "metadata",
            self.tool_directory,
            self.tool_data,
            self.tmp,
            self.objects,
        ]

    def stager_directories(self) -> list[Path]:
        return [self.stager, self.stager_home, self.stager_cache]


def ensure_empty_file(path: Path) -> None:
    """Create ``path`` if it does not exist, keeping existing content."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "ab"):
        pass
