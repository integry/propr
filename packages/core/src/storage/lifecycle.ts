import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { claimOwnerGone, currentClaimOwner, isClaimOwner, type ClaimOwner, type ClaimOwnerProbe } from './claimOwner.js';

/** Written inside the gate directory by its holder, so a waiter can tell a live holder from a dead one. */
const GATE_OWNER_FILE = 'owner';
/** How often a waiter probes whether the gate holder is still alive. */
const GATE_ORPHAN_CHECK_MS = 5_000;
/** A gate with no owner record (holder died between mkdir and write, or an older release) is abandoned after this. */
const GATE_UNOWNED_GRACE_MS = 10 * 60_000;
/** Without a caller-supplied warning, a wait for the gate is reported this often. */
const DEFAULT_WAIT_WARNING_MS = 60_000;

interface GateRecord { owner: ClaimOwner; token: string; takenAt: number }

export interface StorageLifecycleOptions {
  /** Interval of the default "still waiting for the gate" warning. */
  waitWarningMs?: number;
}

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

interface StorageUseOptions {
  /** Maintenance participates in the barrier without advancing actual-use time. */
  recordUse?: boolean;
  waitWarning?: { afterMs: number; warn: () => void };
}

interface StorageUseScope {
  active: boolean;
  users: number;
  claim: string;
  recordUse: boolean;
  waitWarning?: StorageUseOptions['waitWarning'];
}

/**
 * No TTL stealing: a crashed process is uncertainty, not permission to delete.
 * A claim records its owning process, and only proof that the owner is gone
 * (see claimOwnerGone) releases it; elapsed time never does.
 */
export class StorageLifecycle {
  private context = new AsyncLocalStorage<StorageUseScope>();
  constructor(
    readonly root: string = repositoryLifecycleRoot(),
    private readonly ownerProbe?: ClaimOwnerProbe,
    private readonly options: StorageLifecycleOptions = {},
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await assertRealDirectory(this.root);
    await fs.mkdir(path.join(this.root, 'readers'), { recursive: true });
    await assertRealDirectory(path.join(this.root, 'readers'));
  }

