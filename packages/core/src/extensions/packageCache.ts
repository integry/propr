import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionLibraryPackageServer } from '@propr/shared';
import { egressSocketRoots } from '../network/egressExecution.js';
import { extensionPackageManifestTag } from './privateSecrets.js';
import { assertRegistryDependencies, startPackageInstallProxy } from './packageInstallEgress.js';
import { packageBins, selectPackageBin } from './packageRegistry.js';

/** Why a package server cannot be used by a run; the run proceeds without it. */
export class ExtensionPackageError extends Error {
  constructor(readonly reason: 'package_unavailable' | 'package_integrity_mismatch', message: string) { super(message); }
}
const MANIFEST = '.propr-package.json';
const TREE_LIMITS = { entries: 50_000, bytes: 512 * 1024 * 1024 };
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** Installs in progress in this worker, by install directory: concurrent runs share one install. */
const pendingInstalls = new Map<string, Promise<void>>();

interface PackageManifest { version: 1; ecosystem: 'npm'; package: string; packageVersion: string; integrity: string; tree: string; bins: Record<string, string>; installedAt: number }
/** An installed, verified package and the file a launch runs with Node. */
export interface InstalledPackage {
  /** Worker path of the install directory. */
  localDirectory: string;
  /** The same directory as the Docker host names it, for the read-only bind mount. */
  hostDirectory: string;
  /** The executable's path relative to the install directory. */
  entry: string;
}
type PinnedServer = Pick<ExtensionLibraryPackageServer, 'ecosystem' | 'package' | 'version' | 'integrity' | 'bin'>;

/**
 * One digest over every directory, file (content and executable bit) and
 * symbolic link of an install, in a fixed order. Anything else refuses.
 */
export async function packageTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256'); let entries = 0; let bytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const names = (await fs.readdir(path.join(root, relative))).sort();
    for (const name of names) {
      if (!relative && name === MANIFEST) continue;
      const child = relative ? `${relative}/${name}` : name;
      const full = path.join(root, child);
      const stat = await fs.lstat(full);
      if (++entries > TREE_LIMITS.entries) throw new ExtensionPackageError('package_unavailable', 'Installed package is too large');
      if (stat.isSymbolicLink()) hash.update(`l\0${child}\0${await fs.readlink(full)}\n`);
      else if (stat.isDirectory()) { hash.update(`d\0${child}\n`); await walk(child); }
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > TREE_LIMITS.bytes) throw new ExtensionPackageError('package_unavailable', 'Installed package is too large');
        hash.update(`f\0${child}\0${stat.mode & 0o111 ? 'x' : '-'}\0${createHash('sha256').update(await fs.readFile(full)).digest('hex')}\n`);
      } else throw new ExtensionPackageError('package_integrity_mismatch', 'Installed package contains an unsupported file type');
    }
  };
  await walk('');
  return hash.digest('hex');
}

const manifestBody = (manifest: PackageManifest) => JSON.stringify([manifest.version, manifest.ecosystem, manifest.package, manifest.packageVersion, manifest.integrity, manifest.tree, Object.entries(manifest.bins).sort(), manifest.installedAt]);
const sameTag = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Make an install read-only: directories and executables 0555, other files 0444. */
async function freeze(directory: string, writable = false): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    const full = path.join(directory, name); const stat = await fs.lstat(full);
    if (stat.isDirectory()) await freeze(full, writable);
    else if (stat.isFile()) await fs.chmod(full, writable ? 0o644 : stat.mode & 0o111 ? 0o555 : 0o444);
  }
  await fs.chmod(directory, writable ? 0o755 : 0o555);
}
async function removeTree(directory: string): Promise<void> {
  try { await freeze(directory, true); } catch { /* removal below reports nothing either */ }
  await fs.rm(directory, { recursive: true, force: true });
}

export type NpmRunner = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<void>;
const runNpm: NpmRunner = (args, options) => new Promise((resolve, reject) => {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`npm exited with ${code}`)); });
});

/**
 * Worker-owned cache of installed package servers, one directory per pinned
 * package and integrity value, outside every task workspace. Installs run
 * once, without lifecycle scripts; a run mounts the directory read-only after
 * its files are checked against the manifest recorded at install.
 */
