import type { DesktopGitHubAccount } from './github-account';

export const DESKTOP_PROTOCOL = 'propr';

export const IPC_CHANNELS = Object.freeze({
  microphoneRequest: 'desktop:microphone-request',
  microphoneRevoke: 'desktop:microphone-revoke',
  appMetadata: 'desktop:app-metadata',
  appQuit: 'desktop:app-quit',
  activeWorkRefresh: 'desktop:active-work-refresh',
  windowMinimize: 'desktop:window-minimize',
  windowToggleMaximize: 'desktop:window-toggle-maximize',
  windowClose: 'desktop:window-close',
  authLogout: 'desktop:auth-logout',
  openExternal: 'desktop:open-external',
  storageSecurity: 'desktop:storage-security',
  profilesList: 'desktop:profiles-list',
  profilesSave: 'desktop:profiles-save',
  profilesRemove: 'desktop:profiles-remove',
  profilesSetActive: 'desktop:profiles-set-active',
  authenticationPairAdmit: 'desktop:authentication-pair-admit',
  authenticationPair: 'desktop:authentication-pair',
  authenticationCancel: 'desktop:authentication-cancel',
  authenticationReopenApproval: 'desktop:authentication-reopen-approval',
  authenticationCopyApproval: 'desktop:authentication-copy-approval',
  authenticationProgress: 'desktop:authentication-progress',
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
  setupStatus: 'desktop:setup-status',
  setupStart: 'desktop:setup-start',
  setupRetry: 'desktop:setup-retry',
  setupCancel: 'desktop:setup-cancel',
  setupSelectPrivateKey: 'desktop:setup-select-private-key',
  setupAcquireWebhookSecret: 'desktop:setup-acquire-webhook-secret',
  setupGithubInstallationDecision: 'desktop:setup-github-installation-decision',
  setupProgress: 'desktop:setup-progress',
  deepLink: 'desktop:deep-link',
  deepLinkConsumerReady: 'desktop:deep-link-consumer-ready',
  deepLinkAcknowledgement: 'desktop:deep-link-acknowledgement',
  acceptanceJourneyStage: 'desktop:acceptance-journey-stage',
  notificationsGet: 'desktop:notifications-get',
  notificationsUpdate: 'desktop:notifications-update',
  notificationsTest: 'desktop:notifications-test',
  notificationsPublish: 'desktop:notifications-publish',
  notificationsClear: 'desktop:notifications-clear',
  notificationsChanged: 'desktop:notifications-changed',
  notificationNavigate: 'desktop:notification-navigate',
  nativeCommand: 'desktop:native-command',
  nativeNavigationState: 'desktop:native-navigation-state',
} as const);

export const DESKTOP_NATIVE_COMMANDS = Object.freeze([
  'new-plan',
  'new-task',
  'search',
  'toggle-sidebar',
  'connect-instance',
  'diagnostics',
  'dashboard',
  'goals',
  'repositories',
  'llm-logs',
  'settings',
  'back',
  'forward',
  'tasks',
  'plans',
  'inbox',
  'manage-instances',
  'notification-settings',
  'quit',
] as const);

export type DesktopNativeCommand = typeof DESKTOP_NATIVE_COMMANDS[number];

export const isDesktopNativeCommand = (value: unknown): value is DesktopNativeCommand =>
  typeof value === 'string' && (DESKTOP_NATIVE_COMMANDS as readonly string[]).includes(value);

export interface DesktopNativeCommandDelivery {
  command: DesktopNativeCommand;
  connectionScope: DesktopConnectionScope | null;
}

export interface DesktopNativeNavigationState {
  connectionScope: DesktopConnectionScope | null;
  canManageInstances: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export const isDesktopNativeNavigationState = (value: unknown): value is DesktopNativeNavigationState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).length === 4
    && (state.connectionScope === null || isDesktopConnectionScope(state.connectionScope))
    && typeof state.canManageInstances === 'boolean'
    && typeof state.canGoBack === 'boolean' && typeof state.canGoForward === 'boolean';
};

export interface DesktopDeepLinkDelivery {
  deliveryId: number;
  url: string;
}

export type DesktopDeepLinkConsumption = {
  kind: 'connect-confirmation' | 'open-queued' | 'open-navigated';
  target: string;
};

export interface DesktopDeepLinkAcknowledgement extends DesktopDeepLinkDelivery {
  consumption: DesktopDeepLinkConsumption;
}

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
  /** Main-verified account bound to this connection; absent for legacy/unpaired profiles. */
  account?: DesktopGitHubAccount;
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

export type DesktopPairingFailureCode =
  | 'APPROVAL_EXPIRED'
  | 'SECURE_STORAGE_FAILED'
  | 'PAIRING_REJECTED'
  | 'ACCOUNT_MISMATCH'
  | 'PAIRING_UNREACHABLE'
  | 'PAIRING_CANCELLED';

export type DesktopPairingResult =
  | { paired: true }
  | { paired: false; code: DesktopPairingFailureCode };

