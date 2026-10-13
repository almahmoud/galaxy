"""``planet-stager`` command line."""

import argparse
import importlib
import json
import logging
import os
import sys

from planet_runtime import (
    __version__,
    isolation,
)
from planet_runtime.layout import Layout
from planet_runtime.transfer import (
    RetryPolicy,
    Transfers,
)

COMMANDS = {
    "in": ("planet_runtime.stage_in", "Prepare a tool job (init container)."),
    "out": ("planet_runtime.stage_out", "Wait for the tool, finish the job and upload results."),
    "upload": ("planet_runtime.upload", "Fetch uploaded data with Galaxy's data fetch and finish it."),
    "set-metadata": ("planet_runtime.set_metadata", "Set metadata of existing datasets."),
}
RETRY_SECONDS = {"in": 600.0, "out": 1800.0, "upload": 1800.0, "set-metadata": 1800.0}


def main(argv: list[str] | None = None) -> int:
    # Before the manifest URL is read and before any child process starts.
    isolation.make_undumpable()
    parser = argparse.ArgumentParser(prog="planet-stager", description="Planet job pod runtime.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, (_, help_text) in COMMANDS.items():
        subparsers.add_parser(name, help=help_text)
    wait = subparsers.add_parser("wait", help="Wait for the tool container and print how it ended.")
    wait.add_argument("--id-tag", default="", help="Job id, to read the Galaxy exit code file.")
    wait.add_argument("--start-timeout", type=float, default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("PLANET_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    layout = Layout.from_env()
    if args.command == "wait":
        from planet_runtime.stage_out import tool_exit

        print(json.dumps(tool_exit(layout, args.id_tag, args.start_timeout).__dict__))
        return 0

    module = importlib.import_module(COMMANDS[args.command][0])
    transfers = Transfers(RetryPolicy(max_elapsed=RETRY_SECONDS[args.command]))
    return module.run(layout, transfers)


if __name__ == "__main__":
    sys.exit(main())
