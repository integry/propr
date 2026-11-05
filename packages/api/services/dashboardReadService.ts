import { randomUUID } from 'node:crypto';
import { Worker, parentPort } from 'node:worker_threads';
import knex, { type Knex } from 'knex';
import type { OutcomeReadRow, CompletedRow } from '../routes/dashboardOutcomeQueries.js';
import { sqliteFilename } from './backgroundDatabase.js';

// This private, versioned catalog deliberately does not participate in Knex's
// shared migration ledger: older Node services can still validate that ledger.
export const OUTCOME_TABLES = {
  state: 'dashboard_outcome_v1_state', dirty: 'dashboard_outcome_v1_dirty',
  runs: 'dashboard_outcome_v1_runs', entities: 'dashboard_outcome_v1_entities',
  outbox: 'dashboard_outcome_v1_outbox',
} as const;

/** Install capture before starting the keyset backfill. No source rows are copied here. */
export async function installOutcomeProjection(db: Knex): Promise<void> {
  await db.transaction(async tx => {
    // Lock before reading the catalog, including when multiple APIs start together.
    await tx.raw(`CREATE TABLE IF NOT EXISTS ${OUTCOME_TABLES.state} (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 1,
      cursor TEXT NOT NULL DEFAULT '', seeded INTEGER NOT NULL DEFAULT 0,
      ready INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER, epoch TEXT NOT NULL)`);
    await tx(OUTCOME_TABLES.state).insert({ id: 1, epoch: randomUUID() }).onConflict('id').ignore();
    await tx.raw(`CREATE TABLE IF NOT EXISTS ${OUTCOME_TABLES.dirty} (
      task_id TEXT PRIMARY KEY, token TEXT NOT NULL, changed_at INTEGER NOT NULL)`);
    await tx.raw(`CREATE INDEX IF NOT EXISTS dashboard_outcome_v1_dirty_age ON ${OUTCOME_TABLES.dirty}(changed_at, task_id)`);
    // No affinity on sort_at: preserve SQLite ordering for legacy numeric as
    // well as textual source timestamps instead of coercing them to text.
    await tx.raw(`CREATE TABLE IF NOT EXISTS ${OUTCOME_TABLES.runs} (
      completion_id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, repository TEXT NOT NULL,
      entity_id TEXT NOT NULL, source_revision TEXT NOT NULL, sort_at NOT NULL, title TEXT, base_type TEXT, raw_recap TEXT, command_mode TEXT, payload TEXT NOT NULL)`);
    await tx.raw(`CREATE INDEX IF NOT EXISTS dashboard_outcome_v1_task ON ${OUTCOME_TABLES.runs}(task_id)`);
    await tx.raw(`CREATE INDEX IF NOT EXISTS dashboard_outcome_v1_history ON ${OUTCOME_TABLES.runs}
      (entity_id, sort_at DESC, task_id DESC, completion_id DESC)`);
    await tx.raw(`CREATE INDEX IF NOT EXISTS dashboard_outcome_v1_title ON ${OUTCOME_TABLES.runs}
      (entity_id, sort_at DESC, task_id DESC, completion_id DESC) WHERE title IS NOT NULL`);
    await tx.raw(`CREATE TABLE IF NOT EXISTS ${OUTCOME_TABLES.entities} (
      entity_id TEXT PRIMARY KEY, repository TEXT NOT NULL, sort_at NOT NULL,
      task_id TEXT NOT NULL, completion_id INTEGER NOT NULL, title TEXT,
      revision TEXT NOT NULL, payload TEXT NOT NULL)`);
    for (const [name, prefix] of [['feed', ''], ['repository', 'repository, ']]) {
      await tx.raw(`CREATE INDEX IF NOT EXISTS dashboard_outcome_v1_${name} ON ${OUTCOME_TABLES.entities}
        (${prefix}sort_at DESC, task_id DESC, completion_id DESC, entity_id)`);
    }
    await tx.raw(`CREATE TABLE IF NOT EXISTS ${OUTCOME_TABLES.outbox} (repository TEXT PRIMARY KEY, token TEXT NOT NULL)`);
    for (const table of ['tasks', 'task_history']) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const refs = action === 'UPDATE' ? ['OLD', 'NEW'] : [action === 'DELETE' ? 'OLD' : 'NEW'];
        const updateColumns = table === 'tasks'
          ? 'task_id, repository, issue_number, pr_number, task_type, model_name, created_at, initial_job_data, final_result'
          : 'task_id, history_id, state, timestamp, reason, metadata';
        await tx.raw(`CREATE TRIGGER IF NOT EXISTS dashboard_outcome_v1_${table}_${action.toLowerCase()}
          AFTER ${action === 'UPDATE' ? `UPDATE OF ${updateColumns}` : action} ON ${table} BEGIN
          ${refs.map(ref => `INSERT INTO ${OUTCOME_TABLES.dirty}(task_id, token, changed_at)
            VALUES (${ref}.task_id, lower(hex(randomblob(16))), unixepoch())
            ON CONFLICT(task_id) DO UPDATE SET token = excluded.token;`).join('\n')}
          END`);
      }
    }
  });
}

