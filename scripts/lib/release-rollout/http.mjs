// Public, unauthenticated HTTP reads for the release rollout check. Every
// target is a public endpoint, so no request carries a token.

export const STATUS = Object.freeze({ ok: 'ok', missing: 'missing', stale: 'stale' });
export const ok = found => ({ status: STATUS.ok, found });
export const missing = found => ({ status: STATUS.missing, found });
export const stale = found => ({ status: STATUS.stale, found });

const USER_AGENT = 'propr-release-rollout-check';
export const REQUEST_TIMEOUT_MS = 20_000;

/** GET `url`; resolves to `{ status, ok, text }` and never throws on HTTP errors. */
export async function get(ctx, url, { accept = '*/*' } = {}) {
  const response = await ctx.fetchImpl(url, {
    headers: { accept, 'user-agent': USER_AGENT, 'cache-control': 'no-cache' },
    redirect: 'follow',
    signal: AbortSignal.timeout(ctx.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

export async function getJson(ctx, url, options) {
  const response = await get(ctx, url, { accept: 'application/json', ...options });
  if (!response.ok) return { ...response, json: undefined };
  try {
    return { ...response, json: JSON.parse(response.text) };
  } catch {
    throw new Error(`GET ${url} did not return JSON`);
  }
}

/** Memoises one read per run, so targets that share a source fetch it once. */
export function cached(ctx, key, read) {
  if (!ctx.cache.has(key)) ctx.cache.set(key, read());
  return ctx.cache.get(key);
}

/** An error message with its network cause, for example "fetch failed (ENOTFOUND)". */
export function describeError(error) {
  const cause = error?.cause?.code ?? error?.cause?.message;
  return `${error?.message ?? String(error)}${cause ? ` (${cause})` : ''}`;
}

export const shortDigest = digest => (typeof digest === 'string' ? digest.replace(/^(sha256:[0-9a-f]{12})[0-9a-f]+$/, '$1…') : String(digest));
