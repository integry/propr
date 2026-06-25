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

/**
 * Resolve the base URL used for both REST API calls and the Socket.IO
 * connection so they always target the same origin. Returns an empty string
 * for same-origin requests.
 */
export const getApiBaseUrl = (): string =>
  runtimeConfig.apiBaseUrl?.trim() || import.meta.env.VITE_API_BASE_URL || '';