/** Enqueue one keyset backfill batch without overwriting captured changes. */
export async function seedOutcomeProjection(db: Knex): Promise<void> {
  await db.transaction(async tx => {
    await tx(OUTCOME_TABLES.state).where('id', 1).update({ updated_at: Date.now() });
    const current = await tx(OUTCOME_TABLES.state).where('id', 1).first();
    if (current.seeded) return;
    const tasks = await tx('tasks').where('task_id', '>', current.cursor).orderBy('task_id').limit(100).select('task_id');
    for (const task of tasks) {
      await tx(OUTCOME_TABLES.dirty).insert({ task_id: task.task_id, token: randomUUID(), changed_at: Math.floor(Date.now() / 1000) })
        .onConflict('task_id').ignore();
    }
    await tx(OUTCOME_TABLES.state).where('id', 1).update(tasks.length
      ? { cursor: tasks[tasks.length - 1].task_id } : { seeded: 1 });
  });
}

/** Explicit rebuild; capture stays installed and source data is never modified. */
export async function rebuildOutcomeProjection(db: Knex): Promise<void> {
  await installOutcomeProjection(db);
  await db.transaction(async tx => {
    await tx(OUTCOME_TABLES.state).where('id', 1).update({ ready: 0, seeded: 0, cursor: '', processed: 0, failures: 0, error: null, epoch: randomUUID() });
    await tx(OUTCOME_TABLES.runs).delete();
    await tx(OUTCOME_TABLES.entities).delete();
  });
}

export async function outcomeProjectionStatus(db: Knex) {
  if (!await db.schema.hasTable(OUTCOME_TABLES.state)) return { version: 1, ready: false };
  const state = await db(OUTCOME_TABLES.state).where('id', 1).first();
  const pending = await db(OUTCOME_TABLES.dirty).count({ count: '*' }).min({ oldest: 'changed_at' }).first();
  return { ...state, ready: Boolean(state?.ready), pending: Number(pending?.count ?? 0),
    lagMs: pending?.oldest ? Math.max(0, Date.now() - Number(pending.oldest) * 1000) : 0 };
}

export type CompletionLoader = ((repository: string, options?: { limit?: number; search?: string }) => Promise<OutcomeReadRow[]>) & {
  summary?: (repository: string, options?: { limit?: number; search?: string }) => Promise<OutcomeReadRow[]>;
};
export interface DashboardReadService { load: CompletionLoader; close(): Promise<void> }

