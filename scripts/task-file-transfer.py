"""Copy one file the agent task wrote to a host mount, treating it as data only.

Agent entrypoints start as root, run the task as node, and afterwards copy a
few files the task could write (refreshed OAuth tokens, the transcript) back
to mounts the host reads. Neither half trusts the paths it is given:

  read ROOT RELPATH MAX_BYTES         run as node; prints one framed file
  read-match ROOT SUFFIX MAX_BYTES    the same for the first file under ROOT
                                      whose path ends in /SUFFIX
  write ROOT RELPATH MAX_BYTES MODE [--parents] [--force-mode]
                                      run with the entrypoint's privileges;
                                      reads one frame from stdin and replaces
                                      ROOT/RELPATH with it atomically

Every path is opened one component at a time from / with O_NOFOLLOW, so a
symlink anywhere in it is refused rather than followed. The source must be a
regular file with a single link and at most MAX_BYTES. The frame carries the
size the reader saw, and the writer commits only once it has received exactly
that many bytes followed by end of input, so a reader that fails part-way
never replaces the destination. A destination that already exists keeps its
owner and mode (without set-id bits) unless --force-mode is given; a new one,
or one that replaces a symlink (never written through), gets MODE and the
owner of its directory.

Exit status: 0 copied, 3 nothing to copy (the source does not exist), 2
refused or failed.
"""

import errno
import os
import stat
import sys

ABSENT = 3
REFUSED = 2
FRAME_MAGIC = b"propr-task-file-v1 "
CHUNK = 1 << 16
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Refused(Exception):
    pass


class Absent(Exception):
    pass


def components(path, absolute):
    if absolute and not path.startswith("/"):
        raise Refused(f"{path!r} is not an absolute path")
    if not absolute and (not path or path.startswith("/")):
        raise Refused(f"{path!r} is not a relative path")
    parts = [part for part in path.split("/") if part]
    if any(part in (".", "..") for part in parts):
        raise Refused(f"{path!r} contains . or ..")
    return parts


def open_child_directory(parent_fd, name, create):
    try:
        return os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except FileNotFoundError:
        if not create:
            raise Absent(name) from None
    except OSError as error:
        if error.errno in (errno.ENOTDIR, errno.ELOOP):
            raise Refused(f"{name!r} is a symbolic link or not a directory") from None
        raise
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    if os.geteuid() == 0:
        parent = os.fstat(parent_fd)
        os.fchown(fd, parent.st_uid, parent.st_gid)
    return fd


def open_directory(parts, create=False):
    """Open /parts[0]/parts[1]/... refusing symlinks; the caller closes the fd."""
    fd = os.open("/", DIRECTORY_FLAGS)
    try:
        for part in parts:
            child = open_child_directory(fd, part, create)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_source(dir_fd, name, max_bytes):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    except FileNotFoundError:
        raise Absent(name) from None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise Refused(f"{name!r} is a symbolic link") from None
        raise
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        raise Refused(f"{name!r} is not a regular file")
    if info.st_nlink != 1:
        os.close(fd)
        raise Refused(f"{name!r} has {info.st_nlink} hard links")
    if info.st_size > max_bytes:
        os.close(fd)
        raise Refused(f"{name!r} is larger than {max_bytes} bytes")
    return fd, info.st_size


def emit(fd, size):
    out = sys.stdout.buffer
    out.write(FRAME_MAGIC + str(size).encode() + b"\n")
    remaining = size
    while remaining:
        chunk = os.read(fd, min(CHUNK, remaining))
        if not chunk:
            raise Refused("the file shrank while it was read")
        out.write(chunk)
        remaining -= len(chunk)
    if os.read(fd, 1):
        # Poison the frame so the writer refuses it instead of committing a prefix.
        out.write(b"!")
        raise Refused("the file grew while it was read")
    out.flush()


def read(root, relpath, max_bytes):
    parts = components(relpath, absolute=False)
    dir_fd = open_directory(components(root, absolute=True) + parts[:-1])
    try:
        fd, size = open_source(dir_fd, parts[-1], max_bytes)
    finally:
        os.close(dir_fd)
    try:
        emit(fd, size)
    finally:
        os.close(fd)


