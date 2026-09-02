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

    const unclaimed = service.snapshotIdentityClaim(
      'propr-connect-discovered', 'https://t-discovered123.propr.dev',
    );
    assert.equal(unclaimed.status, 'unclaimed');
    assert.equal(unclaimed.isCurrent(), true);
    const candidates = await service.discover();
    assert.deepEqual(candidates, [{
      id: 'propr-connect-discovered',
      label: 'ProPR Connect',
      apiBaseUrl: 'https://t-discovered123.propr.dev',
    }]);
    const serialized = JSON.stringify(candidates);
    assert.doesNotMatch(serialized, /123e4567|root|path|environment|executable|credential|authority/i);
    const claim = service.snapshotIdentityClaim(
      'propr-connect-discovered', 'https://t-discovered123.propr.dev',
    );
    assert.equal(claim.status, 'claimed');
    if (claim.status === 'claimed') {
      assert.equal(claim.publicInstanceIdentity, readyStatus().publicInstanceIdentity);
      assert.equal(claim.isCurrent(), true);
    }
    assert.equal(unclaimed.isCurrent(), false);
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
    const staleOrigin = service.snapshotIdentityClaim(saved.id, saved.apiBaseUrl);
    assert.equal(staleOrigin.status, 'origin-mismatch');
    assert.equal(staleOrigin.isCurrent(), true);
    const current = service.snapshotIdentityClaim(saved.id, 'https://t-recovered456.propr.dev');
    assert.equal(current.status, 'claimed');
    if (current.status === 'claimed') {
      assert.equal(current.publicInstanceIdentity, readyStatus().publicInstanceIdentity);
      assert.equal(current.isCurrent(), true);
    }
    const firstGeneration = current.status === 'claimed' ? current.generation : -1;
    const releaseCommit = current.beginCommit();
    assert.ok(releaseCommit);
    let rediscoverySettled = false;
    const rediscovery = service.rediscover(saved.id).then(result => {
      rediscoverySettled = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(rediscoverySettled, false);
    assert.equal(current.isCurrent(), false);
    const pending = service.snapshotIdentityClaim(saved.id, 'https://t-recovered456.propr.dev');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.isCurrent(), false);
    assert.equal(pending.beginCommit(), null);
    releaseCommit();
    assert.deepEqual(await rediscovery, {
      id: saved.id,
      label: saved.label,
      apiBaseUrl: 'https://t-recovered456.propr.dev',
    });
    const rotated = service.snapshotIdentityClaim(saved.id, 'https://t-recovered456.propr.dev');
    assert.equal(rotated.status, 'claimed');
    if (rotated.status === 'claimed') assert.ok(rotated.generation > firstGeneration);
    assert.equal(current.isCurrent(), false);
    assert.equal(await service.rediscover('missing-profile'), null);
  });

  it('discards rediscovery when the exact saved profile changes while native discovery awaits', async () => {
    const saved = {
      id: 'saved-profile', label: 'Managed workspace',
      apiBaseUrl: 'https://t-stale123.propr.dev',
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const replacements = [
      null,
      { ...saved, label: 'Edited workspace', updatedAt: '2026-08-02T00:00:00.000Z' },
      { ...saved, apiBaseUrl: 'https://t-replaced999.propr.dev', updatedAt: '2026-08-02T00:00:00.000Z' },
      { ...saved, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
    ];
    for (const replacement of replacements) {
      let reads = 0;
      let resolveDiscovery!: (status: ConnectStatusDocument) => void;
      const discovery = new Promise<ConnectStatusDocument>(resolve => { resolveDiscovery = resolve; });
      const service = new DesktopConnectDiscoveryService({
        list: async () => {
          const currentRead = reads++;
          return {
            profiles: currentRead === 0 ? [saved] : replacement ? [replacement] : [],
            activeProfileId: saved.id,
          };
        },
      }, { supported: true, discover: () => discovery });
      const result = service.rediscover(saved.id);
      await Promise.resolve();
      resolveDiscovery(readyStatus('https://t-recovered456.propr.dev'));
      assert.equal(await result, null);
    }
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
