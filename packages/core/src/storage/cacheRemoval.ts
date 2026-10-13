import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { StorageProtection } from '@propr/shared';
import type { StorageAuthority } from './databaseExport.js';
import { assertRealDirectory } from './lifecycle.js';
import type { CacheRecord } from './registry.js';
import { resolveRepositoryClonePath } from '../git/repositoryPaths.js';
import type { auditRepository } from './repositorySafety.js';

interface CacheRemovalOptions {
  clonesRoot: string; root: string; authorize?: StorageAuthority;
  auditCache: (directory: string, record: CacheRecord, signal: AbortSignal) => ReturnType<typeof auditRepository>;
}
export async function removeRegisteredCache(record: CacheRecord, fingerprint: string, signal: AbortSignal, options: CacheRemovalOptions): Promise<StorageProtection[]> {
  const { authorize } = options;
  const directory = resolveRepositoryClonePath(options.clonesRoot, record.owner, record.name);
  await assertRealDirectory(options.clonesRoot);
  await assertRealDirectory(path.dirname(directory));
  const root = await fs.open(options.clonesRoot, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  const parent = await fs.open(path.dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  let quarantine: string | undefined;
  try {
    const source = `/proc/self/fd/${parent.fd}/${record.name}`;
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || stat.dev !== record.identity.device || stat.ino !== record.identity.inode) return ['unsafe_path'];
    quarantine = await fs.mkdtemp(`/proc/self/fd/${root.fd}/.cleanup-`);
    await fs.rename(source, `${quarantine}/repository`);
    // Rename isolates the exact inode; a substituted source is retained, never followed.
    // On interruption the quarantine remains intact and is never age-pruned.
    const realQuarantine = await fs.realpath(`${quarantine}/repository`);
    const final = await options.auditCache(realQuarantine, record, signal);
    if (signal.aborted || final.reasons.length || final.fingerprint !== fingerprint) {
      // Restore only when the original name is still absent; lifecycle peers cannot race
      // here. If an external writer replaced it, retain both directories for recovery.
      const occupied = await fs.lstat(source).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (!occupied) await fs.rename(`${quarantine}/repository`, source);
      return signal.aborted ? ['busy'] : final.reasons.length ? final.reasons : ['changed'];
    }
    try { await authorize?.(); }
    catch (error) {
      const occupied = await fs.lstat(source).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (!occupied) await fs.rename(`${quarantine}/repository`, source);
      throw error;
    }
    await fs.rm(`${quarantine}/repository`, { recursive: true });
    await fs.unlink(path.join(options.root, 'repositories', `${record.id}.json`));
    return [];
  } finally {
    if (quarantine) await fs.rmdir(quarantine).catch(() => undefined);
    await parent.close(); await root.close();
  }
}
