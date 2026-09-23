import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { vi } from 'vitest';

/**
 * Runs the shipped worker sources in one VM context, the way a browser
 * evaluates a classic worker and the scripts it imports: shared global scope,
 * and one listener list per event that every module appends to.
 */
export type WorkerListener = (event: Record<string, unknown>) => void;

export interface WorkerHarness {
  openedUrls: string[];
  shownNotifications: Array<{ title: string; options: Record<string, unknown> }>;
  badgeCounts: number[];
  networkRequests: string[];
  dispatch(name: string, event: Record<string, unknown>): void;
  cacheContents(name: string): string[];
  seedPreview(url: string, stamp: number): void;
  failNetwork(failing: boolean): void;
  setWindows(windows: Array<Record<string, unknown>>): void;
}

export const PREVIEW_CACHE = 'propr-preview-v1';
export const PREVIEW_STAMP_PARAMETER = 'propr-cached-at';
export const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPTURE_URL = 'https://github.com/user-attachments/assets/screen-0';

const workerScript = (name: string) => readFileSync(resolve(process.cwd(), 'public', name), 'utf8');

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

/** What a cross-origin capture looks like to an element that asked for it without `crossorigin`. */
function opaqueResponse(): Response {
  const result = new Response('capture bytes', { status: 200 });
  Object.defineProperties(result, {
    type: { value: 'opaque' },
    status: { value: 0 },
  });
  return result;
}

export function createHarness(): WorkerHarness {
  class MockServiceWorkerGlobalScope {}
  const listeners = new Map<string, WorkerListener[]>();
  const openedUrls: string[] = [];
  const shownNotifications: WorkerHarness['shownNotifications'] = [];
  const badgeCounts: number[] = [];
  const networkRequests: string[] = [];
  let windows: Array<Record<string, unknown>> = [];
  const cacheEntries = new Map<string, Map<string, Response>>();
  // Dispatched events carry a request stand-in rather than a real Request.
  const cacheKey = (request: unknown): string => typeof request === 'object' && request !== null
    && typeof (request as { url?: unknown }).url === 'string'
    ? (request as { url: string }).url
    : String(request);
  const namedCache = (name: string) => {
    const entries = cacheEntries.get(name) ?? new Map<string, Response>();
    cacheEntries.set(name, entries);
    return {
      // A real Cache hands out a fresh Response per match, so bodies stay readable.
      match: vi.fn(async (request: unknown) => entries.get(cacheKey(request))?.clone()),
      put: vi.fn(async (request: unknown, value: Response) => {
        entries.set(cacheKey(request), value);
      }),
      delete: vi.fn(async (request: unknown) => entries.delete(cacheKey(request))),
      keys: vi.fn(async () => [...entries.keys()].map(url => new Request(url))),
    };
  };
  const caches = {
    open: vi.fn(async (name: string) => namedCache(name)),
    keys: vi.fn(async () => ['unrelated-cache', 'propr-shell-old']),
    delete: vi.fn(async () => true),
    match: vi.fn(async (request: unknown) => {
      for (const entries of cacheEntries.values()) {
        const hit = entries.get(cacheKey(request));
        if (hit) return hit.clone();
      }
      return undefined;
    }),
  };
  const scope = Object.assign(new MockServiceWorkerGlobalScope(), {
    location: { origin: 'https://app.example.com' },
    addEventListener: (name: string, listener: WorkerListener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
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
  let networkFailing = false;
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    const url = cacheKey(request);
    networkRequests.push(url);
    if (networkFailing) throw new TypeError('Failed to fetch');
    const parsed = new URL(url, 'https://app.example.com');
    if (parsed.hostname === 'github.com') return opaqueResponse();
    const pathname = parsed.pathname;
    if (pathname === '/' || pathname === '/index.html') {
      return response(`<!doctype html>
        <script src="/config.js"></script>
        <script type="module" src="/assets/app-abc.js"></script>
        <link rel="modulepreload" href="/assets/vendor-def.js">
        <link rel="stylesheet" href="/assets/app-abc.css">`, 'text/html');
    }
    if (pathname.endsWith('.js')) return response('asset', 'text/javascript');
    if (pathname.endsWith('.css')) return response('asset', 'text/css');
    if (pathname === '/pwa-shell-assets.json') {
      return response(JSON.stringify([
        '/assets/app-abc.js',
        '/assets/vendor-def.js',
        '/assets/app-abc.css',
        '/assets/lazy-route.js',
        'https://attacker.example/external.js',
      ]), 'application/json');
    }
    if (pathname.endsWith('.webmanifest')) return response('{}', 'application/manifest+json');
    return response('image', 'image/png');
  });

  const context = vm.createContext({
    self: scope,
    ServiceWorkerGlobalScope: MockServiceWorkerGlobalScope,
    caches,
    fetch: fetchMock,
    importScripts: (path: string) => {
      vm.runInContext(workerScript(path.replace(/^\//, '')), context);
    },
    Request,
    Response,
    URL,
    Set,
  });
  vm.runInContext(workerScript('service-worker.js'), context);

  return {
    openedUrls,
    shownNotifications,
    badgeCounts,
    networkRequests,
    dispatch(name, event) {
      for (const listener of listeners.get(name) ?? []) listener(event);
    },
    cacheContents(name) { return [...(cacheEntries.get(name)?.keys() ?? [])]; },
    seedPreview(url, stamp) {
      const entries = cacheEntries.get(PREVIEW_CACHE) ?? new Map<string, Response>();
      cacheEntries.set(PREVIEW_CACHE, entries);
      entries.set(url, new Response('cached capture'));
      entries.set(`${url}?${PREVIEW_STAMP_PARAMETER}`, new Response(String(stamp)));
    },
    failNetwork(failing) { networkFailing = failing; },
    setWindows(nextWindows) { windows = nextWindows; },
  };
}

export function dispatchFetch(harness: WorkerHarness, request: Partial<Request> & {
  method: string;
  mode: RequestMode;
  url: string;
}): Promise<unknown> | undefined {
  let responsePromise: Promise<unknown> | undefined;
  const pending: Array<Promise<unknown>> = [];
  harness.dispatch('fetch', {
    // A real Request always carries these; a fixture names only what it exercises.
    request: { destination: '' as RequestDestination, headers: new Headers(), ...request },
    respondWith(value: Promise<unknown>) {
      // The browser rejects a second answer to one request; so must the harness.
      if (responsePromise) throw new Error('respondWith() was already called for this request');
      responsePromise = value;
    },
    waitUntil(value: Promise<unknown>) { pending.push(value); },
  });
  if (!responsePromise) return undefined;
  // Work extended past the response, such as writing the entry, settles first.
  return responsePromise.then(async response => {
    await Promise.all(pending);
    return response;
  });
}

export function waitableEvent(properties: Record<string, unknown>): {
  event: Record<string, unknown>;
  completion(): Promise<unknown>;
} {
  const promises: Array<Promise<unknown>> = [];
  return {
    event: {
      ...properties,
      waitUntil(value: Promise<unknown>) { promises.push(value); },
    },
    completion: () => Promise.all(promises),
  };
}
