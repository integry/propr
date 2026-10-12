import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { DatabaseExportStatus } from '@propr/shared';
import { assertRealDirectory } from './lifecycle.js';
import { databaseExportWorker, isExportSecretName, isExportSecretValue } from './databaseExportWorker.js';
import { acquireExportLease, DatabaseExportLockError, EXPORT_TTL, eraseExportSnapshot, exportSnapshotName, recoverExpiredExportLocks, releaseExportLease } from './databaseExportLease.js';
import { StorageContractError } from './cleanupRequest.js';

export { DatabaseExportLockError };

const require = createRequire(import.meta.url);
const MAX_BYTES = 512 * 1024 ** 2;
const TTL = EXPORT_TTL;
// Recollect at job execution, including credentials absent from current agents.
// Preserve exact values (whitespace may be significant); never expose this set
// through job metadata, diagnostics, or errors.
export function configuredExportSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(Object.entries(env).flatMap(([name, value]) =>
    isExportSecretName(name) && isExportSecretValue(value) ? [value] : []))];
}
export type StorageAuthority = () => Promise<void>;
// Compatibility boundary for existing storage callers.
type ExportOperationArgs = [instanceId: string, generation: string, id: string, actor: string, authorize: StorageAuthority];
interface ExportRequest {
  instanceId: string;
  generation: string;
  operationId: string;
  actor: string;
  authorize: StorageAuthority;
}
function exportRequest(args: ExportOperationArgs): ExportRequest {
  const [instanceId, generation, operationId, actor, authorize] = args;
  return { instanceId, generation, operationId, actor, authorize };
}
interface ExportJob { token: string; actor: string; status: DatabaseExportStatus; directory: string; worker?: Worker; disposed?: Promise<void>; removing?: Promise<void>; identity?: { dev: number; ino: number }; ancestry: Array<{ path: string; dev: number; ino: number }> }

/** Private, bounded, process-generation-bound jobs. Never accepts a caller path. */
export class DatabaseExports {
  readonly generation = randomUUID();
  private job?: ExportJob;
  private admitting = false;
  constructor(private readonly source: string, private readonly root: string) {
    // Old process generations are never redeemable. Recover expired locks left by a
    // crash, restart or another runtime; never steal a live, unexpired job.
    const timer = setTimeout(() => { void this.reap().catch(() => undefined); }, TTL);
    timer.unref();
  }
  private async reap() {
    if (this.job || this.admitting) return;
    await recoverExpiredExportLocks(this.root);
  }

  private async validateSource() {
    await assertRealDirectory(path.dirname(this.source));
    const stat = await fs.lstat(this.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Unsafe database');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const side = await fs.lstat(`${this.source}${suffix}`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (side && (!side.isFile() || side.isSymbolicLink() || side.nlink !== 1 || side.size > MAX_BYTES)) throw new Error('Unsafe database sidecar');
    }
    return stat;
  }

  async start(instanceId: string, actor: string, authorize: StorageAuthority): Promise<DatabaseExportStatus> {
    if (this.admitting) throw new DatabaseExportLockError('Another database export is in progress. Wait for it to finish or expire, then try again.');
    const previous = this.job;
    if (previous && Date.parse(previous.status.expiresAt) > Date.now()) throw new DatabaseExportLockError('Another database export is in progress. Wait for it to finish or expire, then try again.');
    // Claimed synchronously, before any await: concurrent starts cannot both pass the guard.
    this.admitting = true;
    try {
      if (previous) {
        // An expired job is never redeemable; any retained files stay governed by its on-disk lease.
        await this.discard(previous).catch(() => undefined);
        if (this.job === previous) this.job = undefined;
      }
      await authorize();
      const stat = await this.validateSource();
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      await assertRealDirectory(this.root);
      const rootStat = await fs.stat(this.root);
      if ((rootStat.mode & 0o077) !== 0) throw new Error('Export directory must be private');
      const space = await fs.statfs(this.root);
      if (space.bavail * space.bsize < MAX_BYTES * 3) throw new Error('Insufficient export space');
      // Cross-process admission: recovers expired locks, never steals a live one.
      const expiresAt = Date.now() + TTL;
      const token = await acquireExportLease(this.root, expiresAt);
      const directory = path.join(this.root, exportSnapshotName(token));
      let ancestry: ExportJob['ancestry'];
      try { ancestry = await this.captureAncestry(directory); }
      catch (error) { await eraseExportSnapshot(directory); await releaseExportLease(this.root, token); throw error; }
      const job: ExportJob = {
        token, actor, directory, ancestry,
        status: { version: 1, instanceId, generation: this.generation, operationId: randomUUID(), state: 'running', expiresAt: new Date(expiresAt).toISOString(), scope: 'customer_database' },
      };
      this.job = job;
      void this.run(job, stat, authorize).catch(() => { job.status.state = 'failed'; });
      const expiry = setTimeout(() => { void this.discard(job).catch(() => undefined); }, TTL);
      expiry.unref();
      return { ...job.status };
    } finally { this.admitting = false; }
  }

