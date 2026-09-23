import { previewPixelRatio } from './previewDownsampling';

/**
 * Compact previews are produced by a multi-pass canvas downsample of the
 * full-resolution capture, so every page load otherwise re-fetches a 4K image,
 * decodes it and runs several main-thread passes per thumbnail. Persist the
 * finished thumbnail per display size so a reload paints from the cache before
 * the source image is even requested.
 */
export interface CachedPreviewRecord {
  key: string;
  dataUrl: string;
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  timestamp: number;
}

export const PREVIEW_CACHE_DB_NAME = 'propr-preview-cache';
export const PREVIEW_CACHE_STORE_NAME = 'previews';
export const PREVIEW_CACHE_VERSION = 1;
export const PREVIEW_CACHE_TIMESTAMP_INDEX = 'timestamp';
/** A week keeps list thumbnails warm between sessions without pinning captures that have since been replaced. */
export const PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** L1 keeps re-mounts and route changes free, and is the whole cache where IndexedDB is unavailable. */
const memoryCache = new Map<string, CachedPreviewRecord>();

/**
 * Layout widths carry subpixel fractions and the ratio is a float, so round
 * both: otherwise a 79.98px and an 80px measurement of the same thumbnail
 * would occupy two entries and neither would ever be reused.
 */
export function getPreviewCacheKey(url: string, targetWidth: number, targetHeight: number, ratio: number): string {
  return `${url}|${Math.round(targetWidth)}x${Math.round(targetHeight)}@${Math.round(ratio * 100) / 100}`;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

/** Resolves null — never rejects — when storage is missing, blocked or private-mode restricted. */
export function openPreviewDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const request = indexedDB.open(PREVIEW_CACHE_DB_NAME, PREVIEW_CACHE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(PREVIEW_CACHE_STORE_NAME)
          ? request.transaction?.objectStore(PREVIEW_CACHE_STORE_NAME)
          : database.createObjectStore(PREVIEW_CACHE_STORE_NAME, { keyPath: 'key' });
        // The index drives expiry pruning by range instead of a full scan.
        if (store && !store.indexNames.contains(PREVIEW_CACHE_TIMESTAMP_INDEX)) store.createIndex(PREVIEW_CACHE_TIMESTAMP_INDEX, 'timestamp');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return databasePromise;
}

/** Runs one store request, swallowing quota/teardown failures so the memory cache stays authoritative. */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const database = await openPreviewDatabase();
  if (!database) return undefined;
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = database.transaction(PREVIEW_CACHE_STORE_NAME, mode);
      const request = run(transaction.objectStore(PREVIEW_CACHE_STORE_NAME));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    return undefined;
  }
}

const isExpired = (record: CachedPreviewRecord, now: number) => now - record.timestamp > PREVIEW_CACHE_TTL_MS;

/** Reads L1 then L2; an entry past the one-week window is a miss and is dropped on the way out. */
export async function getCachedPreview(key: string, now: number = Date.now()): Promise<CachedPreviewRecord | undefined> {
  const local = memoryCache.get(key);
  if (local) {
    if (!isExpired(local, now)) return local;
    await deleteCachedPreview(key);
    return undefined;
  }
  const stored = await withStore<CachedPreviewRecord | undefined>('readonly', store => store.get(key) as IDBRequest<CachedPreviewRecord | undefined>);
  if (!stored) return undefined;
  if (isExpired(stored, now)) {
    await deleteCachedPreview(key);
    return undefined;
  }
  memoryCache.set(key, stored);
  return stored;
}

export async function setCachedPreview(key: string, record: CachedPreviewRecord): Promise<void> {
  const stored = { ...record, key };
  memoryCache.set(key, stored);
  await withStore('readwrite', store => store.put(stored));
}

export async function deleteCachedPreview(key: string): Promise<void> {
  memoryCache.delete(key);
  await withStore('readwrite', store => store.delete(key));
}

/** Test and sign-out escape hatch; leaves the database itself in place. */
export async function clearPreviewCache(): Promise<void> {
  memoryCache.clear();
  await withStore('readwrite', store => store.clear());
}

export async function pruneExpiredPreviews(now: number = Date.now()): Promise<void> {
  for (const [key, record] of memoryCache) if (isExpired(record, now)) memoryCache.delete(key);
  if (typeof IDBKeyRange === 'undefined') return;
  await withStore('readwrite', store => {
    const request = store.index(PREVIEW_CACHE_TIMESTAMP_INDEX).openCursor(IDBKeyRange.upperBound(now - PREVIEW_CACHE_TTL_MS));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    return request;
  });
}

let pruneScheduled = false;

/** Pruning is housekeeping: run it once per session, off the render path. */
function schedulePrune() {
  if (pruneScheduled || typeof window === 'undefined') return;
  pruneScheduled = true;
  const idle = window.requestIdleCallback;
  const run = () => void pruneExpiredPreviews().catch(() => undefined);
  if (typeof idle === 'function') idle(run, { timeout: 5000 });
  else window.setTimeout(run, 2000);
}

/**
 * Captures the finished thumbnail from a drawn canvas. Callers only reach this
 * with a canvas drawn from a CORS-enabled source; the remaining failures — a
 * SecurityError from a tainted canvas, or storage over quota — fail silently,
 * leaving the freshly drawn canvas (or the native `<img>`) as the user-visible
 * result.
 */
export async function cacheCanvasPreview(url: string, targetWidth: number, targetHeight: number, canvas: HTMLCanvasElement): Promise<CachedPreviewRecord | undefined> {
  try {
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl?.startsWith('data:image/')) return undefined;
    const record: CachedPreviewRecord = {
      key: getPreviewCacheKey(url, targetWidth, targetHeight, previewPixelRatio()),
      dataUrl,
      cssWidth: Number.parseFloat(canvas.style.width) || canvas.width,
      cssHeight: Number.parseFloat(canvas.style.height) || canvas.height,
      width: canvas.width,
      height: canvas.height,
      timestamp: Date.now(),
    };
    await setCachedPreview(record.key, record);
    schedulePrune();
    return record;
  } catch {
    return undefined;
  }
}

function decodePreviewImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    try {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    } catch {
      resolve(null);
    }
  });
}

/** Restores the backing store, the CSS box and the pixels recorded by `downsampleToCanvas`. */
export async function renderCachedPreview(canvas: HTMLCanvasElement, cached: CachedPreviewRecord): Promise<boolean> {
  try {
    const context = canvas.getContext('2d');
    if (!context || !cached.width || !cached.height) return false;
    const image = await decodePreviewImage(cached.dataUrl);
    if (!image) return false;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.style.width = `${cached.cssWidth}px`;
    canvas.style.height = `${cached.cssHeight}px`;
    context.clearRect(0, 0, cached.width, cached.height);
    context.drawImage(image, 0, 0, cached.width, cached.height);
    return true;
  } catch {
    return false;
  }
}
