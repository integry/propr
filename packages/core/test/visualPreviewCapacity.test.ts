import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { detectGitHubAttachmentPlan, githubAttachmentLimitBytes, githubInlineEligibility, resolveGitHubAttachmentCapacity, resolveVisualPreviewOriginalAssetCapacity, resolveVisualPreviewOriginalCapacity, VISUAL_PREVIEW_CONTENT_TYPES, MIB } from '@propr/shared';
import { loadGitHubAttachmentCapacity } from '../src/services/visualPreviewCapacityService.js';
import { normalizeStoredVisualPreviewSettings } from '../src/config/configManager.js';
import { db } from '../src/db/connection.js';

after(async () => { await db.destroy(); });

for (const override of ['auto', 'free', 'paid'] as const) {
  for (const detected of ['unknown', 'free', 'paid'] as const) {
    test(`${override} override with ${detected} detection applies media-specific limits`, () => {
      const capacity = resolveGitHubAttachmentCapacity(override, detected);
      const paid = override === 'paid' || (override === 'auto' && detected === 'paid');
      for (const type of Object.values(VISUAL_PREVIEW_CONTENT_TYPES)) {
        assert.equal(githubAttachmentLimitBytes(type, capacity), (type.startsWith('video/') && paid ? 100 : 10) * MIB);
      }
      for (const type of ['application/pdf', 'image/bmp', 'video/avi', 'application/octet-stream', '']) {
        assert.equal(githubAttachmentLimitBytes(type, capacity), null);
      }
      assert.equal(capacity.effectivePlan, paid ? 'paid' : 'free');
      assert.equal(capacity.source, override !== 'auto' ? 'override' : detected === 'unknown' ? 'conservative-fallback' : 'detected');
    });
  }
}

test('auto recognizes only explicit known plans and defaults conservatively', () => {
  for (const input of [undefined, null, {}, { plan: 'paid' }, { plan: { name: 'business' } }, { plan: { name: 'unknown', private_repos: 100 } }, { site_admin: true }, { company: 'Paid company' }]) {
    assert.equal(detectGitHubAttachmentPlan(input), 'unknown');
  }
  for (const name of ['pro', 'team', 'enterprise', 'Medium']) assert.equal(detectGitHubAttachmentPlan({ plan: { name } }), 'paid');
  assert.equal(detectGitHubAttachmentPlan({ plan: { name: 'free' } }), 'free');
  assert.equal(resolveGitHubAttachmentCapacity().override, 'auto');
  assert.equal(resolveGitHubAttachmentCapacity('invalid').source, 'conservative-fallback');
});

test('stored settings retain override but discard client-supplied resolved paid status', () => {
  const settings = normalizeStoredVisualPreviewSettings({ enabled: true, types: ['video'], githubAttachmentPlan: 'free', githubAttachmentCapacity: resolveGitHubAttachmentCapacity('paid'), originalEvidenceCapability: { maxBytes: 500 * MIB } });
  assert.equal(settings.githubAttachmentPlan, 'free');
  assert.equal(settings.githubAttachmentCapacity, undefined);
  assert.equal(settings.originalEvidenceCapability, undefined);
});

test('managed original capacity honors server limits independently of GitHub plans and caps staging at 500 MiB', () => {
  const allowedContentTypes = Object.values(VISUAL_PREVIEW_CONTENT_TYPES);
  for (const plan of ['auto', 'free', 'paid'] as const) {
    for (const maxBytes of [20 * MIB, 500 * MIB, 600 * MIB]) {
      assert.deepEqual(resolveVisualPreviewOriginalCapacity({ maxBytes, allowedContentTypes }, resolveGitHubAttachmentCapacity(plan)), {
        source: 'managed-storage', imageLimitBytes: Math.min(maxBytes, 500 * MIB), videoLimitBytes: Math.min(maxBytes, 500 * MIB),
      });
    }
  }
});

test('missing or invalid original capabilities retain conservative legacy staging', () => {
  for (const capability of [undefined, ...[0, -1, NaN, Infinity, 0.5].map(maxBytes => ({ maxBytes, allowedContentTypes: ['image/png'] }))]) {
    assert.deepEqual(resolveVisualPreviewOriginalCapacity(capability), {
      source: 'legacy', imageLimitBytes: 10 * MIB, videoLimitBytes: 10 * MIB,
    });
    assert.equal(resolveVisualPreviewOriginalCapacity(capability, resolveGitHubAttachmentCapacity('paid')).videoLimitBytes, 100 * MIB);
  }
});

