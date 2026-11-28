"""Seed and sync Pi credentials between the host auth.json and a disposable copy.

The Pi entrypoint copies the host auth.json into a disposable agent dir before
the run. `seed` records what was copied. `sync`, after the run, writes OAuth
refreshes Pi made in the disposable copy back to the host file, per provider
entry and only while the host entry still equals what was seeded, so a host
login or logout during the run wins. API-key entries are never rewritten, and
nothing is written when no OAuth entry changed.

Usage:
    pi-credentials.py seed <runtime auth.json> <snapshot>
    pi-credentials.py sync <host auth.json> <runtime auth.json> <snapshot>
    pi-credentials.py sync-from-stdin <host auth.json> <pinned target filename>
"""

import errno
import json
import os
import stat
import sys
import tempfile
import time
from pathlib import Path

# Pi serializes auth.json writes with proper-lockfile: a `<auth.json>.lock`
# directory whose mtime it refreshes while held, and which it treats as stale
# after 30 seconds. Take the same lock so a host Pi refresh never interleaves
# with the write-back.
LOCK_STALE_SECONDS = 30
LOCK_WAIT_SECONDS = 30
LOCK_RETRY_SECONDS = 0.1


def read_json_with_metadata(path, *, follow_symlinks=True):
    flags = os.O_RDONLY | os.O_NONBLOCK
    if not follow_symlinks:
        flags |= os.O_NOFOLLOW
    try:
        with os.fdopen(os.open(path, flags), encoding="utf-8-sig") as handle:
            metadata = os.fstat(handle.fileno())
            if stat.S_ISREG(metadata.st_mode):
                # Pi strips a UTF-8 BOM before parsing; do the same.
                return json.load(handle), metadata
    except (FileNotFoundError, NotADirectoryError, ValueError):
        pass
    return None, None


def read_json(path):
    return read_json_with_metadata(path)[0]


def is_oauth(entry):
    return isinstance(entry, dict) and entry.get("type") == "oauth"


def write_private(path, content, original=None):
    """Atomically replace a file via an owner-only temporary file."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=f"{path.name}.propr-tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            if original is not None:
                created = os.fstat(fd)
                if (created.st_uid, created.st_gid) != (original.st_uid, original.st_gid):
                    os.fchown(fd, original.st_uid, original.st_gid)
            os.fchmod(fd, stat.S_IMODE(original.st_mode) if original is not None else 0o600)
            os.fsync(fd)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class LockTimeout(Exception):
    pass


class AuthLock:
    """proper-lockfile compatible lock on a Pi auth.json."""

    def __init__(self, auth_path):
        # The caller supplies the resolved target. Keep a pinned parent intact.
        self.path = auth_path.with_name(auth_path.name + ".lock")

    def __enter__(self):
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                os.mkdir(self.path, 0o700)
                return self
            except FileExistsError:
                try:
                    stale = time.time() - self.path.stat().st_mtime > LOCK_STALE_SECONDS
                except FileNotFoundError:
                    continue
                if stale:
                    try:
                        os.rmdir(self.path)
                    except OSError as error:
                        if error.errno not in (errno.ENOENT, errno.ENOTEMPTY):
                            raise
                    continue
            if time.monotonic() >= deadline:
                raise LockTimeout(f"{self.path} is held by another process")
            time.sleep(LOCK_RETRY_SECONDS)

    def __exit__(self, *exc):
        try:
            os.rmdir(self.path)
        except FileNotFoundError:
            pass


def serialize(auth):
    # The layout Pi itself writes: JSON.stringify(data, null, 2).
    return json.dumps(auth, indent=2, ensure_ascii=False)


def seed(runtime_auth, snapshot):
    """Record the auth.json copied into the runtime before Pi touches it."""
    content = json.dumps(read_json(runtime_auth))
    if snapshot == "-":
        print(content)
        return
    snapshot = Path(snapshot)
    snapshot.unlink(missing_ok=True)
    write_private(snapshot, content)


def refreshed_entries(seeded, runtime):
    """OAuth entries Pi changed in the runtime copy, keyed by provider."""
    if not isinstance(seeded, dict) or not isinstance(runtime, dict):
        return {}
    return {
        provider: entry
        for provider, entry in runtime.items()
        if is_oauth(entry) and is_oauth(seeded.get(provider)) and entry != seeded[provider]
    }


def sync(host_auth, runtime_auth, snapshot):
    """Write OAuth refreshes back to the host; returns the providers written."""
    return write_refreshes(Path(os.path.realpath(host_auth)), read_json(snapshot), read_json(runtime_auth))


def write_refreshes(host_auth, seeded, runtime, source=None):
    changes = refreshed_entries(seeded, runtime)
    if not changes or not host_auth.is_file():
        return []
    # Work on the resolved target so a symlinked auth.json keeps its link and
    # shares the lock taken by host Pi. Recheck the binding after waiting.
    with AuthLock(host_auth):
        # The source link may have changed while Pi ran or while we waited.
        if source is not None and Path(os.path.realpath(source)) != host_auth.parent.resolve() / host_auth.name:
            return []
        current, metadata = read_json_with_metadata(host_auth, follow_symlinks=False)
        if not isinstance(current, dict):
            return []
        # Compare-and-swap per entry: a host login, logout or its own refresh
        # since the seed leaves the host entry different, and the host wins.
        written = [provider for provider, entry in changes.items() if current.get(provider) == seeded[provider]]
        if not written:
            return []
        for provider in written:
            current[provider] = changes[provider]
        write_private(host_auth, serialize(current), metadata)
    return written


def main(argv):
    if len(argv) == 3 and argv[0] == "seed":
        seed(argv[1], argv[2])
        return 0
    if argv and (argv[0], len(argv)) in {("sync", 4), ("sync-from-stdin", 3)}:
        try:
            if argv[0] == "sync":
                written = sync(argv[1], argv[2], argv[3])
            else:
                # The two JSON records are the trusted pre-run baseline and
                # the disposable auth read by the unprivileged runtime user.
                seeded = json.loads(sys.stdin.readline())
                runtime = json.loads(sys.stdin.readline() or "null")
                host_auth = Path("/proc/self/fd/9") / Path(argv[2]).name
                written = write_refreshes(host_auth, seeded, runtime, source=argv[1])
        except LockTimeout as error:
            print(f"Not writing Pi credential refreshes back: {error}", file=sys.stderr)
            return 3
        if written:
            print(f"Wrote refreshed Pi OAuth credentials back for: {', '.join(sorted(written))}", file=sys.stderr)
        return 0
    print(__doc__[__doc__.index("Usage:"):].rstrip(), file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
