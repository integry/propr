import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionLibraryPackageServer } from '@propr/shared';
import { ExtensionPackageError, type ExtensionPackageCache, type InstalledPackage } from './packageCache.js';
import { PACKAGE_MOUNT_ROOT } from './packageLaunch.js';

/**
 * Package (stdio) MCP servers on runtimes without bind mounts (Sprites, Fly
 * Machines). The worker installs and verifies each one exactly as for Docker;
 * the run then replays that verified install inside the sandbox: the same
 * package.json and package-lock.json, so every dependency is fetched from the
 * same registry at the same version and checked against the same integrity
 * value by `npm ci`, with lifecycle scripts disabled. The result is
 * root-owned and read-only at `/opt/propr/packages/<key>`.
 */
export interface RemotePackageServer {
  /** The worker cache key: package, version and integrity value. Names the install directory. */
  key: string;
  package: string;
  version: string;
  integrity: string;
  /** The executable relative to the install directory, as on Docker. */
  entry: string;
  /** The worker install's package.json and package-lock.json, verbatim. */
  packageJson: string;
  lock: string;
}

export interface RemotePackageInstall {
  /** The npm registry every dependency in the lock files was resolved from. */
  registry: string;
  servers: readonly RemotePackageServer[];
}

/** Upper bound for one server's lock files: they travel in the run's upload or Machine configuration. */
const MAX_LOCK_BYTES = 2 * 1024 * 1024;
/** Time limit for installing the run's package servers inside a Sprite or Fly Machine. */
export const PACKAGE_SERVER_INSTALL_TIMEOUT_MS = 10 * 60_000;

export const remotePackageDirectory = (key: string) => `${PACKAGE_MOUNT_ROOT}/${key}`;

/** The install the sandbox replays for one verified package server. */
export async function remotePackageServer(server: ExtensionLibraryPackageServer, installed: InstalledPackage, cache: ExtensionPackageCache): Promise<RemotePackageServer> {
  const read = async (name: string) => {
    const content = await fs.readFile(path.join(installed.localDirectory, name), 'utf8').catch(() => undefined);
    if (content === undefined || Buffer.byteLength(content) > MAX_LOCK_BYTES) throw new ExtensionPackageError('package_unavailable', 'The package server install is too large for this agent runtime');
    return content;
  };
  return { key: cache.key(server), package: server.package, version: server.version, integrity: server.integrity!, entry: installed.entry, packageJson: await read('package.json'), lock: await read('package-lock.json') };
}

/** One value for a set of package servers; equal sets of pinned packages give the same digest. */
export function packageServersDigest(servers: readonly Pick<RemotePackageServer, 'key'>[] = []): string {
  if (!servers.length) return 'none';
  return createHash('sha256').update([...new Set(servers.map(server => server.key))].sort().join('\n')).digest('hex').slice(0, 16);
}

/** Log fields for a package server set: digest and count, package names only for a short list. */
export function packageServersLogFields(servers: readonly Pick<RemotePackageServer, 'key' | 'package' | 'version'>[] = []) {
  return { packageServersDigest: packageServersDigest(servers), packageServers: servers.length,
    ...(servers.length <= 5 ? { packages: servers.map(server => `${server.package}@${server.version}`) } : {}) };
}

/** The installer's input file. `path` is the PATH npm runs with. */
export function packageServerInstallSpec(install: RemotePackageInstall, timeoutMs = PACKAGE_SERVER_INSTALL_TIMEOUT_MS, searchPath = '/usr/local/bin:/usr/bin:/bin') {
  return JSON.stringify({ registry: install.registry.replace(/\/+$/, ''), root: PACKAGE_MOUNT_ROOT, timeout: timeoutMs, path: searchPath, servers: install.servers });
}

/**
 * Installs package servers inside a Sprite or Fly Machine, as root, before the
 * agent exists: `python3 -I installer.py <spec.json> [<result.json>]`.
 * Exit 0 when every server is installed. On failure it exits non-zero, prints
 * the end of the output to stderr and, with a result path, records
 * `{ms, code, tail}` there (`code` is `timeout` when the time limit ended it).
 */
