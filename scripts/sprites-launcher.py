"""Installed on the clean Sprite. Only 'launch' starts with privileges."""
import base64
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import stat
import subprocess
import sys

ROOT = Path('/opt/propr/run')
RESULT = Path('/opt/propr/result')
LIMIT = 1024 * 1024
PYTHON = '/usr/bin/python3'
LAUNCHER = '/opt/propr/launcher.py'


def write_json(path, value):
    path.write_text(json.dumps(value))


def install_and_launch(upload):
    # This phase runs exactly once on a restored filesystem, before the first
    # process running as node. No path supplied by the repository is installed.
    os.umask(0o077)
    run = json.loads(upload.read_bytes())
    upload.unlink()
    ROOT.mkdir(mode=0o755)
    ROOT.chmod(0o711)
    # The launch has its own private mount namespace. Even tools with hardcoded
    # /tmp paths write to the checkpointed root, including detached children.
    scratch = ROOT / 'tmp'
    scratch.mkdir()
    scratch.chmod(0o1777)
    subprocess.run(['mount', '--bind', str(scratch), '/tmp'], cwd='/', check=True)
    node = pwd.getpwnam('node')
    source = ROOT / 'source'
    source.mkdir()
    for dest, content, executable in run['files']:
        target = source / dest
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(content))
        os.chown(target, 0, node.pw_gid)
        target.chmod(0o550 if executable else 0o440)
    for directory, _, _ in os.walk(source):
        os.chown(directory, 0, node.pw_gid)
        os.chmod(directory, 0o750)
    export = ROOT / 'export'
    export.mkdir()
    os.chown(export, int(os.environ['SUDO_UID']), -1)
    write_json(ROOT / 'agent.json', run['agent'])
    os.chown(ROOT / 'agent.json', 0, node.pw_gid)
    (ROOT / 'agent.json').chmod(0o440)
    input_file = ROOT / 'stdin'
    input_file.write_text(run['stdin'])
    RESULT.mkdir(mode=0o700)
    with input_file.open('rb') as prompt:
        child = subprocess.Popen(run['transport'], env=run['transportEnv'], stdin=prompt,
                                 cwd='/', start_new_session=True)

        def forward(signum, _frame):
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass

        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, forward)
        code = child.wait()
    # Only the trusted workspace transport writes here. Make its two result
    # files readable by the SDK's filesystem user, even for a nonzero exit.
    for name in ('status', 'result.bundle'):
        file = RESULT / name
        if file.exists():
            file.chmod(0o644)
    RESULT.chmod(0o711)
    return code


def agent():
    assert os.geteuid() != 0
    data = json.loads((ROOT / 'agent.json').read_bytes())
    for directory in data['directories']:
        Path(directory).mkdir(parents=True, exist_ok=True)
    if data['store']:
        shutil.copytree(ROOT / 'source', data['store'], dirs_exist_ok=True)
        for directory, _, files in os.walk(data['store']):
            os.chmod(directory, 0o700)
            for name in files:
                file = Path(directory) / name
                file.chmod(0o700 if file.stat().st_mode & 0o100 else 0o600)
    if data.get('claudeSeed') is not None:
        Path('/home/node/.claude.json').write_bytes(base64.b64decode(data['claudeSeed']))
    os.execvpe(data['argv'][0], data['argv'], data['env'])


def regular(path):
    """Pin each directory by fd. Check the opened file again and bound the read."""
    parent = os.open('/', os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        before = os.lstat(path.name, dir_fd=parent)
        if not stat.S_ISREG(before.st_mode) or before.st_size > LIMIT:
            raise ValueError('invalid credential export')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as file:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
                raise ValueError('invalid credential export')
            content = file.read(LIMIT + 1)
            if len(content) > LIMIT:
                raise ValueError('oversized credential export')
            return content, info.st_mtime_ns
    finally:
        os.close(parent)


def credentials(action):
    # The export directory and its numeric filenames stay under worker
    # control. Only the node subprocess traverses a provider HOME.
    if action == 'export':
        data = json.loads((ROOT / 'agent.json').read_bytes())
        outputs = data['outputs']
    else:
        outputs = range(int(sys.argv[2]))
    returned = []
    for index, output in enumerate(outputs):
        dest = ROOT / 'export' / str(index)
        if action == 'export':
            with subprocess.Popen(
                    ['su-exec', 'node', PYTHON, '-I', LAUNCHER, 'read-live', str(Path(data['store']) / output)],
                    cwd='/', stdout=subprocess.PIPE) as child:
                payload = child.stdout.read(LIMIT + 9)
                if len(payload) > LIMIT + 8:
                    child.kill()
                    raise ValueError('oversized credential export')
                if child.wait() != 0:
                    raise ValueError('invalid live credential')
            if payload:
                if len(payload) < 8:
                    raise ValueError('incomplete credential export')
                stamp = int.from_bytes(payload[:8], 'big', signed=True)
                with dest.open('xb') as file:
                    file.write(payload[8:])
                    file.flush()
                    os.utime(file.fileno(), ns=(stamp, stamp))
                    os.fchown(file.fileno(), int(os.environ['SUDO_UID']), -1)
        else:
            try:
                content, stamp = regular(dest)
            except FileNotFoundError:
                continue
            returned.append(dict(index=index, content=base64.b64encode(content).decode(),
                                 mtimeMs=stamp / 1e6))
    if action == 'read-export':
        print(json.dumps(returned))


def read_live(path):
    assert os.geteuid() != 0
    try:
        content, stamp = regular(path)
    except FileNotFoundError:
        return
    sys.stdout.buffer.write(stamp.to_bytes(8, 'big', signed=True) + content)


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'launch':
        sys.exit(install_and_launch(Path(sys.argv[2])))
    elif action == 'read-live':
        read_live(Path(sys.argv[2]))
    elif action == 'agent':
        agent()
    elif action in ('export', 'read-export'):
        credentials(action)
