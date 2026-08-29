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
  authenticate(profile: DesktopProfile): Promise<void>;
}

export interface DesktopExternalBrowserAdapter {
  open(url: string): Promise<void>;
}

export interface DesktopLocalSetupAdapter {
  setup(): Promise<DesktopProfile>;
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
export interface ProprDesktopBridge extends DesktopAdapters {
  isDesktop: true;
}

declare global {
  interface Window {
    __PROPR_DESKTOP__?: ProprDesktopBridge;
  }
}

