/**
 * A canvas can only be exported once every image drawn into it is origin-clean,
 * and an `<img>` without `crossorigin` is fetched in no-cors mode, which taints
 * it. Compact previews therefore ask for CORS so the downsampled thumbnail can
 * be persisted.
 *
 * Hosts that do not answer with `Access-Control-Allow-Origin` fail that request
 * outright — GitHub's `user-attachments` endpoint is one of them, because the
 * 302 it serves carries no CORS headers. Retrying every thumbnail on every load
 * would double the image traffic for no benefit, so a refusal is remembered per
 * origin and later previews go straight to the uncacheable no-cors load.
 */
const PREVIEW_CORS_STORAGE_KEY = 'propr.previewCorsBlockedOrigins';

function readBlockedOrigins(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREVIEW_CORS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((origin): origin is string => typeof origin === 'string') : [];
  } catch {
    return []; // Absent, private-mode restricted or corrupt storage just means "not known to be blocked".
  }
}

const blockedOrigins = new Set(readBlockedOrigins());

const previewOrigin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** False once this browser has seen the origin refuse a CORS image fetch. */
export function previewCorsWorthTrying(url: string): boolean {
  return !blockedOrigins.has(previewOrigin(url));
}

/** Recorded only after the no-cors retry succeeded, so a 404 or an offline load is not mistaken for a CORS refusal. */
export function rememberPreviewCorsRefused(url: string): void {
  const origin = previewOrigin(url);
  if (!origin || blockedOrigins.has(origin)) return;
  blockedOrigins.add(origin);
  try {
    localStorage.setItem(PREVIEW_CORS_STORAGE_KEY, JSON.stringify([...blockedOrigins]));
  } catch {
    // Still remembered for the rest of this session.
  }
}

/** Test and sign-out escape hatch, so a fresh client re-probes an origin that may since have gained CORS. */
export function resetPreviewCorsMemory(): void {
  blockedOrigins.clear();
  try {
    localStorage.removeItem(PREVIEW_CORS_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}
