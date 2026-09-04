export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export type DesktopDeepLinkConsumption = {
  kind: 'connect-confirmation' | 'open-queued' | 'open-navigated';
  target: string;
};

export interface DesktopProfile {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'local' | 'remote';
  lastConnectedAt?: string;
}

export type DesktopConnectionResult =
  | { status: 'ready'; version?: string; authentication?: string; activationTicket?: string; transportScope?: string; profileId?: string; identityEpoch?: string }
  | { status: 'authentication-required'; message?: string; version?: string; authentication?: string }
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
  /** Whether this host has a real network-wide discovery provider. */
  supported: boolean;
  discover(): Promise<DesktopProfile[]>;
}

export interface DesktopAuthenticationAdapter {
  /**
   * Resolves only after the desktop host has completed authentication and
   * installed credentials that are ready for requests to this profile.
   * Opening the system browser alone is not successful authentication.
   */
  authenticate(profile: DesktopProfile): Promise<void>;
  cancel?(profileId: string): Promise<void>;
}

export const DESKTOP_AUTHENTICATION_COMPLETE_EVENT = 'propr:desktop-authentication-complete';
export const DESKTOP_ACCESS_INVALID_EVENT = 'propr:desktop-access-invalid';

export interface DesktopAuthenticationCompleteEventDetail {
  profileId: string;
}

export interface DesktopAccessInvalidEventDetail {
  profileId: string;
  transportScope: string;
  code: string;
}

export interface DesktopExternalBrowserAdapter {
  open(url: string): Promise<void>;
}

export interface DesktopLocalSetupAdapter {
  supported: boolean;
  setup(): Promise<DesktopProfile>;
}

export interface DesktopConnectionAdapter {
  probe(profile: DesktopProfile): Promise<DesktopConnectionResult>;
  activate?(
    profile: DesktopProfile,
    result: Extract<DesktopConnectionResult, { status: 'ready' }>,
    isCurrent?: () => boolean,
  ): Promise<DesktopConnectionResult>;
  publishActivation?(profile: DesktopProfile, result: Extract<DesktopConnectionResult, { status: 'ready' }>): void;
  deactivate?(): void;
}

export type DesktopAcceptanceJourneyStage =
  | 'AUTHENTICATION_REQUIRED'
  | 'CREDENTIAL_COMMITTED'
  | 'AUTHENTICATED_REPROBE_READY'
  | 'ACTIVATION_COMMITTED'
  | 'ACTIVATION_PUBLISHED'
  | 'REACT_CONNECTED';

export interface DesktopManagedTunnelRecoveryAdapter {
  /**
   * Request a secret-free Connect endpoint refresh for an existing profile.
   * The renderer supplies only the opaque profile id and must explicitly
   * confirm a returned candidate before it can replace the saved endpoint.
   */
  rediscover(profileId: string): Promise<DesktopProfile | null>;
}

export interface DesktopAdapters {
  platform: DesktopPlatform;
  app: {
    onDeepLink(listener: (url: string) => DesktopDeepLinkConsumption | null): () => void;
  };
  profiles: DesktopProfileAdapter;
  discovery: DesktopDiscoveryAdapter;
  authentication: DesktopAuthenticationAdapter;
  externalBrowser: DesktopExternalBrowserAdapter;
  localSetup: DesktopLocalSetupAdapter;
  connection: DesktopConnectionAdapter;
  managedTunnelRecovery?: DesktopManagedTunnelRecoveryAdapter;
  /** @internal Authorized packaged-journey evidence; absent in production use. */
  acceptance?: {
    reportJourneyStage(stage: DesktopAcceptanceJourneyStage): Promise<void>;
  };
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