  /**
   * The gate is a directory shared by every ProPR process on the host. Its
   * holder records itself inside it; a waiter that finds the holder gone
   * (crashed process, restarted container) removes the gate instead of waiting
   * forever, which once froze every worker after an out-of-memory crash.
   */
  async exclusive<T>(run: () => Promise<T>, waitMs = 10_000): Promise<T> {
    await this.initialize();
    const gate = path.join(this.root, 'gate');
    const token = randomUUID();
    const until = Date.now() + waitMs;
    let nextOrphanCheck = 0;
    for (;;) {
      try { await fs.mkdir(gate); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= until) throw new StorageBusyError();
        if (Date.now() >= nextOrphanCheck) {
          nextOrphanCheck = Date.now() + GATE_ORPHAN_CHECK_MS;
          if (await this.reclaimAbandonedGate(gate)) continue;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      const record: GateRecord = { owner: currentClaimOwner(), token, takenAt: Date.now() };
      await fs.writeFile(path.join(gate, GATE_OWNER_FILE), JSON.stringify(record), { flag: 'wx' });
    } catch (error) {
      await fs.rmdir(gate).catch(() => undefined);
      throw error;
    }
    try { return await run(); }
    finally { await this.releaseGate(gate, token); }
  }

  /** Reads the holder's record; null when the gate has none (or is unreadable). */
  private async gateRecord(gate: string): Promise<GateRecord | null> {
    try {
      const record = JSON.parse(await fs.readFile(path.join(gate, GATE_OWNER_FILE), 'utf8')) as Partial<GateRecord>;
      return isClaimOwner(record?.owner) && typeof record.token === 'string' ? record as GateRecord : null;
    } catch { return null; }
  }

  /** Removes the gate when its holder is gone, or when it has had no holder record for the grace period. */
  private async reclaimAbandonedGate(gate: string): Promise<boolean> {
    const record = await this.gateRecord(gate);
    let why: string;
    if (record) {
      if (!await claimOwnerGone(record.owner, this.ownerProbe)) return false;
      why = `its holder (${record.owner.host} pid ${record.owner.pid}) is gone`;
    } else {
      let age: number;
      try { age = Date.now() - (await fs.stat(gate)).mtimeMs; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      if (age < GATE_UNOWNED_GRACE_MS) return false;
      why = `it has had no holder record for ${Math.round(age / 60_000)} minutes`;
    }
    await fs.unlink(path.join(gate, GATE_OWNER_FILE)).catch(() => undefined);
    try { await fs.rmdir(gate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    console.warn(`[storage] Removed an abandoned storage lifecycle gate: ${why}`);
    return true;
  }

  /** Releases only the gate this call took; a gate reclaimed and retaken by another process is left alone. */
  private async releaseGate(gate: string, token: string): Promise<void> {
    const record = await this.gateRecord(gate);
    if (record?.token !== token) {
      console.warn('[storage] The storage lifecycle gate was reclaimed while held; the holder was probably judged dead');
      return;
    }
    await fs.unlink(path.join(gate, GATE_OWNER_FILE)).catch(() => undefined);
    await fs.rmdir(gate).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }

  /** Who holds the gate right now, for wait warnings. */
  async gateHolder(): Promise<ClaimOwner | null> {
    return (await this.gateRecord(path.join(this.root, 'gate')))?.owner ?? null;
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
  async use<T>(run: () => Promise<T>, admission?: { filesystem: string; reserveBytes: number; taskBytes: number }, options: StorageUseOptions = {}): Promise<T> {
    const existing = this.context.getStore();
    if (existing?.active) {
      existing.users++;
      try {
        // Actual use nested inside maintenance still advances the durable clock.
        if (!existing.recordUse && options.recordUse !== false) {
          existing.recordUse = true;
          await this.touch();
        }
        return await run();
      } finally { await this.release(existing); }
    }
    const claim = path.join(this.root, 'readers', randomUUID());
    // Publish intent before waiting: cleanup cancels proof, while the gate still
    // prevents this operation racing any in-progress rename or deletion. A crash
    // leaves a protective claim; elapsed time never authorizes stealing it.
    // Admission (and release) waits without a deadline; an abandoned gate still
    // requires explicit recovery, rather than failing an accepted worker job.
    await this.initialize();
    await fs.writeFile(claim, JSON.stringify({ ...(admission ? { reservedBytes: admission.taskBytes } : {}), owner: currentClaimOwner() }), { flag: 'wx' });
    try {
      await this.withWaitWarning(() => this.exclusive(async () => {
        if (admission) await this.admit(admission);
        if (options.recordUse !== false) await this.touch();
      }, Infinity), options.waitWarning);
    } catch (error) { await fs.unlink(claim); throw error; }
    const scope = { active: true, users: 1, claim, recordUse: options.recordUse !== false, waitWarning: options.waitWarning };
    return this.context.run(scope, async () => {
      try { return await run(); }
      finally { await this.release(scope); }
    });
  }

  /** A caller's warning fires once; without one, a wait is reported every interval so it can never be silent. */
  private async withWaitWarning<T>(run: () => Promise<T>, warning?: StorageUseOptions['waitWarning']): Promise<T> {
    const started = Date.now();
    const timer = warning
      ? setTimeout(warning.warn, warning.afterMs)
      : setInterval(() => {
        void this.gateHolder().then(holder => console.warn(
          `[storage] Still waiting for the storage lifecycle gate after ${Math.round((Date.now() - started) / 1000)}s`
          + (holder ? ` (held by ${holder.host} pid ${holder.pid})` : ' (no holder record)'),
        ));
      }, this.options.waitWarningMs ?? DEFAULT_WAIT_WARNING_MS);
    timer.unref();
    try { return await run(); }
    finally { clearTimeout(timer); clearInterval(timer); }
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
          // A process killed mid-operation (a worker restart) never releases its claim.
          if (isClaimOwner(record.owner) && await claimOwnerGone(record.owner, this.ownerProbe)) {
            await fs.unlink(path.join(this.root, 'readers', name)).catch(() => undefined);
            console.warn(`[storage] Released a storage claim whose owner (${record.owner.host} pid ${record.owner.pid}) is gone`);
            continue;
          }
          if (record.reservedBytes === undefined) continue;
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

  private async release(scope: StorageUseScope): Promise<void> {
    if (--scope.users > 0) return;
    scope.active = false;
    await this.withWaitWarning(() => this.exclusive(async () => {
      if (scope.recordUse) await this.touch();
      await fs.unlink(scope.claim);
    }, Infinity), scope.waitWarning);
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