function workerUrl(): URL {
  if (!import.meta.url.endsWith('.ts')) return new URL('./dashboardReadWorker.js', import.meta.url);
  const source = `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};`
    + `register(); await import(${JSON.stringify(new URL('./dashboardReadWorker.ts', import.meta.url).href)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

class SQLiteDashboardReads implements DashboardReadService {
  private worker?: Worker;
  private ready?: Promise<Worker>;
  private rejectReady?: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextId = 0;
  private pending = new Map<number, { resolve(rows: CompletedRow[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private inFlight = new Map<string, Promise<CompletedRow[]>>();

  constructor(private filename: string, private timeoutMs: number) {}

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.ready = undefined;
    clearTimeout(this.startupTimer);
    this.rejectReady?.(error);
    this.rejectReady = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void worker.terminate();
  }

  async start(): Promise<Worker> {
    if (this.closed) throw new Error('Dashboard read service is closed');
    if (this.ready) return this.ready;
    const worker = new Worker(workerUrl(), { workerData: { filename: this.filename } });
    this.worker = worker;
    this.ready = new Promise<Worker>((resolve, reject) => {
      this.rejectReady = reject;
      this.startupTimer = setTimeout(() => this.fail(worker, new Error('Dashboard read worker startup timed out')), 30_000);
      worker.on('message', (message: { type?: string; id: number; rows: CompletedRow[]; error?: string }) => {
        if (this.worker !== worker) return;
        if (message.type === 'ready') {
          clearTimeout(this.startupTimer);
          this.rejectReady = undefined;
          resolve(worker);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.rows);
      });
      worker.on('error', (error: unknown) => {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown error';
        this.fail(worker, error instanceof Error ? error : new Error(`Dashboard read worker failed: ${code}`));
      });
      worker.on('exit', code => this.fail(worker, new Error(`Dashboard read worker exited with code ${code}`)));
    });
    return this.ready;
  }

  load = (repository: string, options: { limit?: number; search?: string } = {}) => {
    if (this.closed) return Promise.reject(new Error('Dashboard read service is closed'));
    const key = JSON.stringify([repository, options.limit ?? 20, options.search ?? '']);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= 32) return Promise.reject(new Error('Dashboard read queue is full'));
    const promise = this.send(repository, options);
    this.inFlight.set(key, promise);
    // Share concurrent identical reads only; the next request reads current DB
    // state. No response TTL or cross-repository result cache is introduced.
    void promise.finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }).catch(() => undefined);
    return promise;
  };

  private async send(repository: string, options: { limit?: number; search?: string }): Promise<CompletedRow[]> {
    const worker = await this.start();
    if (this.closed || this.worker !== worker) throw new Error('Dashboard read worker is unavailable');
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail(worker, new Error('Dashboard read timed out')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, repository, options }); }
      catch (error) { this.fail(worker, error as Error); }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker) {
      this.fail(worker, new Error('Dashboard read service is closed'));
      await worker.terminate();
    }
  }
}

export async function startDashboardReadService(db: Knex, options: { timeoutMs?: number; projection?: boolean } = {}): Promise<DashboardReadService> {
  const { loadCompletedRows, loadOutcomeSummaries } = await import('../routes/dashboardOutcomeQueries.js');
  const filename = sqliteFilename(db);
  if (db.client.config.client !== 'better-sqlite3' || !filename || filename === ':memory:') {
    // Supplied connections have no projection producer. The summary protocol
    // also accepts legacy rows with embedded earlier updates.
    const load: CompletionLoader = (repository, query) => loadCompletedRows(db, repository, query);
    return { load: Object.assign(load, { summary: load }), close: async () => undefined };
  }
  const service = new SQLiteDashboardReads(filename, options.timeoutMs ?? 30_000);
  await service.start();
  const projection = options.projection === false || process.env.DASHBOARD_OUTCOME_PROJECTION === 'legacy' ? undefined : startProjectionWorker(filename);
  let closed = false;
  const summaries = projection
    ? shareSummaryReads((repository, query) => loadOutcomeSummaries(db, repository, query))
    : service.load;
  return {
    load: Object.assign(service.load, { summary: (repository: string, query?: { limit?: number; search?: string }) =>
      closed ? Promise.reject(new Error('Dashboard read service is closed')) : summaries(repository, query) }),
    close: async () => { closed = true; await projection?.close(); await service.close(); },
  };
}


// The route supplies the existing authenticated instance's Redis publisher.
// The durable outbox is acknowledged only after publication succeeds.
let publishOutcomeActivity: ((repository: string) => Promise<void>) | undefined;
export function setOutcomeActivityPublisher(publish: (repository: string) => Promise<void>): void {
  publishOutcomeActivity = publish;
}

function startProjectionWorker(filename: string): { close(): Promise<void> } {
  let worker: Worker | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    const registration = import.meta.url.endsWith('.ts')
      ? `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register();` : '';
    const source = `${registration} const { runOutcomeProjectionWorker } = await import(${JSON.stringify(import.meta.url)});
      await runOutcomeProjectionWorker(${JSON.stringify(filename)});`;
    const current = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    worker = current;
    const publishing = new Set<string>();
    current.on('message', (message: { repository: string; token: string }) => {
      if (!publishOutcomeActivity || publishing.has(message.repository)) return;
      publishing.add(message.repository);
      void publishOutcomeActivity(message.repository).then(() => {
        if (!closed && worker === current) current.postMessage(message);
      }).catch(() => undefined).finally(() => publishing.delete(message.repository)); // Retain failed outbox entries.
    });
    current.on('error', error => console.error('Outcome projection worker:', error.message));
    current.on('exit', () => { if (!closed) retry = setTimeout(start, 1000); });
  };
  start();
  return { close: async () => { closed = true; clearTimeout(retry); await worker?.terminate(); } };
}

async function publishPendingOutcomes(db: Knex, lastPublish: number): Promise<number> {
  if (Date.now() - lastPublish <= 500 || !(await db(OUTCOME_TABLES.state).first('ready'))?.ready) return lastPublish;
  for (const event of await db(OUTCOME_TABLES.outbox).limit(100)) parentPort?.postMessage(event);
  return Date.now();
}

async function recordProjectionFailure(db: Knex, error: unknown, installed: boolean): Promise<void> {
  // Lock contention is normal; a failed attempt never consumes dirty work.
  if (error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message)) return;
  console.error('Outcome projection failed:', error);
  if (installed) await db(OUTCOME_TABLES.state).where('id', 1)
    .update({ error: error instanceof Error ? error.message : String(error) }).increment('failures', 1).catch(() => undefined);
}

/** Runs off the API event loop. Restarts resume the persisted cursor and dirty queue. */
export async function runOutcomeProjectionWorker(filename: string): Promise<void> {
  const { advanceOutcomeProjection } = await import('../routes/dashboardOutcomeQueries.js');
  const db = knex({ client: 'better-sqlite3', connection: { filename },
    useNullAsDefault: true, pool: { min: 1, max: 1,
      afterCreate: (connection: { pragma(sql: string): void }, done: (error: Error | null, connection: unknown) => void) => {
        connection.pragma('busy_timeout = 0'); done(null, connection);
      } } });
  const acknowledgements: Array<{ repository: string; token: string }> = [];
  parentPort?.on('message', message => acknowledgements.push(message));
  let installed = false;
  let lastPublish = 0;
  try {
    for (;;) {
      try {
        if (!installed) { await installOutcomeProjection(db); installed = true; }
        for (const ack of acknowledgements.splice(0)) await db(OUTCOME_TABLES.outbox).where(ack).delete();
        const more = await advanceOutcomeProjection(db);
        lastPublish = await publishPendingOutcomes(db, lastPublish);
        await new Promise(resolve => setTimeout(resolve, more ? 0 : 250));
      } catch (error) {
        await recordProjectionFailure(db, error, installed);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } finally { await db.destroy(); }
}


function shareSummaryReads(load: NonNullable<CompletionLoader['summary']>): NonNullable<CompletionLoader['summary']> {
  const pending = new Map<string, Promise<OutcomeReadRow[]>>();
  return (repository, options = {}) => {
    const key = JSON.stringify([repository, options.limit ?? 20, options.search ?? '']);
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 32) return Promise.reject(new Error('Dashboard read queue is full'));
    const read = load(repository, options);
    pending.set(key, read);
    void read.finally(() => { if (pending.get(key) === read) pending.delete(key); }).catch(() => undefined);
    return read;
  };
}
