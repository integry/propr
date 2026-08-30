import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  const discard = vi.fn(async () => ({ discarded: true }));
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
    connection: { probe, activate, discard, invalidate: vi.fn(async () => ({ invalidated: false })) },
    lifecycle: {
      status: async () => ({ state: 'disconnected' }),
      start: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      stop: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      restart: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
    },
  };
  return { bridge, pair, probe, activate, discard, profiles: () => profiles };
};

describe('Electron remote instance adapters', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    setDesktopConnectionScope.mockClear();
  });
  it('uses status-only main-process pairing and probe APIs', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];
    window.localStorage.setItem('profile-state', 'A');
    window.sessionStorage.setItem('profile-session', 'A');

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
    window.localStorage.setItem('profile-state', 'A');
    window.sessionStorage.setItem('profile-session', 'A');
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
    expect(window.localStorage.getItem('profile-state')).toBe('A');
    expect(window.sessionStorage.getItem('profile-session')).toBe('A');
    expect(fixture.discard).toHaveBeenCalledWith({
      profileId: 'profile-2', transportScope: 'wrong-profile-scope',
    });
  });

  it('clears renderer storage after a successful same-origin profile switch', async () => {
    const fixture = bridgeFixture();
    await fixture.bridge.profiles.save({
      id: 'profile-a', label: 'Profile A', apiBaseUrl: storedProfile.apiBaseUrl,
    });
    await fixture.bridge.profiles.setActive('profile-a');
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];
    window.localStorage.setItem('profile-state', 'profile-a-local-sentinel');
    window.sessionStorage.setItem('profile-session', 'profile-a-session-sentinel');
    const clear = vi.spyOn(Storage.prototype, 'clear');

    const activated = await adapters.connection.activate?.(profile, {
      status: 'ready',
      version: '0.8.15',
      activationTicket: 'ticket-7',
    });

    expect(activated?.status).toBe('ready');
    expect(window.localStorage.getItem('profile-state')).toBeNull();
    expect(window.sessionStorage.getItem('profile-session')).toBeNull();
    expect(clear).toHaveBeenCalledTimes(2);
    if (activated?.status === 'ready') adapters.connection.publishActivation?.(profile, activated);
    expect(clear.mock.invocationCallOrder.at(-1)).toBeLessThan(setDesktopConnectionScope.mock.invocationCallOrder[0]);
    clear.mockRestore();
  });

  it('cancels pairing and removes profiles entirely through main-process IPC', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);

    await adapters.profiles.remove('profile-1');

    expect(fixture.bridge.authentication.cancel).toHaveBeenCalledWith('profile-1');
    expect(fixture.profiles()).toEqual([]);
  });

  it('leaves renderer state untouched while probing an edited profile origin', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    window.localStorage.setItem('profile-state', 'A');
    window.sessionStorage.setItem('profile-session', 'A');

    await adapters.connection.probe({
      ...fromProfile(storedProfile),
      baseUrl: 'https://attacker.example.test',
    });

    expect(window.localStorage.getItem('profile-state')).toBe('A');
    expect(window.sessionStorage.getItem('profile-session')).toBe('A');
    expect(setDesktopConnectionScope).not.toHaveBeenCalled();
  });

  it('leaves renderer state untouched when an origin edit save or pairing fails', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const edited = { ...fromProfile(storedProfile), baseUrl: 'https://edited.example.test' };
    window.localStorage.setItem('profile-state', 'A-local');
    window.sessionStorage.setItem('profile-session', 'A-session');
    vi.spyOn(fixture.bridge.profiles, 'save').mockRejectedValueOnce(new Error('save failed'));
    await expect(adapters.profiles.save(edited)).rejects.toThrow('save failed');
    fixture.pair.mockRejectedValueOnce(new Error('pairing cancelled'));
    await expect(adapters.authentication.authenticate(edited)).rejects.toThrow('pairing cancelled');
    expect(window.localStorage.getItem('profile-state')).toBe('A-local');
    expect(window.sessionStorage.getItem('profile-session')).toBe('A-session');
  });

  it('does not clear on thrown or stale activation and discards only a stale main result', async () => {
    const fixture = bridgeFixture();
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];
    window.localStorage.setItem('profile-state', 'A');
    window.sessionStorage.setItem('profile-session', 'A');
    fixture.activate.mockRejectedValueOnce(new Error('activation failed'));

    await expect(adapters.connection.activate?.(profile, {
      status: 'ready', activationTicket: 'ticket-throw',
    })).rejects.toThrow('activation failed');
    expect(window.localStorage.getItem('profile-state')).toBe('A');
    expect(window.sessionStorage.getItem('profile-session')).toBe('A');

    fixture.activate.mockResolvedValueOnce({
      status: 'ready', profileId: profile.id, transportScope: 'stale-scope',
    });
    const stale = await adapters.connection.activate?.(profile, {
      status: 'ready', activationTicket: 'ticket-stale',
    }, () => false);
    expect(stale?.status).toBe('authentication-required');
    expect(window.localStorage.getItem('profile-state')).toBe('A');
    expect(window.sessionStorage.getItem('profile-session')).toBe('A');
    expect(fixture.discard).toHaveBeenCalledWith({ profileId: profile.id, transportScope: 'stale-scope' });
  });

  it('publishes no B scope and restores sentinels when storage clearing fails', async () => {
    const fixture = bridgeFixture();
    await fixture.bridge.profiles.setActive('profile-a');
    const adapters = createElectronDesktopAdapters(fixture.bridge);
    const profile = (await adapters.profiles.list())[0];
    window.localStorage.setItem('profile-state', 'A-local');
    window.sessionStorage.setItem('profile-session', 'A-session');
    const clear = vi.spyOn(Storage.prototype, 'clear').mockImplementationOnce(() => {
      throw new Error('storage disabled');
    });

    const activated = await adapters.connection.activate?.(profile, {
      status: 'ready', activationTicket: 'ticket-7',
    });

    expect(activated).toEqual({
      status: 'offline',
      message: 'Desktop storage isolation failed. Restart ProPR Desktop before connecting again.',
    });
    expect(window.localStorage.getItem('profile-state')).toBe('A-local');
    expect(window.sessionStorage.getItem('profile-session')).toBe('A-session');
    expect(fixture.discard).toHaveBeenCalledWith({ profileId: profile.id, transportScope: 'scope-7' });
    expect(setDesktopConnectionScope).toHaveBeenCalledWith(null);
    expect(setDesktopConnectionScope).not.toHaveBeenCalledWith(expect.objectContaining({
      transportScope: 'scope-7',
    }), expect.anything());
    clear.mockRestore();
  });
});

const fromProfile = (profile: StoredProfile) => ({
  id: profile.id,
  name: profile.label,
  baseUrl: profile.apiBaseUrl,
  kind: 'remote' as const,
});
