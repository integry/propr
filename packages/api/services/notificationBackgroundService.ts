import { Worker } from 'node:worker_threads';
import type { Knex } from 'knex';
import type {
  DraftUpdatePayload,
  IndexingUpdatePayload,
  TaskUpdatePayload,
} from '@propr/shared';
import { createBackgroundDatabase, sqliteFilename } from './backgroundDatabase.js';
import { NotificationProjectionService } from './notificationProjectionService.js';
import { WebPushDispatcher } from './webPushDispatcher.js';
import type {
  NotificationBackgroundOperation,
  NotificationBackgroundRequest,
  NotificationBackgroundResponse,
  NotificationProjectionSink,
} from './notificationBackgroundProtocol.js';

export interface NotificationBackgroundService extends NotificationProjectionSink {
  readonly webPushDispatcherConfigured: boolean;
  close(): Promise<void>;
}

function workerUrl(): URL {
  if (!import.meta.url.endsWith('.ts')) {
    return new URL('./notificationBackgroundWorker.js', import.meta.url);
  }
  // Node does not consistently propagate tsx's programmatic resolver into a
  // worker spawned by the test runner. Register it inside a tiny module
  // bootstrap before loading the TypeScript worker used by tests/dev.
  const tsxApi = import.meta.resolve('tsx/esm/api');
  const entry = new URL('./notificationBackgroundWorker.ts', import.meta.url).href;
  const source = `import { register } from ${JSON.stringify(tsxApi)};`
    + `register(); await import(${JSON.stringify(entry)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

class WorkerNotificationBackgroundService implements NotificationBackgroundService {
  readonly webPushDispatcherConfigured: boolean;
  private nextRequestId = 1;
  private closed = false;
  private failure: Error | undefined;
  private readonly pending = new Map<number, {
    resolve(): void;
    reject(error: Error): void;
  }>();

  private constructor(
    private readonly worker: Worker,
    webPushDispatcherConfigured: boolean,
  ) {
    this.webPushDispatcherConfigured = webPushDispatcherConfigured;
    worker.on('message', message => this.handleMessage(message as NotificationBackgroundResponse));
    worker.on('error', error => this.fail(error));
    worker.on('exit', code => {
      if (!this.closed || code !== 0 || this.pending.size > 0) {
        this.fail(new Error(`Notification background worker exited with code ${code}`));
      }
    });
  }

  static async start(databaseFilename: string): Promise<WorkerNotificationBackgroundService> {
    const worker = new Worker(workerUrl(), {
      workerData: { databaseFilename },
      // The core package creates its process-local default connection during
      // module evaluation. Worker-specific env makes that connection target the
      // requested file before any imports execute (also in tsx development).
      env: { ...process.env, DB_FILENAME: databaseFilename },
    });
    const configured = await new Promise<boolean>((resolve, reject) => {
      const onMessage = (message: NotificationBackgroundResponse): void => {
        if (message.type !== 'ready') return;
        cleanup();
        resolve(message.webPushDispatcherConfigured);
      };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onExit = (code: number): void => {
        cleanup();
        reject(new Error(`Notification background worker exited during startup with code ${code}`));
      };
      const cleanup = (): void => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.once('exit', onExit);
    });
    return new WorkerNotificationBackgroundService(worker, configured);
  }

  projectTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
    return this.request({ type: 'task', payload });
  }

  projectDraftUpdate(payload: DraftUpdatePayload): Promise<void> {
    return this.request({ type: 'draft', payload });
  }

  projectIndexingUpdate(payload: IndexingUpdatePayload): Promise<void> {
    return this.request({ type: 'indexing', payload });
  }

  projectSystemSnapshot(
    snapshot: Record<string, unknown> & { timestamp: string },
    additionalAdministratorIds: readonly string[] = [],
  ): Promise<void> {
    return this.request({ type: 'system', snapshot, additionalAdministratorIds });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.failure) return;
    const id = this.nextRequestId++;
    const completion = this.response(id);
    this.worker.postMessage({ type: 'close', id } satisfies NotificationBackgroundRequest);
    await completion;
  }

  private request(operation: NotificationBackgroundOperation): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextRequestId++;
    const completion = this.response(id);
    this.worker.postMessage({ type: 'operation', id, operation } satisfies NotificationBackgroundRequest);
    return completion;
  }

  private response(id: number): Promise<void> {
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
  }

  private handleMessage(message: NotificationBackgroundResponse): void {
    if (message.type !== 'result') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error));
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

class LocalNotificationBackgroundService implements NotificationBackgroundService {
  readonly webPushDispatcherConfigured: boolean;
  private readonly active = new Set<Promise<void>>();
  private closed = false;

  private constructor(
    private readonly projection: NotificationProjectionService,
    private readonly dispatcher: WebPushDispatcher | undefined,
    private readonly closeDatabase: () => Promise<void>,
    webPushDispatcherConfigured: boolean,
  ) {
    this.webPushDispatcherConfigured = webPushDispatcherConfigured;
  }

  static async start(source: Knex): Promise<LocalNotificationBackgroundService> {
    const background = await createBackgroundDatabase(source);
    let dispatcher: WebPushDispatcher | undefined;
    let configured = false;
    try {
      dispatcher = new WebPushDispatcher({ database: background.database });
      configured = dispatcher.start().configured;
    } catch {
      console.warn('[notifications] Web Push dispatcher disabled: invalid dispatcher tuning configuration');
    }
    const projection = new NotificationProjectionService({ database: background.database });
    projection.startStalledDetector();
    return new LocalNotificationBackgroundService(
      projection, dispatcher, background.close, configured,
    );
  }

  projectTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
    return this.run('task update', () => this.projection.projectTaskUpdate(payload));
  }

  projectDraftUpdate(payload: DraftUpdatePayload): Promise<void> {
    return this.run('draft update', () => this.projection.projectDraftUpdate(payload));
  }

  projectIndexingUpdate(payload: IndexingUpdatePayload): Promise<void> {
    return this.run('indexing update', () => this.projection.projectIndexingUpdate(payload));
  }

  projectSystemSnapshot(
    snapshot: Record<string, unknown> & { timestamp: string },
    additionalAdministratorIds: readonly string[] = [],
  ): Promise<void> {
    return this.run(
      'system health snapshot',
      () => this.projection.projectSystemSnapshot(snapshot, additionalAdministratorIds),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.projection.close();
    await Promise.allSettled([...this.active]);
    await this.dispatcher?.close();
    await this.closeDatabase();
  }

  private run(label: string, operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const run = this.projection.bestEffort(label, operation).finally(() => this.active.delete(run));
    this.active.add(run);
    return run;
  }
}

/**
 * Start notification projection and delivery outside the API event loop when
 * SQLite is in use. Other database clients retain their asynchronous driver.
 */
export async function startNotificationBackgroundService(
  database: Knex,
): Promise<NotificationBackgroundService> {
  const filename = sqliteFilename(database);
  if (database.client.config.client === 'better-sqlite3'
    && filename
    && filename !== ':memory:') {
    return WorkerNotificationBackgroundService.start(filename);
  }
  return LocalNotificationBackgroundService.start(database);
}
