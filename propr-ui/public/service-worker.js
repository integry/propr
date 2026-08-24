/* global ServiceWorkerGlobalScope */

const CACHE_PREFIX = 'propr-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL_FALLBACK_URL = '/index.html';
const SHELL_ASSET_MANIFEST_URL = '/pwa-shell-assets.json';
const LOCAL_DISMISS_ACTION = 'propr-dismiss';
const APP_ICON_URL = '/icons/pwa-192x192.png';
const MAX_BADGE_COUNT = 99;
const MAX_EVENT_ID_BYTES = 255;

const PRECACHE_URLS = [
  '/',
  SHELL_FALLBACK_URL,
  '/manifest.webmanifest',
  APP_ICON_URL,
  '/icons/pwa-512x512.png',
  '/icons/pwa-maskable-512x512.png',
  '/apple-touch-icon.png',
  '/logo.png',
  '/logo-loading.png',
  '/media/logo-and-name.png',
];

const EXPLICIT_SHELL_ASSETS = new Set([
  ...PRECACHE_URLS.filter(path => path !== '/'),
  SHELL_ASSET_MANIFEST_URL,
]);
const APP_ROUTE_PATTERNS = [
  /^\/$/,
  /^\/repositories\/?$/,
  /^\/tasks(?:\/[^/]+)?\/?$/,
  /^\/studio(?:\/[^/]+)?\/?$/,
  /^\/plans\/?$/,
  /^\/inbox\/?$/,
  /^\/ai-agents\/?$/,
  /^\/settings\/?$/,
  /^\/admin\/members\/?$/,
  /^\/summaries\/[^/]+\/[^/]+\/?$/,
  /^\/llm-logs\/?$/,
  /^\/login\/?$/,
  /^\/revert\/?$/,
];

function normalizedPathname(url) {
  try {
    return decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return url.pathname.toLowerCase();
  }
}

function isSensitiveRequestUrl(url) {
  const pathname = normalizedPathname(url);
  const segments = pathname.split('/').filter(Boolean);
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  if (pathname === '/socket.io' || pathname.startsWith('/socket.io/')) return true;
  if (pathname.endsWith('/config.js')) return true;
  if (segments.some(segment => segment === 'auth' || segment === 'oauth')) return true;
  if (segments[0] === 'login' || segments[0] === 'logout') return true;
  const oauthCallback = url.searchParams.has('state')
    && ['code', 'error', 'error_description', 'error_uri']
      .some(parameter => url.searchParams.has(parameter));
  return url.searchParams.has('oauth_complete') || oauthCallback;
}

function isStaticShellAsset(url) {
  return url.pathname.startsWith('/assets/') || EXPLICIT_SHELL_ASSETS.has(url.pathname);
}

function hasPrivateCacheDirective(response) {
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
  return cacheControl.includes('no-store') || cacheControl.includes('private');
}

function isCacheableResponse(response, expectedKind) {
  if (!response.ok || response.type !== 'basic' || response.redirected) return false;
  if (hasPrivateCacheDirective(response)) return false;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (expectedKind === 'document') return contentType.includes('text/html');
  return !contentType.includes('text/html');
}

function shellAssetsFromDocument(html) {
  const assets = new Set();
  const attributePattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
        assets.add(url.href);
      }
    } catch {
      // Ignore malformed document attributes instead of broadening cache scope.
    }
  }
  return [...assets];
}

async function fetchAndCache(cache, url, expectedKind) {
  const request = new Request(new URL(url, self.location.origin), {
    cache: 'reload',
    credentials: 'same-origin',
  });
  const response = await fetch(request);
  if (!isCacheableResponse(response, expectedKind)) {
    throw new Error(`Unable to cache application shell asset: ${url}`);
  }
  const documentHtml = expectedKind === 'document'
    ? await response.clone().text()
    : null;
  await cache.put(request, response);
  return documentHtml;
}