def read_match(root, suffix, max_bytes):
    """Frame the first regular file under root whose path ends in /suffix."""
    wanted = components(suffix, absolute=False)
    root_fd = open_directory(components(root, absolute=True))
    try:
        # fwalk never follows symlinks to directories; the file itself is
        # opened relative to its directory fd with O_NOFOLLOW.
        for dirpath, dirnames, filenames, dir_fd in os.fwalk(".", dir_fd=root_fd, follow_symlinks=False):
            dirnames.sort()
            if wanted[-1] not in filenames:
                continue
            path = [part for part in dirpath.split("/") if part not in ("", ".")]
            parents = wanted[:-1]
            if len(path) < len(parents) or path[len(path) - len(parents):] != parents:
                continue
            fd, size = open_source(dir_fd, wanted[-1], max_bytes)
            try:
                emit(fd, size)
            finally:
                os.close(fd)
            return
    finally:
        os.close(root_fd)
    raise Absent(suffix)


def read_frame_header(stream, max_bytes):
    header = stream.readline(64)
    if not header:
        raise Absent("no file on stdin")
    if not header.startswith(FRAME_MAGIC) or not header.endswith(b"\n"):
        raise Refused("malformed input frame")
    digits = header[len(FRAME_MAGIC):-1]
    if not digits.isdigit():
        raise Refused("malformed input frame")
    size = int(digits)
    if size > max_bytes:
        raise Refused(f"input is larger than {max_bytes} bytes")
    return size


def copy_frame(stream, fd, size):
    remaining = size
    while remaining:
        chunk = stream.read(min(CHUNK, remaining))
        if not chunk:
            raise Refused("input ended early")
        write_all(fd, chunk)
        remaining -= len(chunk)
    if stream.read(1):
        raise Refused("input has trailing data")


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def write(root, relpath, max_bytes, mode, parents, force_mode):
    stream = sys.stdin.buffer
    size = read_frame_header(stream, max_bytes)
    parts = components(relpath, absolute=False)
    name = parts[-1]
    try:
        parent_fd = open_directory(components(root, absolute=True) + parts[:-1], create=parents)
    except Absent as missing:
        # Only a missing source means "nothing to copy"; this is a failed write.
        raise Refused(f"destination directory {missing} does not exist") from None
    temporary = f"{name}.propr-tmp-{os.getpid()}"
    created = False
    try:
        try:
            existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and stat.S_ISLNK(existing.st_mode):
            # The rename replaces the link itself; nothing is written through it.
            existing = None
        elif existing is not None and not stat.S_ISREG(existing.st_mode):
            raise Refused(f"destination {name!r} is not a regular file")
        owner = os.fstat(parent_fd) if existing is None else existing
        target_mode = mode if existing is None or force_mode else existing.st_mode & 0o777
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent_fd)
        created = True
        try:
            copy_frame(stream, fd, size)
            if os.geteuid() == 0:
                os.fchown(fd, owner.st_uid, owner.st_gid)
            os.fchmod(fd, target_mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        created = False
        os.fsync(parent_fd)
    finally:
        if created:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)


def main(argv):
    try:
        action, root, path, max_bytes = argv[1:5]
        max_bytes = int(max_bytes)
        if action == "read" and len(argv) == 5:
            read(root, path, max_bytes)
        elif action == "read-match" and len(argv) == 5:
            read_match(root, path, max_bytes)
        elif action == "write" and len(argv) >= 6 and set(argv[6:]) <= {"--parents", "--force-mode"}:
            write(root, path, max_bytes, int(argv[5], 8) & 0o777, "--parents" in argv[6:], "--force-mode" in argv[6:])
        else:
            raise ValueError
    except (ValueError, IndexError):
        sys.stderr.write(__doc__)
        return REFUSED
    except Absent:
        return ABSENT
    except Refused as error:
        sys.stderr.write(f"task-file-transfer: refused: {error}\n")
        return REFUSED
    except OSError as error:
        sys.stderr.write(f"task-file-transfer: {error.strerror or error}\n")
        return REFUSED
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
