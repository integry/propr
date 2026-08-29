import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { DesktopCredentialService } from './credential-service';
import { ProfileStore, type EncryptionProvider, type StoredCredential } from './profile-store';

const temporaryDirectories: string[] = [];
const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(value, 'utf8'),
  decrypt: value => value.toString('utf8'),
};
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
    protocolVersion: 1 as const,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};
const token = (character: string) => `propr_it_${character.repeat(43)}`;
const credential = (profileId: string, origin: string, character: string): StoredCredential => ({
  version: 1,
  profileId,
  origin,
  token: token(character),
});

const createStore = async (): Promise<ProfileStore> => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
  temporaryDirectories.push(directory);
  return new ProfileStore(directory, encryption);
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('main-process desktop credential service', () => {
  it('injects the active bearer only for its bound profile origin and strips renderer identity', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const wireRequests: Array<{ url: string; headers: Record<string, string | string[]> }> = [];
    let service!: DesktopCredentialService;
    service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        const requestHeaders: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => { requestHeaders[key] = value; });
        // Simulate a session cookie Electron might otherwise append after the
        // main-process fetch has applied its unforgeable request marker.
        requestHeaders.Cookie = 'main-process=session';
        const decision = service.prepareRequest(url, requestHeaders);
        assert.equal(decision.cancel, undefined);
        wireRequests.push({ url, headers: decision.requestHeaders ?? {} });
        return url.endsWith('/api/desktop/discovery') ? json(discovery) : json({ username: 'octocat' });
      },
    });

    const result = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(result.status, 'ready');
    assert.deepEqual(service.authorizeRequest('https://a.example.test/api/tasks', {
      Cookie: 'legacy=session', Authorization: 'Bearer renderer-controlled', Accept: 'application/json',
    }), {
      Accept: 'application/json',
      Authorization: `Bearer ${token('A')}`,
    });
    assert.deepEqual(service.authorizeRequest('https://attacker.example.test/api/tasks', {
      Cookie: 'inactive=session', Authorization: 'Bearer renderer-controlled',
    }), {});
    assert.deepEqual(service.authorizeRequest('https://a.example.test/assets/app.js', {
      Cookie: 'active=session', Authorization: 'Bearer renderer-controlled',
    }), {});
    assert.deepEqual(service.authorizeRequest('wss://a.example.test/socket.io/?transport=websocket', {
      Cookie: 'socket=session', Authorization: 'Bearer renderer-controlled',
    }), { Authorization: `Bearer ${token('A')}` });
    assert.deepEqual(service.authorizeRequest('https://a.example.test/api/tasks', {
      Cookie: 'legacy=session',
      Authorization: 'Bearer renderer-controlled',
      'X-ProPR-Desktop-Main-Request': 'renderer-forgery',
    }), { Authorization: `Bearer ${token('A')}` });
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/desktop/pairings', {}), {
      cancel: true,
    });
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/desktop/tokens/current', {}), {
      cancel: true,
    });
    assert.deepEqual(wireRequests.at(-1), {
      url: 'https://a.example.test/api/auth/user',
      headers: { authorization: `Bearer ${token('A')}` },
    });
    assert.deepEqual(service.sanitizeResponseHeaders('https://a.example.test/api/tasks', {
      'Set-Cookie': ['active=session'], 'X-Test': ['preserved'],
    }), { 'X-Test': ['preserved'] });
    assert.deepEqual(service.sanitizeResponseHeaders('https://inactive.example.test/api/tasks', {
      'set-cookie': ['inactive=session'],
    }), {});
    assert.deepEqual(service.sanitizeResponseHeaders('wss://inactive.example.test/socket.io/', {
      'SET-COOKIE': ['socket=session'],
    }), {});
  });

  it('uses only the active bearer when profiles share an origin and never a cookie identity', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });

    assert.equal((await service.probe({
      id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl,
    })).status, 'ready');
    assert.equal((await service.probe({
      id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl,
    })).status, 'ready');

    assert.deepEqual(service.authorizeRequest('https://same.example.test/api/tasks', {
      Cookie: 'profile-a=session', Authorization: `Bearer ${token('A')}`,
    }), { Authorization: `Bearer ${token('B')}` });
  });

  it('never sends an A-origin bearer after the profile URL is edited to an attacker origin', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        return new Response(null, { status: 204 });
      },
    });

    const result = await service.probe({
      id: profile.id,
      label: profile.label,
      apiBaseUrl: 'https://attacker.example.test',
    });

    assert.equal(result.status, 'authentication-required');
    assert.equal(requests.filter(request => request.url.startsWith('https://attacker.example.test'))
      .every(request => request.authorization === null), true);
    assert.equal(requests.some(request => request.url === 'https://a.example.test/api/desktop/tokens/current'
      && request.authorization === `Bearer ${token('A')}`), true);
    assert.equal(await store.readCredential(profile.id), null);
  });

  it('ignores delayed A invalidation after B connects and preserves tokens for authorization/transient codes', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });
    const readyA = await service.probe({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl });
    const readyB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(readyA.status, 'ready');
    assert.equal(readyB.status, 'ready');
    if (readyA.status !== 'ready' || readyB.status !== 'ready') return;

    assert.deepEqual(await service.invalidate({
      profileId: profileA.id,
      connectionGeneration: readyA.connectionGeneration,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: false });
    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      connectionGeneration: readyB.connectionGeneration,
      code: 'AUTHORIZATION_CHANGED',
    }), { invalidated: false });
    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      connectionGeneration: readyB.connectionGeneration,
      code: 'AUTHENTICATION_FAILED',
    }), { invalidated: false });
    assert.ok(await store.readCredential(profileA.id));
    assert.ok(await store.readCredential(profileB.id));

    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      connectionGeneration: readyB.connectionGeneration,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: true });
    assert.ok(await store.readCredential(profileA.id));
    assert.equal(await store.readCredential(profileB.id), null);
  });

  for (const race of ['delete', 'switch'] as const) {
    it(`revokes a transient completion instead of persisting when pairing races with ${race}`, async () => {
      const store = await createStore();
      const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
      const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
      let service!: DesktopCredentialService;
      let raced = false;
      let raceOperation: Promise<void> = Promise.resolve();
      const revocations: string[] = [];
      const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
      service = new DesktopCredentialService({
        profiles: store,
        clientName: 'Test desktop',
        pairingTiming: {
          now: () => pairingNow,
          sleep: async () => undefined,
        },
        openExternal: async () => undefined,
        fetch: async (input, init) => {
          const url = input.toString();
          if (url.endsWith('/api/desktop/pairings')) return json({
            pairingId: `dpr_${'A'.repeat(22)}`,
            deviceSecret: 'B'.repeat(43),
            approvalUrl: 'https://a.example.test/approve',
            expiresAt: new Date(pairingNow + 10_000).toISOString(),
            interval: 1,
          }, 201);
          if (url.endsWith('/poll')) {
            if (!raced) {
              raced = true;
              queueMicrotask(() => {
                raceOperation = race === 'delete'
                  ? service.removeProfile(profileA.id)
                  : service.setActiveProfile(profileB.id);
              });
            }
            return json({ status: 'complete', token: token('C'), tokenType: 'Bearer', expiresAt: null });
          }
          if (url.endsWith('/api/desktop/tokens/current')) {
            revocations.push(new Headers(init?.headers).get('Authorization') ?? '');
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
      });

      await assert.rejects(
        service.pair({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl }),
        /cancelled/i,
      );
      await raceOperation;
      assert.equal(await store.readCredential(profileA.id), null);
      assert.deepEqual(revocations, [`Bearer ${token('C')}`]);
    });
  }
});
