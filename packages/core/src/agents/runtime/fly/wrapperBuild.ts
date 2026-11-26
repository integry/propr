// The derived-image build half of the Fly Machine wrapper (fly-run.py), spliced
// into `wrapper`: snapshot the root filesystem, install, write the change as an
// OCI layer, then read the layer back and check it against dpkg before the
// worker downloads it. Python source in a template literal: no backticks, and
// a literal dollar-brace must be built by concatenation.
export const BUILD_PYTHON = String.raw`
# Paths that are not part of the image: kernel and runtime mounts, files Fly
# writes into every Machine, this wrapper's own files and apt's download caches.
BUILD_EXCLUDE = frozenset(['/proc', '/sys', '/dev', '/run', '/tmp', '/mnt', '/lost+found', '/.fly', '/.fly-upper-layer',
    str(run), '/opt/propr', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf', '/var/lib/apt/lists',
    '/var/cache/apt/archives', '/var/cache/apt/pkgcache.bin', '/var/cache/apt/srcpkgcache.bin', '/var/cache/debconf/config.dat-old',
    '/var/cache/debconf/templates.dat-old', '/var/log/apt', '/var/log/dpkg.log', '/var/log/alternatives.log'])

def mount_points(root='/'):
    # Image paths of every mount below the root filesystem. Paths on them are
    # not part of the image (kernel filesystems, tmpfs, bind-mounted files).
    root = os.path.realpath(root)
    points = set()
    try:
        with open('/proc/self/mountinfo') as f:
            lines = f.read().splitlines()
    except OSError:
        return points
    for line in lines:
        fields = line.split(' ')
        if len(fields) < 5:
            continue
        point = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), fields[4])
        if root != '/':
            if point != root and not point.startswith(root + '/'):
                continue
            point = point[len(root):] or '/'
        if point != '/':
            points.add(point)
    return points

def snapshot(root='/'):
    # Metadata of every path on the root filesystem, keyed by its image path;
    # ctime and inode catch in-place rewrites, renames and owner or mode changes.
    # Mounts are skipped by mount point. Only directories are compared by
    # device: on an overlay root whose layers are on different filesystems a
    # regular file reports its layer's device, not the root's, and a device
    # check on files would leave every installed file out of the layer.
    real = lambda path: os.path.join(root, path[1:])
    root_dev = os.lstat(root).st_dev
    mounts = mount_points(root)
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
            if path in BUILD_EXCLUDE or path in mounts:
                continue
            try:
                st = os.lstat(real(path))
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode) and st.st_dev != root_dev:
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

# Built by concatenation: this file is a JavaScript template literal.
DPKG_FIELDS = '\t'.join('$' + '{%s}' % f for f in ('Package', 'Status', 'Installed-Size', 'Provides')) + '\n'

def dpkg_installed(dpkg_query='dpkg-query'):
    # name -> (installed size in bytes, names it provides) for every installed package.
    output = subprocess.run([dpkg_query, '-W', '-f=' + DPKG_FIELDS], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            stdin=subprocess.DEVNULL, check=True).stdout.decode('utf8', 'replace')
    installed = {}
    for line in output.splitlines():
        parts = (line.split('\t') + ['', '', '', ''])[:4]
        if parts[1] != 'install ok installed':
            continue
        size = int(parts[2]) * 1024 if parts[2].isdigit() else 0
        provides = {p.strip().split(' ')[0].split(':')[0] for p in parts[3].split(',') if p.strip()}
        installed[parts[0]] = (size, provides)
    return installed

def dpkg_excluded(root='/'):
    # dpkg path-exclude/path-include filters (slim base images drop docs and
    # man pages this way); dpkg -L still lists the files it did not unpack.
    filters = []
    directory = os.path.join(root, 'etc/dpkg/dpkg.cfg.d')
    files = [os.path.join(root, 'etc/dpkg/dpkg.cfg')]
    try:
        files += [os.path.join(directory, n) for n in sorted(os.listdir(directory))]
    except OSError:
        pass
    for name in files:
        try:
            lines = Path(name).read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            # 'path-exclude /usr/share/doc/*' or 'path-exclude=/usr/share/doc/*'
            parts = re.split(r'[=\s]+', line.strip().lstrip('-'), maxsplit=1)
            if len(parts) == 2 and parts[0] in ('path-exclude', 'path-include') and parts[1]:
                filters.append((parts[0] == 'path-include', parts[1].strip()))
    def excluded(path):
        skip = False
        for include, pattern in filters:
            if fnmatch.fnmatchcase(path, pattern):
                skip = not include
        return skip
    return excluded

def image_path(path, root='/'):
    # The image path of a dpkg -L entry, through symlinked parents (/bin -> usr/bin).
    root = os.path.realpath(root)
    parent = os.path.realpath(os.path.join(root, os.path.dirname(path)[1:]))
    if parent != root and not parent.startswith(root + '/'):
        return None
    return os.path.join(parent[len(root):] or '/', os.path.basename(path))

def outside_image(path, mounts):
    return any(p in BUILD_EXCLUDE or p in mounts for p in [path] + list(ancestors(path)))

def verify_layer(requested, before_installed, before, after, layer_file, root='/', dpkg_query='dpkg-query', dpkg_list=None):
    # Reads the layer back and checks every requested package is installed and
    # each file dpkg lists for it is in the layer, or unchanged in the base
    # image. Raises with the first problem; returns what the worker re-checks.
    installed = dpkg_installed(dpkg_query)
    with tarfile.open(layer_file, 'r:gz') as tar:
        members = {'/' + m.name.rstrip('/') for m in tar.getmembers()}
    mounts = mount_points(root)
    excluded = dpkg_excluded(root)
    listing = dpkg_list or (lambda name: subprocess.run([dpkg_query, '-L', name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                                         stdin=subprocess.DEVNULL, check=True).stdout.decode('utf8', 'replace').splitlines())
    installed_bytes = 0
    files = 0
    for name in requested:
        package = name if name in installed else next((p for p, (_, provides) in sorted(installed.items()) if name in provides), None)
        if package is None:
            raise RuntimeError('%s is not installed (dpkg-query reports no "install ok installed" package or provider)' % name)
        if package not in before_installed:
            installed_bytes += installed[package][0]
        for entry in listing(package):
            if not entry.startswith('/') or entry == '/.':
                continue
            path = image_path(entry, root)
            if path is None or outside_image(path, mounts):
                continue
            real = os.path.join(root, path[1:])
            if not os.path.lexists(real):
                if excluded(entry) or excluded(path):
                    continue
                raise RuntimeError('%s lists %s, which does not exist after the install' % (package, entry))
            if os.path.isdir(real) and not os.path.islink(real):
                continue
            if path not in members and not (path in before and before[path] == after.get(path)):
                raise RuntimeError('%s installed %s, but the layer does not contain it' % (package, path))
            files += 1
    return {'packages': len(requested), 'files': files, 'installedBytes': installed_bytes}

def build():
    # A derived image build Machine: install the packages on the base image and
    # leave the change as a layer for the worker to push. No credential is here.
    run.chmod(0o700)
    status('building')
    spec = json.loads((run / 'build.json').read_bytes())
    before = snapshot()
    before_installed = dpkg_installed()
    result = run_install(spec)
    if result['code'] == 0:
        try:
            after = snapshot()
            layer = write_layer(before, after, run / 'layer.tar.gz')
            result['verified'] = verify_layer(spec['verify'], before_installed, before, after, run / 'layer.tar.gz')
            result['layer'] = layer
        except Exception as error:
            result['error'] = type(error).__name__ + ': ' + str(error)[:500]
    write_json('build-result', result)
    status('built' if 'layer' in result else 'build-error' if result['code'] == 0 else 'build-failed')
    os.utime(run, None)
    wait_for_ack(300)
`;
