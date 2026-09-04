import { afterEach, describe, expect, test, vi } from 'vitest';
import { dismissAllNotifications, dismissNotification, markNotificationRead } from './notificationApi';

const event = {
  id: 'event:token-refresh',
  deduplicationKey: 'event-token-refresh-key',
  kind: 'task',
  severity: 'error',
  target: { type: 'task', repository: 'integry/propr', taskId: 'task-1' },
  title: 'Task failed',
  body: 'The task did not complete.',
  occurredAt: '2026-08-24T12:00:00.000Z',
  createdAt: '2026-08-24T12:00:00.000Z',
};

function tokenRefreshed(): Response {
  return new Response(JSON.stringify({ code: 'TOKEN_REFRESHED' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function state(readAt: string | null, dismissedAt: string | null, unreadCount: number): Response {
  return new Response(JSON.stringify({
    notification: { ...event, readAt, dismissedAt },
    unreadCount,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('notification mutation API', () => {
  afterEach(() => vi.restoreAllMocks());

  test('replays bodyless read and dismiss mutations after token refresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenRefreshed())
      .mockResolvedValueOnce(state('2026-08-24T12:01:00.000Z', null, 1))
      .mockResolvedValueOnce(tokenRefreshed())
      .mockResolvedValueOnce(state('2026-08-24T12:01:00.000Z', '2026-08-24T12:02:00.000Z', 0));

    await expect(markNotificationRead(event.id)).resolves.toMatchObject({ unreadCount: 1 });
    await expect(dismissNotification(event.id)).resolves.toMatchObject({ unreadCount: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/api/notifications/event%3Atoken-refresh/read'),
      expect.stringContaining('/api/notifications/event%3Atoken-refresh/read'),
      expect.stringContaining('/api/notifications/event%3Atoken-refresh/dismiss'),
      expect.stringContaining('/api/notifications/event%3Atoken-refresh/dismiss'),
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(init?.body).toBeUndefined();
    }
  });

  test('replays clear-all after token refresh and validates the unread count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokenRefreshed())
      .mockResolvedValueOnce(new Response(JSON.stringify({ unreadCount: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(dismissAllNotifications()).resolves.toEqual({ unreadCount: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toContain('/api/notifications/dismiss-all');
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(init?.body).toBeUndefined();
    }
  });
});
