import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopCredentialService } from '../src/credential-service.ts';
import { ProfileStore } from '../src/profile-store.ts';
import { createPackagedConnectAccountConfirmation } from '../src/packaged-connect-account-confirmation.ts';
import { createPackagedJourneyFixture, PACKAGED_CONNECT_ACCOUNT } from './packaged-connect-journey-fixture.mjs';
import { collectPackagedConnectAccountEvidence } from './packaged-connect-evidence.mjs';

// Unit/integration-only storage. The native smoke still requires the real OS backend.
const encryption = {
  isEncryptionAvailable: () => true, backend: () => 'keychain',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString(),
};
const confirmationPath = '/api/auth/user?desktop_account_confirmation=1';

for (const delay of [0, 300]) {
  test(`real credential service pairs and reprobes against Connect fixture (approval delay ${delay}ms)`, async () => {
    const fixture = await createPackagedJourneyFixture({ approvalReadinessDelayMs: delay });
    const directory = await mkdtemp(join(tmpdir(), 'propr-connect-account-test-'));
    const profiles = new ProfileStore(directory, encryption);
    const confirmation = createPackagedConnectAccountConfirmation(fixture.endpoint, 'pair');
    let service;
    try {
      const profile = { id: 'packaged-remote', label: 'Packaged remote', apiBaseUrl: fixture.endpoint };
      service = new DesktopCredentialService({
        profiles, clientName: 'Packaged Connect regression', fetch,
        openPairingBrowser: async ({ approvalUrl }) => {
          assert.equal((await fetch(approvalUrl, { credentials: 'omit' })).status, 200);
        },
        confirmAccount: async (account, origin, signal) => {
          assert.deepEqual(account, PACKAGED_CONNECT_ACCOUNT);
          // A browser-approved, activated token is still transient until host confirmation.
          assert.equal(await profiles.readCredential(profile.id), null);
          assert.equal((await profiles.list()).profiles.length, 0);
          return confirmation.confirm(account, origin, signal);
        },
      });
      assert.equal((await service.probe(profile)).status, 'authentication-required');
      await service.pair(profile);
      confirmation.assertComplete();
      assert.deepEqual((await profiles.list()).profiles[0].account, PACKAGED_CONNECT_ACCOUNT);
      assert.equal((await service.probe(profile)).status, 'ready');
      await service.dispose();
      await profiles.close();
      const reloaded = new ProfileStore(directory, encryption);
      const reprobeConfirmation = createPackagedConnectAccountConfirmation(fixture.endpoint, 'reprobe');
      service = new DesktopCredentialService({
        profiles: reloaded, clientName: 'Fresh Connect reprobe', fetch,
        openPairingBrowser: async () => assert.fail('reprobe must reuse the saved credential'),
        confirmAccount: reprobeConfirmation.confirm,
      });
      try {
        assert.equal((await service.probe(profile)).status, 'ready');
        reprobeConfirmation.assertComplete();
        assert.deepEqual(collectPackagedConnectAccountEvidence({
          requests: fixture.requests, authorization: `Bearer ${fixture.secrets[2]}`,
        }), {
          accountConfirmationCount: 1, accountProbeCount: 2,
          accountRequestBoundaryValid: true, accountConfirmationOrderValid: true,
        });
      } finally { await service.dispose(); await reloaded.close(); }
    } finally {
      await service?.dispose(); await profiles.close(); await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('fixture rejects unauthenticated, provisional, malformed, and scope-bearing identity requests', async () => {
  const f = await createPackagedJourneyFixture();
  const bearer = { Authorization: `Bearer ${f.secrets[2]}` };
  const post = (path, body) => fetch(`${f.endpoint}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(`${f.endpoint}${confirmationPath}`, { headers: bearer })).status, 401);
    const binding = { instanceId: 'test', origin: f.endpoint, scope: 'instance', credentialGeneration: 1 };
    const pairing = await (await post('/api/desktop/pairings', binding)).json();
    const activatePath = `/api/desktop/pairings/${pairing.pairingId}/activate`;
    const activation = { deviceSecret: f.secrets[0], activationTicket: f.secrets[1] };
    assert.equal((await post(activatePath, activation)).status, 400);
    await fetch(pairing.approvalUrl);
    await post(`/api/desktop/pairings/${pairing.pairingId}/poll`, { deviceSecret: f.secrets[0] });
    assert.equal((await fetch(`${f.endpoint}${confirmationPath}`, { headers: bearer })).status, 401);
    assert.equal((await post(activatePath, activation)).status, 200);
    for (const path of [confirmationPath, '/api/auth/user', '/api/auth/user?proprDesktopScopeGeneration=1']) {
      assert.equal((await fetch(`${f.endpoint}${path}`)).status, 401);
      for (const headers of [{ Authorization: 'Bearer wrong' }, { ...bearer, Cookie: 'session=wrong' },
        { ...bearer, 'X-ProPR-Desktop-Transport-Scope': 'renderer-scope' }]) {
        assert.equal((await fetch(`${f.endpoint}${path}`, { headers })).status, 401);
      }
      const response = await fetch(`${f.endpoint}${path}`, { headers: bearer });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, PACKAGED_CONNECT_ACCOUNT.id);
    }
    for (const path of ['/api/auth/user?desktop_account_confirmation=0', `${confirmationPath}&extra=1`,
      '/api/auth/user?proprDesktopScopeGeneration=2']) {
      assert.equal((await fetch(`${f.endpoint}${path}`, { headers: bearer })).status, 401);
    }
  } finally { await f.close(); }
});

for (const failure of ['malformed-account', 'denied-admission', 'cancelled-confirmation']) {
  test(`Connect pairing keeps the credential uncommitted on ${failure}`, async () => {
    const f = await createPackagedJourneyFixture();
    const directory = await mkdtemp(join(tmpdir(), 'propr-connect-account-test-'));
    const profiles = new ProfileStore(directory, encryption);
    let confirmed = 0;
    const service = new DesktopCredentialService({
      profiles, clientName: 'Rejected Connect regression',
      openPairingBrowser: async ({ approvalUrl }) => { await fetch(approvalUrl); },
      confirmAccount: async () => { confirmed++; return false; },
      fetch: async (input, init) => {
        if (input.toString().endsWith(confirmationPath) && failure !== 'cancelled-confirmation') {
          return new Response(JSON.stringify(failure === 'malformed-account' ? {} : { code: 'INSUFFICIENT_INSTANCE_PERMISSION' }),
            { status: failure === 'malformed-account' ? 200 : 403 });
        }
        return fetch(input, init);
      },
    });
    try {
      await assert.rejects(service.pair({ id: 'remote', label: 'Remote', apiBaseUrl: f.endpoint }), {
        code: failure === 'cancelled-confirmation' ? 'PAIRING_CANCELLED' : 'PAIRING_REJECTED',
      });
      assert.equal(confirmed, failure === 'cancelled-confirmation' ? 1 : 0);
      assert.equal(await profiles.readCredential('remote'), null);
      assert.equal((await profiles.list()).profiles.length, 0);
    } finally {
      await service.dispose(); await profiles.close(); await f.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
