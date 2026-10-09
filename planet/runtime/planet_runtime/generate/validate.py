"""Validate tool bundles against planet/toolbox/tool-bundle.schema.json.

Usage::

    python -m planet_runtime.generate.validate [--schema SCHEMA] PATH...

Each PATH is a bundle file or a directory searched recursively for ``*.json``.
Requires the ``jsonschema`` package.
"""

import argparse
import json
import logging
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from galaxy.util import galaxy_directory

from ._common import configure_logging

log = logging.getLogger(__name__)

DEFAULT_SCHEMA = Path("planet") / "toolbox" / "tool-bundle.schema.json"


def load_validator(schema_path: Path):
    from jsonschema import Draft202012Validator

    schema = json.loads(schema_path.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def bundle_errors(validator, bundle: Any) -> list[str]:
    errors = sorted(validator.iter_errors(bundle), key=lambda e: list(e.absolute_path))
    return [f"/{'/'.join(str(p) for p in error.absolute_path)}: {error.message}" for error in errors]


def _bundle_files(paths: list[Path]) -> Iterator[Path]:
    for path in paths:
        if path.is_dir():
            yield from sorted(path.rglob("*.json"))
        else:
            yield path


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--schema", type=Path, help=f"default: <galaxy root>/{DEFAULT_SCHEMA}")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    configure_logging(args.verbose)
    validator = load_validator(args.schema or Path(galaxy_directory()) / DEFAULT_SCHEMA)
    checked = failed = 0
    for path in _bundle_files(args.paths):
        checked += 1
        errors = bundle_errors(validator, json.loads(path.read_text()))
        if errors:
            failed += 1
            log.error("%s: %d schema errors", path, len(errors))
            for error in errors[:20]:
                log.error("  %s", error)
    log.info("validated %d bundles, %d invalid", checked, failed)
    if failed or not checked:
        sys.exit(1)


if __name__ == "__main__":
    main()
