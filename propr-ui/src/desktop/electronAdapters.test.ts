import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, DesktopProfile as StoredProfile } from '../../../apps/desktop/src/shared/contract';
import { createElectronDesktopAdapters } from './electronAdapters';

const setDesktopConnectionScope = vi.hoisted(() => vi.fn());
vi.mock('../api/apiClient', () => ({ setDesktopConnectionScope }));

const storedProfile: StoredProfile = {
  id: 'profile-1',
  label: 'Team server',
  apiBaseUrl: 'https://propr.example.test',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

const bridgeFixture = () => {
  let profiles = [storedProfile];
  let activeProfileId: string | null = null;
  const pair = vi.fn(async () => ({ paired: true as const }));
  const probe = vi.fn(async () => ({
    status: 'ready' as const,
    version: '0.8.15',
    activationTicket: 'ticket-7',
  }));
  const activate = vi.fn(async () => ({
    status: 'ready' as const,
    profileId: storedProfile.id,
    transportScope: 'scope-7',
  }));
  const bridge: DesktopBridge = {
    app: {
      getMetadata: async () => ({
        name: 'ProPR Desktop', version: '0.8.15', platform: 'linux', arch: 'x64', packaged: true,
      }),
      onDeepLink: () => () => undefined,
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
    authentication: { pair, cancel: vi.fn(async () => undefined) },
    connection: { probe, activate, invalidate: vi.fn(async () => ({ invalidated: false })) },
    lifecycle: {
      status: async () => ({ state: 'disconnected' }),
      start: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      stop: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      restart: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
    },
  };
  return { bridge, pair, probe, activate, profiles: () => profiles };
};

describe('Electron remote instance adapters', () => {
  it('uses status-only main-process pairing and probe APIs', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];

    await adapters.authentication.authenticate(profile);
    const result = await adapters.connection.probe(profile);
    expect(fixture.pair).toHaveBeenCalledWith({
      id: profile.id,
      label: profile.name,
      apiBaseUrl: profile.baseUrl,
    });
    expect(result).toEqual({ status: 'ready', version: '0.8.15', activationTicket: 'ticket-7' });
    expect('credentials' in fixture.bridge).toBe(false);

    if (result.status !== 'ready') return;
    const activated = await adapters.connection.activate?.(profile, result);
    expect(fixture.activate).toHaveBeenCalledWith('ticket-7');
    expect(activated).toEqual({
      status: 'ready',
      version: '0.8.15',
      authentication: undefined,
      profileId: profile.id,
      transportScope: 'scope-7',
    });
    if (activated?.status === 'ready') adapters.connection.publishActivation?.(profile, activated);
    expect(setDesktopConnectionScope).toHaveBeenCalledWith({
      bridge: fixture.bridge,
      profileId: storedProfile.id,
      transportScope: 'scope-7',
    }, profile.baseUrl);
  });

  it('rejects a main-bound profile mismatch without publishing the returned scope', async () => {
    const fixture = bridgeFixture();
    fixture.activate.mockResolvedValueOnce({
      status: 'ready',
      profileId: 'profile-2',
      transportScope: 'wrong-profile-scope',
    });
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];
    const probe = await adapters.connection.probe(profile);
    if (probe.status !== 'ready') return;

    const activated = await adapters.connection.activate?.(profile, probe);

    expect(activated).toEqual(expect.objectContaining({
      status: 'authentication-required',
      message: expect.stringMatching(/connection changed/i),
    }));
    expect(setDesktopConnectionScope).toHaveBeenCalledWith(null);
    expect(setDesktopConnectionScope).not.toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-2',
    }), expect.anything());
  });

  it('clears renderer storage after a successful same-origin profile switch', async () => {
    const fixture = bridgeFixture();
    await fixture.bridge.profiles.setActive('profile-a');
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];
    window.localStorage.setItem('profile-state', 'from-profile-a');
    window.sessionStorage.setItem('profile-session', 'from-profile-a');

    const activated = await adapters.connection.activate?.(profile, {
      status: 'ready',
      version: '0.8.15',
      activationTicket: 'ticket-7',
    });

    expect(activated?.status).toBe('ready');
    expect(window.localStorage.getItem('profile-state')).toBeNull();
    expect(window.sessionStorage.getItem('profile-session')).toBeNull();
  });

  it('cancels pairing and removes profiles entirely through main-process IPC', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);

    await adapters.profiles.remove('profile-1');

    expect(fixture.bridge.authentication.cancel).toHaveBeenCalledWith('profile-1');
    expect(fixture.profiles()).toEqual([]);
  });

  it('clears renderer state before probing an edited profile origin', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    window.localStorage.setItem('profile-state', 'A');
    window.sessionStorage.setItem('profile-session', 'A');

    await adapters.connection.probe({
      ...fromProfile(storedProfile),
      baseUrl: 'https://attacker.example.test',
    });

    expect(window.localStorage.getItem('profile-state')).toBeNull();
    expect(window.sessionStorage.getItem('profile-session')).toBeNull();
    expect(setDesktopConnectionScope).toHaveBeenCalledWith(null);
  });
});

const fromProfile = (profile: StoredProfile) => ({
  id: profile.id,
  name: profile.label,
  baseUrl: profile.apiBaseUrl,
  kind: 'remote' as const,
});