export const isDesktopPairingOperationId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export interface DesktopPairingProgress {
  operationId: string;
  profileId: string;
  stage: 'browser-opening' | 'approval-pending' | 'browser-open-failed';
}

export type DesktopPairingApprovalActionResult = {
  status: 'succeeded' | 'unavailable' | 'failed';
};

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
}

export interface DesktopAccessInvalidation extends DesktopConnectionScope {
  code: string;
}

export interface DesktopNotificationScope extends DesktopConnectionScope {
  /** Authenticated instance user. Preferences remain local to this device. */
  userId: string;
}

const DESKTOP_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DESKTOP_TRANSPORT_SCOPE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DESKTOP_USER_ID_PATTERN = /^[^\x00-\x20\x7f]{1,128}$/;

const isDesktopConnectionScope = (value: unknown): value is DesktopConnectionScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).length === 2
    && typeof scope.profileId === 'string' && DESKTOP_PROFILE_ID_PATTERN.test(scope.profileId)
    && typeof scope.transportScope === 'string'
    && DESKTOP_TRANSPORT_SCOPE_PATTERN.test(scope.transportScope);
};

export const isDesktopNativeCommandDelivery = (
  value: unknown,
): value is DesktopNativeCommandDelivery => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const delivery = value as Record<string, unknown>;
  return Object.keys(delivery).length === 2
    && isDesktopNativeCommand(delivery.command)
    && (delivery.connectionScope === null || isDesktopConnectionScope(delivery.connectionScope));
};

export const isDesktopNotificationScope = (value: unknown): value is DesktopNotificationScope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).length === 3
    && typeof scope.profileId === 'string' && DESKTOP_PROFILE_ID_PATTERN.test(scope.profileId)
    && typeof scope.transportScope === 'string'
    && DESKTOP_TRANSPORT_SCOPE_PATTERN.test(scope.transportScope)
    && typeof scope.userId === 'string' && DESKTOP_USER_ID_PATTERN.test(scope.userId);
};

export interface DesktopNotificationPreferences {
  enabled: boolean;
  taskStarted: boolean;
  taskCompleted: boolean;
  taskFailed: boolean;
  taskNeedsAttention: boolean;
}

export interface DesktopNotificationCapability {
  supported: boolean;
  platform: DesktopPlatform;
  /** Electron cannot observe Focus/DND or whether the OS actually displayed a banner. */
  permission: 'unknown' | 'unsupported';
  reason?: 'platform-deferred' | 'native-api-unavailable';
}

export interface DesktopNotificationSettings {
  preferences: DesktopNotificationPreferences;
  capability: DesktopNotificationCapability;
  scope: 'account-instance-device';
}

export interface DesktopNotificationTestResult {
  status: 'accepted' | 'failed' | 'unconfirmed' | 'not-attempted' | 'cancelled';
}

export interface DesktopTaskTransition {
  taskId: string;
  state: string;
  previousState: string;
  repository?: string;
  issueNumber?: number;
  timestamp: string;
  version?: number;
}

export type LocalLifecycleState = 'disconnected' | 'starting' | 'connected' | 'stopping' | 'error';

export interface LocalLifecycleStatus {
  state: LocalLifecycleState;
  detail?: string;
}

export type LocalLifecycleOperationResult =
  | { ok: true; status: LocalLifecycleStatus }
  | { ok: false; code: 'not-implemented'; status: LocalLifecycleStatus };

export interface DesktopSetupRequest {
  sessionId: string;
  root: { mode: 'default' | 'resume' };
  reinitialize: boolean;
  agents: string[];
  github:
    | { mode: 'keep' }
    | { mode: 'relay' }
    | { mode: 'app'; appId: string; privateKeyCapability: string; installationId: string };
  intake:
    | { mode: 'keep' }
    | { mode: 'routing_websocket' }
    | { mode: 'polling' }
    | { mode: 'direct_webhook'; secretCapability: string };
  whitelist: string[] | null;
  repository: { fullName: string; alias?: string; baseBranch?: string } | null;
}

export interface DesktopSetupRecoveryRequest {
  sessionId: string;
  recoveryAction: 'replace-running-stack';
}

export interface DesktopFilesystemSelection { capability: string; label: string }
export interface DesktopSecretSelection { capability: string; label: 'Secret entered' }

export interface DesktopGithubInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

export interface DesktopGithubSelectedIdentity {
  username: string;
  installation: DesktopGithubInstallation;
}

export type DesktopGithubInstallationDecision =
  | { action: 'select'; installationId: string }
  | { action: 'refresh' }
  | { action: 'install' }
  | { action: 'reauthenticate' };

export interface DesktopGithubIdentityState {
  status: 'selection-required' | 'authorization-failed' | 'refreshing' | 'installing' | 'reauthenticating' | 'enrolling' | 'enrolled';
  username: string;
  installations: DesktopGithubInstallation[];
  selectedInstallationId?: string;
  permissionExplanation?: string;
  installAvailable: boolean;
}

