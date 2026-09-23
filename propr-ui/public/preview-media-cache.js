/* global ServiceWorkerGlobalScope */

/**
 * Published captures live behind `https://github.com/user-attachments`, which
 * answers with a `no-store` 302 to a freshly signed, single-use asset URL. The
 * HTTP cache can therefore never reuse one: every page load re-downloads and
 * re-decodes the full-resolution source before a thumbnail can be drawn.
 *
 * Neither hop sends `Access-Control-Allow-Origin`, so those bytes are
 * unreadable both here and in the page — a canvas drawn from one is tainted, so
 * no downsampled thumbnail can be exported into storage. The opaque response
 * itself can be kept though, keyed by the stable attachment URL, and that is
 * enough for a reload to paint from disk without touching the network.
 *
 * `service-worker.js` loads this with `importScripts`. It registers its own
 * listeners and shares no state with the application shell cache, so a deploy
 * that cannot serve it still installs a working shell worker.
 */

const PREVIEW_CACHE_NAME = 'propr-preview-v1';
/** A week keeps list thumbnails warm between sessions without pinning captures that have since been replaced. */
const PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Opaque entries are billed against a padded quota, so bound how many captures may accumulate. */
const PREVIEW_CACHE_MAX_ENTRIES = 60;
const PREVIEW_STAMP_PARAMETER = 'propr-cached-at';
const FORGET_PREVIEW_MESSAGE = 'propr-forget-preview';

/** Mirrors the `trustedGitHubAttachmentUrl` shape the app will render. */
function isPreviewMediaUrl(url) {
  return url.protocol === 'https:'
    && url.hostname.toLowerCase() === 'github.com'
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && /^\/user-attachments\/assets\/[A-Za-z0-9_-]+$/.test(url.pathname);
}

/** An opaque response exposes no headers, so a capture's age is kept beside it. */
function previewStampUrl(url) {
  return `${url}?${PREVIEW_STAMP_PARAMETER}`;
}

async function readPreviewStamp(cache, url) {
  const stamp = await cache.match(previewStampUrl(url));
  if (!stamp) return null;
  const recorded = Number(await stamp.text());
  return Number.isFinite(recorded) ? recorded : null;
}

function deletePreviewEntry(cache, url) {
  return Promise.all([cache.delete(url), cache.delete(previewStampUrl(url))]);
}

/** Drops captures past the one-week window, then the oldest of whatever is left over budget. */
async function trimPreviewCache(cache, now) {
  const entries = [];
  for (const request of await cache.keys()) {
    // A stamp is addressed through its capture and removed with it.
    if (new URL(request.url).search === '') {
      entries.push({ url: request.url, stamp: await readPreviewStamp(cache, request.url) ?? 0 });
    }
  }
  const expired = entries.filter(entry => now - entry.stamp > PREVIEW_CACHE_TTL_MS);
  const surviving = entries.filter(entry => now - entry.stamp <= PREVIEW_CACHE_TTL_MS)
    .sort((first, second) => second.stamp - first.stamp);
  await Promise.all([...expired, ...surviving.slice(PREVIEW_CACHE_MAX_ENTRIES)]
    .map(entry => deletePreviewEntry(cache, entry.url)));
}

/**
 * An opaque response reports status 0, so a GitHub error page cannot be told
 * apart from a capture here. The element decoding it can, and reports the entry
 * back for eviction, which is what stops a transient failure from being
 * replayed for the rest of the week.
 */
async function storePreviewMedia(cache, request, response) {
  if (response.type !== 'opaque' && !response.ok) return;
  try {
    await cache.put(request, response);
    await cache.put(previewStampUrl(request.url), new Response(String(Date.now())));
    await trimPreviewCache(cache, Date.now());
  } catch {
    // Quota is shared with the application shell; a capture that will not fit is simply not held.
  }
}

async function servePreviewMedia(event) {
  const request = event.request;
  const cache = await caches.open(PREVIEW_CACHE_NAME);
  const cached = await cache.match(request);
  const stamp = cached ? await readPreviewStamp(cache, request.url) : null;
  if (cached && stamp !== null && Date.now() - stamp <= PREVIEW_CACHE_TTL_MS) return cached;
  try {
    const response = await fetch(request);
    // Writing and pruning happen after the element already has its bytes.
    event.waitUntil(storePreviewMedia(cache, request, response.clone()));
    return response;
  } catch (error) {
    // An expired capture still paints; only a cold cache surfaces the network failure.
    if (cached) return cached;
    throw error;
  }
}

async function forgetPreviewMedia(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return;
  }
  if (!isPreviewMediaUrl(url)) return;
  await deletePreviewEntry(await caches.open(PREVIEW_CACHE_NAME), url.href);
}

async function purgeExpiredPreviews() {
  try {
    await trimPreviewCache(await caches.open(PREVIEW_CACHE_NAME), Date.now());
  } catch {
    // Housekeeping must never hold up activation.
  }
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  self.addEventListener('activate', event => {
    event.waitUntil(purgeExpiredPreviews());
  });

  self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    // Captures are the only cross-origin resource worth holding, and only as the
    // opaque bytes a no-cors element asked for: answering a CORS request with
    // them would fail the load outright.
    if (request.mode !== 'no-cors' || !isPreviewMediaUrl(new URL(request.url))) return;
    event.respondWith(servePreviewMedia(event));
  });

  self.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== FORGET_PREVIEW_MESSAGE) return;
    event.waitUntil(forgetPreviewMedia(data.url));
  });
}
