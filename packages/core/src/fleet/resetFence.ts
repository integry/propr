import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalFleetJson, fleetResetIdentitySchema, type FleetResetBinding } from '@propr/shared';

interface Statement { run(...args: unknown[]): unknown; get(...args: unknown[]): Record<string, string | number | null>; all(...args: unknown[]): Record<string, string | number | null>[] }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }

export type ResetIdentity = FleetResetBinding['predecessor'];
export const resetUnavailable = (): never => { throw new Error('fleet_reset_unavailable'); };
export function openResetDatabase(file: string, mode: 'create' | 'existing' | 'readonly' = 'create'): Database {
  const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (file: string, options: { fileMustExist: boolean; readonly: boolean }) => Database;
  const db = new Sqlite(file, { fileMustExist: mode !== 'create', readonly: mode === 'readonly' });
  if (mode !== 'readonly') db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  return db;
}

/** Durable admission fence shared by Core processes. An abandoned lease is never
 * timed out or stolen. Its owner must close, or reset remains recovery_required.
 * The control root is provisioned outside all tenant state and retained by reset. */
export class ResetGenerationFence {
  private readonly db: Database;
  constructor(readonly root: string, mode: 'create' | 'existing' | 'readonly' = 'create') {
    let current = path.resolve(root);
    for (;;) {
      const s = fs.lstatSync(current);
      if (!s.isDirectory() || s.isSymbolicLink()) resetUnavailable();
      if (current === path.resolve(root) && (s.mode & 0o077)) resetUnavailable();
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const file = path.join(root, 'generation.sqlite');
    if (fs.existsSync(file)) { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) resetUnavailable(); }
    this.db = openResetDatabase(file, mode);
    if (mode !== 'create') return;
    fs.chmodSync(file, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL, fence TEXT);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, identity TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects (name TEXT PRIMARY KEY, intent TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS authorities (id TEXT PRIMARY KEY, identity TEXT NOT NULL, kind TEXT NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  provision(identity: ResetIdentity) {
    this.db.prepare('INSERT INTO identity VALUES (1, ?, NULL)').run(canonicalFleetJson(identity));
  }
  provisionSuccessor(binding: FleetResetBinding) {
    this.db.prepare('INSERT INTO identity VALUES (1, ?, ?)').run(canonicalFleetJson(binding.successor), canonicalFleetJson(binding));
  }
  activateSuccessor(binding: FleetResetBinding) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get();
      if (row?.identity !== canonicalFleetJson(binding.successor) || row.fence !== canonicalFleetJson(binding)) resetUnavailable();
      this.db.prepare('UPDATE identity SET fence=NULL WHERE singleton=1').run();
    });
  }
  /** Positive control proof; both staged and activated successors retain identity. */
  assertSuccessor(binding: FleetResetBinding) {
    this.successorActive(binding);
    return binding.successor;
  }
  successorActive(binding: FleetResetBinding): boolean {
    const row = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get();
    if (row?.identity !== canonicalFleetJson(binding.successor) ||
      (row.fence !== null && row.fence !== canonicalFleetJson(binding))) resetUnavailable();
    return row.fence === null;
  }
  async waitForIdle(binding: FleetResetBinding, timeoutMs = 30_000) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (!this.sealed(binding)) resetUnavailable();
      if (this.idle()) return;
      if (performance.now() >= deadline) resetUnavailable();
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))));
    }
  }
  acquire(identity: ResetIdentity, kind: string) {
    const id = randomUUID();
    this.write(identity, () => this.db.prepare('INSERT INTO leases VALUES (?, ?, ?)').run(id, canonicalFleetJson(identity), kind));
    return () => { this.db.prepare('DELETE FROM leases WHERE id=?').run(id); };
  }
  assert(identity: ResetIdentity) {
    const row = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get();
    if (!row || row.fence || row.identity !== canonicalFleetJson(identity)) resetUnavailable();
  }
  /** Synchronous writes commit while holding SQLite's cross-process fence lock. */
  write<T>(identity: ResetIdentity, fn: () => T): T {
    return this.transaction(() => { this.assert(identity); return fn(); });
  }
  async use<T>(identity: ResetIdentity, kind: string, fn: () => Promise<T>): Promise<T> {
    const id = randomUUID();
    this.write(identity, () => this.db.prepare('INSERT INTO leases VALUES (?, ?, ?)').run(id, canonicalFleetJson(identity), kind));
    try { const value = await fn(); this.assert(identity); return value; }
    finally { this.db.prepare('DELETE FROM leases WHERE id=?').run(id); }
  }
  seal(binding: FleetResetBinding) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get();
      if (!row || row.identity !== canonicalFleetJson(binding.predecessor) || (row.fence && row.fence !== canonicalFleetJson(binding))) resetUnavailable();
      this.db.prepare('UPDATE identity SET fence=? WHERE singleton=1').run(canonicalFleetJson(binding));
    });
  }
  sealed(binding: FleetResetBinding) {
    const row = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get();
    return row?.identity === canonicalFleetJson(binding.predecessor) && row.fence === canonicalFleetJson(binding);
  }
  idle() { return this.db.prepare('SELECT count(*) AS n FROM leases').get().n === 0; }
  issue(identity: ResetIdentity, kind: string) {
    return this.write(identity, () => {
      const id = randomUUID(); this.db.prepare('INSERT INTO authorities VALUES (?, ?, ?)').run(id, canonicalFleetJson(identity), kind); return id;
    });
  }
  accepts(identity: ResetIdentity, kind: string, id: string) {
    try { this.assert(identity); return !!this.db.prepare('SELECT 1 FROM authorities WHERE id=? AND identity=? AND kind=?').get(id, canonicalFleetJson(identity), kind); }
    catch { return false; }
  }
  revoke(binding: FleetResetBinding) {
    if (!this.sealed(binding)) resetUnavailable();
    this.db.prepare('DELETE FROM authorities WHERE identity=?').run(canonicalFleetJson(binding.predecessor));
  }
  revoked(binding: FleetResetBinding) {
    return this.sealed(binding) && this.db.prepare('SELECT count(*) AS n FROM authorities WHERE identity=?').get(canonicalFleetJson(binding.predecessor)).n === 0;
  }
  intent(name: string, intent: unknown): boolean {
    const bytes = canonicalFleetJson(intent);
    return this.transaction(() => {
      const previous = this.effect(name);
      if (previous) { if (previous.intent !== bytes) resetUnavailable(); return false; }
      this.db.prepare('INSERT INTO effects VALUES (?, ?, NULL)').run(name, bytes); return true;
    });
  }
  effect(name: string): { intent: string; result: string | null } | undefined { return this.db.prepare('SELECT * FROM effects WHERE name=?').get(name) as { intent: string; result: string | null } | undefined; }
  complete(name: string, result: unknown) {
    const bytes = canonicalFleetJson(result);
    this.transaction(() => {
      const previous = this.effect(name); if (!previous || (previous.result && previous.result !== bytes)) resetUnavailable();
      this.db.prepare('UPDATE effects SET result=? WHERE name=?').run(bytes, name);
    });
  }
  close() { this.db.close(); }
}

