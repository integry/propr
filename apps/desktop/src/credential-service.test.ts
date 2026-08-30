import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_REVOCATION_BINDING_HEADER,
  DESKTOP_TOKEN_REVOCATION_ENDPOINT,
  DESKTOP_TOKEN_REVOCATION_SCHEMA,
  DESKTOP_TOKEN_REVOCATION_VERSION,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import { DesktopCredentialService } from './credential-service';
import { ProfileStore, type EncryptionProvider, type StoredCredential } from './profile-store';

const temporaryDirectories: string[] = [];
const credentialServices: DesktopCredentialService[] = [];
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
const terminalRevocationBody = (
  init: RequestInit | undefined,
  code: 'TOKEN_NOT_FOUND' | 'INSTANCE_TOKEN_REVOKED' | 'INSTANCE_TOKEN_EXPIRED' = 'TOKEN_NOT_FOUND',
): Record<string, unknown> => ({
  schema: DESKTOP_TOKEN_REVOCATION_SCHEMA,
  version: DESKTOP_TOKEN_REVOCATION_VERSION,
  endpoint: DESKTOP_TOKEN_REVOCATION_ENDPOINT,
  terminal: true,
  code,
  credentialGeneration: new Headers(init?.headers).get(DESKTOP_REVOCATION_BINDING_HEADER),
});
const terminalRevocation = (
  init: RequestInit | undefined,
  code: 'TOKEN_NOT_FOUND' | 'INSTANCE_TOKEN_REVOKED' | 'INSTANCE_TOKEN_EXPIRED' = 'TOKEN_NOT_FOUND',
): Response => json(terminalRevocationBody(init, code), code === 'TOKEN_NOT_FOUND' ? 404 : 401);
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

const createCredentialService = (
  dependencies: ConstructorParameters<typeof DesktopCredentialService>[0],
): DesktopCredentialService => {
  const service = new DesktopCredentialService(dependencies);
  credentialServices.push(service);
  return service;
};

