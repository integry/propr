"""Seed and sync Pi credentials between the host auth.json and a disposable copy.

The Pi entrypoint copies the host auth.json into a disposable agent dir before
the run. `seed` records what was copied. `sync`, after the run, writes OAuth
refreshes Pi made in the disposable copy back to the host file, per provider
entry and only while the host entry still equals what was seeded, so a host
login or logout during the run wins. API-key entries are never rewritten, and
nothing is written when no OAuth entry changed.

Files are data only: every read is size-limited, opens with O_NOFOLLOW and
accepts nothing but a JSON object. The write-back target must be a regular
file (never a symlink); it is replaced through a temporary file in the same
directory carrying the original owner, group and mode.

`import` copies one allowlisted file from the pinned host Pi dir (fd 9) into
the disposable agent dir: the source name is a plain file name opened with
O_NOFOLLOW under the pinned directory, must be a regular file of bounded size,
and the copy is created new (O_EXCL, O_NOFOLLOW) and owner-only.

Usage:
    pi-credentials.py import <file name> <runtime destination>
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
# auth.json holds a handful of provider entries; anything larger is not one.
MAX_AUTH_BYTES = 1024 * 1024


# Imported settings and context files (AGENTS.md, SYSTEM.md, ...).
MAX_IMPORT_BYTES = 8 * 1024 * 1024
PINNED_SOURCE_DIR = "/proc/self/fd/9"
IMPORTABLE_FILES = {"auth.json", "settings.json", "models.json", "AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"}
IMPORT_OK, IMPORT_MISSING, IMPORT_REFUSED = 0, 2, 3


# A stdin record is one line of ASCII-escaped JSON: up to 6 bytes per byte.
MAX_RECORD_BYTES = MAX_AUTH_BYTES * 6


def parse_auth(raw, limit=MAX_AUTH_BYTES):
    """A JSON object from at most `limit` bytes of UTF-8, else None."""
    if len(raw) > limit:
        return None
    try:
        # Pi strips a UTF-8 BOM before parsing; do the same.
        value = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def read_json_with_metadata(path):
    """Read a regular file as JSON data, never following a final symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        # Missing, a symlink (ELOOP), or otherwise unreadable: no data.
        return None, None
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            return None, None
        chunks, remaining = [], MAX_AUTH_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    except OSError:
        return None, None
    finally:
        os.close(fd)
    auth = parse_auth(b"".join(chunks))
    return (auth, metadata) if auth is not None else (None, None)


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


def lock_wait_seconds():
    """The lock wait bound. The root entrypoint runs this helper with an empty
    environment, so only unprivileged test runs can shorten it."""
    try:
        value = float(os.environ.get("PROPR_PI_LOCK_WAIT_SECONDS", ""))
    except ValueError:
        return LOCK_WAIT_SECONDS
    return value if 0 < value <= LOCK_WAIT_SECONDS else LOCK_WAIT_SECONDS


class LockTimeout(Exception):
    pass


class AuthLock:
    """proper-lockfile compatible lock on a Pi auth.json."""

    def __init__(self, auth_path):
        # The caller supplies the resolved target. Keep a pinned parent intact.
        self.path = auth_path.with_name(auth_path.name + ".lock")

    def __enter__(self):
        # Every unsuccessful attempt, including a stale lock that cannot be
        # removed (a nonempty or non-directory `.lock`, a dangling link),
        # passes the deadline check: the wait is bounded whatever the lock is.
        wait = lock_wait_seconds()
        deadline = time.monotonic() + wait
        while True:
            try:
                os.mkdir(self.path, 0o700)
                return self
            except FileExistsError:
                pass
            if self._remove_if_stale():
                # Retry at once, but never past the deadline.
                if time.monotonic() < deadline:
                    continue
            if time.monotonic() >= deadline:
                raise LockTimeout(f"{self.path} is held by another process or could not be removed after {wait:g}s")
            time.sleep(LOCK_RETRY_SECONDS)

    def _remove_if_stale(self):
        """True when a stale lock was removed; an unremovable one is left intact."""
        try:
            stale = time.time() - os.lstat(self.path).st_mtime > LOCK_STALE_SECONDS
        except OSError:
            # Gone since mkdir (retry), or not inspectable: wait like contention.
            return False
        if not stale:
            return False
        try:
            os.rmdir(self.path)
        except OSError:
            return False
        return True

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
    content = json.dumps(read_json(runtime_auth), ensure_ascii=True, separators=(",", ":"))
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
    return write_refreshes(Path(host_auth), read_json(snapshot), read_json(runtime_auth))


def is_regular_file(path):
    """True for a regular file that is not a symlink."""
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def write_refreshes(host_auth, seeded, runtime, source=None):
    changes = refreshed_entries(seeded, runtime)
    # Refuse a symlinked (or otherwise non-regular) target outright.
    if not changes or not is_regular_file(host_auth):
        return []
    with AuthLock(host_auth):
        # The source may have been replaced while Pi ran or while we waited.
        if source is not None and (not is_regular_file(source) or Path(os.path.realpath(source)) != host_auth.parent.resolve() / host_auth.name):
            return []
        current, metadata = read_json_with_metadata(host_auth)
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


def import_file(name, destination):
    """Copy an allowlisted regular file from the pinned source dir; returns an IMPORT_* code."""
    if name not in IMPORTABLE_FILES:
        print(f"Warning: refusing to import Pi {name!r}: not an importable file", file=sys.stderr)
        return IMPORT_REFUSED
    try:
        fd = os.open(os.path.join(PINNED_SOURCE_DIR, name), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOCTTY)
    except FileNotFoundError:
        return IMPORT_MISSING
    except OSError as error:
        reason = "it is a symlink; replace it with the file itself" if error.errno == errno.ELOOP else error.strerror
        print(f"Warning: not importing Pi {name}: {reason}", file=sys.stderr)
        return IMPORT_REFUSED
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            print(f"Warning: not importing Pi {name}: not a regular file", file=sys.stderr)
            return IMPORT_REFUSED
        chunks, remaining = [], MAX_IMPORT_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    content = b"".join(chunks)
    if len(content) > MAX_IMPORT_BYTES:
        print(f"Warning: not importing Pi {name}: larger than {MAX_IMPORT_BYTES} bytes", file=sys.stderr)
        return IMPORT_REFUSED
    out = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(content)
        while view:
            view = view[os.write(out, view):]
    finally:
        os.close(out)
    return IMPORT_OK


def main(argv):
    if len(argv) == 3 and argv[0] == "import":
        return import_file(argv[1], argv[2])
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
                # Both are size-limited and must be JSON objects; anything
                # else is treated as "nothing to write back".
                seeded = parse_auth(sys.stdin.buffer.readline(MAX_RECORD_BYTES + 2).rstrip(b"\n"), MAX_RECORD_BYTES)
                runtime = parse_auth(sys.stdin.buffer.readline(MAX_RECORD_BYTES + 2).rstrip(b"\n"), MAX_RECORD_BYTES)
                host_auth = Path("/proc/self/fd/9") / Path(argv[2]).name
                written = write_refreshes(host_auth, seeded, runtime, source=argv[1])
        except LockTimeout as error:
            print(f"Warning: skipping the Pi credential write-back, the host auth.json keeps its previous login: {error}", file=sys.stderr)
            return 3
        if written:
            print(f"Wrote refreshed Pi OAuth credentials back for: {', '.join(sorted(written))}", file=sys.stderr)
        return 0
    print(__doc__[__doc__.index("Usage:"):].rstrip(), file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
