/**
 * Published captures are served from `https://github.com/user-attachments`,
 * which sends no `Access-Control-Allow-Origin` on either the 302 or the signed
 * asset it points at. Their pixels are therefore unreadable: a canvas drawn
 * from one is tainted, so no downsampled thumbnail can be exported to
 * IndexedDB, and a `crossorigin` request is refused outright.
 *
 * The durable tier is the service worker instead (see
 * `public/service-worker.js`), which keeps the opaque response keyed by the
 * stable attachment URL for a week so a reload paints without re-fetching the
 * full-resolution source. Being opaque, that entry could equally be a GitHub
 * error page — which only the element decoding it can tell — so a preview that
 * fails to load reports the entry back for eviction.
 */
const FORGET_PREVIEW_MESSAGE = 'propr-forget-preview';

export function forgetCachedPreviewMedia(url: string): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: FORGET_PREVIEW_MESSAGE, url });
  } catch {
    // No worker is controlling this page, so there is nothing cached to forget.
  }
}
