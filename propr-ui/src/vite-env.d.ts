/// <reference types="vite/client" />

// Injected at build time by Vite (see vite.config.ts) — the product version
// taken from the root package.json.
declare const __APP_VERSION__: string;
declare const __PROPR_DESKTOP__: boolean;

interface Window {
  proprDesktop?: import('../../apps/desktop/src/shared/contract').DesktopBridge;
  __PROPR_DESKTOP__?: import('../../apps/desktop/src/shared/contract').DesktopRendererBridge;
}
