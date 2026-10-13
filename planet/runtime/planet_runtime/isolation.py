"""Isolation between the stagers and the tool-author code that stage-in runs in a child process.

The child runs with the stager's uid. Linux lets a process read
``/proc/<pid>/environ``, ``mem`` and ``fd`` of a dumpable process with the same
uid, so the stagers make themselves non-dumpable before they read
``PLANET_MANIFEST_URL``. Processes the child leaves behind are killed when it
exits, and the stager volume is cleared before stage-in writes its state there.
"""

import ctypes
import os
import shutil
import signal
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

PR_SET_DUMPABLE = 4
PR_SET_CHILD_SUBREAPER = 36
MAX_KILL_ROUNDS = 1000

LINUX = sys.platform.startswith("linux")


def _prctl(option: int, value: int) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(ctypes.c_int(option), ctypes.c_ulong(value), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def make_undumpable() -> bool:
    """Close this process's ``/proc`` entries and ptrace to other processes of the same uid (Linux only).

    ``execve`` resets the flag, so processes this one starts are dumpable again.
    """
    if not LINUX:
        return False
    _prctl(PR_SET_DUMPABLE, 0)
    return True


def children(pid: int) -> set[int]:
    found = set()
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(f"/proc/{entry.name}/stat", "rb") as fh:
                fields = fh.read()
        except OSError:
            continue
        # The command name in parentheses may contain spaces; the parent pid is the second field after it.
        if int(fields[fields.rfind(b")") + 2 :].split()[1]) == pid:
            found.add(int(entry.name))
    return found


@contextmanager
def contained_children() -> Iterator[None]:
    """Kill every process started inside the block, including daemons, when it ends (Linux only).

    The caller is a child subreaper meanwhile, so orphaned descendants are
    re-parented to it instead of to init, and are killed and reaped round by
    round until none is left.
    """
    if not LINUX:
        yield
        return
    me = os.getpid()
    spared = children(me)
    _prctl(PR_SET_CHILD_SUBREAPER, 1)
    try:
        yield
    finally:
        try:
            for _ in range(MAX_KILL_ROUNDS):
                pids = children(me) - spared
                if not pids:
                    break
                for pid in pids:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                for pid in pids:
                    try:
                        os.waitpid(pid, 0)
                    except ChildProcessError:
                        pass
            else:
                raise RuntimeError("Processes started by the template evaluation could not be stopped")
        finally:
            _prctl(PR_SET_CHILD_SUBREAPER, 0)


def clear_directory(directory: Path) -> None:
    """Remove everything inside ``directory``, including unreadable directories, without following links."""
    for entry in os.scandir(directory):
        path = Path(entry.path)
        if entry.is_dir(follow_symlinks=False):
            _make_traversable(path)
            shutil.rmtree(path)
        else:
            path.unlink()


def _make_traversable(top: Path) -> None:
    pending = [top]
    while pending:
        directory = pending.pop()
        os.chmod(directory, stat.S_IRWXU)
        pending.extend(Path(e.path) for e in os.scandir(directory) if e.is_dir(follow_symlinks=False))
