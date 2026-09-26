import { vi } from 'vitest';
import type { DesktopBridge, DesktopProfile as StoredProfile } from '../../../apps/desktop/src/shared/contract';

export const storedProfile: StoredProfile = {
  id: 'profile-1',
  label: 'Team server',
  apiBaseUrl: 'https://propr.example.test',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

export const pairingOperationId = (attempt: number) =>
  `00000000-0000-4000-8000-${attempt.toString().padStart(12, '0')}`;

export const bridgeFixture = () => {
  let profiles = [storedProfile];
  let activeProfileId: string | null = null;
  let pairingAttempt = 0;
  const admit = vi.fn(async () => ({ operationId: pairingOperationId(++pairingAttempt) }));
  const pair = vi.fn(async () => ({ paired: true as const }));
  const reopenApproval = vi.fn(async () => ({ status: 'succeeded' as const }));
  const copyApproval = vi.fn(async () => ({ status: 'succeeded' as const }));
  const onDeepLink = vi.fn(() => () => undefined);
  const probe = vi.fn(async () => ({
    status: 'ready' as const,
    version: '0.8.15',
    activationTicket: 'ticket-7',
  }));
  const activate = vi.fn(async () => ({
    status: 'ready' as const,
    profileId: storedProfile.id,
    transportScope: 'scope-7',
    identityEpoch: 'AAAAAAAAAAAAAAAAAAAAAA',
  }));
  const discard = vi.fn(async () => ({ discarded: true }));
  const discover = vi.fn(async () => [{
    id: 'connect-candidate',
    label: 'ProPR Connect',
    apiBaseUrl: 'https://t-discovered123.propr.dev',
  }]);
  const rediscover = vi.fn(async (profileId: string) => ({
    id: profileId,
    label: 'Team server',
    apiBaseUrl: 'https://t-recovered456.propr.dev',
  }));
  const setupSnapshot = {
    phase: 'idle' as const,
    capability: { supported: true as const, kind: 'local' as const, platform: 'linux' as const },
    sessionId: '11111111-1111-4111-8111-111111111111',
    logs: [],
  };
  const setupStart = vi.fn(async () => setupSnapshot);
  const bridge: DesktopBridge = {
    app: {
      getMetadata: async () => ({
        name: 'ProPR Desktop', version: '0.8.15', platform: 'linux', arch: 'x64', packaged: true,
      }),
      refreshActiveWork: async () => undefined,
      quit: async () => undefined,
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      closeWindow: async () => undefined,
      onDeepLink,
      onNativeCommand: () => () => undefined,
    },
    auth: { logout: async () => undefined },
    external: { open: async () => undefined },
    storage: { security: async () => ({ available: true, backend: 'keychain' }) },
    profiles: {
      list: async () => ({ profiles, activeProfileId }),
      save: async input => {
        const saved = { ...storedProfile, id: input.id ?? 'new', label: input.label, apiBaseUrl: input.apiBaseUrl };
        profiles = [...profiles.filter(profile => profile.id !== saved.id), saved];
        return saved;
      },
      remove: async profileId => { profiles = profiles.filter(profile => profile.id !== profileId); },
      setActive: async profileId => { activeProfileId = profileId; },
    },
    authentication: {
      admit,
      pair,
      cancel: vi.fn(async () => undefined),
      reopenApproval,
      copyApproval,
    },
    connection: { probe, activate, discard, invalidate: vi.fn(async () => ({ invalidated: false })) },
    discovery: { supported: true, discover, rediscover },
    lifecycle: {
      status: async () => ({ state: 'disconnected' }),
      start: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      stop: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      restart: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
    },
    localSetup: {
      status: async () => setupSnapshot,
      start: setupStart,
      retry: async () => setupSnapshot,
      cancel: async () => setupSnapshot,
      selectPrivateKey: async () => null,
      acquireWebhookSecret: async () => null,
      resolveGithubInstallation: async () => setupSnapshot,
      onProgress: () => () => undefined,
    },
  };
  return {
    bridge,
    onDeepLink,
    admit,
    pair,
    reopenApproval,
    copyApproval,
    probe,
    activate,
    discard,
    discover,
    rediscover,
    profiles: () => profiles,
  };
};

export const fromProfile = (profile: StoredProfile) => ({
  id: profile.id,
  name: profile.label,
  baseUrl: profile.apiBaseUrl,
  kind: 'remote' as const,
});