export class ExtensionPackageCache {
  constructor(readonly environment: NodeJS.ProcessEnv = process.env, private readonly npm: NpmRunner = runNpm) {}
  roots() {
    const roots = egressSocketRoots(this.environment);
    return { local: path.join(roots.local, 'extension-packages'), host: path.join(roots.host, 'extension-packages') };
  }
  key(server: PinnedServer): string {
    return createHash('sha256').update([server.ecosystem, server.package, server.version, server.integrity ?? ''].join('\0')).digest('hex').slice(0, 40);
  }
  /** Install the package when it is not cached yet, then verify it. */
  async ensure(server: PinnedServer): Promise<InstalledPackage> {
    if (!server.integrity) throw new ExtensionPackageError('package_unavailable', 'The package server has no recorded integrity value');
    const key = this.key(server);
    const directory = path.join(this.roots().local, key);
    if (!await fs.lstat(directory).catch(() => null)) {
      // One install per key in this worker; concurrent workers race on the final rename.
      let install = pendingInstalls.get(directory);
      if (!install) { install = this.install(server, directory).finally(() => pendingInstalls.delete(directory)); pendingInstalls.set(directory, install); }
      await install;
    }
    return this.verify(server);
  }
  /** Check the installed files against the integrity value and the manifest recorded at install. */
  async verify(server: PinnedServer): Promise<InstalledPackage> {
    const key = this.key(server); const roots = this.roots();
    const directory = path.join(roots.local, key);
    const mismatch = () => new ExtensionPackageError('package_integrity_mismatch', 'Installed package files do not match the pinned integrity value');
    let stored: PackageManifest & { tag: string };
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory()) throw mismatch();
      stored = JSON.parse(await fs.readFile(path.join(directory, MANIFEST), 'utf8'));
    } catch (error) { throw error instanceof ExtensionPackageError ? error : mismatch(); }
    const tag = (() => { try { return extensionPackageManifestTag(manifestBody(stored), this.environment); } catch { return null; } })();
    if (!tag) throw new ExtensionPackageError('package_unavailable', 'Private credential encryption is not configured');
    if (typeof stored.tag !== 'string' || !sameTag(stored.tag, tag)) throw mismatch();
    if (stored.ecosystem !== server.ecosystem || stored.package !== server.package || stored.packageVersion !== server.version || stored.integrity !== server.integrity) throw mismatch();
    if (await packageTreeDigest(directory) !== stored.tree) throw mismatch();
    const bin = selectPackageBin(server.package, stored.bins, server.bin);
    const hostDirectory = path.join(roots.host, key);
    if (/[,:\n]/.test(hostDirectory)) throw new ExtensionPackageError('package_unavailable', 'Extension mount namespace unavailable');
    return { localDirectory: directory, hostDirectory, entry: `node_modules/${server.package}/${stored.bins[bin]}` };
  }
  private async install(server: PinnedServer, directory: string): Promise<void> {
    const root = this.roots().local;
    await fs.mkdir(root, { recursive: true, mode: 0o755 });
    const work = path.join(root, `.install-${randomBytes(8).toString('hex')}`);
    const home = `${work}-home`;
    let proxy: Awaited<ReturnType<typeof startPackageInstallProxy>> | undefined;
    try {
      await fs.mkdir(work, { mode: 0o755 }); await fs.mkdir(home, { mode: 0o700 });
      await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'propr-extension-package', private: true, dependencies: { [server.package]: server.version } }, null, 2));
      // No lifecycle scripts, no user or global npm configuration, no registry credentials.
      // Every connection goes through the install proxy, which admits only the
      // registry's host and port and dials only addresses it vetted itself, so
      // dependency URLs and redirects cannot reach the worker's network. The
      // worker's own proxy variables configure that proxy, never npm.
      proxy = await startPackageInstallProxy(this.environment);
      const env: NodeJS.ProcessEnv = { PATH: this.environment.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home };
      await this.npm(['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--no-bin-links', '--install-strategy=hoisted',
        '--registry', `${proxy.registry}/`, '--proxy', proxy.url, '--https-proxy', proxy.url,
        // Git dependencies would run git outside the proxy; none can be fetched.
        '--git', path.join(home, 'git-dependencies-are-unsupported'),
        '--cache', path.join(home, 'cache'), '--userconfig', path.join(home, 'npmrc'), '--globalconfig', path.join(home, 'npmrc-global')], { cwd: work, env });
      const lock = JSON.parse(await fs.readFile(path.join(work, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string; integrity?: string; hasInstallScript?: boolean; resolved?: string; link?: boolean; inBundle?: boolean }> };
      try { assertRegistryDependencies(lock, proxy.registry); } catch {
        throw new ExtensionPackageError('package_unavailable', 'A dependency of this package comes from outside the package registry, which ProPR never installs');
      }
      const installed = lock.packages?.[`node_modules/${server.package}`];
      if (installed?.version !== server.version || installed.integrity !== server.integrity) throw new ExtensionPackageError('package_integrity_mismatch', 'The registry served a package that does not match the pinned integrity value');
      if (installed.hasInstallScript) throw new ExtensionPackageError('package_unavailable', 'This package needs install scripts, which ProPR never runs');
      const manifestJson = JSON.parse(await fs.readFile(path.join(work, 'node_modules', server.package, 'package.json'), 'utf8')) as { name?: string; version?: string; bin?: unknown };
      if (manifestJson.name !== server.package || manifestJson.version !== server.version) throw new ExtensionPackageError('package_integrity_mismatch', 'Installed package does not match the pinned version');
      await freeze(work);
      const manifest: PackageManifest = { version: 1, ecosystem: 'npm', package: server.package, packageVersion: server.version, integrity: server.integrity!, tree: await packageTreeDigest(work), bins: packageBins(server.package, manifestJson.bin), installedAt: Date.now() };
      await fs.chmod(work, 0o755);
      await fs.writeFile(path.join(work, MANIFEST), JSON.stringify({ ...manifest, tag: extensionPackageManifestTag(manifestBody(manifest), this.environment) }), { mode: 0o444 });
      await fs.chmod(work, 0o555);
      // Another worker may have finished first; its install is verified like any other.
      try { await fs.rename(work, directory); } catch { /* removed below */ }
    } catch (error) {
      throw error instanceof ExtensionPackageError ? error : new ExtensionPackageError('package_unavailable', 'The package could not be installed');
    } finally {
      await proxy?.close().catch(() => {});
      await removeTree(home).catch(() => {});
      if (await fs.lstat(work).catch(() => null)) await removeTree(work).catch(() => {});
    }
  }
}