async function fetchBuiltShellAssets(cache) {
  const request = new Request(new URL(SHELL_ASSET_MANIFEST_URL, self.location.origin), {
    cache: 'reload',
    credentials: 'same-origin',
  });
  const response = await fetch(request);
  if (!isCacheableResponse(response, 'asset')) {
    throw new Error('Unable to cache the built shell asset manifest');
  }
  const entries = await response.clone().json();
  if (!Array.isArray(entries)) {
    throw new Error('Invalid built shell asset manifest');
  }
  const assets = entries.flatMap(value => {
    if (typeof value !== 'string') return [];
    try {
      const url = new URL(value, self.location.origin);
      return url.origin === self.location.origin && url.pathname.startsWith('/assets/')
        ? [url.href]
        : [];
    } catch {
      return [];
    }
  });
  await cache.put(request, response);
  return assets;
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const [documents, builtAssets] = await Promise.all([
    Promise.all(PRECACHE_URLS.map(path => {
      const kind = path === '/' || path === SHELL_FALLBACK_URL ? 'document' : 'asset';
      return fetchAndCache(cache, path, kind);
    })),
    fetchBuiltShellAssets(cache),
  ]);
  const index = documents[PRECACHE_URLS.indexOf(SHELL_FALLBACK_URL)] ?? '';
  await Promise.all([...new Set([...shellAssetsFromDocument(index), ...builtAssets])]
    .map(url => fetchAndCache(cache, url, 'asset')));
}

async function removeOldShellCaches() {
  const names = await caches.keys();
  await Promise.all(names
    .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
    .map(name => caches.delete(name)));
}

async function serveNavigation(request) {
  try {
    const response = await fetch(request);
    if (isCacheableResponse(response, 'document')) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(SHELL_FALLBACK_URL, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(SHELL_FALLBACK_URL) ?? await caches.match('/');
    return cached ?? new Response('ProPR is temporarily unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function serveStaticAsset(request) {
  // Static hosts commonly add `Vary: Origin`. Install-time fetches and later
  // module requests can therefore have different Origin-header state even
  // though they address the same immutable, same-origin build asset.
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheableResponse(response, 'asset')) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

function cleanText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const cleaned = Array.from(value, character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  }).join('').trim();
  return cleaned.length === 0 ? fallback : cleaned.slice(0, maxLength);
}

function isAppRoute(pathname) {
  return APP_ROUTE_PATTERNS.some(pattern => pattern.test(pathname));
}

function isGithubPullRequestUrl(url) {
  return url.protocol === 'https:'
    && url.hostname.toLowerCase() === 'github.com'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*(?:\/.*)?$/.test(url.pathname);
}

function safeOpenUrl(value, fallback = '/') {
  const origin = self.location.origin;
  let candidate;
  try {
    candidate = new URL(typeof value === 'string' ? value : fallback, origin);
  } catch {
    candidate = new URL(fallback, origin);
  }
  if (
    candidate.origin === origin
    && candidate.username === ''
    && candidate.password === ''
    && isAppRoute(candidate.pathname)
  ) return candidate.href;
  if (isGithubPullRequestUrl(candidate)) return candidate.href;
  return new URL(fallback, origin).href;
}

function safeBadgeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return Math.min(value, MAX_BADGE_COUNT);
}

function safeEventTag(value) {
  return typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
    : '';
}

function safeEventId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return '';
  try {
    const byteLength = encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, 'x').length;
    return byteLength <= MAX_EVENT_ID_BYTES ? value : '';
  } catch {
    return '';
  }
}

function safeActionUrl(value, action, fallbackUrl) {
  const fallback = safeOpenUrl(fallbackUrl);
  const target = safeOpenUrl(value, fallback);
  const targetUrl = new URL(target);
  if (
    targetUrl.origin !== self.location.origin
    && action !== ''
    && action.toLowerCase() !== 'view'
  ) {
    return new URL(fallback).origin === self.location.origin
      ? fallback
      : new URL('/', self.location.origin).href;
  }
  return target;
}

function safePayloadActions(value, fallbackUrl) {
  if (!Array.isArray(value)) return [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const action = cleanText(candidate.action, 'view', 32).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!action || action === LOCAL_DISMISS_ACTION) continue;
    return [{
      action,
      title: cleanText(candidate.title, 'View details', 40),
      url: safeActionUrl(candidate.url, action, fallbackUrl),
    }];
  }
  return [];
}

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function updateAppBadge(count) {
  if (count === null) return;
  const badgeApi = self.navigator;
  try {
    if (count === 0 && typeof badgeApi.clearAppBadge === 'function') {
      await badgeApi.clearAppBadge();
    } else if (count > 0 && typeof badgeApi.setAppBadge === 'function') {
      await badgeApi.setAppBadge(count);
    }
  } catch {
    // Badge support is best-effort and varies between installed browsers.
  }
}

