import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectStatusDocument } from '@propr/cli/desktop-discovery';
import { DesktopConnectDiscoveryService } from './connect-discovery';

const readyStatus = (endpoint = 'https://t-discovered123.propr.dev'): ConnectStatusDocument => ({
  schemaVersion: 1,
  status: 'ready',
  canonicalEndpoint: endpoint,
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  configured: true,
  enabled: true,
  sidecarRunning: true,
  apiReady: true,
  restartRequired: false,
  compatibility: '2026-08-01',
  version: '0.8.15',
  reasonCodes: [],
});

describe('desktop fixed-root Connect discovery', () => {
  it('projects only a stable opaque profile and canonical endpoint', async () => {
    const service = new DesktopConnectDiscoveryService({
      list: async () => ({ profiles: [], activeProfileId: null }),
    }, {
      supported: true,
      discover: async () => readyStatus(),
    });

    const candidates = await service.discover();
    assert.deepEqual(candidates, [{
      id: 'propr-connect-discovered',
      label: 'ProPR Connect',
      apiBaseUrl: 'https://t-discovered123.propr.dev',
    }]);
    const serialized = JSON.stringify(candidates);
    assert.doesNotMatch(serialized, /123e4567|root|path|environment|executable|credential|authority/i);
  });

  it('fences rediscovery to an existing managed profile and preserves its id and label', async () => {
    const saved = {
      id: 'saved-profile',
      label: 'Managed workspace',
      apiBaseUrl: 'https://t-stale123.propr.dev',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const service = new DesktopConnectDiscoveryService({
      list: async () => ({ profiles: [saved], activeProfileId: saved.id }),
    }, {
      supported: true,
      discover: async () => readyStatus('https://t-recovered456.propr.dev'),
    });

    assert.deepEqual(await service.rediscover(saved.id), {
      id: saved.id,
      label: saved.label,
      apiBaseUrl: 'https://t-recovered456.propr.dev',
    });
    assert.equal(await service.rediscover('missing-profile'), null);
  });

  it('fails closed for unsupported hosts and malformed native results', async () => {
    const profiles = { list: async () => ({ profiles: [], activeProfileId: null }) };
    await assert.rejects(
      new DesktopConnectDiscoveryService(profiles, {
        supported: false,
        discover: async () => readyStatus(),
      }).discover(),
      /unavailable/,
    );
    assert.deepEqual(await new DesktopConnectDiscoveryService(profiles, {
      supported: true,
      discover: async () => ({ ...readyStatus(), canonicalEndpoint: 'https://T-bad.propr.dev' }),
    }).discover(), []);
  });
});
