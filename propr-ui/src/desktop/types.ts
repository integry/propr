import type { DesktopGitHubAccount } from '../../../apps/desktop/src/shared/github-account';

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export type DesktopDeepLinkConsumption = {
  kind: 'connect-confirmation' | 'open-queued' | 'open-navigated';
  target: string;
};

export interface DesktopProfile {
  account?: DesktopGitHubAccount;
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
  authenticate(
    profile: DesktopProfile,
    onProgress?: (stage: DesktopAuthenticationProgressStage) => void,
  ): Promise<void>;
  cancel?(profileId: string): Promise<void>;
  reopenApproval?(profileId: string): Promise<DesktopPairingApprovalActionResult>;
  copyApproval?(profileId: string): Promise<DesktopPairingApprovalActionResult>;
}

export type DesktopPairingApprovalActionResult =
  import('../../../apps/desktop/src/shared/contract').DesktopPairingApprovalActionResult;

export type DesktopAuthenticationProgressStage =
  | 'starting'
  | 'browser-opening'
  | 'approval-pending'
  | 'browser-open-failed';

export type DesktopAuthenticationFailureCode =
  | 'APPROVAL_EXPIRED'
  | 'SECURE_STORAGE_FAILED'
  | 'PAIRING_REJECTED'
  | 'ACCOUNT_MISMATCH'
  | 'PAIRING_UNREACHABLE'
  | 'PAIRING_CANCELLED';

export class DesktopAuthenticationError extends Error {
  readonly code: DesktopAuthenticationFailureCode;

  constructor(code: DesktopAuthenticationFailureCode) {
    super('Desktop authentication failed');
    this.name = 'DesktopAuthenticationError';
    this.code = code;
  }
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
  /** @deprecated Fixture compatibility only; production Electron uses the guided methods below. */
  setup?(): Promise<DesktopProfile>;
  status?(): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  start?(request: import('../../../apps/desktop/src/shared/contract').DesktopSetupRequest): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  retry?(request?: import('../../../apps/desktop/src/shared/contract').DesktopSetupRequest
    | import('../../../apps/desktop/src/shared/contract').DesktopSetupRecoveryRequest): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  cancel?(): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  selectPrivateKey?(): Promise<import('../../../apps/desktop/src/shared/contract').DesktopFilesystemSelection | null>;
  acquireWebhookSecret?(): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSecretSelection | null>;
  resolveGithubInstallation?(decision: import('../../../apps/desktop/src/shared/contract').DesktopGithubInstallationDecision): Promise<import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot>;
  onProgress?(listener: (snapshot: import('../../../apps/desktop/src/shared/contract').DesktopSetupSnapshot) => void): () => void;
}

export type DesktopGuidedLocalSetupAdapter = Required<Omit<DesktopLocalSetupAdapter, 'setup'>>;

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
  /** Only hosts with isolated bearer bindings may expose saved account switching. */
  savedAccounts?: boolean;
  platform: DesktopPlatform;
  app: {
    hasStartupConnectIntent?(): Promise<boolean>;
    onDeepLink(listener: (
      url: string,
    ) => DesktopDeepLinkConsumption | null | Promise<DesktopDeepLinkConsumption | null>): () => void;
    setNativeNavigationState?(state: import('../../../apps/desktop/src/shared/contract').DesktopNativeNavigationState): Promise<void>;
    onNativeCommand?(listener: (
      delivery: import('../../../apps/desktop/src/shared/contract').DesktopNativeCommandDelivery,
    ) => void): () => void;
    quit?(): Promise<void>;
    minimize?(): Promise<void>;
    toggleMaximize?(): Promise<void>;
    closeWindow?(): Promise<void>;
  };
  profiles: DesktopProfileAdapter;
  discovery: DesktopDiscoveryAdapter;
  authentication: DesktopAuthenticationAdapter;
  externalBrowser: DesktopExternalBrowserAdapter;
  localSetup: DesktopLocalSetupAdapter;
  connection: DesktopConnectionAdapter;
  managedTunnelRecovery?: DesktopManagedTunnelRecoveryAdapter;
  notifications?: import('../../../apps/desktop/src/shared/contract').DesktopBridge['notifications'];
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

export const DESKTOP_LOGGED_OUT_EVENT = 'propr:desktop-logged-out';
