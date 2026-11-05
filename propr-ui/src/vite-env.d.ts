/// <reference types="vite/client" />

// Injected at build time by Vite (see vite.config.ts) — the product version
// taken from the root package.json.
declare const __APP_VERSION__: string;
declare const __PROPR_DESKTOP__: boolean;

interface Window {
  proprDesktop?: import('../../apps/desktop/src/shared/contract').DesktopBridge;
  /** @internal Main-attested, packaged-Linux acceptance capability. */
  __PROPR_PACKAGED_ACCEPTANCE__?: Readonly<{
    setupEvidence(): {
      presentation: string;
      fixture: string;
      phase: import('../../apps/desktop/src/shared/contract').DesktopSetupSnapshot['phase'];
      calls: string[];
    };
    setZoomFactor(factor: 1 | 2): Promise<unknown>;
  }>;
}
