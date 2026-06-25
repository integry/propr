// Runtime configuration for the ProPR UI.
//
// This file is served as a static asset (it is intentionally NOT bundled by
// Vite) so the hosting environment can replace it at container start to point a
// single hosted UI at a per-instance proxy URL without rebuilding. See
// docker-entrypoint.sh, which regenerates this file from PROPR_UI_PUBLIC_API_URL.
//
// The empty default keeps local development and same-origin deployments working:
// an empty apiBaseUrl means REST and Socket.IO use the current origin (the Vite
// proxy in dev, the serving origin in production).
window.__PROPR_CONFIG__ = {
  apiBaseUrl: ""
};
