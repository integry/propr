import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

type WorkerListener = (event: Record<string, unknown>) => void;

interface WorkerHarness {
  listeners: Map<string, WorkerListener>;
  openedUrls: string[];
  shownNotifications: Array<{ title: string; options: Record<string, unknown> }>;
  badgeCounts: number[];
  networkRequests: string[];
  setWindows(windows: Array<Record<string, unknown>>): void;
}

const workerSource = readFileSync(
  resolve(process.cwd(), 'public/service-worker.js'),
  'utf8',
);

function response(body: string, contentType: string): Response {
  const result = new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
  Object.defineProperties(result, {
    type: { value: 'basic' },
    redirected: { value: false },
  });
  return result;
}

function createHarness(): WorkerHarness {
  class MockServiceWorkerGlobalScope {}
  const listeners = new Map<string, WorkerListener>();
  const openedUrls: string[] = [];
  const shownNotifications: WorkerHarness['shownNotifications'] = [];
  const badgeCounts: number[] = [];
  const networkRequests: string[] = [];
  let windows: Array<Record<string, unknown>> = [];
  const cacheEntries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: RequestInfo) => cacheEntries.get(String(request))),
    put: vi.fn(async (request: RequestInfo, value: Response) => {
      cacheEntries.set(String(request), value);
    }),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['unrelated-cache', 'propr-shell-old']),
    delete: vi.fn(async () => true),
    match: vi.fn(async (request: RequestInfo) => cacheEntries.get(String(request))),
  };
  const scope = Object.assign(new MockServiceWorkerGlobalScope(), {
    location: { origin: 'https://app.example.com' },
    addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
    skipWaiting: vi.fn(async () => undefined),
    navigator: {
      setAppBadge: vi.fn(async (count: number) => { badgeCounts.push(count); }),
      clearAppBadge: vi.fn(async () => { badgeCounts.push(0); }),
    },
    registration: {
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => {
        shownNotifications.push({ title, options });
      }),
    },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async (url: string) => {
        openedUrls.push(url);
        return null;
      }),
    },
  });
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    networkRequests.push(request instanceof Request ? request.url : String(request));
    const url = request instanceof Request ? request.url : String(request);
    const pathname = new URL(url, 'https://app.example.com').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      return response(`<!doctype html>
        <script src="/config.js"></script>
        <script type="module" src="/assets/app-abc.js"></script>
        <link rel="modulepreload" href="/assets/vendor-def.js">
        <link rel="stylesheet" href="/assets/app-abc.css">`, 'text/html');
    }
    if (pathname.endsWith('.js')) return response('asset', 'text/javascript');
    if (pathname.endsWith('.css')) return response('asset', 'text/css');
    if (pathname.endsWith('.webmanifest')) return response('{}', 'application/manifest+json');
    return response('image', 'image/png');
  });

  vm.runInNewContext(workerSource, {
    self: scope,
    ServiceWorkerGlobalScope: MockServiceWorkerGlobalScope,
    caches,
    fetch: fetchMock,
    Request,
    Response,
    URL,
    Set,
  });

  return {
    listeners,
    openedUrls,
    shownNotifications,
    badgeCounts,
    networkRequests,
    setWindows(nextWindows) { windows = nextWindows; },
  };
}

function dispatchFetch(harness: WorkerHarness, request: Partial<Request> & {
  method: string;
  mode: RequestMode;
  url: string;
}): Promise<unknown> | undefined {
  let responsePromise: Promise<unknown> | undefined;
  harness.listeners.get('fetch')?.({
    request,
    respondWith(value: Promise<unknown>) { responsePromise = value; },
  });
  return responsePromise;
}

function waitableEvent(properties: Record<string, unknown>): {
  event: Record<string, unknown>;
  completion(): Promise<unknown>;
} {
  let promise: Promise<unknown> = Promise.resolve();
  return {
    event: {
      ...properties,
      waitUntil(value: Promise<unknown>) { promise = value; },
    },
    completion: () => promise,
  };
}

describe('PWA service worker', () => {
  test('pre-caches the built shell references but never runtime config', async () => {
    const harness = createHarness();
    const install = waitableEvent({});

    harness.listeners.get('install')?.(install.event);
    await install.completion();

    expect(harness.networkRequests).toEqual(expect.arrayContaining([
      'https://app.example.com/',
      'https://app.example.com/index.html',
      'https://app.example.com/assets/app-abc.js',
      'https://app.example.com/assets/vendor-def.js',
      'https://app.example.com/assets/app-abc.css',
    ]));
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

    harness.listeners.get('push')?.(push.event);
    await push.completion();

    expect(harness.shownNotifications).toHaveLength(1);
    const options = harness.shownNotifications[0].options;
    expect(options.data).toEqual({
      deepLink: 'https://app.example.com/',
      actionUrls: [{ action: 'stop', url: 'https://app.example.com/' }],
      unreadCount: 7,
    });
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

    harness.listeners.get('notificationclick')?.(click.event);
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
    harness.listeners.get('notificationclick')?.(githubClick.event);
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
    harness.listeners.get('notificationclick')?.(hostileClick.event);
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

    harness.listeners.get('notificationclick')?.(click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual(['https://app.example.com/tasks/task-1']);
    expect(harness.networkRequests).toEqual([]);
  });

  test('handles dismiss locally without opening a window or making a request', async () => {
    const harness = createHarness();
    const click = waitableEvent({
      notification: { data: { deepLink: '/tasks', unreadCount: 1 }, close: vi.fn() },
      action: 'propr-dismiss',
    });

    harness.listeners.get('notificationclick')?.(click.event);
    await click.completion();

    expect(harness.openedUrls).toEqual([]);
    expect(harness.networkRequests).toEqual([]);
    expect(harness.badgeCounts).toEqual([0]);
  });
});
