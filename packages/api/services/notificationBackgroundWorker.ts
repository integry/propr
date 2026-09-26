import { parentPort, workerData } from 'node:worker_threads';
import {
  closeConnection,
  closeEventPublisher,
  db,
  publishNotificationUpdateThroughRedis,
} from '@propr/core';
import type {
  NotificationBackgroundOperation,
  NotificationBackgroundRequest,
  NotificationBackgroundResponse,
} from './notificationBackgroundProtocol.js';

interface NotificationWorkerData {
  databaseFilename: string;
}

if (!parentPort) throw new Error('Notification background worker requires a parent port');
const port = parentPort;

const data = workerData as NotificationWorkerData;
if (typeof data.databaseFilename !== 'string' || data.databaseFilename.length === 0) {
  throw new Error('Notification background worker requires a database filename');
}

const sourceExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const backgroundDatabaseModule: typeof import('./backgroundDatabase.js') = await import(
  `./backgroundDatabase.${sourceExtension}`
);
const projectionModule: typeof import('./notificationProjectionService.js') = await import(
  `./notificationProjectionService.${sourceExtension}`
);
const dispatcherModule: typeof import('./webPushDispatcher.js') = await import(
  `./webPushDispatcher.${sourceExtension}`
);
const { createBackgroundDatabase } = backgroundDatabaseModule;
const { NotificationProjectionService } = projectionModule;
const { WebPushDispatcher } = dispatcherModule;

const background = await createBackgroundDatabase(db);
const projection = new NotificationProjectionService({
  database: background.database,
  publishNotificationUpdate: publishNotificationUpdateThroughRedis,
});
projection.startStalledDetector();

let dispatcher: InstanceType<typeof WebPushDispatcher> | undefined;
let webPushDispatcherConfigured = false;
try {
  dispatcher = new WebPushDispatcher({ database: background.database });
  webPushDispatcherConfigured = dispatcher.start().configured;
} catch {
  console.warn('[notifications] Web Push dispatcher disabled: invalid dispatcher tuning configuration');
}

const active = new Set<Promise<void>>();
let closing = false;

function respond(message: NotificationBackgroundResponse): void {
  port.postMessage(message);
}

function operationLabel(operation: NotificationBackgroundOperation): string {
  switch (operation.type) {
    case 'task': return `task update for ${operation.payload.taskId}`;
    case 'draft': return `draft update for ${operation.payload.draftId}`;
    case 'indexing': return `indexing update for ${operation.payload.repository}`;
    case 'system': return 'system health snapshot';
  }
}

function project(operation: NotificationBackgroundOperation): Promise<void> {
  switch (operation.type) {
    case 'task': return projection.projectTaskUpdate(operation.payload);
    case 'draft': return projection.projectDraftUpdate(operation.payload);
    case 'indexing': return projection.projectIndexingUpdate(operation.payload);
    case 'system': return projection.projectSystemSnapshot(
      operation.snapshot,
      operation.additionalAdministratorIds,
    );
  }
}

function startOperation(id: number, operation: NotificationBackgroundOperation): void {
  if (closing) {
    respond({ type: 'result', id, ok: false, error: 'Notification background service is closing' });
    return;
  }
  const run = projection.bestEffort(operationLabel(operation), () => project(operation))
    .then(() => respond({ type: 'result', id, ok: true }))
    .catch(() => respond({
      type: 'result', id, ok: false, error: 'Notification background operation failed',
    }))
    .finally(() => active.delete(run));
  active.add(run);
}

async function close(id: number): Promise<void> {
  if (closing) return;
  closing = true;
  // Stop accepting new delivery work, then let already-acknowledged projection
  // messages and the active delivery attempt reach their durable boundary.
  const dispatcherClose = dispatcher?.close() ?? Promise.resolve();
  await Promise.allSettled([...active]);
  projection.close();
  await dispatcherClose;
  await background.close();
  // This thread's own publisher connection; closing it lets the worker exit.
  await closeEventPublisher();
  await closeConnection();
  respond({ type: 'result', id, ok: true });
  port.close();
}

port.on('message', (message: NotificationBackgroundRequest) => {
  if (message.type === 'close') {
    void close(message.id);
    return;
  }
  startOperation(message.id, message.operation);
});

respond({ type: 'ready', webPushDispatcherConfigured });
