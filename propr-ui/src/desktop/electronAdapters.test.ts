import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CredentialReadResult,
  DesktopBridge,
  DesktopProfile as StoredProfile,
} from '../../../apps/desktop/src/shared/contract';
import { createElectronDesktopAdapters } from './electronAdapters';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const discovery = {
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  desktopAuthentication: {
    protocolVersion: 1,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};

const storedProfile: StoredProfile = {
  id: 'profile-1',
  label: 'Team server',
  apiBaseUrl: 'https://propr.example.test',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

const bridgeFixture = () => {
  let token: string | null = null;
  let profiles = [storedProfile];
  let activeProfileId: string | null = null;
  const opened: string[] = [];
  const removedCredentials: string[] = [];
  const bridge: DesktopBridge = {
    app: {
      getMetadata: async () => ({
        name: 'ProPR Desktop', version: '0.8.15', platform: 'linux', arch: 'x64', packaged: true,
      }),
      onDeepLink: () => () => undefined,
    },
    auth: { logout: async () => undefined },
    external: { open: async url => { opened.push(url); } },
    storage: { security: async () => ({ available: true, backend: 'keychain' }) },
    profiles: {
      list: async () => ({ profiles, activeProfileId }),
      save: async input => {
        const saved = { ...storedProfile, id: input.id ?? 'new', label: input.label, apiBaseUrl: input.apiBaseUrl };
        profiles = [...profiles.filter(profile => profile.id !== saved.id), saved];
        return saved;
      },
      remove: async profileId => { profiles = profiles.filter(profile => profile.id !== profileId); token = null; },
      setActive: async profileId => { activeProfileId = profileId; },
    },
    credentials: {
      read: async (): Promise<CredentialReadResult> => ({ available: true, value: token }),
      write: async (_profileId, value) => { token = value; return { stored: true }; },
      remove: async profileId => { removedCredentials.push(profileId); token = null; },
    },
    lifecycle: {
      status: async () => ({ state: 'disconnected' }),
      start: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      stop: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
      restart: async () => ({ ok: false, code: 'not-implemented', status: { state: 'disconnected' } }),
    },
  };
  return { bridge, opened, removedCredentials, token: () => token, profiles: () => profiles };
};

describe('Electron remote instance adapters', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('pairs in the system browser, stores only through secure storage, and reconnects after restart', async () => {
    const fixture = bridgeFixture();
    const requests: Array<{ url: string; authorization: string | null; credentials?: RequestCredentials }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('Authorization'),
        credentials: init?.credentials,
      });
      if (url.endsWith('/api/desktop/pairings')) return json({
        pairingId: `dpr_${'A'.repeat(22)}`,
        deviceSecret: 'B'.repeat(43),
        approvalUrl: 'https://propr.example.test/approve',
        expiresAt: '2030-01-01T00:00:00.000Z',
        interval: 1,
      }, 201);
      if (url.endsWith('/poll')) return json({
        status: 'complete', token: `propr_it_${'C'.repeat(43)}`, tokenType: 'Bearer', expiresAt: null,
      });
      if (url.endsWith('/api/desktop/discovery')) return json(discovery);
      if (url.endsWith('/api/auth/user')) return json({ username: 'octocat' });
      return new Response(null, { status: 204 });
    });
    const adapters = createElectronDesktopAdapters(fixture.bridge, {
      fetch: fetch as typeof globalThis.fetch,
      pairingSleep: async () => undefined,
      now: () => Date.parse('2029-01-01T00:00:00.000Z'),
    });
    const profile = (await adapters.profiles.list())[0];

    await adapters.authentication.authenticate(profile);
    expect(fixture.opened).toEqual(['https://propr.example.test/approve']);
    expect(fixture.token()).toBe(`propr_it_${'C'.repeat(43)}`);
    expect(JSON.stringify(await adapters.profiles.list())).not.toContain('propr_it_');
    expect(requests.every(request => !request.url.includes('propr_it_'))).toBe(true);

    const restarted = createElectronDesktopAdapters(fixture.bridge, { fetch: fetch as typeof globalThis.fetch });
    expect(await restarted.connection.probe(profile)).toMatchObject({
      status: 'ready',
      version: '0.8.15',
    });
    expect(requests.at(-1)).toMatchObject({
      authorization: `Bearer propr_it_${'C'.repeat(43)}`,
      credentials: 'omit',
    });
  });

  it('surfaces revoked access, clears the credential, and removes a profile locally', async () => {
    const fixture = bridgeFixture();
    await fixture.bridge.credentials.write('profile-1', 'propr_it_revoked');
    const fetch = vi.fn(async (input: RequestInfo | URL) => input.toString().endsWith('/api/desktop/discovery')
      ? json(discovery)
      : json({ code: 'INVALID_INSTANCE_TOKEN' }, 401));
    const adapters = createElectronDesktopAdapters(fixture.bridge, { fetch: fetch as typeof globalThis.fetch });
    const profile = (await adapters.profiles.list())[0];

    expect(await adapters.connection.probe(profile)).toMatchObject({
      status: 'authentication-required',
      message: expect.stringMatching(/revoked or expired/i),
    });
    expect(fixture.removedCredentials).toEqual(['profile-1']);

    await fixture.bridge.credentials.write('profile-1', 'propr_it_revoke-me');
    await adapters.profiles.remove('profile-1');
    expect(fixture.profiles()).toEqual([]);
    expect(fixture.token()).toBeNull();
  });
});