export const PACKAGE_SERVER_INSTALLER = String.raw`
import json, os, shutil, stat, subprocess, sys, tempfile, time

def main():
    spec = json.loads(open(sys.argv[1], 'rb').read())
    result_path = sys.argv[2] if len(sys.argv) > 2 else None
    started = time.monotonic()
    deadline = started + spec['timeout'] / 1000
    output = bytearray()
    code = 0
    def note(message):
        output.extend((message + '\n').encode())
    try:
        for server in spec['servers']:
            install(spec, server, deadline, output, note)
    except subprocess.TimeoutExpired:
        code = 'timeout'
        note('package server install timed out')
    except Exception as error:
        code = getattr(error, 'returncode', 1) or 1
        note('package server install failed: ' + str(error))
    tail = output[-4096:].decode('utf8', 'replace')
    if result_path:
        tmp = result_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({'ms': round((time.monotonic() - started) * 1000), 'code': code, 'tail': tail}, f)
        os.replace(tmp, result_path)
    if code != 0:
        sys.stderr.write(tail)
        sys.exit(1)

def check_lock(spec, server, lock):
    prefix = spec['registry'] + '/'
    top = lock.get('packages', {}).get('node_modules/' + server['package'])
    if not top or top.get('version') != server['version'] or top.get('integrity') != server['integrity']:
        raise ValueError(server['package'] + ': the lock file does not pin the package at its integrity value')
    for location, entry in lock['packages'].items():
        if not location or entry.get('inBundle') is True:
            continue
        resolved = entry.get('resolved')
        if entry.get('link') is True or not isinstance(resolved, str) or not resolved.startswith(prefix) or not entry.get('integrity'):
            raise ValueError(location + ' does not come from the package registry')

def freeze(path):
    as_root = os.geteuid() == 0
    for directory, _, names in os.walk(path, topdown=False):
        for name in names:
            full = os.path.join(directory, name)
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                continue
            if not stat.S_ISREG(st.st_mode):
                raise ValueError('installed package contains an unsupported file type')
            if as_root:
                os.chown(full, 0, 0)
            os.chmod(full, 0o555 if st.st_mode & 0o111 else 0o444)
        if not os.path.islink(directory):
            if as_root:
                os.chown(directory, 0, 0)
            os.chmod(directory, 0o555)

def install(spec, server, deadline, output, note):
    key = server['key']
    if not key.isalnum():
        raise ValueError('invalid package server key')
    root = spec['root']
    os.makedirs(root, mode=0o755, exist_ok=True)
    final = os.path.join(root, key)
    if os.path.lexists(final):
        note(server['package'] + '@' + server['version'] + ' already installed')
        return
    lock = json.loads(server['lock'])
    check_lock(spec, server, lock)
    work = tempfile.mkdtemp(prefix='.install-', dir=root)
    home = tempfile.mkdtemp(prefix='propr-npm-')
    try:
        with open(os.path.join(work, 'package.json'), 'w') as f:
            f.write(server['packageJson'])
        with open(os.path.join(work, 'package-lock.json'), 'w') as f:
            f.write(server['lock'])
        # The same install as the worker's: no lifecycle scripts, no user or global
        # npm configuration, no git dependencies; npm ci checks every tarball
        # against its integrity value in the lock file.
        argv = ['npm', 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--no-bin-links',
                '--install-strategy=hoisted', '--registry', spec['registry'] + '/', '--git', os.path.join(home, 'git-dependencies-are-unsupported'),
                '--cache', os.path.join(home, 'cache'), '--userconfig', os.path.join(home, 'npmrc'), '--globalconfig', os.path.join(home, 'npmrc-global')]
        note('installing ' + server['package'] + '@' + server['version'])
        child = subprocess.Popen(argv, cwd=work, env={'PATH': spec['path'], 'HOME': home, 'LANG': 'C.UTF-8'}, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            out, _ = child.communicate(timeout=max(1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, 9)
            out, _ = child.communicate()
            output.extend(out)
            raise
        output.extend(out)
        if child.returncode != 0:
            raise subprocess.CalledProcessError(child.returncode, 'npm ci')
        manifest = json.loads(open(os.path.join(work, 'node_modules', server['package'], 'package.json'), 'rb').read())
        if manifest.get('name') != server['package'] or manifest.get('version') != server['version']:
            raise ValueError('installed package does not match the pinned version')
        entry = os.path.normpath(os.path.join(work, server['entry']))
        if not entry.startswith(work + os.sep) or not os.path.isfile(entry) or not os.path.realpath(entry).startswith(os.path.realpath(work) + os.sep):
            raise ValueError('the package executable is missing')
        freeze(work)
        os.chmod(work, 0o755)
        os.rename(work, final)
        os.chmod(final, 0o555)
        note('installed ' + server['package'] + '@' + server['version'])
    finally:
        shutil.rmtree(home, ignore_errors=True)
        if os.path.lexists(work):
            for directory, _, _ in os.walk(work):
                os.chmod(directory, 0o755)
            shutil.rmtree(work, ignore_errors=True)

main()
`;
