// The hosted UI (app.propr.dev) version check, shared by the post-deploy
// verification (scripts/verify-hosted-ui-release.mjs, run by
// .github/workflows/hosted-ui-deploy.yml) and the release rollout check
// (scripts/verify-release-rollout.mjs).
//
// index.html loads one /assets/index-<hash>.js entry module; vite writes
// __APP_VERSION__ into it as a JSON string literal, for example "0.9.2".

export const DEFAULT_HOSTED_UI_URL = 'https://app.propr.dev/';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENTRY_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']*\/assets\/index-[\w-]+\.js)["'][^>]*>/i;

export const isReleaseVersion = version => typeof version === 'string' && VERSION.test(version);

export function requireVersion(version, label = 'RELEASE_VERSION') {
  if (!isReleaseVersion(version)) {
    throw new Error(`${label} must be a release version such as 0.9.0, got ${JSON.stringify(version)}`);
  }
  return version;
}

export function resolveEntryBundle(html, pageUrl) {
  const match = ENTRY_SCRIPT.exec(html);
  if (!match) throw new Error('index.html does not load an /assets/index-*.js entry module');
  const bundle = new URL(match[1], pageUrl);
  if (bundle.origin !== new URL(pageUrl).origin) {
    throw new Error(`entry module ${bundle.href} is not served from ${new URL(pageUrl).origin}`);
  }
  return bundle;
}

export const bundleHasVersion = (source, version) => source.includes(JSON.stringify(version));

export class HttpStatusError extends Error {
  constructor(url, status) {
    super(`GET ${url} returned HTTP ${status}`);
    this.status = status;
  }
}

export async function fetchUncachedText(fetchImpl, url) {
  // Bypass intermediate caches so each attempt sees the current deployment.
  const busted = new URL(url);
  busted.searchParams.set('propr_release_check', String(Date.now()));
  const response = await fetchImpl(busted, { headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
  if (!response.ok) throw new HttpStatusError(url, response.status);
  return response.text();
}

/**
 * Reads the deployed entry bundle once. Throws when index.html or the bundle
 * cannot be read; otherwise reports whether the bundle carries `version`.
 */
export async function readHostedUiBundle({ url, version, fetchImpl = fetch }) {
  const bundle = resolveEntryBundle(await fetchUncachedText(fetchImpl, url), url);
  const source = await fetchUncachedText(fetchImpl, bundle);
  return { bundle, hasVersion: bundleHasVersion(source, version) };
}

export async function checkOnce({ url, version, fetchImpl = fetch }) {
  const { bundle, hasVersion } = await readHostedUiBundle({ url, version, fetchImpl });
  if (!hasVersion) throw new Error(`${bundle.pathname} does not contain ${JSON.stringify(version)}`);
  return bundle;
}
