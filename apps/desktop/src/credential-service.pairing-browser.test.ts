import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { DesktopCredentialService, type DesktopPairingBrowserRequest } from './credential-service';
import { openApprovedDesktopPairingUrl } from './pairing-browser';
import { ProfileStore, type EncryptionProvider } from './profile-store';

const pairingId = `dpr_${'A'.repeat(22)}`;
const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
const origin = 'https://api.example.test';
const approvalUrl = `${origin}/api/desktop/pairings/${pairingId}/browser`;
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

const createService = async (
  openPairingBrowser: (request: DesktopPairingBrowserRequest) => Promise<void>,
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
      if (url === `${origin}/api/desktop/discovery`) return json({
        schemaVersion: 1,
        product: 'ProPR',
        version: '0.8.15',
        apiCompatibility: PROPR_API_COMPATIBILITY,
        uiCompatibility: PROPR_UI_COMPATIBILITY,
        canonicalEndpoint: null,
        publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
        desktopAuthentication: {
          protocolVersion: 2,
          browserPairing: true,
          instanceBearerTokens: true,
          socketIoBearerAuthentication: true,
        },
      });
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
      if (url.endsWith('/poll')) return json({
        status: 'provisional', token: `propr_it_${'T'.repeat(43)}`, tokenType: 'Bearer',
        activationTicket: 'K'.repeat(43),
        activationExpiresAt: new Date(pairingNow + 10_000).toISOString(), ...binding,
      });
      if (url.endsWith('/activate')) return json({
        status: 'active', receipt: 'R'.repeat(22),
        activatedAt: '2026-01-01T00:00:01.000Z', expiresAt: null,
      });
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
  it('binds the API base, pairing id, and response URL through the final shell validator', async () => {
    const opened: string[] = [];
    const service = await createService(request => openApprovedDesktopPairingUrl(request, {
      openExternal: async url => { opened.push(url); },
    }));

    assert.deepEqual(await service.pair({ id: 'profile-a', label: 'A', apiBaseUrl: origin }), { paired: true });
    assert.deepEqual(opened, [approvalUrl]);
  });

  it('rejects a URL replaced after the credential service receives the API response', async () => {
    const opened: string[] = [];
    const service = await createService(request => openApprovedDesktopPairingUrl({
      ...request,
      approvalUrl: `${origin}/api/desktop/pairings/dpr_${'B'.repeat(22)}/browser`,
    }, { openExternal: async url => { opened.push(url); } }));

    await assert.rejects(
      service.pair({ id: 'profile-a', label: 'A', apiBaseUrl: origin }),
      /Desktop pairing browser request was rejected/,
    );
    assert.deepEqual(opened, []);
  });
});