export interface DesktopSetupResumeView {
  agents: string[];
  reinitialize: boolean;
  github: { mode: 'keep' | 'demo' }
    | { mode: 'relay'; identity?: DesktopGithubSelectedIdentity }
    | { mode: 'app'; appId: string; installationId: string; reconfigurationRequired: true };
  intake: { mode: 'keep' | 'routing_websocket' | 'polling' }
    | { mode: 'direct_webhook'; reconfigurationRequired: true };
  whitelist: string[] | null;
  repository: { fullName: string; alias?: string; baseBranch?: string } | null;
  reconfigurationStage?: 'github' | 'intake';
}

export type DesktopSetupPhase = 'idle' | 'running' | 'interrupted' | 'cancelled' | 'failed' | 'completed' | 'unsupported';

export interface DesktopSetupProfile {
  id: string;
  name: string;
  baseUrl: string;
  kind: 'local';
}

export interface DesktopSetupSnapshot {
  phase: DesktopSetupPhase;
  capability: import('@propr/local-setup').LocalSetupCapability;
  sessionId: string;
  rootDir?: string;
  state?: import('@propr/local-setup').SetupState;
  logs: string[];
  errors?: import('@propr/local-setup').SetupStructuredError[];
  error?: string;
  profile?: DesktopSetupProfile;
  resume?: DesktopSetupResumeView;
  resumeAvailable?: boolean;
  reconfigurationRequired?: boolean;
  /** Safe identity metadata only; GitHub and relay tokens never cross IPC. */
  githubIdentity?: DesktopGithubIdentityState;
}

export interface DesktopBridge {
  /** One attempt only; never a persistent device permission. */
  voice?: {
    requestMicrophone(): Promise<boolean>;
    revokeMicrophone(): Promise<void>;
  };
  app: {
    getMetadata(): Promise<DesktopAppMetadata>;
    /** Request a main-owned reconciliation; the renderer cannot supply counts or native resources. */
    refreshActiveWork(): Promise<void>;
    /** Complete a renderer-confirmed quit through the main-owned shutdown lifecycle. */
    quit(): Promise<void>;
    /** Fixed native window operations; no geometry or arbitrary command crosses IPC. */
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    closeWindow(): Promise<void>;
    /** Resolves after consumer registration, before startup may reconnect a saved account. */
    hasStartupConnectIntent?(): Promise<boolean>;
    onDeepLink(listener: (
      url: string,
    ) => DesktopDeepLinkConsumption | null | Promise<DesktopDeepLinkConsumption | null>): () => void;
    setNativeNavigationState?(state: DesktopNativeNavigationState): Promise<void>;
    onNativeCommand(listener: (delivery: DesktopNativeCommandDelivery) => void): () => void;
  };
  auth: {
    logout(scope: DesktopConnectionScope): Promise<void>;
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
    admit(profileId: string): Promise<{ operationId: string }>;
    pair(profile: DesktopProfileInput, operationId: string): Promise<DesktopPairingResult>;
    cancel(profileId: string): Promise<void>;
    reopenApproval(profileId: string, operationId: string): Promise<DesktopPairingApprovalActionResult>;
    copyApproval(profileId: string, operationId: string): Promise<DesktopPairingApprovalActionResult>;
    onProgress?(listener: (progress: DesktopPairingProgress) => void): () => void;
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
  localSetup: {
    status(): Promise<DesktopSetupSnapshot>;
    start(request: DesktopSetupRequest): Promise<DesktopSetupSnapshot>;
    retry(request?: DesktopSetupRequest | DesktopSetupRecoveryRequest): Promise<DesktopSetupSnapshot>;
    cancel(): Promise<DesktopSetupSnapshot>;
    selectPrivateKey(): Promise<DesktopFilesystemSelection | null>;
    acquireWebhookSecret(): Promise<DesktopSecretSelection | null>;
    resolveGithubInstallation(decision: DesktopGithubInstallationDecision): Promise<DesktopSetupSnapshot>;
    onProgress(listener: (snapshot: DesktopSetupSnapshot) => void): () => void;
  };
  notifications?: {
    get(scope: DesktopNotificationScope): Promise<DesktopNotificationSettings>;
    update(
      scope: DesktopNotificationScope,
      preferences: Partial<DesktopNotificationPreferences>,
    ): Promise<DesktopNotificationSettings>;
    test(scope: DesktopNotificationScope): Promise<DesktopNotificationTestResult>;
    publish(scope: DesktopNotificationScope, transition: DesktopTaskTransition): Promise<{ accepted: boolean }>;
    clear(scope: DesktopNotificationScope): Promise<void>;
    onSettingsChanged(listener: (scope: DesktopNotificationScope) => void): () => void;
    onNavigate(listener: (path: string) => void): () => void;
  };
  /** @internal Present only in an authorized packaged Connect acceptance process. */
  acceptance?: {
    reportJourneyStage(stage: DesktopAcceptanceJourneyStage): Promise<void>;
  };
}