async function displayPushNotification(event) {
  const payload = readPushPayload(event);
  const deepLink = safeOpenUrl(payload.deepLink);
  const payloadActions = safePayloadActions(payload.actions, deepLink);
  const badgeCount = safeBadgeCount(payload.unreadCount);
  const eventId = safeEventId(payload.eventId);
  const eventTag = safeEventTag(eventId);
  const actionUrls = payloadActions.map(({ action, url }) => ({ action, url }));
  const actions = payloadActions.map(({ action, title }) => ({ action, title }));
  actions.push({ action: LOCAL_DISMISS_ACTION, title: 'Dismiss' });

  await Promise.all([
    self.registration.showNotification(
      cleanText(payload.title, 'ProPR notification', 80),
      {
        body: cleanText(payload.body, 'A ProPR update is available.', 180),
        icon: APP_ICON_URL,
        badge: APP_ICON_URL,
        tag: eventTag ? `propr-${eventTag}` : 'propr-notification',
        renotify: false,
        actions,
        data: { deepLink, actionUrls, unreadCount: badgeCount, eventId },
      },
    ),
    updateAppBadge(badgeCount),
  ]);
}

function notificationData(notification) {
  const data = notification?.data;
  return data && typeof data === 'object' ? data : {};
}

function actionUrl(data, action) {
  if (!Array.isArray(data.actionUrls)) return data.deepLink;
  const match = data.actionUrls.find(item => item
    && typeof item === 'object'
    && item.action === action);
  return match?.url ?? data.deepLink;
}

async function focusOrOpenApp(targetUrl) {
  const target = new URL(targetUrl);
  if (target.origin !== self.location.origin) {
    await self.clients.openWindow(target.href);
    return;
  }

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    try {
      if (new URL(client.url).origin !== target.origin) continue;
      if (new URL(client.url).href === target.href) {
        await client.focus();
        return;
      }
      if (typeof client.navigate === 'function') {
        const navigated = await client.navigate(target.href);
        await (navigated ?? client).focus();
        return;
      }
    } catch {
      // A stale client may disappear between matchAll(), navigate(), and focus().
    }
  }
  await self.clients.openWindow(target.href);
}

async function handleNotificationClick(event) {
  const data = notificationData(event.notification);
  event.notification.close();
  const count = safeBadgeCount(data.unreadCount);
  await updateAppBadge(count === null ? null : Math.max(0, count - 1));
  if (event.action === LOCAL_DISMISS_ACTION) {
    const eventId = safeEventId(data.eventId);
    if (!eventId) return;
    const source = new URL(safeOpenUrl(data.deepLink));
    const target = new URL('/inbox', self.location.origin);
    for (const [key, value] of source.searchParams) target.searchParams.append(key, value);
    target.searchParams.set('intent', 'dismiss');
    target.searchParams.set('notification', eventId);
    await focusOrOpenApp(target.href);
    return;
  }
  const target = safeActionUrl(actionUrl(data, event.action), event.action, data.deepLink);
  await focusOrOpenApp(target);
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  self.addEventListener('install', event => {
    event.waitUntil(precacheShell().then(() => self.skipWaiting()));
  });

  self.addEventListener('activate', event => {
    event.waitUntil(removeOldShellCaches().then(() => self.clients.claim()));
  });

  self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || isSensitiveRequestUrl(url)) return;
    if (request.mode === 'navigate') {
      event.respondWith(serveNavigation(request));
    } else if (isStaticShellAsset(url)) {
      event.respondWith(serveStaticAsset(request));
    }
  });

  self.addEventListener('push', event => {
    event.waitUntil(displayPushNotification(event));
  });

  self.addEventListener('notificationclick', event => {
    event.waitUntil(handleNotificationClick(event));
  });

  self.addEventListener('notificationclose', event => {
    const count = safeBadgeCount(notificationData(event.notification).unreadCount);
    event.waitUntil(updateAppBadge(count === null ? null : Math.max(0, count - 1)));
  });
}
