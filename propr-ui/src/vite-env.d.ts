/// <reference types="vite/client" />

// Injected at build time by Vite (see vite.config.ts) — the product version
// taken from the root package.json.
declare const __APP_VERSION__: string;
declare const __PROPR_DESKTOP__: boolean;

interface Window {
  proprDesktop?: import('../../apps/desktop/src/shared/contract').DesktopBridge;
  /** @internal Main-attested, packaged-Linux acceptance capability. */
  __PROPR_PACKAGED_ACCEPTANCE__?: Readonly<{
    setZoomFactor(factor: 1 | 2): Promise<unknown>;
  }>;
  /** @internal Fixed visual-fixture selector exposed only after acceptance attestation. */
  __PROPR_PACKAGED_ACCEPTANCE_SCENARIO__?: 'default' | 'setup-error' | 'setup-complete';
}
