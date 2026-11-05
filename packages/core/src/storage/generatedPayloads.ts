import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StorageCandidate, StorageProtection } from '@propr/shared';
import { assertRealDirectory, repositoryStorageLifecycle, storageControlRoot, type StorageLifecycle } from './lifecycle.js';
import { walk, budget, type Budget, type Limits } from './generatedPayloadWalk.js';

// Names alone never establish ownership. Only an empty directory created by a
// trusted producer, with a complete post-generation content proof, is eligible.
export const GENERATED_PAYLOADS = ['node_modules', '.propr/cache', '.propr/build', '.propr/test-cache'] as const;
type Payload = typeof GENERATED_PAYLOADS[number];
interface Record {
  id: string; worktree: string; payload: Payload; device: number; inode: number;
  completed: boolean; cleaned?: boolean; generating?: boolean; fingerprint: string; regeneration: string;
}

export class GeneratedPayloadStorage {
  constructor(readonly worktreesRoot: string, readonly root = storageControlRoot(), readonly lifecycle: StorageLifecycle = repositoryStorageLifecycle, private readonly limits: Limits = {}) {
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid generated-payload proof limits');
  }
  private directory(worktree: string, payload: Payload): string {
    if (!GENERATED_PAYLOADS.includes(payload)) throw new Error('unknown_ownership');
    const relative = path.relative(path.resolve(this.worktreesRoot), path.resolve(worktree));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_path');
    return path.join(path.resolve(worktree), payload);
  }
  private async gitProof(worktree: string, payload: Payload, signal?: AbortSignal): Promise<void> {
    const git = async (args: string[]) => (await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', worktree, ...args], {
      timeout: 5000, maxBuffer: 1024 * 1024, signal,
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    })).stdout;
    try {
      const marker = await fs.lstat(path.join(worktree, '.git'));
      if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory()) || (marker.isFile() && marker.nlink !== 1)) throw new Error('unknown_git_state');
      await git(['rev-parse', '--verify', 'HEAD']);
      if ((await git(['ls-files', '--stage', '--', payload])).trim() || (await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', payload])).trim()) throw new Error('private_work');
      await git(['fsck', '--full', '--no-dangling']);
    } catch (error) { if ((error as Error).message === 'private_work') throw error; throw new Error('unknown_git_state'); }
  }
  private async write(record: Record): Promise<void> {
    const root = path.join(this.root, 'generated-payloads');
    await fs.mkdir(root, { recursive: true }); await assertRealDirectory(root);
    const temporary = path.join(root, randomUUID());
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path.join(root, `${record.id}.json`));
  }
  private async read(id: string): Promise<Record> {
    if (!/^payload-[0-9a-f]{64}$/.test(id)) throw new Error('unknown_ownership');
    await assertRealDirectory(path.join(this.root, 'generated-payloads'));
    const handle = await fs.open(path.join(this.root, 'generated-payloads', `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new Error('unknown_ownership');
      const record = JSON.parse(await handle.readFile('utf8')) as Record;
      if (record.id !== id || this.id(record.worktree, record.payload) !== id || !Number.isSafeInteger(record.device) || !Number.isSafeInteger(record.inode) || typeof record.completed !== 'boolean' || !this.validState(record) || !/^[0-9a-f]{64}$/.test(record.fingerprint) || !record.regeneration) throw new Error('unknown_ownership');
      this.directory(record.worktree, record.payload);
      return record;
    } finally { await handle.close(); }
  }
  private validState(record: Record): boolean {
    return (record.cleaned === undefined || typeof record.cleaned === 'boolean')
      && (record.generating === undefined || typeof record.generating === 'boolean')
      && !(record.cleaned && record.generating);
  }
  private id(worktree: string, payload: Payload): string { return `payload-${createHash('sha256').update(`${path.resolve(worktree)}\0${payload}`).digest('hex')}`; }
  /** Trusted producer API, never an HTTP adopt-existing-directory operation.
   * regenerate must produce only refetchable dependencies/generated outputs.
   * It must not copy customer inputs, secrets or private state into the payload.
   * Only a descriptor-proved owned cleaned root may be reused. Unknown existing
   * directories, interrupted producers and later edits remain protected.
   * A cleaned-root producer path may be /proc/self/fd/N/. and is process-relative.
   * Use it within this process; do not pass it unchanged to a child process.
   */
  async generate(worktree: string, payload: Payload, regeneration: string, regenerate: (directory: string) => Promise<void>): Promise<void> {
    if (!regeneration || regeneration.length > 4096) throw new Error('Regeneration semantics required');
    await this.lifecycle.use(async () => {
      const directory = this.directory(worktree, payload);
      await assertRealDirectory(worktree);
      await this.gitProof(worktree, payload);
      await fs.mkdir(path.dirname(directory), { recursive: true }); await assertRealDirectory(path.dirname(directory));
      const cleaned = await this.prepareGeneration(worktree, payload, directory);
      if (cleaned) {
        await this.regenerateCleaned(cleaned, { directory, regeneration, regenerate });
        return;
      }
      const stat = await fs.lstat(worktree);
      await regenerate(directory);
      const proof = await walk(directory, stat.dev, budget(this.limits));
      await this.write({ id: this.id(worktree, payload), worktree: path.resolve(worktree), payload, device: stat.dev, inode: stat.ino, completed: false, fingerprint: proof.fingerprint, regeneration });
    });
  }
  private async prepareGeneration(worktree: string, payload: Payload, directory: string): Promise<Record | null> {
    return this.lifecycle.exclusive(async () => {
      try { await fs.mkdir(directory); return null; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const record = await this.read(this.id(worktree, payload)).catch(() => null);
        if (!record?.cleaned) throw error; // Unknown existing directories are never adopted.
        await this.pinned(record, async pinnedDirectory => {
          const empty = await walk(pinnedDirectory, record.device, budget(this.limits));
          if (empty.nodes.size !== 1 || empty.fingerprint !== record.fingerprint) throw new Error('private_work');
          // Consume before the producer runs. Failed/interrupted generation cannot
          // reuse the tombstone, even when it left the root empty.
          await this.write({ ...record, cleaned: false, generating: true, completed: false });
        });
        return record;
      }
    });
  }
  private async regenerateCleaned(record: Record, producer: {
    directory: string; regeneration: string; regenerate: (directory: string) => Promise<void>;
  }): Promise<void> {
    await this.pinned(record, async directory => {
      const empty = await walk(directory, record.device, budget(this.limits));
      if (empty.nodes.size !== 1 || empty.fingerprint !== record.fingerprint) throw new Error('private_work');
      const identity = await fs.lstat(directory);
      await producer.regenerate(directory);
      const proof = await walk(directory, record.device, budget(this.limits));
      const current = await fs.lstat(producer.directory);
      if (current.dev !== identity.dev || current.ino !== identity.ino || await fs.realpath(producer.directory) !== await fs.realpath(directory)) throw new Error('unsafe_path');
      await this.write({ ...record, cleaned: false, generating: false, completed: false, fingerprint: proof.fingerprint, regeneration: producer.regeneration });
    });
  }
  async complete(worktree: string, success: boolean): Promise<void> {
    await this.lifecycle.use(async () => {
      for (const payload of GENERATED_PAYLOADS) {
        const record = await this.read(this.id(worktree, payload)).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (record && !record.cleaned && !record.generating) { record.completed = success; await this.write(record); }
      }
    });
  }
  /** Drops the records of a worktree that was removed as a whole. */
  async forget(worktree: string): Promise<void> {
    for (const payload of GENERATED_PAYLOADS) {
      await fs.unlink(path.join(this.root, 'generated-payloads', `${this.id(worktree, payload)}.json`)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
  private async pinned<T>(record: Record, run: (directory: string) => Promise<T>): Promise<T> {
    // Pin every ancestor before using it. This also confines same-device symlink
    // substitutions of the worktree or .propr parent, across proof and removal.
    this.directory(record.worktree, record.payload);
    const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(Boolean).map(line => line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    try {
      let target = path.parse(record.worktree).root;
      for (const component of [...record.worktree.slice(target.length).split(path.sep).filter(Boolean), ...record.payload.split('/')]) {
        const handle = await fs.open(path.join(target, component), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(handle);
        const stat = await handle.stat();
        if (handles.length === record.worktree.slice(path.parse(record.worktree).root.length).split(path.sep).filter(Boolean).length && (stat.dev !== record.device || stat.ino !== record.inode)) throw new Error('unknown_ownership');
        target = `/proc/self/fd/${handle.fd}`;
        const real = await fs.realpath(target);
        const relative = path.relative(path.resolve(this.worktreesRoot), real);
        if (relative && !relative.startsWith('..') && mounts.includes(real)) throw new Error('unsafe_path');
      }
      return await run(`${target}/.`);
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
  private async inspect(record: Record, limits: Budget, signal?: AbortSignal) {
    await this.gitProof(record.worktree, record.payload, signal);
    return this.pinned(record, async directory => {
      const proof = await walk(directory, record.device, limits, { signal });
      if (proof.fingerprint !== record.fingerprint) throw new Error('private_work');
      return proof;
    });
  }
  private async previewNames(root: string, limits: Budget): Promise<{ names: string[]; cursor: string }> {
    const directory = await fs.opendir(root);
    const names: string[] = [];
    for await (const entry of directory) { if (names.length >= 10_000 || Date.now() >= limits.deadline) break; names.push(entry.name); }
    names.sort();
    const cursorPath = path.join(root, 'cursor');
    let cursor = '';
    try {
      const handle = await fs.open(cursorPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128) throw new Error('unknown_ownership');
        cursor = await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { names, cursor };
  }
  /** Called under the shared cleanup barrier, with fresh queue/DB authority. */
  async preview(busy: boolean, idleHours: number, signal: AbortSignal, enabled = true): Promise<StorageCandidate[]> {
    const candidates: StorageCandidate[] = [];
    const root = path.join(this.root, 'generated-payloads');
    try { await assertRealDirectory(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidates; throw error; }
    const limits = budget(this.limits);
    const clock = await this.lifecycle.lastUse();
    const { names, cursor } = await this.previewNames(root, limits);
    const cursorPath = path.join(root, 'cursor');
    const selected = [...names.filter(name => name > cursor), ...names.filter(name => name <= cursor)].filter(name => name !== 'cursor').slice(0, 10);
    let lastName: string | undefined;
    for (const name of selected) {
      if (candidates.length >= 10 || Date.now() >= limits.deadline || limits.entries <= 0 || limits.bytes <= 0) break;
      lastName = name;
      const candidate: StorageCandidate = { id: name.slice(0, -5), category: 'worktrees', estimatedBytes: null, protectedReasons: [] };
      const inspected = await this.previewCandidate(candidate, { busy, idleHours, signal, enabled, clock, limits });
      if (!inspected) continue;
      candidates.push(candidate);
    }
    if (lastName) {
      const temporary = path.join(root, randomUUID());
      await fs.writeFile(temporary, lastName, { flag: 'wx' });
      await fs.rename(temporary, cursorPath);
    }
    return candidates;
  }
  private async previewCandidate(candidate: StorageCandidate, state: {
    busy: boolean; idleHours: number; signal: AbortSignal; enabled: boolean; clock: number | null; limits: Budget;
  }): Promise<boolean> {
    const { busy, idleHours, signal, enabled, clock, limits } = state;
    try {
      const record = await this.read(candidate.id);
      if (record.cleaned) return false;
      if (!enabled) candidate.protectedReasons = ['unsupported'];
      else if (busy || record.generating || !record.completed || signal.aborted) candidate.protectedReasons = ['busy'];
      else if (!clock) candidate.protectedReasons = ['unknown_use'];
      else if (Date.now() - clock < Math.max(24, idleHours) * 3_600_000) candidate.protectedReasons = ['recent_use'];
      else candidate.estimatedBytes = (await this.inspect(record, limits, signal)).bytes;
    } catch (error) { candidate.protectedReasons = [signal.aborted ? 'busy' : this.reason(error)]; }
    return true;
  }
  private reason(error: unknown): StorageProtection {
    const message = (error as Error).message;
    return ['unsafe_path', 'private_work', 'unknown_ownership', 'unknown_git_state', 'unsupported'].includes(message) ? message as StorageProtection : 'changed';
  }
  async remove(id: string, signal: AbortSignal): Promise<StorageProtection[]> {
    let removed = false;
    try {
      const record = await this.read(id);
      if (record.cleaned || record.generating || !record.completed || await this.lifecycle.busy()) return ['busy'];
      const proof = await this.inspect(record, budget(this.limits), signal);
      signal.throwIfAborted();
      // No rename: the exact worktree/path and manifest remain valid for partial
      // interruption. A partial removal fails its fingerprint on a future retry.
      // Managed writers are excluded by the lifecycle gate for this entire walk.
      await this.pinned(record, async directory => {
        await walk(directory, record.device, budget(this.limits), { signal, remove: true, expected: proof.nodes, onRemove: () => { removed = true; } });
        signal.throwIfAborted();
        const empty = await walk(directory, record.device, budget(this.limits), { signal });
        if (empty.nodes.size !== 1) throw new Error('changed');
        await this.write({ ...record, completed: false, cleaned: true, fingerprint: empty.fingerprint });
      });
      // Keep the empty payload root: removing by its original pathname would
      // add a substitution race after releasing descriptors. No customer file
      // can be lost by retaining an empty directory. The durable cleaned proof
      // permits only this owned empty inode to enter another production cycle.
      signal.throwIfAborted();
      return [];
    } catch (error) { return [signal.aborted ? 'busy' : this.reason(error), ...(removed ? ['partial_generated_cleanup' as const] : [])]; }
  }
}
export function generatedPayloadStorage(): GeneratedPayloadStorage {
  return new GeneratedPayloadStorage(process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees');
}
