import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import { DesktopCredentialService, type DesktopPairingBrowserRequest } from './credential-service';
import { openApprovedDesktopPairingUrl } from './pairing-browser';
import { ProfileStore, type EncryptionProvider } from './profile-store';

const pairingId = `dpr_${'A'.repeat(22)}`;
const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
const origin = 'https://api.example.test';
const approvalUrl = `${origin}/api/desktop/pairings/${pairingId}/browser`;
const instanceToken = `propr_it_${'T'.repeat(43)}`;
const temporaryDirectories: string[] = [];
const services: DesktopCredentialService[] = [];

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(value, 'utf8'),
  decrypt: value => value.toString('utf8'),
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

const discovery = {
  schemaVersion: 1 as const,
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  canonicalEndpoint: null,
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  desktopAuthentication: {
    protocolVersion: 2 as const,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};

interface PairingProofOptions {
  beforeProvisional?(): void;
  onRequest?(request: { url: string; authorization: string | null }): void;
}

const createService = async (
  openPairingBrowser: (request: DesktopPairingBrowserRequest) => Promise<void>,
  proof: PairingProofOptions = {},
): Promise<DesktopCredentialService> => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-pairing-sink-'));
  temporaryDirectories.push(directory);
  let binding: Record<string, unknown> = {};
  const service = new DesktopCredentialService({
    profiles: new ProfileStore(directory, encryption),
    clientName: 'Pairing sink test',
    pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
    openPairingBrowser,
    fetch: async (input, init) => {
      const url = input.toString();
      proof.onRequest?.({
        url,
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      if (url === `${origin}/api/desktop/discovery`) return json(discovery);
      if (url === `${origin}/api/desktop/pairings`) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        binding = {
          instanceId: request.instanceId,
          origin: request.origin,
          scope: request.scope,
          credentialGeneration: request.credentialGeneration,
        };
        return json({
          pairingId, deviceSecret: 'D'.repeat(43), approvalUrl,
          expiresAt: new Date(pairingNow + 10_000).toISOString(), interval: 1,
        }, 201);
      }
      if (url.endsWith('/poll')) {
        proof.beforeProvisional?.();
        return json({
          status: 'provisional', token: instanceToken, tokenType: 'Bearer',
          activationTicket: 'K'.repeat(43),
          activationExpiresAt: new Date(pairingNow + 10_000).toISOString(), ...binding,
        });
      }
      if (url.endsWith('/activate')) return json({
        status: 'active', receipt: 'R'.repeat(22),
        activatedAt: '2026-01-01T00:00:01.000Z', expiresAt: null,
      });
      if (url === `${origin}/api/auth/user`) {
        assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${instanceToken}`);
        return json({ username: 'remote-owner' });
      }
      throw new Error('Unexpected pairing request');
    },
  });
  services.push(service);
  return service;
};

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('DesktopCredentialService pairing browser sink', () => {
  it('pairs through the browser journey and rejects a response URL replacement', async () => {
    const opened: string[] = [];
    const requests: Array<{ url: string; authorization: string | null }> = [];
    let browserApproved = false;
    const service = await createService(request => openApprovedDesktopPairingUrl(request, {
      openExternal: async url => {
        opened.push(url);
        // Models the explicit approval click in the independently authenticated
        // system browser. The polling fixture refuses to issue a provisional
        // credential until this manual browser step has completed.
        browserApproved = true;
      },
    }), {
      beforeProvisional: () => assert.equal(browserApproved, true),
      onRequest: request => requests.push(request),
    });

    const profile = { id: 'profile-a', label: 'Remote ProPR', apiBaseUrl: origin };
    const initialProbe = await service.probe(profile);
    assert.equal(initialProbe.status, 'authentication-required');
    const paired = await service.pair(profile);
    const probed = await service.probe(profile);
    assert.equal(probed.status, 'ready');
    if (probed.status !== 'ready') return;
    const activated = await service.activate(probed.activationTicket);

    assert.deepEqual(paired, { paired: true });
    assert.deepEqual(opened, [approvalUrl]);
    assert.deepEqual(requests.map(request => request.url), [
      `${origin}/api/desktop/discovery`,
      `${origin}/api/desktop/discovery`,
      `${origin}/api/desktop/pairings`,
      `${origin}/api/desktop/pairings/${pairingId}/poll`,
      `${origin}/api/desktop/pairings/${pairingId}/activate`,
      `${origin}/api/desktop/discovery`,
      `${origin}/api/auth/user`,
    ]);
    assert.deepEqual(requests.map(request => request.authorization), [
      null, null, null, null, null, null, `Bearer ${instanceToken}`,
    ]);
    assert.deepEqual(service.prepareRequest(
      `${origin}/api/tasks`,
      { [DESKTOP_TRANSPORT_SCOPE_HEADER]: activated.transportScope },
    ).requestHeaders, { Authorization: `Bearer ${instanceToken}` });
    assert.equal(JSON.stringify([initialProbe, paired, probed, activated, opened]).includes(instanceToken), false);

    const replacedOpened: string[] = [];
    const replacedService = await createService(request => openApprovedDesktopPairingUrl({
      ...request,
      approvalUrl: `${origin}/api/desktop/pairings/dpr_${'B'.repeat(22)}/browser`,
    }, { openExternal: async url => { replacedOpened.push(url); } }));

    await assert.rejects(
      replacedService.pair({ id: 'profile-a', label: 'A', apiBaseUrl: origin }),
      /Desktop pairing browser request was rejected/,
    );
    assert.deepEqual(replacedOpened, []);
  });
});