test('managed original capacity applies only to exact allowed content types', () => {
  const githubCapacity = resolveGitHubAttachmentCapacity('paid');
  const capability = { maxBytes: 250 * MIB, allowedContentTypes: ['image/png'] };
  assert.deepEqual(resolveVisualPreviewOriginalAssetCapacity('image/png', capability, githubCapacity), {
    source: 'managed-storage', limitBytes: 250 * MIB,
  });
  assert.deepEqual(resolveVisualPreviewOriginalAssetCapacity('image/jpeg', capability, githubCapacity), {
    source: 'legacy', limitBytes: 10 * MIB,
  });
  assert.deepEqual(resolveVisualPreviewOriginalAssetCapacity('video/mp4', capability, githubCapacity), {
    source: 'legacy', limitBytes: 100 * MIB,
  });
});

test('inline eligibility carries structured reasons independently of original capacity', () => {
  assert.deepEqual(githubInlineEligibility('image/png', 10 * MIB), { eligible: true, limitBytes: 10 * MIB });
  assert.deepEqual(githubInlineEligibility('image/png', 10 * MIB + 1), { eligible: false, reason: 'size-limit-exceeded', limitBytes: 10 * MIB });
  assert.deepEqual(githubInlineEligibility('application/pdf', 1), { eligible: false, reason: 'unsupported-content-type', limitBytes: null });
  for (const size of [0, -1, NaN, Infinity]) assert.equal(githubInlineEligibility('video/mp4', size).eligible, false);
});

test('detection uses only GET /user for a repository owned by the authenticated user', async () => {
  const requests: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  const result = await loadGitHubAttachmentCapacity('auto', 'Integry/propr', {
    resolveToken: async () => 'existing-upload-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ login: 'integry', plan: { name: 'pro' } }));
    },
  });
  assert.equal(result.effectivePlan, 'paid');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.github.com/user');
  assert.equal(requests[0].init?.method, 'GET');
  assert.deepEqual(requests[0].init?.headers, { Accept: 'application/vnd.github+json', Authorization: 'Bearer existing-upload-token', 'User-Agent': 'ProPR' });
  assert.equal(requests[0].init?.body, undefined);
});

test('auto does not apply the authenticated user plan to repositories owned by other users or organizations', async () => {
  for (const repository of ['other-user/project', 'acme-organization/project']) {
    const result = await loadGitHubAttachmentCapacity('auto', repository, {
      resolveToken: async () => 'existing-token',
      fetch: async () => new Response(JSON.stringify({ login: 'credential-user', plan: { name: 'pro' } })),
    });
    assert.equal(result.source, 'conservative-fallback');
    assert.equal(result.effectivePlan, 'free');
    assert.equal(result.videoLimitBytes, 10 * MIB);
  }
});

test('missing, denied, unavailable, ambiguous, and malformed detection falls back without retries or auth changes', async () => {
  for (const fetcher of [
    async () => new Response('{}'),
    async () => new Response('{"plan":{"name":"unrecognized"}}'),
    async () => new Response('denied', { status: 403 }),
    async () => new Response('bad credentials', { status: 401 }),
    async () => new Response('not json'),
    async () => { throw new Error('network unavailable'); },
  ]) {
    let calls = 0;
    const result = await loadGitHubAttachmentCapacity('auto', 'integry/propr', {
      resolveToken: async () => 'existing-token',
      fetch: async () => { calls++; return fetcher(); },
    });
    assert.equal(result.source, 'conservative-fallback');
    assert.equal(result.videoLimitBytes, 10 * MIB);
    assert.equal(calls, 1);
  }
  const missing = await loadGitHubAttachmentCapacity('auto', 'integry/propr', { resolveToken: async () => { throw new Error('missing'); }, fetch: async () => { assert.fail('must not fetch without credentials'); } });
  assert.equal(missing.source, 'conservative-fallback');
});

test('auto without a valid target repository falls back without reading credentials', async () => {
  for (const repository of [undefined, '', 'missing-repository', '/missing-owner']) {
    const result = await loadGitHubAttachmentCapacity('auto', repository, {
      resolveToken: async () => { assert.fail('auto must not inspect an unrelated credential owner'); },
      fetch: async () => { assert.fail('auto must not fetch without a target repository owner'); },
    });
    assert.equal(result.source, 'conservative-fallback');
  }
});

test('explicit overrides do not need credentials or additional API access', async () => {
  for (const override of ['free', 'paid'] as const) {
    const result = await loadGitHubAttachmentCapacity(override, 'integry/propr', { resolveToken: async () => { assert.fail('override must not read credentials'); }, fetch: async () => { assert.fail('override must not fetch'); } });
    assert.equal(result.effectivePlan, override);
    assert.equal(result.source, 'override');
  }
});
