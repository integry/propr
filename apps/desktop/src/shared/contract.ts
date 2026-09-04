export const DESKTOP_PROTOCOL = 'propr';

export const IPC_CHANNELS = Object.freeze({
  appMetadata: 'desktop:app-metadata',
  authLogout: 'desktop:auth-logout',
  openExternal: 'desktop:open-external',
  storageSecurity: 'desktop:storage-security',
  profilesList: 'desktop:profiles-list',
  profilesSave: 'desktop:profiles-save',
  profilesRemove: 'desktop:profiles-remove',
  profilesSetActive: 'desktop:profiles-set-active',
  authenticationPair: 'desktop:authentication-pair',
  authenticationCancel: 'desktop:authentication-cancel',
  connectionProbe: 'desktop:connection-probe',
  connectionActivate: 'desktop:connection-activate',
  connectionDiscard: 'desktop:connection-discard',
  connectionInvalidate: 'desktop:connection-invalidate',
  connectDiscover: 'desktop:connect-discover',
  connectRediscover: 'desktop:connect-rediscover',
  lifecycleStatus: 'desktop:lifecycle-status',
  lifecycleStart: 'desktop:lifecycle-start',
  lifecycleStop: 'desktop:lifecycle-stop',
  lifecycleRestart: 'desktop:lifecycle-restart',
  deepLink: 'desktop:deep-link',
  acceptanceJourneyStage: 'desktop:acceptance-journey-stage',
} as const);

export type DesktopAcceptanceJourneyStage =
  | 'AUTHENTICATION_REQUIRED'
  | 'CREDENTIAL_COMMITTED'
  | 'AUTHENTICATED_REPROBE_READY'
  | 'ACTIVATION_COMMITTED'
  | 'ACTIVATION_PUBLISHED'
  | 'REACT_CONNECTED';

export type DesktopPlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku'
  | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

export interface DesktopAppMetadata {
  name: string;
  version: string;
  platform: DesktopPlatform;
  arch: string;
  packaged: boolean;
}

export interface DesktopProfile {
  id: string;
  label: string;
  apiBaseUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopProfileInput {
  id?: string;
  label: string;
  apiBaseUrl: string;
}

/** Secret-free candidate projected by the trusted main-process discovery service. */
export interface DesktopDiscoveryCandidate {
  id: string;
  label: string;
  apiBaseUrl: string;
}

export interface DesktopProfileList {
  profiles: DesktopProfile[];
  activeProfileId: string | null;
}

export type StorageSecurity = {
  available: true;
  backend: string;
} | {
  available: false;
  backend: string;
  reason: 'os-encryption-unavailable' | 'insecure-basic-text-backend';
};

export type DesktopConnectionResult =
  | { status: 'ready'; version?: string; authentication?: string; activationTicket: string }
  | { status: 'authentication-required'; message?: string; version?: string; authentication?: string }
  | { status: 'incompatible'; message: string; version?: string }
  | { status: 'offline'; message: string };

export interface DesktopConnectionScope {
  profileId: string;
  transportScope: string;
}

export interface DesktopActivatedConnection extends DesktopConnectionScope {
  status: 'ready';
  identityEpoch: string;
  /** The main process committed a stricter replacement document policy and scheduled a reload. */
  rendererReloadRequired?: true;
}

export interface DesktopAccessInvalidation extends DesktopConnectionScope {
  code: string;
}

export type LocalLifecycleState = 'disconnected' | 'starting' | 'connected' | 'stopping' | 'error';

export interface LocalLifecycleStatus {
  state: LocalLifecycleState;
  detail?: string;
}

export type LocalLifecycleOperationResult =
  | { ok: true; status: LocalLifecycleStatus }
  | { ok: false; code: 'not-implemented'; status: LocalLifecycleStatus };

export interface DesktopBridge {
  app: {
    getMetadata(): Promise<DesktopAppMetadata>;
    onDeepLink(listener: (url: string) => void): () => void;
  };
  auth: {
    logout(apiBaseUrl: string): Promise<void>;
  };
  external: {
    open(url: string): Promise<void>;
  };
  storage: {
    security(): Promise<StorageSecurity>;
  };
  profiles: {
    list(): Promise<DesktopProfileList>;
    save(profile: DesktopProfileInput): Promise<DesktopProfile>;
    remove(profileId: string): Promise<void>;
    setActive(profileId: string | null): Promise<void>;
  };
  authentication: {
    pair(profile: DesktopProfileInput): Promise<{ paired: true }>;
    cancel(profileId: string): Promise<void>;
  };
  connection: {
    probe(profile: DesktopProfileInput): Promise<DesktopConnectionResult>;
    activate(activationTicket: string): Promise<DesktopActivatedConnection>;
    discard(value: DesktopConnectionScope): Promise<{ discarded: boolean }>;
    invalidate(value: DesktopAccessInvalidation): Promise<{ invalidated: boolean }>;
  };
  discovery: {
    supported: boolean;
    discover(): Promise<DesktopDiscoveryCandidate[]>;
    rediscover(profileId: string): Promise<DesktopDiscoveryCandidate | null>;
  };
  lifecycle: {
    status(): Promise<LocalLifecycleStatus>;
    start(): Promise<LocalLifecycleOperationResult>;
    stop(): Promise<LocalLifecycleOperationResult>;
    restart(): Promise<LocalLifecycleOperationResult>;
  };
  /** @internal Present only in an authorized packaged Connect acceptance process. */
  acceptance?: {
    reportJourneyStage(stage: DesktopAcceptanceJourneyStage): Promise<void>;
  };
}
