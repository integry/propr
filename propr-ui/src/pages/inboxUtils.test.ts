import { describe, expect, test } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import {
  INBOX_GROUPS,
  mergeNotifications,
  notificationGroup,
  notificationHref,
  notificationKindLabel,
} from './inboxUtils';

function item(overrides: Record<string, unknown>): Notification {
  return notificationSchema.parse({
    id: 'event-1',
    deduplicationKey: 'event-1-key',
    kind: 'task',
    severity: 'error',
    target: { type: 'task', repository: 'integry/propr', taskId: 'task-1' },
    title: 'Task failed',
    body: 'Work did not complete.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    ...overrides,
  });
}

describe('Inbox notification presentation', () => {
  test('covers every event kind with a visible label and required group', () => {
    const notifications = [
      item({ kind: 'plan', target: { type: 'plan', repository: 'i/p', draftId: 'd1' } }),
      item({ id: 'task-ok', severity: 'success' }),
      item({ id: 'review', kind: 'review', severity: 'success', target: { type: 'review', repository: 'i/p', prNumber: 2 } }),
      item({ id: 'pr', kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: 'i/p', prNumber: 2 } }),
      item({ id: 'index', kind: 'indexing', target: { type: 'indexing', repository: 'i/p' } }),
      item({ id: 'system', kind: 'system_failure', target: { type: 'system_failure', component: 'redis' } }),
    ];

    expect(notifications.map(notificationKindLabel)).toEqual([
      'Plan ready',
      'Implementation completed',
      'Review completed',
      'PR attention',
      'Indexing failed',
      'System failure',
    ]);
    expect(new Set(notifications.map(notificationGroup))).toEqual(new Set(INBOX_GROUPS));
  });

  test('prefers server actions and derives stable fallback destinations', () => {
    expect(notificationHref(item({ action: { type: 'navigate', label: 'Open', href: '/plans' } }))).toBe('/plans');
    expect(notificationHref(item({}))).toBe('/tasks/task-1');
    expect(notificationHref(item({
      kind: 'indexing',
      target: { type: 'indexing', repository: 'integry/propr' },
    }))).toBe('/summaries/integry/propr');
  });

  test('de-duplicates cursor pages and retains newest ordering', () => {
    const older = item({ id: 'older', deduplicationKey: 'older', occurredAt: '2026-08-24T10:00:00.000Z' });
    const newer = item({
      id: 'newer',
      deduplicationKey: 'newer',
      occurredAt: '2026-08-24T13:00:00.000Z',
      createdAt: '2026-08-24T13:00:00.000Z',
    });
    expect(mergeNotifications([newer, older], [older]).map(notification => notification.id))
      .toEqual(['newer', 'older']);
  });
});
