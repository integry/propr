import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY, DESKTOP_TRANSPORT_SCOPE_HEADER,
  DESKTOP_REVOCATION_BINDING_HEADER, DESKTOP_TOKEN_REVOCATION_ENDPOINT,
  DESKTOP_TOKEN_REVOCATION_SCHEMA, DESKTOP_TOKEN_REVOCATION_VERSION } from '@propr/shared';
import { DesktopCredentialService } from './credential-service';
import { ProfileStore } from './profile-store';
import { readAccountResponse } from './account-response';
import { registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from './shared/contract';
import { rendererPolicyOriginsForSelection } from './security';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const alice = { id: '101', username: 'alice', avatarUrl: 'https://avatars.githubusercontent.com/u/101' };
const bob = { id: '202', username: 'bob', avatarUrl: null };
const encryption = { isEncryptionAvailable: () => true, backend: () => 'keychain', encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() };
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-accounts-'));
  const store = new ProfileStore(directory, encryption);
  let nextUser = alice;
  let confirmation = true;
  let confirming: (() => Promise<boolean>) | undefined;
  let sequence = 0;
  const users = new Map<string, typeof alice | typeof bob>();
  const expired = new Set<string>();
  const denied = new Set<string>();
  const requests = new Map<string, Record<string, unknown>>();
  const confirmations: unknown[] = [];
  const createService = (profiles = store) => new DesktopCredentialService({
    profiles, clientName: 'Account tests', openPairingBrowser: async () => {},
    confirmAccount: async (account, origin) => { confirmations.push({ account, origin }); return confirming ? confirming() : confirmation; },
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
      if (url.pathname === '/api/desktop/discovery') return json({
        schemaVersion: 1, product: 'ProPR', version: '0.8.15', apiCompatibility: PROPR_API_COMPATIBILITY,
        uiCompatibility: PROPR_UI_COMPATIBILITY, canonicalEndpoint: null,
        publicInstanceIdentity: url.hostname === 'other.test' ? '123e4567-e89b-42d3-a456-426614174001' : '123e4567-e89b-42d3-a456-426614174000',
        desktopAuthentication: { protocolVersion: 2, browserPairing: true, instanceBearerTokens: true, socketIoBearerAuthentication: true },
      });
      if (url.pathname === '/api/desktop/pairings') {
        sequence++;
        const pairingId = `dpr_${String(sequence).padStart(22, 'A')}`;
        const binding = JSON.parse(String(init?.body));
        const bearer = `propr_it_${String(sequence).padStart(43, 'B')}`;
        users.set(bearer, nextUser);
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        requests.set(pairingId, { instanceId: binding.instanceId, origin: binding.origin, scope: binding.scope, credentialGeneration: binding.credentialGeneration, token: bearer, activationExpiresAt: expiresAt });
        return json({ pairingId, deviceSecret: 'D'.repeat(43), approvalUrl: `${url.origin}/approve`, expiresAt, interval: 1 }, 201);
      }
      if (url.pathname.endsWith('/poll')) return json({ status: 'provisional', tokenType: 'Bearer', activationTicket: 'T'.repeat(43), ...requests.get(url.pathname.split('/')[4]) });
      if (url.pathname.endsWith('/activate')) return json({ status: 'active', receipt: 'R'.repeat(22), activatedAt: new Date().toISOString(), expiresAt: null });
      if (url.pathname.endsWith('/cancel')) return json({ status: 'cancelled', cancelledAt: new Date().toISOString() });
      if (url.pathname === '/api/auth/user') {
        assert.equal(init?.credentials, 'omit');
        if (expired.has(token)) return json({ code: 'INSTANCE_TOKEN_EXPIRED' }, 401);
        if (denied.has(token)) return json({ code: 'INSUFFICIENT_INSTANCE_PERMISSION' }, 403);
        return json(users.get(token));
      }
      if (url.pathname === DESKTOP_TOKEN_REVOCATION_ENDPOINT) return json({
        schema: DESKTOP_TOKEN_REVOCATION_SCHEMA, version: DESKTOP_TOKEN_REVOCATION_VERSION,
        endpoint: DESKTOP_TOKEN_REVOCATION_ENDPOINT, terminal: true, code: 'INSTANCE_TOKEN_REVOKED',
        credentialGeneration: new Headers(init?.headers).get(DESKTOP_REVOCATION_BINDING_HEADER),
      }, 401);
      throw new Error(`Unexpected test request: ${url.pathname}`);
    },
  });
  const service = createService();
  const close = async () => { await service.dispose(); await store.close(); await rm(directory, { recursive: true, force: true }); };
  return { store, service, createService, directory, expired, denied, confirmations, close,
    user: (user: typeof alice | typeof bob) => { nextUser = user as typeof alice; },
    confirm: (value: boolean) => { confirmation = value; },
    holdConfirmation: (fn: () => Promise<boolean>) => { confirming = fn; },
  };
};
const first = { id: 'alice-team', label: 'Team', apiBaseUrl: 'https://team.test' };
const second = { ...first, id: 'bob-team' };

