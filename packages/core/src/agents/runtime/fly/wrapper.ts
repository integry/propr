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

def launch():
    run.chmod(0o700)
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
            child.send_signal(sig)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGUSR1, signal.SIGUSR2):
        signal.signal(sig, forward)
    done = threading.Event()
    with (run / 'stdin').open('rb') as stdin, (run / 'stdout').open('wb') as out, (run / 'stderr').open('wb') as err:
        child = subprocess.Popen(data['command'], env=data['transportEnv'], stdin=stdin, stdout=out, stderr=err)
        status('running')
        for sig in pending:
            forward(sig, None)
        secrets = set()
        for secret in data['secrets']:
            if secret:
                raw = secret.encode()
                secrets.update(raw.splitlines())
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
                os._exit(1)
        done.set()
    status('exited ' + str(code if code >= 0 else 128 - code))
    wait_for_retrieval()

def wait_for_retrieval():
    # A fallback bundle can be the only copy, even after the worker goes away.
    # Other orphaned Machines expire after the ordinary retrieval window.
    while (run / 'workspace' / 'result.bundle').exists() or time.time() - run.stat().st_mtime < 900:
        time.sleep(30)

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
                return
            content = f.read(1048577)
            if len(content) <= 1048576:
                print(json.dumps([st.st_mtime_ns / 1000000, base64.b64encode(content).decode()]))
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            raise
    finally:
        os.close(directory)

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'launch':
        launch()
    elif mode == 'agent':
        data = json.loads(agent.read_bytes())
        os.execvpe(data['argv'][0], data['argv'], data['env'])
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
