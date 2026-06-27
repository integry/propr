// Runtime configuration for the UI.
//
// The hosted UI is a single static bundle that serves many local stacks, so the
// API / Socket.IO base URL cannot be baked in at build time — each instance
// must talk to its own per-instance proxy (e.g. https://abc123.proxy.propr.dev).
// The base URL is therefore exposed on `window.__PROPR_CONFIG__` by the static
// `public/config.js`, which the hosting environment rewrites at container start
// from the `PROPR_UI_PUBLIC_API_URL` env var (see docker-entrypoint.sh).
//
// Resolution order for the API base URL:
//   1. Runtime config (window.__PROPR_CONFIG__.apiBaseUrl) — hosted deployments.
//   2. Build-time env (VITE_API_BASE_URL) — static single-target builds.
//   3. Empty string — same-origin (local dev via the Vite proxy).

import { DEFAULT_PROPR_UI_ORIGIN } from '@propr/shared';

export interface ProprRuntimeConfig {
  /** Base URL for REST and Socket.IO. Empty string means same-origin. */
  apiBaseUrl?: string;
}

declare global {
  interface Window {
    __PROPR_CONFIG__?: ProprRuntimeConfig;
  }
}

const runtimeConfig: ProprRuntimeConfig =
  (typeof window !== 'undefined' && window.__PROPR_CONFIG__) || {};

/**
 * Hostname of the managed hosted UI (e.g. `app.propr.dev`), derived from the
 * shared origin constant so there is a single source of truth.
 */
const HOSTED_UI_HOSTNAME = new URL(DEFAULT_PROPR_UI_ORIGIN).hostname;

/** A local development origin where the UI and API ship together. */
export const isLocalhostHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1';

/**
 * Whether the page is being served from the managed hosted UI origin
 * (`app.propr.dev`) — the single static bundle that serves many per-instance
 * proxies and is versioned independently from the API. Used to scope hosted-only
 * behavior (the runtime-config warning, the compatibility gate). A self-hosted
 * production deployment on its own domain (e.g. `https://propr.example.com`)
 * ships the UI and API together and is NOT a hosted-UI origin, so it is exempt
 * from both — only the actual hosted UI is gated. Exported for unit testing.
 */
export const isHostedUiOrigin = (hostname: string): boolean =>
  hostname === HOSTED_UI_HOSTNAME;

/**
 * On the hosted UI origin the bundle expects `config.js` to have run first and
 * populated window.__PROPR_CONFIG__ with a per-instance apiBaseUrl. If it is
 * missing — or loaded but with an empty apiBaseUrl (the more likely
 * misconfiguration: PROPR_UI_PUBLIC_API_URL was unset at container start) — the
 * app falls back to same-origin API calls, which is wrong for the hosted UI and
 * produces confusing failures. Returns a warning message to surface in that
 * case, or null when nothing looks wrong. Only the hosted UI origin is checked:
 * localhost and self-hosted same-origin deployments are exempt. Exported for
 * unit testing.
 */
export const runtimeConfigWarning = (
  hostname: string,
  config: ProprRuntimeConfig | undefined
): string | null => {
  if (!isHostedUiOrigin(hostname)) return null;
  if (!config) {
    return (
      '[propr] window.__PROPR_CONFIG__ is not set — config.js did not load. ' +
      'Falling back to same-origin API calls, which will not reach the per-instance proxy.'
    );
  }
  if (!config.apiBaseUrl?.trim()) {
    return (
      '[propr] window.__PROPR_CONFIG__.apiBaseUrl is empty — config.js loaded but ' +
      'PROPR_UI_PUBLIC_API_URL was not set at container start. ' +
      'Falling back to same-origin API calls, which will not reach the per-instance proxy.'
    );
  }
  return null;
};

if (typeof window !== 'undefined') {
  const warning = runtimeConfigWarning(window.location.hostname, window.__PROPR_CONFIG__);
  if (warning) console.warn(warning);
}

/**
 * Resolve the base URL used for both REST API calls and the Socket.IO
 * connection so they always target the same origin. Returns an empty string
 * for same-origin requests.
 *
 * Trailing slashes are stripped here, once, so the many callers that build
 * paths as `${API_BASE_URL}/api/...` never produce a double slash (e.g.
 * `https://abc.proxy.propr.dev//api/compatibility`). The orchestrator already
 * normalizes the values it injects, but a hand-served `public/config.js`,
 * `VITE_API_BASE_URL`, or manually set apiBaseUrl can still carry one.
 */
export const getApiBaseUrl = (): string =>
  (runtimeConfig.apiBaseUrl?.trim() || import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