afterEach(async () => {
  await Promise.all(credentialServices.splice(0).map(service => service.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('main-process desktop credential service', () => {
  it('injects the active bearer only for its bound profile origin and strips renderer identity', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const wireRequests: Array<{ url: string; headers: Record<string, string | string[]> }> = [];
    let service!: DesktopCredentialService;
    service = createCredentialService({
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
    assert.match(result.activationTicket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal('transportScope' in result, false);
    const activated = await service.activate(result.activationTicket);
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/tasks', transportHeaders(activated.transportScope, {
      Cookie: 'legacy=session', Authorization: 'Bearer renderer-controlled', Accept: 'application/json',
    })).requestHeaders, {
        Accept: 'application/json',
        Authorization: `Bearer ${token('A')}`,
    });
    assert.deepEqual(service.prepareRequest('https://attacker.example.test/api/tasks', transportHeaders(activated.transportScope, {
      Cookie: 'inactive=session', Authorization: 'Bearer renderer-controlled',
    })), { cancel: true });
    assert.deepEqual(service.prepareRequest('https://a.example.test/assets/app.js', transportHeaders(activated.transportScope, {
      Cookie: 'active=session', Authorization: 'Bearer renderer-controlled',
    })), { cancel: true });
    assert.deepEqual(service.prepareRequest(`wss://a.example.test/socket.io/?transport=websocket&proprDesktopTransportScope=${activated.transportScope}`, {
      Cookie: 'socket=session', Authorization: 'Bearer renderer-controlled',
    }, { resourceType: 'webSocket' }).requestHeaders, { Authorization: `Bearer ${token('A')}` });
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/tasks', transportHeaders(activated.transportScope, {
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
    assert.deepEqual(service.prepareRequest('http://remote.example.test/api/tasks', {}), { cancel: true });
    assert.deepEqual(service.prepareRequest('http://127.1:3000/api/tasks', {}), { cancel: true });
    assert.deepEqual(service.prepareRequest('http://local%68ost:3000/api/tasks', {}), { cancel: true });
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
    assert.deepEqual(await service.discardActivation({
      profileId: profile.id, transportScope: 'wrong-scope',
    }), { discarded: false });
    assert.deepEqual(await service.discardActivation(activated), { discarded: true });
    assert.equal((await store.list()).activeProfileId, null);
    assert.deepEqual(await store.readCredential(profile.id), credential(profile.id, profile.apiBaseUrl, 'A'));
    assert.deepEqual(service.prepareRequest(
      profile.apiBaseUrl + '/api/tasks', transportHeaders(activated.transportScope),
    ), { cancel: true });
  });

  it('uses only the active bearer when profiles share an origin and never a cookie identity', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = createCredentialService({
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
    const activatedB = await service.activate(readyB.activationTicket);

    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', transportHeaders(activatedB.transportScope, {
      Cookie: 'profile-a=session', Authorization: `Bearer ${token('A')}`,
    })).requestHeaders, { Authorization: `Bearer ${token('B')}` });
  });

  it('detaches profile B credential A without sending any bearer request to A or minting a ticket', async () => {
    const store = await createStore();
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
    await store.writeCredential(credential(profileB.id, 'https://a.example.test', 'A'));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
        return json(discovery);
      },
    });

    const result = await service.probe({
      id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl,
    });

    assert.equal(result.status, 'authentication-required');
    assert.equal('activationTicket' in result, false);
    assert.deepEqual(requests, [{
      url: 'https://b.example.test/api/desktop/discovery',
      authorization: null,
    }]);
    assert.equal(requests.some(request => request.url.startsWith('https://a.example.test/')), false);
    assert.equal(await store.readCredential(profileB.id), null);
    assert.equal((await store.list()).activeProfileId, null);
  });

  it('does not mint a ticket when a delayed B probe observes credential replacement with origin A', async () => {
    const store = await createStore();
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const response = deferred<Response>();
    const authenticatedRequestStarted = deferred<void>();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        const authorization = new Headers(init?.headers).get('Authorization');
        requests.push({ url, authorization });
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        authenticatedRequestStarted.resolve();
        return response.promise;
      },
    });

    const probe = service.probe({
      id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl,
    });
    await authenticatedRequestStarted.promise;
    const replacement = credential(profileB.id, 'https://a.example.test', 'A');
    await store.writeCredential(replacement);
    response.resolve(json({ username: 'b' }));
    const result = await probe;

    assert.equal(result.status, 'offline');
    assert.match(result.message, /connection changed/i);
    assert.equal('activationTicket' in result, false);
    assert.equal(requests.some(request => request.url.startsWith('https://a.example.test/')), false);
    assert.deepEqual(requests.at(-1), {
      url: 'https://b.example.test/api/auth/user',
      authorization: `Bearer ${token('B')}`,
    });
    assert.deepEqual(await store.readCredential(profileB.id), replacement);
    assert.equal((await store.list()).activeProfileId, null);
  });

  it('atomically rejects a ticket when delayed activation races with profile B credential A', async () => {
    const store = await createStore();
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const activationStarted = deferred<void>();
    const releaseActivation = deferred<void>();
    const delayedProfiles = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'activateProfile') {
          return async (...args: Parameters<ProfileStore['activateProfile']>) => {
            activationStarted.resolve();
            await releaseActivation.promise;
            return target.activateProfile(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const service = createCredentialService({
      profiles: delayedProfiles,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
        return url.endsWith('/api/desktop/discovery') ? json(discovery) : json({ username: 'b' });
      },
    });
    const ready = await service.probe({
      id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl,
    });
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;

    const activation = service.activate(ready.activationTicket);
    await activationStarted.promise;
    const staleCredential = credential(profileB.id, 'https://a.example.test', 'A');
    await store.writeCredential(staleCredential);
    releaseActivation.resolve();

    await assert.rejects(activation, /expired/i);
    assert.equal(requests.some(request => request.url.startsWith('https://a.example.test/')), false);
    assert.deepEqual(await store.readCredential(profileB.id), staleCredential);
    assert.equal((await store.list()).activeProfileId, null);
  });

  it('keeps a slow successful same-origin A probe status-only after fast B activates', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const releaseA = deferred<Response>();
    const startedA = deferred<void>();
    const service = createCredentialService({
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
    const activatedB = await service.activate(readyB.activationTicket);
    releaseA.resolve(json({ username: 'a' }));
    const staleA = await slowA;

    assert.equal(staleA.status, 'offline');
    assert.match(staleA.message, /connection changed/i);
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/tasks',
      transportHeaders(activatedB.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('B')}` });
  });

  it('keeps A active while B is only probed and if B selection persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
    temporaryDirectories.push(directory);
    let failActivationState = false;
    const store = new ProfileStore(directory, encryption, {
      afterDurabilityStep: step => {
        if (failActivationState && step === 'state-fsynced') throw new Error('injected activation persistence failure');
      },
    });
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });
    const probeA = await service.probe({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl });
    assert.equal(probeA.status, 'ready');
    if (probeA.status !== 'ready') return;
    const activeA = await service.activate(probeA.activationTicket);
    const probeB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(probeB.status, 'ready');
    if (probeB.status !== 'ready') return;

    assert.equal((await store.list()).activeProfileId, profileA.id);
    assert.deepEqual(service.prepareRequest(
      profileA.apiBaseUrl + '/api/tasks', transportHeaders(activeA.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('A')}` });

    failActivationState = true;
    await assert.rejects(service.activate(probeB.activationTicket));
    failActivationState = false;
    assert.notEqual((await store.list()).activeProfileId, profileB.id);
    assert.deepEqual(service.prepareRequest(
      profileA.apiBaseUrl + '/api/tasks', transportHeaders(activeA.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('A')}` });
  });

  it('keeps B active during a direct same-origin A probe and rejects replayed activation tickets', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });
    const probeB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(probeB.status, 'ready');
    if (probeB.status !== 'ready') return;
    const activeB = await service.activate(probeB.activationTicket);
    await assert.rejects(service.activate(probeB.activationTicket), /expired/i);

    const probeA = await service.probe({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl });
    assert.equal(probeA.status, 'ready');
    assert.equal((await store.list()).activeProfileId, profileB.id);
    assert.deepEqual(service.prepareRequest(
      profileB.apiBaseUrl + '/api/tasks', transportHeaders(activeB.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('B')}` });
  });

  it('rejects activation after candidate removal, selection drift, or exact credential replacement', async () => {
    for (const race of ['remove', 'selection', 'credential', 'credential-origin'] as const) {
      const store = await createStore();
      const profileA = await store.save({ id: `profile-a-${race}`, label: 'A', apiBaseUrl: 'https://a.example.test' });
      const profileB = await store.save({ id: `profile-b-${race}`, label: 'B', apiBaseUrl: 'https://b.example.test' });
      await store.setActive(profileA.id);
      await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
      const service = createCredentialService({
        profiles: store,
        clientName: 'Test desktop',
        openExternal: async () => undefined,
        fetch: async input => input.toString().endsWith('/api/desktop/discovery')
          ? json(discovery)
          : json({ username: 'octocat' }),
      });
      const probeB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
      assert.equal(probeB.status, 'ready');
      if (probeB.status !== 'ready') continue;
      if (race === 'remove') await service.removeProfile(profileB.id);
      else if (race === 'selection') await store.setActive(null);
      else if (race === 'credential') {
        await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'C'));
      } else {
        await store.writeCredential(credential(profileB.id, profileA.apiBaseUrl, 'A'));
      }

      await assert.rejects(service.activate(probeB.activationTicket), /expired/i);
      assert.notEqual((await store.list()).activeProfileId, profileB.id);
      if (race === 'credential') {
        assert.deepEqual(await store.readCredential(profileB.id), credential(profileB.id, profileB.apiBaseUrl, 'C'));
      } else if (race === 'credential-origin') {
        assert.deepEqual(await store.readCredential(profileB.id), credential(profileB.id, profileA.apiBaseUrl, 'A'));
      }
    }
  });

  it('binds REST and Socket.IO work to one fresh scope and rejects stale or malformed markers', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://same.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://same.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = createCredentialService({
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
    const activatedA = await service.activate(readyA.activationTicket);
    const capturedRestA = transportHeaders(activatedA.transportScope, {
      Cookie: 'renderer=session',
      Authorization: 'Bearer renderer',
    });
    const capturedSocketA = `wss://same.example.test/socket.io/?EIO=4&transport=websocket&proprDesktopTransportScope=${activatedA.transportScope}`;

    const readyB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(readyB.status, 'ready');
    if (readyB.status !== 'ready') return;
    const activatedB = await service.activate(readyB.activationTicket);

    assert.deepEqual(service.prepareRequest('https://same.example.test/api/side-effect', capturedRestA), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/planner/drafts/draft-a/attachments/image-a', capturedRestA,
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest(capturedSocketA, { Cookie: 'socket=a' }, { resourceType: 'webSocket' }), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/side-effect',
      transportHeaders(activatedB.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${token('B')}` });
    const currentSocket = `wss://same.example.test/socket.io/?EIO=4&transport=websocket&proprDesktopTransportScope=${activatedB.transportScope}`;
    assert.equal(service.prepareRequest(currentSocket, {}, { resourceType: 'webSocket' }).cancel, undefined);
    assert.equal(service.prepareRequest(currentSocket, {}, { resourceType: 'webSocket' }).cancel, undefined);
    assert.deepEqual(service.prepareRequest('wss://same.example.test/socket.io/?transport=websocket', {}, {
      resourceType: 'webSocket',
    }), { cancel: true });
    assert.deepEqual(service.prepareRequest(`${currentSocket}&proprDesktopTransportScope=${activatedB.transportScope}`, {}, {
      resourceType: 'webSocket',
    }), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/tasks',
      { 'X-ProPR-Desktop-Transport-Scope': ['bad', activatedB.transportScope], Cookie: 'x', Authorization: 'Bearer x' },
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      'https://same.example.test/api/tasks',
      { 'X-ProPR-Desktop-Transport-Scope': 'not-a-scope', Cookie: 'x', Authorization: 'Bearer x' },
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', {
      Cookie: 'x', Authorization: 'Bearer x', Accept: 'application/json',
    }).requestHeaders, { Accept: 'application/json' });
    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', transportHeaders(activatedB.transportScope, {
      Cookie: 'x', Authorization: 'Bearer x',
      'Access-Control-Request-Headers': 'x-propr-desktop-transport-scope,content-type',
    }), { method: 'OPTIONS' }).requestHeaders, {
      'Access-Control-Request-Headers': 'x-propr-desktop-transport-scope,content-type',
    });
  });

  it('passes through a realistic packaged-origin CORS preflight without renderer identity or bearer injection', () => {
    const service = createCredentialService({
      profiles: { awaitIdle: async () => undefined } as unknown as ProfileStore,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async () => { throw new Error('Network is not expected'); },
    });

    assert.deepEqual(service.prepareRequest('https://same.example.test/api/tasks', {
      Origin: DESKTOP_RENDERER_ORIGIN,
      Cookie: 'renderer=session',
      Authorization: 'Bearer renderer-controlled',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'X-ProPR-Desktop-Transport-Scope, Content-Type',
    }, { method: 'OPTIONS' }), {
      requestHeaders: {
        Origin: DESKTOP_RENDERER_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'X-ProPR-Desktop-Transport-Scope, Content-Type',
      },
    });
  });

  it('rotates scope on every same-profile reprobe and rejects a cold reconnect from the old activation', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'http://localhost:3000' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });
    const first = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(first.status, 'ready');
    if (first.status !== 'ready') return;
    const firstActivation = await service.activate(first.activationTicket);
    const second = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(second.status, 'ready');
    if (second.status !== 'ready') return;
    const secondActivation = await service.activate(second.activationTicket);
    assert.notEqual(firstActivation.transportScope, secondActivation.transportScope);
    assert.equal(firstActivation.identityEpoch, secondActivation.identityEpoch);
    assert.match(firstActivation.identityEpoch, /^[A-Za-z0-9_-]{22}$/);
    assert.match(firstActivation.transportScope, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(service.prepareRequest(
      'http://localhost:3000/api/tasks', transportHeaders(firstActivation.transportScope),
    ), { cancel: true });
    assert.deepEqual(service.prepareRequest(
      `ws://localhost:3000/socket.io/?transport=websocket&proprDesktopTransportScope=${firstActivation.transportScope}`,
      {}, { resourceType: 'webSocket' },
    ), { cancel: true });
    assert.equal(service.prepareRequest(
      `ws://localhost:3000/socket.io/?transport=websocket&proprDesktopTransportScope=${secondActivation.transportScope}`,
      {}, { resourceType: 'webSocket' },
    ).requestHeaders?.Authorization, `Bearer ${token('A')}`);
  });

  it('never sends an A-origin bearer after the profile URL is edited to an attacker origin', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const service = createCredentialService({
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
    assert.equal(requests.some(request => request.url === 'https://a.example.test/api/desktop/tokens/current'), false);
    assert.deepEqual(await store.readCredential(profile.id), credential(profile.id, profile.apiBaseUrl, 'A'));
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
    const service = createCredentialService({
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
    const currentActivation = current.status === 'ready' ? await service.activate(current.activationTicket) : null;

    oldProbeResponse.resolve(json({ code: 'INVALID_INSTANCE_TOKEN' }, 401));
    const staleResult = await staleProbe;

    assert.equal(staleResult.status, 'offline');
    assert.match(staleResult.message, /connection changed.*try again/i);
    assert.deepEqual(await store.readCredential(profile.id), replacement);
    if (!currentActivation) return;
    assert.deepEqual(service.prepareRequest('https://a.example.test/api/tasks', transportHeaders(currentActivation.transportScope, {})).requestHeaders, {
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
    const service = createCredentialService({
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
    const currentActivation = current.status === 'ready' ? await service.activate(current.activationTicket) : null;

    oldProbeResponse.resolve(json({ code: 'INVALID_INSTANCE_TOKEN' }, 401));
    const staleResult = await staleProbe;

    assert.equal(staleResult.status, 'offline');
    assert.match(staleResult.message, /connection changed.*try again/i);
    assert.deepEqual(await store.readCredential(profile.id), replacement);
    if (!currentActivation) return;
    assert.deepEqual(service.prepareRequest('https://b.example.test/api/tasks', transportHeaders(currentActivation.transportScope, {})).requestHeaders, {
      Authorization: `Bearer ${replacement.token}`,
    });
  });

  for (const failure of ['browser-launch', 'cancellation', 'expiry', 'polling', 'secure-storage'] as const) {
    it(`preserves the active profile and credential when an origin edit fails during ${failure}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
      temporaryDirectories.push(directory);
      let rejectReplacementEncryption = false;
      const provider: EncryptionProvider = {
        ...encryption,
        encrypt: value => {
          const stored = JSON.parse(value) as StoredCredential;
          if (rejectReplacementEncryption && stored.token === token('B')) {
            throw new Error('keychain encrypt failed');
          }
          return Buffer.from(value, 'utf8');
        },
      };
      const store = new ProfileStore(directory, provider);
      const profile = await store.save({
        id: 'profile-a', label: 'Working A', apiBaseUrl: 'https://a.example.test',
      });
      const oldCredential = credential(profile.id, profile.apiBaseUrl, 'A');
      await store.writeCredential(oldCredential);
      await store.setActive(profile.id);
      const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
      const requests: Array<{ url: string; authorization: string | null }> = [];
      let service!: DesktopCredentialService;
      service = createCredentialService({
        profiles: store,
        clientName: 'Test desktop',
        pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
        openExternal: async () => {
          if (failure === 'browser-launch') throw new Error('Browser launch failed.');
          if (failure === 'cancellation') service.cancelPairing(profile.id);
        },
        fetch: async (input, init) => {
          const url = input.toString();
          const authorization = new Headers(init?.headers).get('Authorization');
          requests.push({ url, authorization });
          if (url === 'https://a.example.test/api/desktop/discovery') return json(discovery);
          if (url === 'https://a.example.test/api/auth/user') return json({ username: 'working-a' });
          if (url === 'https://b.example.test/api/desktop/pairings') return json({
            pairingId: `dpr_${'A'.repeat(22)}`,
            deviceSecret: 'C'.repeat(43),
            approvalUrl: 'https://b.example.test/approve',
            expiresAt: new Date(pairingNow + (failure === 'expiry' ? -1 : 10_000)).toISOString(),
            interval: 1,
          }, 201);
          if (url.endsWith('/poll')) {
            if (failure === 'polling') throw new Error('Pairing poll failed.');
            return json({ status: 'complete', token: token('B'), tokenType: 'Bearer', expiresAt: null });
          }
          if (url === 'https://b.example.test/api/desktop/tokens/current') {
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
      });
      const ready = await service.probe({
        id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl,
      });
      assert.equal(ready.status, 'ready');
      if (ready.status !== 'ready') return;
      const activated = await service.activate(ready.activationTicket);
      rejectReplacementEncryption = failure === 'secure-storage';

      await assert.rejects(service.pair({
        id: profile.id,
        label: 'Proposed B',
        apiBaseUrl: 'https://b.example.test',
      }));

      assert.deepEqual(await store.list(), { profiles: [profile], activeProfileId: profile.id });
      assert.deepEqual(await store.readCredential(profile.id), oldCredential);
      assert.deepEqual(service.prepareRequest(
        'https://a.example.test/api/tasks',
        transportHeaders(activated.transportScope),
      ).requestHeaders, { Authorization: `Bearer ${oldCredential.token}` });
      assert.equal(requests.some(request => request.url === 'https://a.example.test/api/desktop/tokens/current'
        && request.authorization === `Bearer ${oldCredential.token}`), false);
    });
  }

  it('commits an edited profile and replacement credential before revoking the old token', async () => {
    const store = await createStore();
    const profile = await store.save({
      id: 'profile-a', label: 'Working A', apiBaseUrl: 'https://a.example.test',
    });
    const oldCredential = credential(profile.id, profile.apiBaseUrl, 'A');
    const replacement = credential(profile.id, 'https://b.example.test', 'B');
    await store.writeCredential(oldCredential);
    await store.setActive(profile.id);
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    const revocationSnapshot = deferred<{
      state: Awaited<ReturnType<ProfileStore['list']>>;
      credential: StoredCredential | null;
    }>();
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url === 'https://b.example.test/api/desktop/pairings') return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'C'.repeat(43),
          approvalUrl: 'https://b.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: replacement.token, tokenType: 'Bearer', expiresAt: null });
        }
        if (url === 'https://a.example.test/api/desktop/tokens/current') {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${oldCredential.token}`);
          revocationSnapshot.resolve({
            state: await store.list(),
            credential: await store.readCredential(profile.id),
          });
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await service.pair({
      id: profile.id,
      label: 'Connected B',
      apiBaseUrl: replacement.origin,
    });

    const stateAtRevocation = await revocationSnapshot.promise;
    assert.equal(stateAtRevocation.state.profiles[0]?.label, 'Connected B');
    assert.equal(stateAtRevocation.state.profiles[0]?.apiBaseUrl, replacement.origin);
    assert.equal(stateAtRevocation.state.activeProfileId, null);
    assert.deepEqual(stateAtRevocation.credential, replacement);
    assert.deepEqual(await store.readCredential(profile.id), replacement);
  });

  it('retries an encrypted pending A revocation across failure, restart, remote success, and local cleanup failure', async () => {
    const store = await createStore();
    const profile = await store.save({
      id: 'profile-a', label: 'Working A', apiBaseUrl: 'https://a.example.test',
    });
    const credentialA = credential(profile.id, profile.apiBaseUrl, 'A');
    const credentialB = credential(profile.id, profile.apiBaseUrl, 'B');
    await store.writeCredential(credentialA);
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    const diagnostics: Array<{ code: string; status?: number }> = [];
    let expectedProbeToken = credentialA.token;
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      reportRevocationFailure: value => diagnostics.push(value),
      fetch: async (input, init) => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'C'.repeat(43),
          approvalUrl: 'https://a.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: credentialB.token, tokenType: 'Bearer', expiresAt: null });
        }
        if (url.endsWith('/api/desktop/tokens/current')) {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${credentialA.token}`);
          return json({ error: 'offline' }, 503);
        }
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url.endsWith('/api/auth/user')) {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${expectedProbeToken}`);
          return json({ username: 'credential-b' });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const readyA = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(readyA.status, 'ready');
    if (readyA.status !== 'ready') return;
    const activeA = await service.activate(readyA.activationTicket);
    await service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.deepEqual(await store.readCredential(profile.id), credentialB);
    assert.equal((await store.pendingRevocations()).length, 1);
    assert.deepEqual(diagnostics, [{ code: 'http', status: 503 }]);
    assert.equal(JSON.stringify(diagnostics).includes(credentialA.token), false);
    assert.deepEqual(service.prepareRequest(
      `${profile.apiBaseUrl}/api/tasks`, transportHeaders(activeA.transportScope),
    ), { cancel: true });
    expectedProbeToken = credentialB.token;
    const ready = await service.probe({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;
    const activeB = await service.activate(ready.activationTicket);
    assert.deepEqual(service.prepareRequest(
      `${profile.apiBaseUrl}/api/tasks`, transportHeaders(activeB.transportScope),
    ).requestHeaders, { Authorization: `Bearer ${credentialB.token}` });

    const offlineDiagnostics: Array<{ code: string; status?: number }> = [];
    const offlineRestart = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      reportRevocationFailure: value => offlineDiagnostics.push(value),
      fetch: async () => { throw new Error('offline'); },
    });
    await offlineRestart.initialize();
    assert.deepEqual(offlineDiagnostics, [{ code: 'network' }]);
    assert.equal((await store.pendingRevocations()).length, 1);

    let failCleanup = true;
    const cleanupFailingProfiles = new Proxy(store, {
      get(target, property) {
        if (property === 'completePendingRevocation') return async () => {
          if (failCleanup) {
            failCleanup = false;
            throw new Error('injected cleanup failure');
          }
          return false;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const cleanupDiagnostics: Array<{ code: string; status?: number }> = [];
    const remoteSucceeded = createCredentialService({
      profiles: cleanupFailingProfiles,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      reportRevocationFailure: value => cleanupDiagnostics.push(value),
      fetch: async () => new Response(null, { status: 204 }),
    });
    await remoteSucceeded.initialize();
    assert.deepEqual(cleanupDiagnostics, [{ code: 'local-cleanup' }]);
    assert.equal((await store.pendingRevocations()).length, 1);

    let terminalRetries = 0;
    const onlineRestart = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async (_input, init) => {
        terminalRetries += 1;
        return terminalRevocation(init);
      },
    });
    await onlineRestart.initialize();
    await onlineRestart.initialize();
    assert.equal(terminalRetries, 1);
    assert.deepEqual(await store.pendingRevocations(), []);
    assert.deepEqual(await store.readCredential(profile.id), credentialB);

    const uncertainDirectory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
    temporaryDirectories.push(uncertainDirectory);
    let failCommitFlush = false;
    let armedCommitFlushes = 0;
    const uncertainStore = new ProfileStore(uncertainDirectory, encryption, {
      beforeIO: operation => {
        if (failCommitFlush && operation === 'journal-commit-flush') {
          armedCommitFlushes += 1;
          if (armedCommitFlushes === 2) throw new Error('injected journal commit flush failure');
        }
      },
    });
    const uncertainProfile = await uncertainStore.save({
      id: 'profile-uncertain', label: 'A', apiBaseUrl: 'https://a.example.test',
    });
    const uncertainA = credential(uncertainProfile.id, uncertainProfile.apiBaseUrl, 'A');
    const uncertainB = credential(uncertainProfile.id, uncertainProfile.apiBaseUrl, 'B');
    await uncertainStore.writeCredential(uncertainA);
    const uncertainRevocations: string[] = [];
    const uncertainService = createCredentialService({
      profiles: uncertainStore,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'C'.repeat(43),
          approvalUrl: 'https://a.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: uncertainB.token, tokenType: 'Bearer', expiresAt: null });
        }
        if (url.endsWith('/api/desktop/tokens/current')) {
          uncertainRevocations.push(new Headers(init?.headers).get('Authorization') ?? '');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    failCommitFlush = true;
    await assert.rejects(
      uncertainService.pair({
        id: uncertainProfile.id,
        label: 'B',
        apiBaseUrl: uncertainProfile.apiBaseUrl,
      }),
      /injected journal commit flush failure/,
    );
    failCommitFlush = false;
    assert.deepEqual(uncertainRevocations, [], 'verified B must not be revoked after C becomes observable');
    const uncertainRestart = new ProfileStore(uncertainDirectory, encryption);
    assert.deepEqual(await uncertainRestart.readCredential(uncertainProfile.id), uncertainB);
    assert.equal((await uncertainRestart.pendingRevocations()).length, 1);
  });

  const nativeRevocationCrashModes = ['during-revoke', 'after-remote-success'] as const;
  assert.equal(nativeRevocationCrashModes.length, 2);
  for (const crashMode of nativeRevocationCrashModes) {
    it(`recovers B and retries idempotently after a real process crash ${crashMode}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
      temporaryDirectories.push(directory);
      const setup = new ProfileStore(directory, encryption);
      const profile = await setup.save({
        id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test',
      });
      const credentialA = credential(profile.id, profile.apiBaseUrl, 'A');
      const credentialB = credential(profile.id, profile.apiBaseUrl, 'B');
      await setup.writeCredential(credentialA);
      const baseline = await setup.readProfileCredential(profile.id);
      await setup.commitPairedProfile(
        { id: profile.id, label: 'B', apiBaseUrl: profile.apiBaseUrl },
        credentialB, baseline, () => true,
      );
      assert.equal((await setup.pendingRevocations()).length, 1);

      const child = spawn(process.execPath, [
        '--import', 'tsx', join(import.meta.dirname, 'pending-revocation-crash-fixture.ts'),
        directory, crashMode,
      ], { stdio: 'ignore' });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(
        result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0),
        true,
        `${crashMode}: child did not terminate at the requested revocation boundary`,
      );

      const restarted = new ProfileStore(directory, encryption);
      assert.deepEqual(await restarted.readCredential(profile.id), credentialB);
      assert.equal((await restarted.pendingRevocations()).length, 1);
      let retries = 0;
      const retryingService = createCredentialService({
        profiles: restarted,
        clientName: 'Restarted desktop',
        openExternal: async () => undefined,
        fetch: async (_input, init) => {
          retries += 1;
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${credentialA.token}`);
          return terminalRevocation(init);
        },
      });
      await retryingService.initialize();
      await retryingService.initialize();
      assert.equal(retries, 1);
      assert.deepEqual(await restarted.pendingRevocations(), []);
      assert.deepEqual(await restarted.readCredential(profile.id), credentialB);
      console.log('NATIVE_SCENARIO revocation-crash');
    });
  }

  for (const [name, response] of [
    ['204 success', (_init: RequestInit | undefined) => new Response(null, { status: 204 })],
    ['404 TOKEN_NOT_FOUND', (init: RequestInit | undefined) => terminalRevocation(init)],
    ['401 INSTANCE_TOKEN_REVOKED', (init: RequestInit | undefined) => terminalRevocation(init, 'INSTANCE_TOKEN_REVOKED')],
    ['401 INSTANCE_TOKEN_EXPIRED', (init: RequestInit | undefined) => terminalRevocation(init, 'INSTANCE_TOKEN_EXPIRED')],
  ] as const) {
    it(`cleans durable retry material only for endpoint-bound terminal ${name}`, async () => {
      const store = await createStore();
      const profile = await store.save({ id: 'profile-terminal', label: 'A', apiBaseUrl: 'https://a.example.test' });
      const old = credential(profile.id, profile.apiBaseUrl, 'A');
      await store.writeCredential(old);
      await store.removeCredential(profile.id);
      const pending = await store.pendingRevocations();
      assert.equal(pending.length, 1);
      const service = createCredentialService({
        profiles: store,
        clientName: 'Terminal contract test',
        openExternal: async () => undefined,
        fetch: async (input, init) => {
          assert.equal(input.toString(), `${old.origin}${DESKTOP_TOKEN_REVOCATION_ENDPOINT}`);
          assert.equal(new Headers(init?.headers).get(DESKTOP_REVOCATION_BINDING_HEADER), pending[0].credentialGeneration);
          return response(init);
        },
      });
      await service.initialize();
      assert.deepEqual(await store.pendingRevocations(), []);
    });
  }

  const retryableRevocationResponses: ReadonlyArray<[
    string,
    (init: RequestInit | undefined) => Response,
  ]> = [
    ['empty 401', () => new Response(null, { status: 401 })],
    ['empty 404', () => new Response(null, { status: 404 })],
    ['HTML route 404', () => new Response('<h1>not found</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } })],
    ['malformed JSON', () => new Response('{', { status: 404, headers: { 'Content-Type': 'application/json' } })],
    ['wrong content type', init => new Response(JSON.stringify(terminalRevocationBody(init)), {
      status: 404, headers: { 'Content-Type': 'text/plain' },
    })],
    ['wrong schema version', init => json({ ...terminalRevocationBody(init), version: 2 }, 404)],
    ['wrong credential generation', init => json({
      ...terminalRevocationBody(init), credentialGeneration: 'Z'.repeat(22),
    }, 404)],
    ['unknown terminal code', init => json({ ...terminalRevocationBody(init), code: 'INVALID_INSTANCE_TOKEN' }, 404)],
    ['status/code mismatch', init => json(terminalRevocationBody(init), 401)],
    ['redirect', () => Response.redirect('https://proxy.example.test/moved', 302)],
    ['redirected 204', () => {
      const result = new Response(null, { status: 204 });
      Object.defineProperty(result, 'redirected', { value: true });
      return result;
    }],
    ['wrong endpoint 204', () => {
      const result = new Response(null, { status: 204 });
      Object.defineProperty(result, 'url', { value: 'https://proxy.example.test/api/desktop/tokens/current' });
      return result;
    }],
    ['server failure', () => json({ code: 'DESKTOP_AUTH_FAILED' }, 503)],
    ['oversized JSON', init => json({ ...terminalRevocationBody(init), padding: 'x'.repeat(2_048) }, 404)],
  ];
  for (const [name, response] of retryableRevocationResponses) {
    it(`retains encrypted retry material for ${name}`, async () => {
      const store = await createStore();
      const profile = await store.save({ id: 'profile-retryable', label: 'A', apiBaseUrl: 'https://a.example.test' });
      await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
      await store.removeCredential(profile.id);
      const diagnostics: Array<{ code: string; status?: number }> = [];
      const service = createCredentialService({
        profiles: store,
        clientName: 'Retryable contract test',
        openExternal: async () => undefined,
        reportRevocationFailure: diagnostic => diagnostics.push(diagnostic),
        fetch: async (_input, init) => response(init),
      });
      await service.initialize();
      assert.equal((await store.pendingRevocations()).length, 1);
      assert.deepEqual(diagnostics, [{ code: 'http', status: response(undefined).status }]);
      assert.equal(JSON.stringify(diagnostics).includes(token('A')), false);
    });
  }

  const streamingRevocationCases: ReadonlyArray<[
    string,
    boolean,
    (init: RequestInit | undefined) => Response,
  ]> = [
    ['chunked 2048-byte terminal JSON', true, init => {
      const jsonBody = JSON.stringify(terminalRevocationBody(init));
      const body = new TextEncoder().encode(jsonBody + ' '.repeat(2_048 - Buffer.byteLength(jsonBody)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.slice(0, 1_024));
          controller.enqueue(body.slice(1_024));
          controller.close();
        },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }],
    ['chunked 2049-byte terminal JSON', false, init => {
      const jsonBody = JSON.stringify(terminalRevocationBody(init));
      const body = new TextEncoder().encode(jsonBody + ' '.repeat(2_049 - Buffer.byteLength(jsonBody)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.slice(0, 2_048));
          controller.enqueue(body.slice(2_048));
          controller.close();
        },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }],
    ['terminal JSON without Content-Length', true, init => {
      const body = new TextEncoder().encode(JSON.stringify(terminalRevocationBody(init)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.slice(0, 7));
          controller.enqueue(body.slice(7));
          controller.close();
        },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }],
    ['deceptive short Content-Length', false, init => {
      const body = JSON.stringify(terminalRevocationBody(init));
      return new Response(body, {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body) - 1) },
      });
    }],
    ['extra chunk after declared Content-Length', false, init => {
      const body = new TextEncoder().encode(JSON.stringify(terminalRevocationBody(init)));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.enqueue(new TextEncoder().encode(' '));
          controller.close();
        },
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) },
      });
    }],
    ['malformed UTF-8', false, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0xc3, 0x28]));
        controller.close();
      },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } })],
    ['premature body error', false, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        controller.error(new Error('injected body failure'));
      },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } })],
  ];

  for (const [name, completes, response] of streamingRevocationCases) {
    it(`${completes ? 'accepts' : 'retains'} encrypted retry material for ${name}`, async () => {
      const store = await createStore();
      const profile = await store.save({
        id: 'profile-streaming', label: 'A', apiBaseUrl: 'https://a.example.test',
      });
      await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
      await store.removeCredential(profile.id);
      const service = createCredentialService({
        profiles: store,
        clientName: 'Streaming terminal contract test',
        openExternal: async () => undefined,
        fetch: async (_input, init) => response(init),
      });

      const initialized = await service.initialize();

      assert.equal((await store.pendingRevocations()).length, completes ? 0 : 1);
      assert.equal(initialized.status, completes ? 'ready' : 'degraded');
    });
  }

  it('bounds a one-byte slowloris body and retains its encrypted retry material', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-slowloris', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    await store.removeCredential(profile.id);
    let bodyCancelled = false;
    const service = createCredentialService({
      profiles: store,
      clientName: 'Slowloris terminal contract test',
      openExternal: async () => undefined,
      revocationDeadlines: { headerMs: 50, bodyMs: 25, recordMs: 75, aggregateMs: 100 },
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
        cancel() { bodyCancelled = true; },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    });

    const initialized = await service.initialize();

    assert.deepEqual(initialized, { status: 'degraded', retryPending: true });
    assert.equal(bodyCancelled, true);
    assert.equal((await store.pendingRevocations()).length, 1);
  });

  it('dispose aborts a stalled header fetch, deduplicates its generation, and leaves no later activity', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-dispose-fetch', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    await store.removeCredential(profile.id);
    const fetchStarted = deferred<void>();
    let fetchCalls = 0;
    let fetchAborted = false;
    const service = createCredentialService({
      profiles: store,
      clientName: 'Dispose fetch barrier test',
      openExternal: async () => undefined,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        fetchCalls += 1;
        fetchStarted.resolve();
        const signal = init?.signal;
        assert.ok(signal);
        const abort = () => {
          fetchAborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
    });

    const first = service.initialize();
    const duplicate = service.initialize();
    await fetchStarted.promise;
    await service.dispose();
    await Promise.all([first, duplicate]);
    const callsAtDispose = fetchCalls;
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(fetchAborted, true);
    assert.equal(fetchCalls, 1);
    assert.equal(fetchCalls, callsAtDispose);
    assert.equal((await store.pendingRevocations()).length, 1);
    await assert.rejects(
      service.removeProfile(profile.id),
      /credential service is closed/i,
    );
  });

  it('dispose cancels a headers-then-stall body and retains exact encrypted material', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-dispose-body', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const old = credential(profile.id, profile.apiBaseUrl, 'A');
    await store.writeCredential(old);
    await store.removeCredential(profile.id);
    const bodyStarted = deferred<void>();
    let bodyCancelled = false;
    let networkCalls = 0;
    const service = createCredentialService({
      profiles: store,
      clientName: 'Dispose body barrier test',
      openExternal: async () => undefined,
      fetch: async () => {
        networkCalls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            bodyStarted.resolve();
          },
          cancel() { bodyCancelled = true; },
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      },
    });

    const initialization = service.initialize();
    await bodyStarted.promise;
    await service.dispose();
    await initialization;
    const callsAtDispose = networkCalls;
    await new Promise(resolve => setTimeout(resolve, 20));

    const pending = await store.pendingRevocations();
    assert.equal(bodyCancelled, true);
    assert.equal(networkCalls, callsAtDispose);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].credential, old);
  });

  it('dispose waits for terminal journal cleanup and no file operation runs afterward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
    temporaryDirectories.push(directory);
    const journalWriteStarted = deferred<void>();
    const releaseJournalWrite = deferred<void>();
    let barrierArmed = false;
    let ioOperations = 0;
    const store = new ProfileStore(directory, encryption, {
      beforeIO: operation => {
        ioOperations += 1;
        if (barrierArmed && operation === 'journal-write') {
          barrierArmed = false;
          journalWriteStarted.resolve();
          return releaseJournalWrite.promise;
        }
      },
    });
    const profile = await store.save({ id: 'profile-dispose-journal', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    await store.removeCredential(profile.id);
    barrierArmed = true;
    let networkCalls = 0;
    const service = createCredentialService({
      profiles: store,
      clientName: 'Dispose journal barrier test',
      openExternal: async () => undefined,
      fetch: async () => {
        networkCalls += 1;
        return new Response(null, { status: 204 });
      },
    });

    const initialization = service.initialize();
    await journalWriteStarted.promise;
    let disposed = false;
    const disposal = service.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    releaseJournalWrite.resolve();
    await Promise.all([initialization, disposal]);
    const ioAtDispose = ioOperations;
    const networkAtDispose = networkCalls;
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(ioOperations, ioAtDispose);
    assert.equal(networkCalls, networkAtDispose);
    assert.deepEqual(await store.pendingRevocations(), []);
  });

  it('bounds aggregate startup across stalled records and recovers all encrypted records later', async () => {
    const store = await createStore();
    for (const [id, character] of [['profile-startup-a', 'A'], ['profile-startup-b', 'B']] as const) {
      const profile = await store.save({ id, label: id, apiBaseUrl: `https://${character.toLowerCase()}.example.test` });
      await store.writeCredential(credential(profile.id, profile.apiBaseUrl, character));
      await store.removeCredential(profile.id);
    }
    let stalledCalls = 0;
    const offline = createCredentialService({
      profiles: store,
      clientName: 'Bounded startup test',
      openExternal: async () => undefined,
      revocationDeadlines: { headerMs: 100, bodyMs: 50, recordMs: 125, aggregateMs: 500 },
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        stalledCalls += 1;
        const signal = init?.signal;
        assert.ok(signal);
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }),
    });
    const startedAt = Date.now();

    const initialization = await offline.initialize();

    assert.deepEqual(initialization, { status: 'degraded', retryPending: true });
    assert.ok(Date.now() - startedAt < 1_500);
    assert.equal(stalledCalls, 2);
    assert.equal((await store.pendingRevocations()).length, 2);
    await offline.dispose();

    let recoveryCalls = 0;
    const online = createCredentialService({
      profiles: store,
      clientName: 'Later online recovery test',
      openExternal: async () => undefined,
      fetch: async () => {
        recoveryCalls += 1;
        return new Response(null, { status: 204 });
      },
    });
    assert.deepEqual(await online.initialize(), { status: 'ready', retryPending: false });
    assert.equal(recoveryCalls, 2);
    assert.deepEqual(await store.pendingRevocations(), []);
  });

  it('retries a crash-left provisional pairing credential on startup', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-provisional', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const provisional = await store.journalPendingRevocation(
      credential(profile.id, profile.apiBaseUrl, 'C'),
    );
    assert.equal('stored' in provisional, false);
    if ('stored' in provisional) return;
    assert.equal(provisional.deferred, true);
    let calls = 0;
    const restarted = createCredentialService({
      profiles: store,
      clientName: 'Restarted after provisional crash',
      openExternal: async () => undefined,
      fetch: async (_input, init) => {
        calls += 1;
        assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token('C')}`);
        return new Response(null, { status: 204 });
      },
    });
    await restarted.initialize();
    assert.equal(calls, 1);
    assert.deepEqual(await store.pendingRevocations(), []);
    console.log('NATIVE_SCENARIO transient-revocation');
  });

  it('ignores delayed A invalidation after B connects and preserves tokens for authorization/transient codes', async () => {
    const store = await createStore();
    const profileA = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const profileB = await store.save({ id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test' });
    await store.writeCredential(credential(profileA.id, profileA.apiBaseUrl, 'A'));
    await store.writeCredential(credential(profileB.id, profileB.apiBaseUrl, 'B'));
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      openExternal: async () => undefined,
      fetch: async input => input.toString().endsWith('/api/desktop/discovery')
        ? json(discovery)
        : json({ username: 'octocat' }),
    });
    const readyA = await service.probe({ id: profileA.id, label: profileA.label, apiBaseUrl: profileA.apiBaseUrl });
    const activatedA = readyA.status === 'ready' ? await service.activate(readyA.activationTicket) : null;
    const readyB = await service.probe({ id: profileB.id, label: profileB.label, apiBaseUrl: profileB.apiBaseUrl });
    assert.equal(readyA.status, 'ready');
    assert.equal(readyB.status, 'ready');
    if (readyA.status !== 'ready' || readyB.status !== 'ready') return;
    const activatedB = await service.activate(readyB.activationTicket);
    if (!activatedA) return;

    assert.deepEqual(await service.invalidate({
      profileId: profileA.id,
      transportScope: activatedA.transportScope,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: false });
    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      transportScope: activatedB.transportScope,
      code: 'AUTHORIZATION_CHANGED',
    }), { invalidated: false });
    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      transportScope: activatedB.transportScope,
      code: 'AUTHENTICATION_FAILED',
    }), { invalidated: false });
    assert.ok(await store.readCredential(profileA.id));
    assert.ok(await store.readCredential(profileB.id));

    assert.deepEqual(await service.invalidate({
      profileId: profileB.id,
      transportScope: activatedB.transportScope,
      code: 'INVALID_INSTANCE_TOKEN',
    }), { invalidated: true });
    await service.initialize();
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
    service = createCredentialService({
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

  it('keeps an exactly persisted cancelled pairing token pending when revocation fails', async () => {
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
    service = createCredentialService({
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
    const pending = await store.pendingRevocations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].credential.token, token('C'));
    console.log('NATIVE_SCENARIO transient-revocation');
  });

  it('detaches a removed profile locally before deferred revoke and preserves a later replacement', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const revocationStarted = deferred<void>();
    const releaseRevocation = deferred<Response>();
    const service = createCredentialService({
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
    // Drain the serialized retry queue before the test removes its keychain
    // directory; removeProfile intentionally does not wait on the network.
    await service.initialize();

    assert.equal((await store.list()).profiles.find(item => item.id === profile.id)?.label, replacementProfile.label);
    assert.deepEqual(await store.readCredential(profile.id), replacementCredential);
  });

  it('never lets a delayed A-to-B revoke overwrite a later C save, pairing, selection, or credential', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    await store.setActive(profile.id);
    await store.writeCredential(credential(profile.id, profile.apiBaseUrl, 'A'));
    const revokeStarted = deferred<void>();
    const releaseRevoke = deferred<Response>();
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    const service = createCredentialService({
      profiles: store,
      clientName: 'Test desktop',
      pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
      openExternal: async () => undefined,
      fetch: async (input, init) => {
        const url = input.toString();
        if (url === 'https://a.example.test/api/desktop/tokens/current') {
          assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${token('A')}`);
          revokeStarted.resolve();
          return releaseRevoke.promise;
        }
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: 'https://c.example.test/approve',
          expiresAt: new Date(pairingNow + 10_000).toISOString(),
          interval: 1,
        }, 201);
        if (url.endsWith('/poll')) {
          return json({ status: 'complete', token: token('C'), tokenType: 'Bearer', expiresAt: null });
        }
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url.endsWith('/api/auth/user')) return json({ username: 'c' });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const staleBSave = service.saveProfile({
      id: profile.id, label: 'B', apiBaseUrl: 'https://b.example.test',
    });
    await revokeStarted.promise;
    const profileC = await service.saveProfile({
      id: profile.id, label: 'C', apiBaseUrl: 'https://c.example.test',
    });
    await service.pair({ id: profile.id, label: 'C', apiBaseUrl: profileC.apiBaseUrl });
    const probeC = await service.probe({ id: profile.id, label: 'C', apiBaseUrl: profileC.apiBaseUrl });
    assert.equal(probeC.status, 'ready');
    if (probeC.status !== 'ready') return;
    await service.activate(probeC.activationTicket);

    releaseRevoke.resolve(new Response(null, { status: 204 }));
    await staleBSave;

    const finalState = await store.list();
    assert.equal(finalState.profiles.find(item => item.id === profile.id)?.label, 'C');
    assert.equal(finalState.profiles.find(item => item.id === profile.id)?.apiBaseUrl, 'https://c.example.test');
    assert.equal(finalState.activeProfileId, profile.id);
    assert.deepEqual(await store.readCredential(profile.id), credential(profile.id, 'https://c.example.test', 'C'));
  });

  it('returns connection-changed and preserves a re-paired credential for an old ready invalidation', async () => {
    const store = await createStore();
    const profile = await store.save({ id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test' });
    const oldCredential = credential(profile.id, profile.apiBaseUrl, 'A');
    const replacement = credential(profile.id, profile.apiBaseUrl, 'B');
    await store.writeCredential(oldCredential);
    const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
    const service = createCredentialService({
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
    const activated = await service.activate(ready.activationTicket);

    await service.pair({ id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl });
    assert.deepEqual(await service.invalidate({
      profileId: profile.id,
      transportScope: activated.transportScope,
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
        saveAndDetachCredential: (input: Parameters<ProfileStore['saveAndDetachCredential']>[0]) =>
          store.saveAndDetachCredential(input),
        commitPairedProfile: (...args: Parameters<ProfileStore['commitPairedProfile']>) => {
          if (!raced) {
            raced = true;
            raceOperation = race === 'delete'
              ? service.removeProfile(profileA.id)
              : service.setActiveProfile(profileB.id);
          }
          return store.commitPairedProfile(...args);
        },
        detachProfile: (profileId: string) => store.detachProfile(profileId),
        setActive: (profileId: string | null) => store.setActive(profileId),
        activateProfile: (...args: Parameters<ProfileStore['activateProfile']>) => store.activateProfile(...args),
        security: () => store.security(),
        readCredential: (profileId: string) => store.readCredential(profileId),
        readProfileCredential: (profileId: string) => store.readProfileCredential(profileId),
        writeCredential: (value: StoredCredential) => store.writeCredential(value),
        removeCredential: (profileId: string) => store.removeCredential(profileId),
        removeCredentialIfCurrent: (...args: Parameters<ProfileStore['removeCredentialIfCurrent']>) =>
          store.removeCredentialIfCurrent(...args),
        journalPendingRevocation: (value: StoredCredential) => store.journalPendingRevocation(value),
        releasePendingRevocation: (...args: Parameters<ProfileStore['releasePendingRevocation']>) =>
          store.releasePendingRevocation(...args),
        pendingRevocations: () => store.pendingRevocations(),
        completePendingRevocation: (...args: Parameters<ProfileStore['completePendingRevocation']>) =>
          store.completePendingRevocation(...args),
        awaitIdle: () => store.awaitIdle(),
      };
      service = createCredentialService({
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
      console.log('NATIVE_SCENARIO transient-revocation');
    });
  }

  const pairedPublishBoundaries = ['state-written', 'state-fsynced'] as const;
  const pairedPublishRaces = ['cancel', 'switch'] as const;
  assert.equal(pairedPublishBoundaries.length * pairedPublishRaces.length, 4);
  for (const boundary of pairedPublishBoundaries) {
    for (const race of pairedPublishRaces) {
      it(`keeps durable A when ${race} linearizes at paired ${boundary} before publish`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'propr-credential-service-'));
        temporaryDirectories.push(directory);
        const reached = deferred<void>();
        const release = deferred<void>();
        let armed = false;
        const store = new ProfileStore(directory, encryption, {
          afterDurabilityStep: async step => {
            if (!armed || step !== boundary) return;
            armed = false;
            reached.resolve();
            await release.promise;
          },
        });
        const profileA = await store.save({
          id: 'profile-a', label: 'A', apiBaseUrl: 'https://a.example.test',
        });
        const profileB = await store.save({
          id: 'profile-b', label: 'Other', apiBaseUrl: 'https://b.example.test',
        });
        const credentialA = credential(profileA.id, profileA.apiBaseUrl, 'A');
        await store.writeCredential(credentialA);
        await store.setActive(profileA.id);
        const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
        const revocations: string[] = [];
        const service = createCredentialService({
          profiles: store,
          clientName: 'Test desktop',
          pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
          openExternal: async () => undefined,
          fetch: async (input, init) => {
            const url = input.toString();
            if (url.endsWith('/api/desktop/pairings')) return json({
              pairingId: `dpr_${'A'.repeat(22)}`,
              deviceSecret: 'C'.repeat(43),
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
        armed = true;
        const pairing = service.pair({
          id: profileA.id, label: 'Proposed B', apiBaseUrl: profileA.apiBaseUrl,
        });
        await reached.promise;
        const raced = race === 'cancel'
          ? Promise.resolve(service.cancelPairing(profileA.id))
          : service.setActiveProfile(profileB.id);
        release.resolve();

        await assert.rejects(pairing, /cancelled/i);
        await raced;
        const restarted = new ProfileStore(directory, encryption);
        const snapshot = await restarted.readProfileCredential(profileA.id);
        assert.equal(snapshot.profile?.label, 'A');
        assert.deepEqual(snapshot.credential, credentialA);
        assert.equal((await restarted.list()).activeProfileId, race === 'cancel' ? profileA.id : profileB.id);
        assert.deepEqual(revocations, [`Bearer ${token('C')}`]);
        assert.deepEqual(service.prepareRequest(
          `${profileA.apiBaseUrl}/api/tasks`, transportHeaders('AAAAAAAAAAAAAAAAAAAAAA'),
        ), { cancel: true });
        console.log('NATIVE_SCENARIO cancellation-switch');
      });
    }
  }
});
