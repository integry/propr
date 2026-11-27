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
"""

import errno
import json
import os
import stat
import sys
import time
from pathlib import Path

# Pi serializes auth.json writes with proper-lockfile: a `<auth.json>.lock`
# directory whose mtime it refreshes while held, and which it treats as stale
# after 30 seconds. Take the same lock so a host Pi refresh never interleaves
# with the write-back.
LOCK_STALE_SECONDS = 30
LOCK_WAIT_SECONDS = 30
LOCK_RETRY_SECONDS = 0.1


def read_json(path):
    try:
        # Pi strips a UTF-8 BOM before parsing; do the same.
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return None


def is_oauth(entry):
    return isinstance(entry, dict) and entry.get("type") == "oauth"


def write_private(path, content, mode=0o600):
    """Write `content` to `path` atomically via an owner-only temp file, then apply `mode`."""
    path = Path(path)
    temporary = path.with_name(f"{path.name}.propr-tmp-{os.getpid()}")
    try:
        # O_EXCL with 0o600: the tokens are never readable by others, whatever
        # the umask or the directory mode, and a planted file is not reused.
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class LockTimeout(Exception):
    pass


class AuthLock:
    """proper-lockfile compatible lock on a Pi auth.json."""

    def __init__(self, auth_path):
        self.path = Path(os.path.realpath(auth_path) + ".lock")

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
    snapshot = Path(snapshot)
    snapshot.unlink(missing_ok=True)
    write_private(snapshot, json.dumps(read_json(runtime_auth)))


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
    host_auth = Path(host_auth)
    if not Path(snapshot).is_file():
        return []
    seeded = read_json(snapshot)
    changes = refreshed_entries(seeded, read_json(runtime_auth))
    if not changes or not host_auth.is_file():
        return []
    with AuthLock(host_auth):
        current = read_json(host_auth)
        if not isinstance(current, dict):
            return []
        # Compare-and-swap per entry: a host login, logout or its own refresh
        # since the seed leaves the host entry different, and the host wins.
        written = [provider for provider, entry in changes.items() if current.get(provider) == seeded[provider]]
        if not written:
            return []
        for provider in written:
            current[provider] = changes[provider]
        write_private(host_auth, serialize(current), stat.S_IMODE(host_auth.stat().st_mode))
    return written


def main(argv):
    if len(argv) == 3 and argv[0] == "seed":
        seed(argv[1], argv[2])
        return 0
    if len(argv) == 4 and argv[0] == "sync":
        try:
            written = sync(argv[1], argv[2], argv[3])
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