  private async captureAncestry(directory: string): Promise<ExportJob['ancestry']> {
    const ancestry: ExportJob['ancestry'] = [];
    for (const leaf of [path.dirname(this.source), directory]) {
      let current = path.resolve(leaf);
      for (;;) {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe ancestor');
        ancestry.push({ path: current, dev: stat.dev, ino: stat.ino });
        const parent = path.dirname(current); if (parent === current) break; current = parent;
      }
    }
    return ancestry;
  }

  private async run(job: ExportJob, original: Awaited<ReturnType<typeof fs.stat>>, authorize: StorageAuthority) {
    let deadline: NodeJS.Timeout | undefined;
    let revocation: NodeJS.Timeout | undefined;
    try {
      await authorize();
      const worker = new Worker(databaseExportWorker, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData: {
        sqliteModule: require.resolve('better-sqlite3'), source: this.source,
        forbiddenSecrets: configuredExportSecrets(),
        ancestry: job.ancestry, identity: { dev: original.dev, ino: original.ino },
        target: path.join(job.directory, 'database.sqlite'), maxBytes: MAX_BYTES,
      } });
      job.worker = worker;
      const metadata = await new Promise<Partial<DatabaseExportStatus>>((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Export timed out')), 60_000);
        revocation = setInterval(() => { void authorize().catch(reject); }, 250);
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Export interrupted')));
        worker.once('message', value => value.failed ? reject(new Error('Export failed')) : resolve(value));
      });
      await authorize();
      await assertRealDirectory(path.dirname(this.source));
      const current = await fs.lstat(this.source);
      if (!current.isFile() || current.nlink !== 1 || current.dev !== original.dev || current.ino !== original.ino) throw new Error('Source changed');
      await this.checkAncestry(job);
      const snapshot = await fs.lstat(path.join(job.directory, 'database.sqlite'));
      job.identity = { dev: snapshot.dev, ino: snapshot.ino };
      Object.assign(job.status, metadata, { state: 'ready' });
    } catch {
      job.status.state = 'failed';
      await job.worker?.terminate();
      await this.removeFiles(job);
    } finally {
      clearTimeout(deadline); clearInterval(revocation);
      await job.worker?.terminate(); job.worker = undefined;
    }
  }

  private selected(request: ExportRequest): ExportJob {
    const { instanceId, generation, operationId, actor } = request;
    const job = this.job;
    if (!job || job.actor !== actor || job.status.instanceId !== instanceId || generation !== this.generation || job.status.operationId !== operationId || Date.parse(job.status.expiresAt) <= Date.now()) throw new StorageContractError(410, 'Export unavailable or expired');
    return job;
  }
  async status(...args: ExportOperationArgs) {
    const request = exportRequest(args);
    const job = this.selected(request);
    const { authorize } = request;
    try { await authorize(); } catch (error) { await this.discard(job); throw error; }
    return { ...job.status };
  }
  async redeem(...args: ExportOperationArgs) {
    const request = exportRequest(args);
    const job = this.selected(request);
    const { authorize } = request;
    await authorize();
    // A consumed redemption is a definitive refusal (410); an unready job is retained (409).
    if (job.status.state === 'redeemed') throw new StorageContractError(410, 'Export unavailable or expired');
    if (job.status.state !== 'ready') throw new StorageContractError(409, 'Export not ready for download');
    // Synchronous consumption before opening: simultaneous redemptions cannot both succeed.
    job.status.state = 'redeemed';
    try {
      await this.checkAncestry(job);
      const file = await fs.open(path.join(job.directory, 'database.sqlite'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== job.status.sizeBytes || stat.dev !== job.identity?.dev || stat.ino !== job.identity?.ino) throw new Error('Unsafe export');
        await authorize();
        return { file, status: { ...job.status }, dispose: () => this.discard(job) };
      } catch (error) { await file.close(); throw error; }
    } catch (error) {
      await this.discard(job);
      // Consumed and discarded: only authority failures keep their own status.
      throw error instanceof StorageContractError ? error : new StorageContractError(410, 'Export unavailable or expired');
    }
  }
  async cancel(...args: ExportOperationArgs) {
    const request = exportRequest(args);
    const job = this.selected(request);
    const { authorize } = request;
    await authorize(); await this.discard(job);
  }
  private async checkAncestry(job: ExportJob) {
    for (const item of job.ancestry) {
      const stat = await fs.lstat(item.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino) throw new Error('Export ancestor changed');
    }
  }
  private removeFiles(job: ExportJob): Promise<void> {
    job.removing ??= (async () => {
      // A substituted ancestor is uncertainty: retain it for operator investigation.
      try { await this.checkAncestry(job); }
      catch { return; }
      await eraseExportSnapshot(job.directory);
    })();
    return job.removing;
  }
  private discard(job: ExportJob): Promise<void> {
    job.disposed ??= (async () => {
      await job.worker?.terminate();
      await this.removeFiles(job);
      if (this.job === job) {
        const root = job.ancestry.find(item => item.path === path.resolve(this.root));
        const stat = await fs.lstat(this.root);
        if (stat.isDirectory() && stat.dev === root?.dev && stat.ino === root?.ino) {
          await releaseExportLease(this.root, job.token);
        }
        this.job = undefined;
      }
    })();
    return job.disposed;
  }
}
