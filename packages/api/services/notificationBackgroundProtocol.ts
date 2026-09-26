import type {
  DraftUpdatePayload,
  IndexingUpdatePayload,
  TaskUpdatePayload,
} from '@propr/shared';

export type NotificationBackgroundOperation =
  | { type: 'task'; payload: TaskUpdatePayload }
  | { type: 'draft'; payload: DraftUpdatePayload }
  | { type: 'indexing'; payload: IndexingUpdatePayload }
  | {
    type: 'system';
    snapshot: Record<string, unknown> & { timestamp: string };
    additionalAdministratorIds: readonly string[];
  };

export type NotificationBackgroundRequest =
  | { type: 'operation'; id: number; operation: NotificationBackgroundOperation }
  | { type: 'close'; id: number };

export type NotificationBackgroundResponse =
  | { type: 'ready'; webPushDispatcherConfigured: boolean }
  | { type: 'result'; id: number; ok: true }
  | { type: 'result'; id: number; ok: false; error: string };

export interface NotificationProjectionSink {
  projectTaskUpdate(payload: TaskUpdatePayload): Promise<void>;
  projectDraftUpdate(payload: DraftUpdatePayload): Promise<void>;
  projectIndexingUpdate(payload: IndexingUpdatePayload): Promise<void>;
  projectSystemSnapshot(
    snapshot: Record<string, unknown> & { timestamp: string },
    additionalAdministratorIds?: readonly string[],
  ): Promise<void>;
}