test('paired local account survives packaged policy reload, saved selection, and app restart', async () => {
  const f = await fixture();
  const profile = { id: 'local', label: 'This computer', apiBaseUrl: 'http://localhost:4000' };
  let store = f.store;
  let credentials = f.service;
  let origins: readonly string[] = [];
  let reloads = 0;
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const event = { senderFrame: { url: 'propr-renderer://app/index.html' } };
  const register = () => registerIpcHandlers({
    app: {},
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => Promise<any>) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    profiles: store, credentials, connectDiscovery: {}, lifecycle: {}, logger: { log() {} },
    desktopSession: { clearStorageData: async () => {} },
    packagedRendererUrl: event.senderFrame.url, openExternal: async () => {},
    onRendererActiveProfileChanged: (origin: string | null | undefined) => {
      const next = rendererPolicyOriginsForSelection(origins, origin);
      if (JSON.stringify(next) !== JSON.stringify(origins)) reloads++;
      origins = next;
    },
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  let ipc = register();
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  const select = async () => {
    const beforeReloads = reloads;
    // Match the renderer's saved-account connect sequence, including its save
    // between the ready probe and activation.
    await invoke(IPC_CHANNELS.profilesSetActive, null);
    assert.equal((await store.list()).activeProfileId, null);
    assert.deepEqual(credentials.prepareRequest(`${profile.apiBaseUrl}/api/tasks`, {}, {
      rendererOwned: true, resourceType: 'xhr',
    }), { cancel: true });
    const probe = await invoke(IPC_CHANNELS.connectionProbe, profile);
    assert.equal(probe.status, 'ready');
    await invoke(IPC_CHANNELS.profilesSave, profile);
    assert.equal(reloads, beforeReloads, 'selection clearing and saving must not reload before activation');
    const active = await invoke(IPC_CHANNELS.connectionActivate, probe.activationTicket);
    assert.equal(active.profileId, profile.id);
    assert.equal((await store.list()).activeProfileId, profile.id);
    assert.equal(credentials.prepareRequest(`${profile.apiBaseUrl}/api/tasks`, {
      [DESKTOP_TRANSPORT_SCOPE_HEADER]: active.transportScope,
    }, { rendererOwned: true, resourceType: 'xhr' }).cancel, undefined);
    return active;
  };
  try {
    const admission = await invoke(IPC_CHANNELS.authenticationPairAdmit, profile.id);
    assert.deepEqual(await invoke(IPC_CHANNELS.authenticationPair, profile, admission.operationId), { paired: true });
    assert.equal((await store.list()).profiles[0].account?.username, 'alice');
    await select();
    assert.equal(reloads, 1, 'first local activation installs its document CSP');
    // The policy reload automatically reconnects the durable active account.
    await select();
    assert.equal(reloads, 1, 'automatic reconnect must not enter a reload loop');
    ipc.dispose();
    await credentials.dispose();
    await store.close();
    store = new ProfileStore(f.directory, encryption);
    credentials = f.createService(store);
    const persisted = await store.list();
    assert.equal(persisted.activeProfileId, profile.id);
    origins = [persisted.profiles[0].apiBaseUrl];
    ipc = register();
    const restarted = await select();
    assert.equal(reloads, 1, 'restart reconnect must keep the connected document');
    await assert.rejects(invoke(IPC_CHANNELS.authLogout, {
      profileId: restarted.profileId, transportScope: 'stale-scope',
    }), /IPC_OPERATION_FAILED/);
    assert.deepEqual(origins, [profile.apiBaseUrl], 'rejected logout must retain the current account policy');
    await invoke(IPC_CHANNELS.authLogout, {
      profileId: restarted.profileId, transportScope: restarted.transportScope,
    });
    assert.deepEqual(origins, [], 'committed logout must narrow the production policy');
    assert.equal((await store.list()).activeProfileId, null);
    assert.equal(await store.readCredential(profile.id), null);
    assert.deepEqual(credentials.prepareRequest(`${profile.apiBaseUrl}/api/tasks`, {
      [DESKTOP_TRANSPORT_SCOPE_HEADER]: restarted.transportScope,
    }, { rendererOwned: true, resourceType: 'xhr' }), { cancel: true });
  } finally {
    ipc.dispose();
    await credentials.dispose();
    await store.close();
    await f.close();
  }
});

for (const origin of ['https://team.test', 'https://other.test']) {
  test(`two approved users switch and reload with isolated credentials: ${origin}`, async () => {
    const f = await fixture();
    try {
      await f.service.pair(first);
      f.user(bob);
      const target = { ...second, apiBaseUrl: origin };
      await f.service.pair(target);
      const a = await f.store.readCredential(first.id);
      const b = await f.store.readCredential(target.id);
      assert.notEqual(a?.token, b?.token);
      assert.deepEqual((await f.store.list()).profiles.map(p => p.account?.id), ['101', '202']);
      const probeA = await f.service.probe(first);
      assert.equal(probeA.status, 'ready');
      if (probeA.status !== 'ready') return;
      const activeA = await f.service.activate(probeA.activationTicket);
      await f.service.setActiveProfile(null);
      assert.equal((await new ProfileStore(f.directory, encryption).list()).activeProfileId, null);
      const probeB = await f.service.probe(target);
      assert.equal(probeB.status, 'ready');
      if (probeB.status !== 'ready') return;
      const activeB = await f.service.activate(probeB.activationTicket);
      assert.deepEqual(f.service.prepareRequest(`${origin}/api/tasks`, { [DESKTOP_TRANSPORT_SCOPE_HEADER]: activeA.transportScope }), { cancel: true });
      assert.deepEqual(f.service.prepareRequest(`${origin}/api/tasks`, { [DESKTOP_TRANSPORT_SCOPE_HEADER]: activeB.transportScope }).requestHeaders, { Authorization: `Bearer ${b?.token}` });
      assert.equal(f.service.isActiveConnectionScope(activeA), false);
      await f.service.removeProfile(first.id);
      assert.equal((await f.store.readCredential(target.id))?.token, b?.token);
      assert.equal((await f.store.list()).activeProfileId, target.id);
      f.denied.add(b!.token);
      assert.equal((await f.service.probe(target)).status, 'offline');
      assert.ok(await f.store.readCredential(target.id));
      f.denied.clear();
      f.expired.add(b!.token);
      assert.equal((await f.service.probe(target)).status, 'authentication-required');
      assert.equal(await f.store.readCredential(target.id), null);
      assert.equal((await f.store.list()).profiles[0].account?.id, '202');
      // Expiry retains the intended account; a different browser user cannot replace it.
      f.user(alice);
      await assert.rejects(f.service.pair(target));
      assert.equal(await f.store.readCredential(target.id), null);
    } finally { await f.close(); }
  });
}

test('confirmation rejects wrong browser account and cancellation leaves the previous credential intact', async () => {
  const f = await fixture();
  try {
    await f.service.pair(first);
    const original = await f.store.readCredential(first.id);
    await f.store.save({ ...first, account: bob } as typeof first);
    assert.equal((await f.store.list()).profiles[0].account?.id, '101');
    f.user(bob);
    await assert.rejects(f.service.pair(first), { code: 'ACCOUNT_MISMATCH' });
    assert.deepEqual(await f.store.readCredential(first.id), original);
    f.confirm(false);
    await assert.rejects(f.service.pair(second));
    assert.equal(await f.store.readCredential(second.id), null);
    assert.equal((await f.store.list()).profiles.length, 1);
    await f.service.saveProfile({ ...first, apiBaseUrl: 'https://other.test' });
    assert.equal((await f.store.list()).profiles[0].account?.id, '101');
    assert.equal(await f.store.readCredential(first.id), null);
    assert.deepEqual(f.confirmations.at(-1), { account: bob, origin: second.apiBaseUrl });
  } finally { await f.close(); }
});

test('a switch during identity confirmation cannot publish the late account', async () => {
  const f = await fixture();
  try {
    let confirm!: (value: boolean) => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    f.holdConfirmation(() => { entered(); return new Promise(resolve => { confirm = resolve; }); });
    const pairing = f.service.pair(first);
    await pending;
    await f.service.setActiveProfile(null);
    confirm(true);
    await assert.rejects(pairing);
    assert.equal(await f.store.readCredential(first.id), null);
    assert.equal((await f.store.list()).activeProfileId, null);
  } finally { await f.close(); }
});

test('identity validation rejects oversized, malformed and cancelled bodies and unsafe avatars', async () => {
  assert.equal(await readAccountResponse(json({ id: 'bad', username: 'alice' }), new AbortController().signal), null);
  assert.equal(await readAccountResponse(json({ ...alice, extra: 'x'.repeat(20_000) }), new AbortController().signal), null);
  assert.deepEqual(await readAccountResponse(json({ ...alice, avatarUrl: 'https://team.test/api/private' }), new AbortController().signal), { ...alice, avatarUrl: null });
  const controller = new AbortController();
  const pending = readAccountResponse(new Response(new ReadableStream({ start() {} })), controller.signal);
  controller.abort();
  assert.equal(await pending, null);
});
