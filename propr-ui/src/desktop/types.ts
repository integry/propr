export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export interface DesktopProfile {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'local' | 'remote';
  lastConnectedAt?: string;
}

export type DesktopConnectionResult =
  | { status: 'ready'; version?: string }
  | { status: 'authentication-required'; message?: string }
  | { status: 'incompatible'; message: string; version?: string }
  | { status: 'offline'; message: string };

export interface DesktopProfileAdapter {
  list(): Promise<DesktopProfile[]>;
  save(profile: DesktopProfile): Promise<void>;
  remove(profileId: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(profileId: string | null): Promise<void>;
}

export interface DesktopDiscoveryAdapter {
  discover(): Promise<DesktopProfile[]>;
}

export interface DesktopAuthenticationAdapter {
  /**
   * Resolves only after the desktop host has completed authentication and
   * installed credentials that are ready for requests to this profile.
   * Opening the system browser alone is not successful authentication.
   */
  authenticate(profile: DesktopProfile): Promise<void>;
}

export const DESKTOP_AUTHENTICATION_COMPLETE_EVENT = 'propr:desktop-authentication-complete';

export interface DesktopAuthenticationCompleteEventDetail {
  profileId: string;
}

export interface DesktopExternalBrowserAdapter {
  open(url: string): Promise<void>;
}

export interface DesktopLocalSetupAdapter {
  status(): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  start(request: import('../../../apps/desktop/src/shared/contract').DesktopSetupRequest): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  retry(request?: import('../../../apps/desktop/src/shared/contract').DesktopSetupRequest): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  cancel(): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  onProgress(listener: (snapshot: import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot) => void): () => void;
}

export interface DesktopConnectionAdapter {
  probe(profile: DesktopProfile): Promise<DesktopConnectionResult>;
}

export interface DesktopAdapters {
  platform: DesktopPlatform;
  profiles: DesktopProfileAdapter;
  discovery: DesktopDiscoveryAdapter;
  authentication: DesktopAuthenticationAdapter;
  externalBrowser: DesktopExternalBrowserAdapter;
  localSetup: DesktopLocalSetupAdapter;
  connection: DesktopConnectionAdapter;
}

/**
 * Small preload-facing contract. Electron can expose this object through
 * contextBridge without exposing Node or command execution to React.
 */
export type ProprDesktopBridge = import('../../../apps/desktop/src/shared/contract').DesktopRendererBridge;
