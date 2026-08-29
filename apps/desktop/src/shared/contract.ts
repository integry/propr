export const DESKTOP_PROTOCOL = 'propr';

export const IPC_CHANNELS = Object.freeze({
  appMetadata: 'desktop:app-metadata',
  openExternal: 'desktop:open-external',
  storageSecurity: 'desktop:storage-security',
  profilesList: 'desktop:profiles-list',
  profilesSave: 'desktop:profiles-save',
  profilesRemove: 'desktop:profiles-remove',
  profilesSetActive: 'desktop:profiles-set-active',
  credentialsRead: 'desktop:credentials-read',
  credentialsWrite: 'desktop:credentials-write',
  credentialsRemove: 'desktop:credentials-remove',
  lifecycleStatus: 'desktop:lifecycle-status',
  lifecycleStart: 'desktop:lifecycle-start',
  lifecycleStop: 'desktop:lifecycle-stop',
  lifecycleRestart: 'desktop:lifecycle-restart',
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

export type CredentialReadResult =
  | { available: false; value: null }
  | { available: true; value: string | null };

export type CredentialWriteResult =
  | { stored: true }
  | { stored: false; reason: 'encryption-unavailable' };

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
  credentials: {
    read(profileId: string): Promise<CredentialReadResult>;
    write(profileId: string, value: string): Promise<CredentialWriteResult>;
    remove(profileId: string): Promise<void>;
  };
  lifecycle: {
    status(): Promise<LocalLifecycleStatus>;
    start(): Promise<LocalLifecycleOperationResult>;
    stop(): Promise<LocalLifecycleOperationResult>;
    restart(): Promise<LocalLifecycleOperationResult>;
  };
}
