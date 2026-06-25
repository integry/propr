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

// On a hosted (non-localhost) origin the bundle expects `config.js` to have run
// first and populated window.__PROPR_CONFIG__. If it is missing, the app falls
// back to same-origin API calls — which is wrong for the hosted UI (it must
// target a per-instance proxy) and produces confusing failures. Surface a one-
// time warning to aid debugging; local development (no config.js) is exempt.
if (typeof window !== 'undefined' && !window.__PROPR_CONFIG__) {
  const { hostname } = window.location;
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!isLocalhost) {
    // eslint-disable-next-line no-console
    console.warn(
      '[propr] window.__PROPR_CONFIG__ is not set — config.js did not load. ' +
        'Falling back to same-origin API calls, which will not reach the per-instance proxy.'
    );
  }
}

/**
 * Resolve the base URL used for both REST API calls and the Socket.IO
 * connection so they always target the same origin. Returns an empty string
 * for same-origin requests.
 */
export const getApiBaseUrl = (): string =>
  runtimeConfig.apiBaseUrl?.trim() || import.meta.env.VITE_API_BASE_URL || '';
