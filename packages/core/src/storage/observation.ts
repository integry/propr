import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { StorageCategory, StorageObservation } from '@propr/shared';
import { assertRealDirectory } from './lifecycle.js';

export interface StorageRoot { category: StorageCategory; path: string }
function mergeCategory(categories: StorageObservation['categories'], observed: StorageObservation['categories'][number]): void {
  const existing = categories.find(category => category.category === observed.category);
  if (!existing) { categories.push(observed); return; }
  existing.bytes = existing.bytes === null && observed.bytes === null ? null : (existing.bytes ?? 0) + (observed.bytes ?? 0);
  if (observed.state !== 'complete') existing.state = existing.bytes === null ? 'unknown' : 'partial';
}

/** Bounded async scan. Linux directory descriptors pin traversal across rename/symlink swaps. */
export async function observeStorage(instanceId: string, roots: StorageRoot[], options: { maxEntries?: number; maxMs?: number } = {}): Promise<StorageObservation> {
  const started = Date.now();
  const maxEntries = options.maxEntries ?? 100_000;
  const deadline = started + (options.maxMs ?? 5_000);
  const seen = new Set<string>();
  const filesystems = new Map<number, { id: string; totalBytes: number; availableBytes: number }>();
  let entries = 0;
  const categories: StorageObservation['categories'] = [];
  for (const root of roots) {
    let bytes = 0;
    let partial = false;
    let found = false;
    const visit = async (target: string, device?: number): Promise<void> => {
      if (++entries > maxEntries || Date.now() > deadline) { partial = true; return; }
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || (device !== undefined && device !== stat.dev)) { partial = true; return; }
      const key = `${stat.dev}:${stat.ino}`;
      if (seen.has(key)) return;
      if (!stat.isDirectory() && !stat.isFile()) { partial = true; return; }
      // O_NOFOLLOW refuses substitution between lstat and open. Check inode after open.
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : constants.O_NONBLOCK));
      try {
        const pinned = await handle.stat();
        if (stat.dev !== pinned.dev || stat.ino !== pinned.ino) { partial = true; return; }
        seen.add(key);
        found = true;
        bytes += stat.blocks * 512;
        if (!filesystems.has(stat.dev)) {
          const capacity = await fs.statfs(`/proc/self/fd/${handle.fd}`);
          filesystems.set(stat.dev, { id: `filesystem-${filesystems.size + 1}`, totalBytes: capacity.blocks * capacity.bsize, availableBytes: capacity.bavail * capacity.bsize });
        }
        if (stat.isDirectory()) {
          const pinnedPath = `/proc/self/fd/${handle.fd}`;
          const directory = await fs.opendir(pinnedPath);
          for await (const entry of directory) {
            if (entries >= maxEntries || Date.now() > deadline) { partial = true; break; }
            try { await visit(path.join(pinnedPath, entry.name), stat.dev); }
            catch { partial = true; }
          }
        }
      } finally { await handle.close(); }
    };
    if (process.platform !== 'linux') {
      categories.push({ category: root.category, bytes: null, state: 'unsupported' });
      continue;
    }
    try {
      if (path.resolve(root.path) === path.parse(path.resolve(root.path)).root) throw new Error('unsafe_root');
      await assertRealDirectory(path.dirname(path.resolve(root.path)));
      await visit(root.path);
    } catch { partial = true; }
    mergeCategory(categories, { category: root.category, bytes: found ? bytes : null, state: partial ? (found ? 'partial' : 'unknown') : 'complete' });
  }
  const allCategories: StorageCategory[] = ['database_config', 'repository_caches', 'worktrees', 'salvage', 'logs_artifacts', 'provider_credentials', 'task_history'];
  for (const category of allCategories) if (!categories.some(value => value.category === category)) categories.push({ category, bytes: null, state: 'unsupported' });
  return {
    version: 1, instanceId, observedAt: new Date().toISOString(), scanning: false,
    state: categories.every(value => value.state === 'complete') ? 'complete' : 'partial',
    ownedBytes: categories.some(value => value.bytes !== null) ? categories.reduce((sum, value) => sum + (value.bytes ?? 0), 0) : null,
    categories, filesystems: [...filesystems.values()],
  };
}
