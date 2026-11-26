// The config files are installed before any repository code runs. Root owns the
// capture directory and the transport environment. Only agent.json is shared.
export const RUN = '/root/propr-run';
export const WRAPPER = '/opt/propr/fly-run.py';
export const AGENT = '/opt/propr/fly-agent.json';
export const wrapper = String.raw`
import base64, errno, gzip, hashlib, json, os, pwd, signal, stat, subprocess, sys, tarfile, threading, time
from pathlib import Path
from urllib.parse import quote

run = Path('${RUN}')
agent = Path('${AGENT}')
wrapper = '${WRAPPER}'
python = '/usr/bin/python3'

def status(value):
    tmp = run / 'status.tmp'
    with tmp.open('w') as f:
        f.write(value + '\n')
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(run / 'status')

def live(stream, secrets, done):
    # The console is best effort. Skip long or unfinished lines rather than
    # leak a split secret or hold up the process writing the physical file.
    with (run / stream).open('rb') as f:
        pending = b''
        dropping = False
        while not done.is_set():
            data = f.readline(8192)
            if not data:
                done.wait(.2)
                continue
            if not dropping:
                pending += data
                if len(pending) > 8192:
                    dropping = True
            if data.endswith(b'\n'):
                if not dropping:
                    for secret in secrets:
                        pending = pending.replace(secret, b'[REDACTED]')
                    print('propr-' + stream + ' ' + json.dumps(pending.decode('utf8', 'replace').rstrip('\n')), flush=True)
                pending = b''
                dropping = False

def run_install(spec):
    # The argv carries the specs as arguments, never as shell text; only
    # trusted values form the environment.
    started = time.monotonic()
    child = subprocess.Popen(spec['argv'], env={'PATH': spec['path'], 'HOME': '/root', 'LANG': 'C.UTF-8'}, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output, _ = child.communicate(timeout=spec['timeout'] / 1000)
        code = child.returncode
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        output, _ = child.communicate()
        code = 'timeout'
    return {'ms': round((time.monotonic() - started) * 1000), 'code': code, 'tail': output[-4096:].decode('utf8', 'replace')}

def write_json(name, value):
    tmp = run / (name + '.tmp')
    tmp.write_text(json.dumps(value))
    tmp.replace(run / name)

def wait_for_ack(idle):
    # Keep the Machine while the worker reads it (chunk reads touch the run
    # directory), then exit so auto_destroy removes it.
    while not (run / 'packages-read').exists() and time.time() - run.stat().st_mtime < idle:
        time.sleep(.2)

def install_packages(spec):
    # Before dropping to node and before reporting ready: the run never starts
    # without its packages.
    status('installing')
    result = run_install(spec)
    write_json('packages-result', result)
    if result['code'] == 0:
        return True
    status('install-failed')
    os.utime(run, None)
    wait_for_ack(300)
    return False

# Paths that are not part of the image: kernel and runtime mounts, files Fly
# writes into every Machine, this wrapper's own files and apt's download caches.
BUILD_EXCLUDE = frozenset(['/proc', '/sys', '/dev', '/run', '/tmp', '/mnt', '/lost+found', '/.fly', '/.fly-upper-layer',
    str(run), '/opt/propr', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/var/lib/apt/lists',
    '/var/cache/apt/archives', '/var/cache/apt/pkgcache.bin', '/var/cache/apt/srcpkgcache.bin', '/var/cache/debconf/config.dat-old',
    '/var/cache/debconf/templates.dat-old', '/var/log/apt', '/var/log/dpkg.log', '/var/log/alternatives.log'])

def snapshot(root='/'):
    # Metadata of every path on the root filesystem, keyed by its image path;
    # ctime and inode catch in-place rewrites, renames and owner or mode changes.
    real = lambda path: os.path.join(root, path[1:])
    root_dev = os.lstat(root).st_dev
    entries = {}
    stack = ['/']
    while stack:
        directory = stack.pop()
        try:
            names = os.listdir(real(directory))
        except OSError:
            continue
        for name in names:
            path = os.path.join(directory, name)
            if path in BUILD_EXCLUDE:
                continue
            try:
                st = os.lstat(real(path))
            except OSError:
                continue
            if st.st_dev != root_dev:
                continue
            link = os.readlink(real(path)) if stat.S_ISLNK(st.st_mode) else None
            entries[path] = (st.st_mode, st.st_uid, st.st_gid, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino, link)
            if stat.S_ISDIR(st.st_mode):
                stack.append(path)
    return entries

class Digest:
    def __init__(self, target):
        self.target = target
        self.hash = hashlib.sha256()
        self.size = 0
    def write(self, data):
        self.hash.update(data)
        self.size += len(data)
        return self.target.write(data)
    def flush(self):
        self.target.flush()

def ancestors(path):
    parent = os.path.dirname(path)
    while parent != '/':
        yield parent
        parent = os.path.dirname(parent)

def write_layer(before, after, target, root='/'):
    # An OCI layer of what the install changed: changed and added paths with
    # their parent directories, and a whiteout for each topmost removed path.
    # A directory replaced by a file or symlink gets a whiteout at its parent,
    # ahead of the replacement, and no whiteouts beneath it: those would have
    # to traverse the replacement to apply.
    changed = {p for p, v in after.items() if before.get(p) != v}
    replaced = {p for p in changed if p in before and stat.S_ISDIR(before[p][0]) and not stat.S_ISDIR(after[p][0])}
    removed = {p for p in before if p not in after}
    removed = {p for p in removed if not any(a in removed or a in replaced for a in ancestors(p))}
    whiteouts = {os.path.join(os.path.dirname(p), '.wh.' + os.path.basename(p)): p for p in removed | replaced}
    members = set(changed)
    for path in list(changed) + list(whiteouts):
        members.update(a for a in ancestors(path) if a in after)
    # Parent first; the whiteout of a replaced directory sorts just before its
    # replacement whatever the name, since appliers remove the whiteout's target.
    order = lambda p: (whiteouts[p].split('/'), 0) if whiteouts.get(p) in replaced else (p.split('/'), 1)
    with open(target, 'wb') as out:
        compressed = Digest(out)
        gz = gzip.GzipFile(filename='', mode='wb', fileobj=compressed, mtime=0, compresslevel=6)
        raw = Digest(gz)
        with tarfile.open(fileobj=raw, mode='w|', format=tarfile.PAX_FORMAT) as tar:
            for path in sorted(members | set(whiteouts), key=order):
                if path in whiteouts:
                    info = tarfile.TarInfo(path[1:])
                    info.mtime = 0
                    tar.addfile(info)
                else:
                    tar.add(os.path.join(root, path[1:]), arcname=path[1:], recursive=False)
        gz.close()
        out.flush()
        os.fsync(out.fileno())
    return {'digest': 'sha256:' + compressed.hash.hexdigest(), 'size': compressed.size,
            'diffId': 'sha256:' + raw.hash.hexdigest(), 'changed': len(changed), 'removed': len(whiteouts)}

def build():
    # A derived image build Machine: install the packages on the base image and
    # leave the change as a layer for the worker to push. No credential is here.
    run.chmod(0o700)
    status('building')
    spec = json.loads((run / 'build.json').read_bytes())
    before = snapshot()
    result = run_install(spec)
    if result['code'] == 0:
        try:
            result['layer'] = write_layer(before, snapshot(), run / 'layer.tar.gz')
        except Exception as error:
            result['error'] = type(error).__name__ + ': ' + str(error)[:500]
    write_json('build-result', result)
    status('built' if 'layer' in result else 'build-error' if result['code'] == 0 else 'build-failed')
    os.utime(run, None)
    wait_for_ack(300)

def launch():
    run.chmod(0o700)
    packages = run / 'packages.json'
    if packages.exists() and not install_packages(json.loads(packages.read_bytes())):
        return
    data = json.loads((run / 'input').read_bytes())
    node = pwd.getpwnam('node')
    for directory in data['directories']:
        Path(directory).mkdir(parents=True, exist_ok=True)
        os.chown(directory, node.pw_uid, node.pw_gid)
    if data['backupTmpfs']:
        target = '/home/node/.claude/backups'
        subprocess.run(['/bin/mount', '-t', 'tmpfs', '-o', 'rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=%d,gid=%d' % (node.pw_uid, node.pw_gid), 'tmpfs', target], check=True)
    for file in data['owned']:
        os.chown(file, node.pw_uid, node.pw_gid)
    os.chown(agent, 0, node.pw_gid)
    os.chmod(agent, 0o640)
    child = None
    pending = []
    def forward(sig, frame):
        if child is None:
            pending.append(sig)
        elif child.poll() is None:
            if sig == signal.SIGALRM:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                child.send_signal(sig)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGUSR1, signal.SIGUSR2, signal.SIGALRM):
        signal.signal(sig, forward)
    credential_pending = bool(data.get('credentialPath'))
    status('ready')
    deadline = time.monotonic() + data['bootTimeout'] / 1000
    while not (run / 'start').exists():
        if pending or time.monotonic() >= deadline:
            return
        time.sleep(.1)
    if pending:
        return
    if credential_pending:
        (run / 'credential-pending').touch()
    done = threading.Event()
    with (run / 'stdin').open('rb') as stdin, (run / 'stdout').open('wb') as out, (run / 'stderr').open('wb') as err:
        child = subprocess.Popen(data['command'], env=data['transportEnv'], stdin=stdin, stdout=out, stderr=err, start_new_session=True)
        status('running')
        for sig in pending:
            forward(sig, None)
        secrets = set()
        for secret in data['secrets']:
            if secret:
                raw = secret.encode()
                secrets.update(line for line in raw.splitlines() if len(line) >= 12)
                secrets.update([base64.b64encode(raw), raw.hex().encode(), quote(secret, safe='').encode()])
        secrets = sorted(filter(None, secrets), key=len, reverse=True)
        for stream in ('stdout', 'stderr'):
            threading.Thread(target=live, args=(stream, secrets, done), daemon=True).start()
        # Backstop for a lost worker. Its normal execution deadline signals us
        # first, allowing the clone wrapper to finish its snapshot.
        try:
            code = child.wait(timeout=data['timeout'] / 1000 + 120)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                code = child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                if not credential_pending:
                    os._exit(1)
                forward(signal.SIGALRM, None)
                code = child.wait()
        done.set()
    status('exited ' + str(code if code >= 0 else 128 - code))
    wait_for_retrieval(credential_pending, data['credentialRetention'])

def wait_for_retrieval(credential_pending, credential_retention):
    deadline = time.monotonic() + credential_retention
    while True:
        if (run / 'workspace' / 'result.bundle').exists() or (credential_pending and (run / 'credential-pending').exists()):
            remaining = deadline - time.monotonic()
        elif not credential_pending or (run / 'workspace-pending').exists():
            remaining = 900 - (time.time() - run.stat().st_mtime)
        else:
            return
        if remaining <= 0:
            return
        time.sleep(min(30, remaining))

def export(path):
    # Called as node. No ancestor symlinks, no devices/FIFOs, size and bytes
    # from the same descriptor, even if a background agent swaps the path.
    directory = os.open('/', os.O_DIRECTORY)
    parts = Path(path).parts[1:]
    try:
        for part in parts[:-1]:
            fd = os.open(part, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
        with os.fdopen(fd, 'rb') as f:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_size > 1048576:
                raise ValueError('Invalid credential file')
            content = f.read(1048577)
            if len(content) != st.st_size:
                raise ValueError('Incomplete credential file')
            print(json.dumps([st.st_mtime_ns / 1000000, base64.b64encode(content).decode()]))
    except OSError as error:
        if error.errno != errno.ENOENT:
            raise
        print('null')
    finally:
        os.close(directory)

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'launch':
        launch()
    elif mode == 'build':
        build()
    elif mode in ('agent', 'hook'):
        data = json.loads(agent.read_bytes())
        argv = data['argv'] if mode == 'agent' else sys.argv[2:]
        env = data['env']
        if mode == 'hook':
            for name in ('PROPR_WORKSPACE', 'PROPR_CACHE_DIR', 'PROPR_EXECUTION_TIMEOUT_MS', 'LANG'):
                if name in os.environ:
                    env.setdefault(name, os.environ[name])
        os.execvpe(argv[0], argv, env)
    elif mode == 'export':
        export(sys.argv[2])
    elif mode == 'probe':
        state = (run / 'status').read_text().strip()
        print(state)
        print(sum((run / s).stat().st_size for s in ('stdout', 'stderr')) if state == 'running' else 0)
    elif mode == 'size':
        try:
            print(os.stat(sys.argv[2]).st_size)
        except FileNotFoundError:
            sys.exit(44)
    elif mode == 'chunk':
        os.utime(run, None)
        with open(sys.argv[2], 'rb') as f:
            f.seek(int(sys.argv[3]))
            print(base64.b64encode(f.read(int(sys.argv[4]))).decode())
`;
