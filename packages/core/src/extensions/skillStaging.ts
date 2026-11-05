import logger from '../utils/logger.js';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { egressProcessNamespace } from '../network/egressExecution.js';
import { EXTENSION_LIMITS } from '@propr/shared';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { ExtensionError } from './extensionProfileStore.js';
import { validateSkillFiles, type SkillFile } from './skillBundles.js';

export function assertSkillStagingPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') throw new ExtensionError(503, 'Extension skill staging requires a Linux worker with /proc/self/fd available');
}

// Foreign PID namespaces cannot be probed. A worker refreshes its lease while
// owning the staging handle; a restarted worker may reclaim it after 48 hours.
export const EXTENSION_STAGING_ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ownerHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const stagingBoot = async () => ownerHash((await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && (!a.isFile() || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
/** Inspect every component, not just the final directory. */
export async function inspectStagingAncestors(directory: string): Promise<Map<string, Stats>> {
  const result = new Map<string, Stats>();
  let cursor = path.parse(path.resolve(directory)).root;
  for (const component of path.resolve(directory).slice(cursor.length).split('/').filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExtensionError(503, 'Unsafe extension staging ancestor');
    result.set(cursor, stat);
  }
  if (await fs.realpath(directory) !== path.resolve(directory)) throw new ExtensionError(503, 'Unsafe extension staging resolution');
  return result;
}
/** Linux directory handles anchor each operation; no path component can redirect a write. */
async function openDirectory(directory: string, create = false) {
  assertSkillStagingPlatform();
  let handle = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of path.resolve(directory).slice(1).split('/').filter(Boolean)) {
      const target = `/proc/self/fd/${handle.fd}/${component}`;
      // eslint-disable-next-line max-depth -- directory handles and ownership checks stay within their try/finally cleanup boundaries
      if (create) try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const next = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close(); handle = next;
    }
    if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== path.resolve(directory)) throw new ExtensionError(409, 'Staging directory replaced');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
export async function ensureStagingRoot(directory: string): Promise<void> {
  const handle = await openDirectory(directory, true);
  try {
    await inspectStagingAncestors(directory);
    const stat = await handle.stat();
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new ExtensionError(503, 'Extension staging root is not private');
  } finally { await handle.close(); }
}
export async function writeStagedSkill(directory: string, relative: string, content: Buffer): Promise<void> {
  let handle = await openDirectory(directory);
  try {
    const parts = relative.split('/'); const filename = parts.pop()!;
    for (const component of parts) {
      const target = `/proc/self/fd/${handle.fd}/${component}`;
      try { await fs.mkdir(target, { mode: 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const next = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close(); handle = next;
    }
    const file = await fs.open(`/proc/self/fd/${handle.fd}/${filename}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
    try { await file.writeFile(content); } finally { await file.close(); }
    if (await fs.realpath(`/proc/self/fd/${handle.fd}`) !== path.dirname(path.join(directory, relative))) throw new ExtensionError(409, 'Staging directory replaced during write');
  } finally { await handle.close(); }
}
/** Create and retain the private parent before any path-based work or cleanup. */
export async function createStagingDirectory(root: string): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const parent = await openDirectory(root);
  let runHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let created: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let refreshing = Promise.resolve();
  const cleanup = async () => {
    clearInterval(heartbeat);
    await refreshing;
    try {
      if (runHandle) {
        const original = await runHandle.stat();
        // A rename inside the trusted root must not leave our original tree behind.
        for (const name of await fs.readdir(`/proc/self/fd/${parent.fd}`)) {
          const target = `/proc/self/fd/${parent.fd}/${name}`;
          const stat = await fs.lstat(target);
          if (stat.dev === original.dev && stat.ino === original.ino) await fs.rm(target, { recursive: true, force: true });
        }
      }
      if (created) await fs.rm(`/proc/self/fd/${parent.fd}/${created}`, { recursive: true, force: true });
    } finally { await runHandle?.close(); await parent.close(); }
  };
  try {
    // Ownership is in the atomic directory name, including if creation crashes
    // before any file can be written. PIDs are meaningful only in this namespace.
    const namespace = ownerHash(await egressProcessNamespace());
    const boot = await stagingBoot();
    const target = await fs.mkdtemp(`/proc/self/fd/${parent.fd}/run-${boot}-${namespace}-${process.pid}-`); created = path.basename(target);
    runHandle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directory = path.join(root, created);
    if (await fs.realpath(`/proc/self/fd/${parent.fd}`) !== path.resolve(root) || await fs.realpath(`/proc/self/fd/${runHandle.fd}`) !== path.resolve(directory)) throw new ExtensionError(409, 'Staging root replaced during creation');
    await runHandle.chmod(0o755);
    heartbeat = setInterval(() => {
      refreshing = refreshing.then(async () => {
        const now = new Date(); await runHandle!.utimes(now, now);
      }).catch(() => { logger.warn('Could not refresh extension staging lease'); });
    }, 60_000);
    heartbeat.unref();
    return { directory, cleanup };
  } catch (error) {
    try { await cleanup(); }
    catch { logger.warn('Could not clean failed extension staging; orphan sweep will retry'); }
    throw error;
  }
}
export async function stagingValidator(root: string, directory: string, bundles: { id: string; digest: string }[]): Promise<() => Promise<void>> {
  const ancestors = await inspectStagingAncestors(directory);
  const original = new Map<string, Stats>();
  const collect = async (target: string) => {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw new ExtensionError(503, 'Unsafe staged skill link');
    original.set(target, stat);
    if (stat.isDirectory()) for (const name of await fs.readdir(target)) await collect(path.join(target, name));
  };
  await collect(directory);
  return async () => {
    const current = await inspectStagingAncestors(directory);
    for (const [target, stat] of ancestors) if (!current.has(target) || !same(stat, current.get(target)!)) throw new ExtensionError(409, 'Skill staging ancestor replaced');
    const seen = new Set<string>();
    const inventory = async (target: string) => {
      const stat = await fs.lstat(target);
      if (!original.has(target) || !same(stat, original.get(target)!) || (stat.isFile() && stat.nlink !== 1)) throw new ExtensionError(409, 'Staged skill tree replaced');
      seen.add(target);
      if (stat.isDirectory()) for (const name of await fs.readdir(target)) await inventory(path.join(target, name));
    };
    await inventory(directory);
    if (seen.size !== original.size) throw new ExtensionError(409, 'Staged skill tree changed');
    const resolved = await fs.realpath(directory);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new ExtensionError(503, 'Skill staging escaped trusted root');
    const read = async (target: string, prefix = ''): Promise<SkillFile[]> => {
      const stat = await fs.lstat(target);
      if (!original.has(target) || !same(stat, original.get(target)!)) throw new ExtensionError(409, 'Staged skill replaced');
      if (stat.isDirectory()) {
        const files: SkillFile[] = [];
        for (const name of await fs.readdir(target)) files.push(...await read(path.join(target, name), prefix ? `${prefix}/${name}` : name));
        return files;
      }
      const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!stat.isFile() || stat.nlink !== 1 || !same(stat, await file.stat())) throw new ExtensionError(409, 'Staged skill replaced during read');
        if (stat.size > EXTENSION_LIMITS.bytes) throw new ExtensionError(409, 'Staged skill exceeds its saved size');
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
        if (offset !== bytes.length || (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || !same(stat, await file.stat())) throw new ExtensionError(409, 'Staged skill changed during read');
        const content = bytes.toString('base64');
        if (!same(stat, await fs.lstat(target))) throw new ExtensionError(409, 'Staged skill replaced during read');
        return [{ path: prefix, content }];
      } finally { await file.close(); }
    };
    for (const bundle of bundles) if (validateSkillFiles(await read(path.join(directory, bundle.id))).digest !== bundle.digest) throw new ExtensionError(409, 'Staged skill digest mismatch');
    // Recheck after reads to detect ancestor replacement during digesting.
    const after = await inspectStagingAncestors(directory);
    for (const [target, stat] of ancestors) if (!after.has(target) || !same(stat, after.get(target)!)) throw new ExtensionError(409, 'Skill staging ancestor replaced during read');
  };
}

/** Reclaim dead local owners or expired foreign leases on this host and boot. */
/* eslint-disable max-depth -- nested try/finally blocks retain root and parent handles across ownership checks */
// eslint-disable-next-line complexity -- dead-owner and expired-lease checks share the handle-anchored deletion boundary
export async function sweepOrphanedExtensionStaging(extensionsRoot: string): Promise<number> {
  if (process.platform !== 'linux') return 0;
  let root: Awaited<ReturnType<typeof openDirectory>>;
  try { root = await openDirectory(extensionsRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  try {
    const namespace = ownerHash(await egressProcessNamespace());
    const boot = await stagingBoot();
    for (const instance of await fs.readdir(`/proc/self/fd/${root.fd}`)) {
      let parent: Awaited<ReturnType<typeof openDirectory>>;
      try { parent = await openDirectory(path.join(extensionsRoot, instance)); } catch { continue; }
      try {
        const stat = await parent.stat();
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) continue;
        for (const name of await fs.readdir(`/proc/self/fd/${parent.fd}`)) {
          const owner = /^run-(?:([a-f0-9]{16})-)?([a-f0-9]{16})-([1-9][0-9]*)-[A-Za-z0-9]+$/.exec(name);
          if (!owner || (owner[1] && owner[1] !== boot)) continue;
          const local = owner[2] === namespace;
          // Older names prove only namespace ownership, never host/boot ownership.
          if (!local && !owner[1]) continue;
          const pid = Number(owner[3]);
          if (!Number.isSafeInteger(pid)) continue;
          if (local) {
            try { process.kill(pid, 0); continue; } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
            }
          }
          const target = `/proc/self/fd/${parent.fd}/${name}`;
          const run = await fs.lstat(target);
          if (!run.isDirectory() || run.isSymbolicLink() || run.uid !== process.getuid?.()) continue;
          if (!local && Date.now() - run.mtimeMs <= EXTENSION_STAGING_ORPHAN_MAX_AGE_MS) continue;
          // Check again after awaited inspection, so refreshed/replaced evidence
          // does not authorize deletion. The private root limits mutation authority.
          const current = await fs.lstat(target);
          if (!same(run, current) || run.mtimeMs !== current.mtimeMs) continue;
          await fs.rm(target, { recursive: true, force: true });
          removed++;
        }
      } finally { await parent.close(); }
    }
  } finally { await root.close(); }
  return removed;
}
/* eslint-enable max-depth */
