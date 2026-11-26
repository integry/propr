// The config files are installed before any repository code runs. Root owns the
// capture directory and the transport environment. Only agent.json is shared.
export const RUN = '/root/propr-run';
export const WRAPPER = '/opt/propr/fly-run.py';
export const AGENT = '/opt/propr/fly-agent.json';
export const wrapper = String.raw`
import base64, errno, json, os, pwd, signal, stat, subprocess, sys, threading, time
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

def install_package_servers():
    # Before dropping to node and before reporting ready: the agent never starts
    # without its package MCP servers. The installer bounds npm and records
    # {ms, code, tail}; only trusted values form its environment.
    spec = run / 'package-servers.json'
    if not spec.exists():
        return True
    status('installing')
    result = run / 'package-servers-result'
    try:
        subprocess.run([python, '-I', '/opt/propr/fly-package-servers.py', str(spec), str(result)], env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=json.loads(spec.read_bytes())['timeout'] / 1000 + 60)
    except subprocess.TimeoutExpired:
        pass
    try:
        if json.loads(result.read_bytes()).get('code') == 0:
            return True
    except (OSError, ValueError):
        pass
    status('install-failed')
    # Keep the Machine for the worker to read the failure, then exit (auto_destroy).
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline and not (run / 'package-servers-read').exists():
        time.sleep(.2)
    return False

def launch():
    run.chmod(0o700)
    if not install_package_servers():
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
    extensions = Path('/opt/propr/extensions')
    if data.get('extensions') and extensions.is_dir() and not extensions.is_symlink():
        for directory, _, names in os.walk(extensions):
            os.chown(directory, 0, 0)
            os.chmod(directory, 0o555)
            for name in names:
                os.chown(Path(directory) / name, 0, 0)
                os.chmod(Path(directory) / name, 0o444)
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
