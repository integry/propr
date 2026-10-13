import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/** Durable instance policy, registry and audit records, outside repository working copies. */
export function storageControlRoot(): string {
  return path.join(process.env.DATA_DIR ?? (process.env.DB_FILENAME ? path.dirname(path.resolve(process.env.DB_FILENAME)) : path.resolve('data')), 'storage-control');
}

/** Cache-volume barrier: independent instances sharing this root must share the lock too. */
export function repositoryLifecycleRoot(): string {
  const clones = path.resolve(process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones');
  return path.join(path.dirname(clones), `.${path.basename(clones)}-storage-lifecycle`);
}

/** Reject every symlink component, including trusted configuration accidentally pointing through one. */
export async function assertRealDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_path');
  }
}

export class StorageBusyError extends Error {
  constructor() { super('Storage lifecycle is busy or requires recovery'); }
}

/** No TTL stealing: a crashed process is uncertainty, not permission to delete. */
export class StorageLifecycle {
  private context = new AsyncLocalStorage<{ active: boolean; users: number; claim: string }>();
  constructor(readonly root: string = repositoryLifecycleRoot()) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await assertRealDirectory(this.root);
    await fs.mkdir(path.join(this.root, 'readers'), { recursive: true });
    await assertRealDirectory(path.join(this.root, 'readers'));
  }

  async exclusive<T>(run: () => Promise<T>, waitMs = 10_000): Promise<T> {
    await this.initialize();
    const gate = path.join(this.root, 'gate');
    const until = Date.now() + waitMs;
    for (;;) {
      try { await fs.mkdir(gate); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= until) throw new StorageBusyError();
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await run(); }
    finally { await fs.rmdir(gate); }
  }

  /** Optional cleanup yields its proof to published admissions, across processes.
   * Cancellation is cooperative: never release the gate while proof/deletion is running.
   */
  async cleanup<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const controller = new AbortController();
      const stopped = new AbortController();
      const monitor = (async () => {
        while (!stopped.signal.aborted) {
          try {
            if (await this.busy()) { controller.abort(); return; }
            await delay(25, undefined, { signal: stopped.signal });
          } catch {
            if (!stopped.signal.aborted) controller.abort();
            return;
          }
        }
      })();
      try { return await run(controller.signal); }
      finally { stopped.abort(); await monitor; }
    });
  }

  async busy(): Promise<boolean> {
    const reader = await fs.opendir(path.join(this.root, 'readers'));
    try { return (await reader.read()) !== null; }
    finally { await reader.close(); }
  }

  async lastUse(): Promise<number | null> {
    try {
      const handle = await fs.open(path.join(this.root, 'last-use'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const value = Number(await handle.readFile('utf8'));
        return Number.isFinite(value) && value > 0 && value <= Date.now() ? value : null;
      } finally { await handle.close(); }
    } catch { return null; }
  }

  private async touch(): Promise<void> {
    const temporary = path.join(this.root, `clock-${randomUUID()}`);
    await fs.writeFile(temporary, String(Date.now()), { flag: 'wx' });
    await fs.rename(temporary, path.join(this.root, 'last-use'));
  }

  /** A read claim covers the entire operation, including child Git and filesystem work. */
  async use<T>(run: () => Promise<T>, admission?: { filesystem: string; reserveBytes: number; taskBytes: number }): Promise<T> {
    const existing = this.context.getStore();
    if (existing?.active) {
      existing.users++;
      try { return await run(); }
      finally { await this.release(existing); }
    }
    const claim = path.join(this.root, 'readers', randomUUID());
    // Publish intent before waiting: cleanup cancels proof, while the gate still
    // prevents this operation racing any in-progress rename or deletion. A crash
    // leaves a protective claim; elapsed time never authorizes stealing it.
    // Admission (and release) waits without a deadline; an abandoned gate still
    // requires explicit recovery, rather than failing an accepted worker job.
    await this.initialize();
    await fs.writeFile(claim, admission ? JSON.stringify({ reservedBytes: admission.taskBytes }) : '', { flag: 'wx' });
    try {
      await this.exclusive(async () => {
        if (admission) await this.admit(admission);
        await this.touch();
      }, Infinity);
    } catch (error) { await fs.unlink(claim); throw error; }
    const scope = { active: true, users: 1, claim };
    return this.context.run(scope, async () => {
      try { return await run(); }
      finally { await this.release(scope); }
    });
  }

  private async admit(admission: { filesystem: string; reserveBytes: number; taskBytes: number }): Promise<void> {
    if (![admission.reserveBytes, admission.taskBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid worktree admission reserve');
    let reserved = 0;
    for (const name of await fs.readdir(path.join(this.root, 'readers'))) {
      const file = await fs.open(path.join(this.root, 'readers', name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024) throw new StorageBusyError();
        const value = await file.readFile('utf8');
        if (value) {
          const record = JSON.parse(value);
          if (!Number.isSafeInteger(record.reservedBytes) || record.reservedBytes <= 0) throw new StorageBusyError();
          reserved += record.reservedBytes;
        }
      } finally { await file.close(); }
    }
    let filesystem = path.resolve(admission.filesystem);
    for (;;) {
      try { await assertRealDirectory(filesystem); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(filesystem);
        if (parent === filesystem) throw error;
        filesystem = parent;
      }
    }
    const stat = await fs.statfs(filesystem);
    if (stat.bavail * stat.bsize < admission.reserveBytes + reserved) throw new Error('Worktree disk pressure: admission reserve unavailable; data retained');
  }

  private async release(scope: { active: boolean; users: number; claim: string }): Promise<void> {
    if (--scope.users > 0) return;
    scope.active = false;
    await this.exclusive(async () => {
      await this.touch();
      await fs.unlink(scope.claim);
    }, Infinity);
  }

}
export const repositoryStorageLifecycle = new StorageLifecycle();

/** Queue producers join the same barrier as workers and cleanup. */
export function protectStorageQueue<T extends object>(queue: T): T {
  const guarded = new Set(['add', 'addBulk', 'retryJobs', 'promoteJobs']);
  return new Proxy(queue, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (typeof property === 'string' && guarded.has(property)) {
        return (...args: unknown[]) => repositoryStorageLifecycle.use(() => Reflect.apply(member, target, args));
      }
      return member.bind(target);
    },
  });
}
