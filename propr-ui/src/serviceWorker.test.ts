import { describe, expect, test, vi } from 'vitest';
import { createHarness, dispatchFetch, waitableEvent } from './test/serviceWorkerHarness';

describe('PWA service worker', () => {
  test.each([
    ['missing data', undefined],
    ['invalid JSON', { json: () => { throw new SyntaxError('invalid payload'); } }],
    ['a non-object payload', { json: () => ['not', 'an', 'object'] }],
  ])('shows a safe fallback notification for %s', async (_label, data) => {
    const harness = createHarness();
    const push = waitableEvent({ ...(data === undefined ? {} : { data }) });

    harness.dispatch('push', push.event);
    await push.completion();

    expect(harness.shownNotifications).toEqual([{
      title: 'ProPR notification',
      options: expect.objectContaining({
        body: 'A ProPR update is available.',
        tag: 'propr-notification',
        actions: [{ action: 'propr-dismiss', title: 'Dismiss' }],
        data: {
          deepLink: 'https://app.example.com/',
          actionUrls: [],
          unreadCount: null,
          eventId: '',
        },
      }),
    }]);
    expect(harness.badgeCounts).toEqual([]);
  });

  test('pre-caches the built shell references but never runtime config', async () => {
    const harness = createHarness();
    const install = waitableEvent({});

    harness.dispatch('install', install.event);
    await install.completion();

    expect(harness.networkRequests).toEqual(expect.arrayContaining([
      'https://app.example.com/',
      'https://app.example.com/index.html',
      'https://app.example.com/assets/app-abc.js',
      'https://app.example.com/assets/vendor-def.js',
      'https://app.example.com/assets/app-abc.css',
      'https://app.example.com/assets/lazy-route.js',
    ]));
    expect(harness.networkRequests).not.toContain('https://attacker.example/external.js');
    expect(harness.networkRequests).not.toContain('https://app.example.com/config.js');
  });

  test.each([
    ['https://app.example.com/api/tasks', 'GET', 'cors'],
    ['https://app.example.com/socket.io/?transport=polling', 'GET', 'cors'],
    ['https://app.example.com/config.js', 'GET', 'no-cors'],
    ['https://app.example.com/api/auth/github/callback?code=x&state=y', 'GET', 'navigate'],
    ['https://app.example.com/?error=access_denied&state=y', 'GET', 'navigate'],
    ['https://app.example.com/login?oauth_complete=true', 'GET', 'navigate'],
    ['https://app.example.com/assets/app.js', 'POST', 'cors'],
    ['https://third-party.example/app.js', 'GET', 'cors'],
  ])('never intercepts excluded request %s', (url, method, mode) => {
    const harness = createHarness();
    expect(dispatchFetch(harness, {
      url,
      method,
      mode: mode as RequestMode,
    })).toBeUndefined();
    expect(harness.networkRequests).toEqual([]);
  });

  test('intercepts only same-origin navigations and explicit static shell assets', () => {
    const harness = createHarness();
    expect(dispatchFetch(harness, {
      url: 'https://app.example.com/tasks/123', method: 'GET', mode: 'navigate',
    })).toBeDefined();
    expect(dispatchFetch(harness, {
      url: 'https://app.example.com/assets/app-abc.js', method: 'GET', mode: 'cors',
    })).toBeDefined();
    expect(dispatchFetch(harness, {
      url: 'https://app.example.com/user-export.json', method: 'GET', mode: 'cors',
    })).toBeUndefined();
  });

  test('sanitizes push URLs, displays a local dismiss action, and updates the badge', async () => {
    const harness = createHarness();
    const push = waitableEvent({
      data: {
        json: () => ({
          eventId: '../../unsafe-id',
          title: 'Task complete',
          body: 'Open the result.',
          deepLink: 'https://attacker.example/phish',
          unreadCount: 7,
          actions: [{ action: 'stop', title: 'Stop task', url: 'https://attacker.example/stop' }],
        }),
      },
    });

    harness.dispatch('push', push.event);
    await push.completion();

    expect(harness.shownNotifications).toHaveLength(1);
    const options = harness.shownNotifications[0].options;
    expect(options.data).toEqual({
      deepLink: 'https://app.example.com/',
      actionUrls: [{ action: 'stop', url: 'https://app.example.com/' }],
      unreadCount: 7,
      eventId: '../../unsafe-id',
    });
    expect(options.tag).toBe('propr-unsafe-id');
    expect(options.actions).toEqual([
      { action: 'stop', title: 'Stop task' },
      { action: 'propr-dismiss', title: 'Dismiss' },
    ]);
    expect(harness.badgeCounts).toEqual([7]);
  });

  test('focuses and navigates an existing PWA window for same-origin deep links', async () => {
    const harness = createHarness();
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => ({ focus }));
    harness.setWindows([{
      url: 'https://app.example.com/',
      navigate,
      focus: vi.fn(async () => undefined),
    }]);
    const notification = { data: { deepLink: '/tasks/task-1', unreadCount: 2 }, close: vi.fn() };
    const click = waitableEvent({ notification, action: '' });

    harness.dispatch('notificationclick', click.event);
    await click.completion();

    expect(navigate).toHaveBeenCalledWith('https://app.example.com/tasks/task-1');
    expect(focus).toHaveBeenCalled();
    expect(harness.openedUrls).toEqual([]);
    expect(harness.badgeCounts).toEqual([1]);
  });

  test('allows GitHub PR actions but rejects arbitrary external action URLs', async () => {
    const harness = createHarness();
    const githubClick = waitableEvent({
      notification: {
        data: {
          deepLink: '/repositories',
          actionUrls: [{ action: 'view', url: 'https://github.com/integry/propr/pull/1721' }],
        },
        close: vi.fn(),
      },
      action: 'view',
    });
    harness.dispatch('notificationclick', githubClick.event);
    await githubClick.completion();
    expect(harness.openedUrls).toEqual(['https://github.com/integry/propr/pull/1721']);

    harness.openedUrls.length = 0;
    const hostileClick = waitableEvent({
      notification: {
        data: {
          deepLink: '/repositories',
          actionUrls: [{ action: 'view', url: 'https://example.net/pull/1721' }],
        },
        close: vi.fn(),
      },
      action: 'view',
    });
    harness.dispatch('notificationclick', hostileClick.event);
    await hostileClick.completion();
    expect(harness.openedUrls).toEqual(['https://app.example.com/repositories']);
  });

  test('never performs or externally delegates a mutating notification action', async () => {
    const harness = createHarness();
    const click = waitableEvent({
      notification: {
        data: {
          deepLink: '/tasks/task-1',
          actionUrls: [{
            action: 'approve-execute',
            url: 'https://github.com/integry/propr/pull/1721',
          }],
        },
        close: vi.fn(),
      },
      action: 'approve-execute',
    });

    harness.dispatch('notificationclick', click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual(['https://app.example.com/tasks/task-1']);
    expect(harness.networkRequests).toEqual([]);
  });

  test('shows both plan actions and hands approval to the in-app confirmation intent', async () => {
    const harness = createHarness();
    const push = waitableEvent({
      data: {
        json: () => ({
          deepLink: 'https://app.example.com/studio/draft-1',
          actions: [
            { action: 'refine', title: 'Refine', url: 'https://app.example.com/studio/draft-1?intent=refine' },
            { action: 'approve-execute', title: 'Approve / Execute', url: 'https://app.example.com/studio/draft-1?intent=approve_execute' },
          ],
        }),
      },
    });
    harness.dispatch('push', push.event);
    await push.completion();

    expect(harness.shownNotifications[0].options.actions).toEqual([
      { action: 'refine', title: 'Refine' },
      { action: 'approve-execute', title: 'Approve / Execute' },
    ]);

    const click = waitableEvent({
      notification: harness.shownNotifications[0].options,
      action: 'approve-execute',
    });
    (click.event.notification as { close?: () => void }).close = vi.fn();
    harness.dispatch('notificationclick', click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual([
      'https://app.example.com/studio/draft-1?intent=approve_execute',
    ]);
    expect(harness.networkRequests).toEqual([]);
  });

  test('hands dismiss to the authenticated Inbox without making a request', async () => {
    const harness = createHarness();
    const click = waitableEvent({
      notification: {
        data: { deepLink: '/tasks?connect_api_url=flow', unreadCount: 1, eventId: 'event-1' },
        close: vi.fn(),
      },
      action: 'propr-dismiss',
    });

    harness.dispatch('notificationclick', click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual([
      'https://app.example.com/inbox?connect_api_url=flow&intent=dismiss&notification=event-1',
    ]);
    expect(harness.networkRequests).toEqual([]);
    expect(harness.badgeCounts).toEqual([0]);
  });

  test('preserves the exact bounded event id when handing dismiss to the Inbox', async () => {
    const harness = createHarness();
    const click = waitableEvent({
      notification: {
        data: { deepLink: '/tasks', eventId: 'producer:task/42?attempt=2' },
        close: vi.fn(),
      },
      action: 'propr-dismiss',
    });

    harness.dispatch('notificationclick', click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual([
      'https://app.example.com/inbox?intent=dismiss&notification=producer%3Atask%2F42%3Fattempt%3D2',
    ]);
    expect(harness.networkRequests).toEqual([]);
  });

  test('does not hand an unbounded event id to the Inbox', async () => {
    const harness = createHarness();
    const click = waitableEvent({
      notification: {
        data: { deepLink: '/tasks', eventId: 'x'.repeat(256) },
        close: vi.fn(),
      },
      action: 'propr-dismiss',
    });

    harness.dispatch('notificationclick', click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual([]);
    expect(harness.networkRequests).toEqual([]);
  });
});
