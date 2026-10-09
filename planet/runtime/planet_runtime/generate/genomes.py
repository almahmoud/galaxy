"""Generate the ``GET /api/genomes`` payload from a builds file.

Usage::

    python -m planet_runtime.generate.genomes OUT_FILE [--builds-file PATH]

Galaxy reads genome builds with ``galaxy.managers.dbkeys.GenomeBuilds`` and lists them
through ``galaxy.visualization.genomes.Genomes.get_dbkeys``. The latter module needs the
full application stack, so its few lines of bookkeeping are reproduced here: builds are
keyed by dbkey (a later duplicate replaces the description but keeps the position) and
returned as ``[description, dbkey]`` pairs.
"""

import argparse
import logging
import os
from pathlib import Path

from galaxy.managers.dbkeys import GenomeBuilds
from galaxy.util import galaxy_directory
from galaxy.util.bunch import Bunch

from ._common import (
    api_json,
    configure_logging,
    write_json,
)

log = logging.getLogger(__name__)

SAMPLE_BUILDS = os.path.join("tool-data", "shared", "ucsc", "builds.txt.sample")


def dbkeys(builds_file: str) -> list[list[str]]:
    app = Bunch(config=Bunch(len_file_path=None, builds_file_path=builds_file), tool_data_tables={})
    genome_builds = GenomeBuilds(app)
    genomes: dict[str, str] = {}
    for key, description in genome_builds.get_genome_build_names():
        genomes[key] = description
    return api_json(list[list[str]], [[description, key] for key, description in genomes.items()])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_file", type=Path, help="genomes.json to write")
    parser.add_argument("--builds-file", help="builds.txt (default: Galaxy's builds.txt.sample)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    configure_logging(args.verbose)
    builds_file = args.builds_file or os.path.join(galaxy_directory(), SAMPLE_BUILDS)
    payload = dbkeys(builds_file)
    size = write_json(args.out_file, payload)
    log.info("genomes: %d dbkeys, %d bytes", len(payload), size)


if __name__ == "__main__":
    main()
