export const DESKTOP_PROTOCOL = 'propr';

export const IPC_CHANNELS = Object.freeze({
  appMetadata: 'desktop:app-metadata',
  authLogout: 'desktop:auth-logout',
  remoteAuthenticate: 'desktop:remote-authenticate',
  openExternal: 'desktop:open-external',
  storageSecurity: 'desktop:storage-security',
  profilesList: 'desktop:profiles-list',
  profilesSave: 'desktop:profiles-save',
  profilesRemove: 'desktop:profiles-remove',
  profilesSetActive: 'desktop:profiles-set-active',
  lifecycleStatus: 'desktop:lifecycle-status',
  lifecycleStart: 'desktop:lifecycle-start',
  lifecycleStop: 'desktop:lifecycle-stop',
  lifecycleRestart: 'desktop:lifecycle-restart',
  discovery: 'desktop:discovery',
  setupStatus: 'desktop:setup-status',
  setupStart: 'desktop:setup-start',
  setupRetry: 'desktop:setup-retry',
  setupCancel: 'desktop:setup-cancel',
  setupSelectPrivateKey: 'desktop:setup-select-private-key',
  setupAcquireWebhookSecret: 'desktop:setup-acquire-webhook-secret',
  setupProgress: 'desktop:setup-progress',
  deepLink: 'desktop:deep-link',
} as const);

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

export interface DesktopRemoteAuthenticationRequest {
  profileId: string;
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
  lifecycle: {
    status(): Promise<LocalLifecycleStatus>;
    start(): Promise<LocalLifecycleOperationResult>;
    stop(): Promise<LocalLifecycleOperationResult>;
    restart(): Promise<LocalLifecycleOperationResult>;
  };
}

export type DesktopPlatformView = 'macos' | 'windows' | 'linux';

/** Renderer profile shape used by the shared desktop presentation layer. */
export interface DesktopProfileView {
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

export interface DesktopSetupRequest {
  sessionId: string;
  root: { mode: 'default' | 'resume' };
  reinitialize: boolean;
  agents: string[];
  github:
    | { mode: 'keep' }
    | { mode: 'demo' }
    | { mode: 'relay' }
    | { mode: 'app'; appId: string; privateKeyCapability: string; installationId: string };
  intake:
    | { mode: 'keep' }
    | { mode: 'routing_websocket' | 'polling' }
    | { mode: 'direct_webhook'; secretCapability: string };
  whitelist: string[] | null;
  repository: { fullName: string; alias?: string; baseBranch?: string } | null;
}

export interface DesktopFilesystemSelection {
  capability: string;
  label: string;
}

export interface DesktopSecretSelection {
  capability: string;
  label: 'Secret entered';
}

export interface DesktopSetupResumeView {
  agents: string[];
  reinitialize: boolean;
  github: { mode: 'keep' | 'demo' | 'relay' } | { mode: 'app'; appId: string; installationId: string; reconfigurationRequired: true };
  intake: { mode: 'keep' | 'routing_websocket' | 'polling' } | { mode: 'direct_webhook'; reconfigurationRequired: true };
  whitelist: string[] | null;
  repository: { fullName: string; alias?: string; baseBranch?: string } | null;
  reconfigurationStage?: 'github' | 'intake';
}

export type DesktopSetupPhase =
  | 'idle'
  | 'running'
  | 'interrupted'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'unsupported';

export interface DesktopSetupSnapshot {
  phase: DesktopSetupPhase;
  capability: import('@propr/local-setup').LocalSetupCapability;
  sessionId: string;
  rootDir?: string;
  state?: import('@propr/local-setup').SetupState;
  logs: string[];
  errors?: import('@propr/local-setup').SetupStructuredError[];
  error?: string;
  profile?: DesktopProfileView;
  resume?: DesktopSetupResumeView;
  resumeAvailable?: boolean;
  reconfigurationRequired?: boolean;
}

/** Narrow bridge consumed by `propr-ui/src/desktop`. */
export interface DesktopRendererBridge {
  isDesktop: true;
  platform: DesktopPlatformView;
  app: {
    onDeepLink(listener: (url: string) => void): () => void;
  };
  profiles: {
    list(): Promise<DesktopProfileView[]>;
    save(profile: DesktopProfileView): Promise<void>;
    remove(profileId: string): Promise<void>;
    getActiveId(): Promise<string | null>;
    setActiveId(profileId: string | null): Promise<void>;
  };
  discovery: { discover(): Promise<DesktopProfileView[]> };
  authentication: { authenticate(profile: DesktopProfileView): Promise<void> };
  externalBrowser: { open(url: string): Promise<void> };
  localSetup: {
    status(): Promise<DesktopSetupSnapshot>;
    start(request: DesktopSetupRequest): Promise<DesktopSetupSnapshot>;
    retry(request?: DesktopSetupRequest): Promise<DesktopSetupSnapshot>;
    cancel(): Promise<DesktopSetupSnapshot>;
    selectPrivateKey(): Promise<DesktopFilesystemSelection | null>;
    acquireWebhookSecret(): Promise<DesktopSecretSelection | null>;
    onProgress(listener: (snapshot: DesktopSetupSnapshot) => void): () => void;
  };
  connection: { probe(profile: DesktopProfileView): Promise<DesktopConnectionResult> };
}
