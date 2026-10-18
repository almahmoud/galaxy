"""``planet-stager`` command line."""

import argparse
import gc
import importlib
import json
import logging
import os
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from planet_runtime import (
    __version__,
    isolation,
)
from planet_runtime.layout import Layout
from planet_runtime.redact import RedactingFormatter
from planet_runtime.transfer import (
    RetryPolicy,
    Transfers,
)

COMMANDS = {
    "in": ("planet_runtime.stage_in", "Prepare a tool job (init container)."),
    "out": ("planet_runtime.stage_out", "Wait for the tool, finish the job and upload results."),
    "upload": ("planet_runtime.upload", "Fetch uploaded data with Galaxy's data fetch and finish it."),
    "set-metadata": ("planet_runtime.set_metadata", "Set metadata of existing datasets."),
    "install": ("planet_runtime.install", "Install the tools of a Tool Shed or GitHub repository."),
}
RETRY_SECONDS = {"in": 600.0, "out": 1800.0, "upload": 1800.0, "set-metadata": 1800.0, "install": 600.0}


def configure_logging(level: str) -> None:
    """Log to stderr through a formatter that removes presigned-request credentials.

    Warnings and uncaught exceptions, including those of threads, go through the same handler.
    """
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
    logging.captureWarnings(True)
    log = logging.getLogger("planet_runtime")

    def excepthook(kind, value, traceback):
        log.critical("Uncaught exception", exc_info=(kind, value, traceback))

    def thread_excepthook(args):
        if args.exc_type is not SystemExit:
            log.critical("Uncaught exception in a thread", exc_info=(args.exc_type, args.exc_value, args.exc_traceback))

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook


@contextmanager
def gc_paused() -> Iterator[None]:
    """Pause the cyclic garbage collector, then freeze what was allocated out of later collections.

    Galaxy's imports create objects that live as long as the process; collecting
    while they are built costs about a tenth of the import time.
    """
    gc.disable()
    try:
        yield
    finally:
        gc.freeze()
        gc.enable()


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

    configure_logging(os.environ.get("PLANET_LOG_LEVEL", "INFO"))
    layout = Layout.from_env()
    if args.command == "wait":
        from planet_runtime.stage_out import tool_exit

        print(json.dumps(tool_exit(layout, args.id_tag, args.start_timeout).__dict__))
        return 0

    with gc_paused():
        module = importlib.import_module(COMMANDS[args.command][0])
    transfers = Transfers(RetryPolicy(max_elapsed=RETRY_SECONDS[args.command]))
    return module.run(layout, transfers)


def entry() -> None:
    """Console script: runs :func:`main` and exits without tearing down the interpreter.

    Finalizing the modules and objects Galaxy's imports leave behind takes about
    a second, which would delay the end of the container.
    """
    code = main()
    exit_now(code)


def exit_now(code: int) -> None:
    logging.shutdown()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    entry()