let configured: { fence: ResetGenerationFence; identity: ResetIdentity } | undefined;
/** Explicit opt-in only. A missing/corrupt identity is refusal, never self provisioning. */
export function configuredResetFence() {
  const root = process.env.PROPR_FLEET_RESET_RUNTIME_ROOT;
  if (!root) return undefined;
  if (!configured) {
    const identity = fleetResetIdentitySchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'process-identity.json'), 'utf8')));
    const fence = new ResetGenerationFence(root, 'existing'); fence.assert(identity); configured = { fence, identity };
  }
  return configured;
}
export function assertConfiguredResetGeneration() { const c = configuredResetFence(); c?.fence.assert(c.identity); }
export async function withResetGeneration<T>(kind: string, fn: () => Promise<T>) {
  const c = configuredResetFence(); return c ? c.fence.use(c.identity, kind, fn) : fn();
}

/**
 * Return the single graceful shutdown shared by signals, callers and reset.
 * Only successful closure releases the durable participant lease. A rejected
 * close is retained, including on repeated shutdown requests.
 */
export function watchResetGeneration(close: () => Promise<void>, managed = configuredResetFence()): () => Promise<void> {
  if (!managed) return close;
  const release = managed.fence.acquire(managed.identity, 'process-resources');
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    if (!closing) {
      if (timer) clearInterval(timer);
      closing = Promise.resolve().then(close).then(() => { release?.(); });
    }
    return closing;
  };
  if (managed) {
    timer = setInterval(() => {
      try { managed.fence.assert(managed.identity); }
      catch { void shutdown().catch(() => { /* Durable lease intentionally retained. */ }); }
    }, 100);
    timer.unref();
  }
  return shutdown;
}
