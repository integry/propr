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
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};
const transportHeaders = (transportScope: string, headers: Record<string, string | string[]> = {}) => ({
  ...headers,
  'X-ProPR-Desktop-Transport-Scope': transportScope,
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
    if (result.status !== 'ready') return;
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/tasks', transportHeaders(result.transportScope, {
      Cookie: 'legacy=session', Authorization: 'Bearer renderer-controlled', Accept: 'application/json',
    })).requestHeaders, {
        Accept: 'application/json',
        Authorization: `Bearer ${token('A')}`,
    });
    assert.deepEqual(service.prepareRequest('https://attacker.example.test/api/tasks', transportHeaders(result.transportScope, {
      Cookie: 'inactive=session', Authorization: 'Bearer renderer-controlled',
    })), { cancel: true });
    assert.deepEqual(service.prepareRequest('https://a.example.test/assets/app.js', transportHeaders(result.transportScope, {
      Cookie: 'active=session', Authorization: 'Bearer renderer-controlled',
    })), { cancel: true });
    assert.deepEqual(service.prepareRequest(`wss://a.example.test/socket.io/?transport=websocket&proprDesktopTransportScope=${result.transportScope}`, {
      Cookie: 'socket=session', Authorization: 'Bearer renderer-controlled',
    }, { resourceType: 'webSocket' }).requestHeaders, { Authorization: `Bearer ${token('A')}` });
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/tasks', transportHeaders(result.transportScope, {
      Cookie: 'legacy=session',
      Authorization: 'Bearer renderer-controlled',
      'X-ProPR-Desktop-Main-Request': 'renderer-forgery',
    })).requestHeaders, { Authorization: `Bearer ${token('A')}` });
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
    const readyB = await service.probe({
      id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl,
    });
    assert.equal(readyB.status, 'ready');
    if (readyB.status !== 'ready') return;

    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', transportHeaders(readyB.transportScope, {
      Cookie: 'profile-a=session', Authorization: `Bearer ${token('A')}`,
    })).requestHeaders, { Authorization: `Bearer ${token('B')}` });
  });

  it('keeps a slow successful same-origin A probe status-only after fast B activates', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const releaseA = deferred<Response>();
    const startedA = deferred<void>();
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        const authorization = new Headers(init?.headers).get('Authorization');
        if (authorization === `Bearer ${token('A')}`) {
          startedA.resolve();
          return releaseA.promise;
        }
        assert.equal(authorization, `Bearer ${token('B')}`);
        return json({ username: 'b' });
      },
    });

    const slowA = service.probe({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl });
    await startedA.promise;
    const readyB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(readyB.status, 'ready');
    if (readyB.status !== 'ready') return;
    releaseA.resolve(json({ username: 'a' }));
    const staleA = await slowA;

    assert.equal(staleA.status, 'offline');
    assert.match(staleA.message, /connection changed/i);
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/tasks',
      transportHeaders(readyB.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('B')}` });
  });

  it('binds REST and Socket.IO work to one fresh scope and rejects stale or malformed markers', async () => {
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
    const readyA = await service.probe({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl });
    assert.equal(readyA.status, 'ready');
    if (readyA.status !== 'ready') return;
    const capturedRestA = transportHeaders(readyA.transportScope, {
      Cookie: 'renderer=session',
      Authorization: 'Bearer renderer',
    });
    const capturedSocketA = `wss://same.example.test/socket.io/?EIO=4&transport=websocket&proprDesktopTransportScope=${readyA.transportScope}`;

    const readyB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(readyB.status, 'ready');
    if (readyB.status !== 'ready') return;

    assert.deepEqual(service.prepareRequest('https://same.example.test/api/side-effect', capturedRestA), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/planner/drafts/draft-a/attachments/image-a', capturedRestA,
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest(capturedSocketA, { Cookie: 'socket=a' }, { resourceType: 'webSocket' }), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/side-effect',
      transportHeaders(readyB.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('B')}` });
    const currentSocket = `wss://same.example.test/socket.io/?EIO=4&transport=websocket&proprDesktopTransportScope=${readyB.transportScope}`;
    assert.equal(service.prepareRequest(currentSocket, {}, { resourceType: 'webSocket' }).cancel, undefined);
    assert.equal(service.prepareRequest(currentSocket, {}, { resourceType: 'webSocket' }).cancel, undefined);
    assert.deepEqual(service.prepareRequest('wss://same.example.test/socket.io/?transport=websocket', {}, {
      resourceType: 'webSocket',
    }), { cancel: true });
    assert.deepEqual(service.prepareRequest(`${currentSocket}&proprDesktopTransportScope=${readyB.transportScope}`, {}, {
      resourceType: 'webSocket',
    }), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/tasks',
      { 'X-ProPR-Desktop-Transport-Scope': ['bad', readyB.transportScope], Cookie: 'x', Authorization: 'Bearer x' },
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/tasks',
      { 'X-ProPR-Desktop-Transport-Scope': 'not-a-scope', Cookie: 'x', Authorization: 'Bearer x' },
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', {
      Cookie: 'x', Authorization: 'Bearer x', Accept: 'application/json',
    }).requestHeaders, { Accept: 'application/json' });
    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', transportHeaders(readyB.transportScope, {
      Cookie: 'x', Authorization: 'Bearer x',
      'Access-Control-Request-Headers': 'x-propr-desktop-transport-scope,content-type',
    }), { method: 'OPTIONS' }).requestHeaders, {
      'Access-Control-Request-Headers': 'x-propr-desktop-transport-scope,content-type',
    });
  });

  it('rotates scope on every same-profile reprobe and rejects a cold reconnect from the old activation', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'http://localhost:3000' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });
    const first = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    const second = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    if (first.status !== 'ready' || second.status !== 'ready') return;
    assert.notEqual(first.transportScope, second.transportScope);
    assert.match(first.transportScope, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(service.prepareRequest(
      'http://localhost:3000/api/tasks', transportHeaders(first.transportScope),
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      `ws://localhost:3000/socket.io/?transport=websocket&proprDesktopTransportScope=${first.transportScope}`,
      {}, { resourceType: 'webSocket' },
    ), { cancel: true });
    assert.equal(service.prepareRequest(
      `ws://localhost:3000/socket.io/?transport=websocket&proprDesktopTransportScope=${second.transportScope}`,
      {}, { resourceType: 'webSocket' },
    ).requestHeaders?.Authorization, `Bearer ${token('A')}`);
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

  it('preserves a re-paired credential and current connection after a stale definitive probe response', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const oldCredential = credential(profile.id, profile.apiBaseUrl, 'A');
    const replacement = credential(profile.id, profile.apiBaseUrl, 'B');
    await store.writeCredential(oldCredential);
    const oldProbeResponse = deferred<Response>();
    const oldProbePending = deferred<void>();
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        const authorization = new Headers(init?.headers).get('Authorization');
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'C'.repeat(43),
          approvalUrl: 'https://a.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: replacement.token, tokenType: 'Bearer', expiresAt: null });
        }
        if (url.endsWith('/api/auth/user') && authorization === `Bearer ${oldCredential.token}`) {
          oldProbePending.resolve();
          return oldProbeResponse.promise;
        }
        if (url.endsWith('/api/auth/user') && authorization === `Bearer ${replacement.token}`) {
          return json({ username: 'replacement' });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const staleProbe = service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    await oldProbePending.promise;
    await service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    const current = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(current.status, 'ready');

    oldProbeResponse.resolve(json({ code: 'INVALID_INSTANCE_TOKEN' }, 401));
    const staleResult = await staleProbe;

    assert.equal(staleResult.status, 'offline');
    assert.match(staleResult.message, /connection changed.*try again/i);
    assert.deepEqual(await store.readCredential(profile.id), replacement);
    if (current.status !== 'ready') return;
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/tasks', transportHeaders(current.transportScope, {})).requestHeaders, {
      Authorization: `Bearer ${replacement.token}`,
    });
  });

  it('preserves a replacement credential at a changed origin after a stale definitive probe response', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const oldCredential = credential(profile.id, profile.apiBaseUrl, 'A');
    const replacement = credential(profile.id, 'https://b.example.test', 'B');
    await store.writeCredential(oldCredential);
    const oldProbeResponse = deferred<Response>();
    const oldProbePending = deferred<void>();
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        const authorization = new Headers(init?.headers).get('Authorization');
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url === 'https://a.example.test/api/desktop/tokens/current') return new Response(null, { status: 204 });
        if (url.endsWith('/api/auth/user') && authorization === `Bearer ${oldCredential.token}`) {
          oldProbePending.resolve();
          return oldProbeResponse.promise;
        }
        if (url === 'https://b.example.test/api/auth/user'
          && authorization === `Bearer ${replacement.token}`) return json({ username: 'replacement' });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const staleProbe = service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    await oldProbePending.promise;
    const changed = await service.saveProfile({
      id: profile.id,
      label: profile.label,
      apiBaseUrl: replacement.origin,
    });
    await store.writeCredential(replacement);
    const current = await service.probe({ id: changed.id, label: changed.label, apiBaseUrl: changed.apiBaseUrl });
    assert.equal(current.status, 'ready');

    oldProbeResponse.resolve(json({ code: 'INVALID_INSTANCE_TOKEN' }, 401));
    const staleResult = await staleProbe;

    assert.equal(staleResult.status, 'offline');
    assert.match(staleResult.message, /connection changed.*try again/i);
    assert.deepEqual(await store.readCredential(profile.id), replacement);
    if (current.status !== 'ready') return;
    assert.deepEqual(service.prepareRequest('https://b.example.test/api/tasks', transportHeaders(current.transportScope, {})).requestHeaders, {
      Authorization: `Bearer ${replacement.token}`,
    });
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
      transportScope: readyA.transportScope,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: false });
    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      transportScope: readyB.transportScope,
      code: 'AUTHORIZATION_CHANGED',
    }), { invalidated: false });
    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      transportScope: readyB.transportScope,
      code: 'AUTHENTICATION_FAILED',
    }), { invalidated: false });
    assert.ok(await store.readCredential(profileA.id));
    assert.ok(await store.readCredential(profileB.id));

    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      transportScope: readyB.transportScope,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: true });
    assert.ok(await store.readCredential(profileA.id));
    assert.equal(await store.readCredential(profileB.id), null);
  });

  it('preserves a replacement written while an old transient token revocation is pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
    temporaryDirectories.push(directory);
    let service!: DesktopCredentialService;
    let cancelOldPairingOnWrite = true;
    const cancellingEncryption: EncryptionProvider = {
      ...encryption,
      encrypt: value => {
        const stored = JSON.parse(value) as StoredCredential;
        if (cancelOldPairingOnWrite && stored.token === token('C')) {
          cancelOldPairingOnWrite = false;
          service.cancelPairing(stored.profileId);
        }
        return Buffer.from(value, 'utf8');
      },
    };
    const store = new ProfileStore(directory, cancellingEncryption);
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const revocationStarted = deferred<void>();
    const releaseRevocation = deferred<Response>();
    let pairingNumber = 0;
    let currentPairing = 0;
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/pairings')) {
          currentPairing = ++pairingNumber;
          return json({
            pairingId: `dpr_${String.fromCharCode(64 + currentPairing).repeat(22)}`,
            deviceSecret: String.fromCharCode(66 + currentPairing).repeat(43),
            approvalUrl: 'https://a.example.test/approve',
            expiresAt: new Date(pairingNow + 10_000).toISOString(),
            interval: 1,
          }, 201);
        }
        if (url.endsWith('/poll')) {
          const character = currentPairing === 1 ? 'C' : 'D';
          return json({ status: 'complete', token: token(character), tokenType: 'Bearer', expiresAt: null });
        }
        if (url.endsWith('/api/desktop/tokens/current')) {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token('C')}`);
          revocationStarted.resolve();
          return releaseRevocation.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const oldPairing = assert.rejects(
      service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl }),
      /cancelled/i,
    );
    await revocationStarted.promise;
    await service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    releaseRevocation.resolve(new Response(null, { status: 204 }));
    await oldPairing;

    assert.deepEqual(await store.readCredential(profile.id), credential(profile.id, profile.apiBaseUrl, 'D'));
  });

  it('deletes an exactly persisted cancelled pairing token even when revocation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
    temporaryDirectories.push(directory);
    let service!: DesktopCredentialService;
    const cancellingEncryption: EncryptionProvider = {
      ...encryption,
      encrypt: value => {
        const stored = JSON.parse(value) as StoredCredential;
        if (stored.token === token('C')) service.cancelPairing(stored.profileId);
        return Buffer.from(value, 'utf8');
      },
    };
    const store = new ProfileStore(directory, cancellingEncryption);
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async input => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: 'https://a.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: token('C'), tokenType: 'Bearer', expiresAt: null });
        }
        if (url.endsWith('/api/desktop/tokens/current')) return json({ error: 'unavailable' }, 500);
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await assert.rejects(
      service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl }),
      /cancelled/i,
    );
    assert.equal(await store.readCredential(profile.id), null);
  });

  it('detaches a removed profile locally before deferred revoke and preserves a later replacement', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const revocationStarted = deferred<void>();
    const releaseRevocation = deferred<Response>();
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/tokens/current')) {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token('A')}`);
          revocationStarted.resolve();
          return releaseRevocation.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const removal = service.removeProfile(profile.id);
    await revocationStarted.promise;
    assert.equal((await store.list()).profiles.some(item => item.id === profile.id), false);
    assert.equal(await store.readCredential(profile.id), null);

    const replacementProfile = await service.saveProfile({
      id: profile.id,
      label: 'Replacement',
      apiBaseUrl: profile.apiBaseUrl,
    });
    const replacementCredential = credential(profile.id, profile.apiBaseUrl, 'B');
    await store.writeCredential(replacementCredential);
    releaseRevocation.resolve(new Response(null, { status: 204 }));
    await removal;

    assert.equal((await store.list()).profiles.find(item => item.id === profile.id)?.label, replacementProfile.label);
    assert.deepEqual(await store.readCredential(profile.id), replacementCredential);
  });

  it('returns connection-changed and preserves a re-paired credential for an old ready invalidation', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const oldCredential = credential(profile.id, profile.apiBaseUrl, 'A');
    const replacement = credential(profile.id, profile.apiBaseUrl, 'B');
    await store.writeCredential(oldCredential);
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    const service = new DesktopCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url.endsWith('/api/auth/user')) {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${oldCredential.token}`);
          return json({ username: 'old-user' });
        }
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'C'.repeat(43),
          approvalUrl: 'https://a.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: replacement.token, tokenType: 'Bearer', expiresAt: null });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const ready = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;

    await service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.deepEqual(await service.invalidate({
      profileId: profile.id,
      transportScope: ready.transportScope,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: false });

    assert.deepEqual(await store.readCredential(profile.id), replacement);
  });

  for (const race of ['delete', 'switch'] as const) {
    it(`revokes a transient completion instead of persisting when pairing races with ${race}`, async () => {
      const store = await createStore();
      const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
      const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
      let service!: DesktopCredentialService;
      let raced = false;
      let raceOperation: Promise<unknown> = Promise.resolve();
      const revocations: string[] = [];
      const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
      let listCalls = 0;
      const profiles = {
        list: async () => {
          const result = await store.list();
          listCalls += 1;
          if (listCalls === 2 && !raced) {
            raced = true;
            raceOperation = race === 'delete'
              ? service.removeProfile(profileA.id)
              : service.setActiveProfile(profileB.id);
          }
          return result;
        },
        save: (input: Parameters<ProfileStore['save']>[0]) => store.save(input),
        detachProfile: (profileId: string) => store.detachProfile(profileId),
        setActive: (profileId: string | null) => store.setActive(profileId),
        security: () => store.security(),
        readCredential: (profileId: string) => store.readCredential(profileId),
        writeCredential: (value: StoredCredential) => store.writeCredential(value),
        removeCredential: (profileId: string) => store.removeCredential(profileId),
        removeCredentialIfCurrent: (...args: Parameters<ProfileStore['removeCredentialIfCurrent']>) =>
          store.removeCredentialIfCurrent(...args),
      };
      service = new DesktopCredentialService({
        profiles,
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
