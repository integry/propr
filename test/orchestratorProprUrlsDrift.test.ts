import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPR_UI_PROXY_SUFFIX as SHARED_PROXY_SUFFIX,
  DEFAULT_CLOUDFLARED_IMAGE as SHARED_CLOUDFLARED_IMAGE,
  DEFAULT_PROPR_UI_ORIGIN as SHARED_PROPR_UI_ORIGIN,
  proprInstanceProxyUrl as sharedProxyUrl,
  isValidProprInstanceId as sharedIsValidId,
  isProprProxyUrl as sharedIsProxyUrl,
  proprTunnelEndpoints as sharedTunnelEndpoints,
} from '@propr/shared';

// The orchestrator is dependency-free .mjs and cannot import @propr/shared, so
// it mirrors the proxy suffix, default cloudflared image, and instance-id
// helpers as local copies. This test fails the moment those copies drift from
// the shared source of truth.
import {
  PROPR_UI_PROXY_SUFFIX as LAUNCHER_PROXY_SUFFIX,
  DEFAULT_CLOUDFLARED_IMAGE as LAUNCHER_CLOUDFLARED_IMAGE,
  DEFAULT_PROPR_UI_ORIGIN as LAUNCHER_PROPR_UI_ORIGIN,
  proprInstanceProxyUrl as launcherProxyUrl,
  isValidProprInstanceId as launcherIsValidId,
  isProprProxyUrl as launcherIsProxyUrl,
  proprTunnelEndpoints as launcherTunnelEndpoints,
} from '../docker/launcher/orchestrator.mjs';

describe('launcher hosted-UI constants stay in sync with @propr/shared', () => {
  test('mirrored literals match the shared constants', () => {
    assert.equal(LAUNCHER_PROXY_SUFFIX, SHARED_PROXY_SUFFIX);
    assert.equal(LAUNCHER_CLOUDFLARED_IMAGE, SHARED_CLOUDFLARED_IMAGE);
    assert.equal(LAUNCHER_PROPR_UI_ORIGIN, SHARED_PROPR_UI_ORIGIN);
  });

  test('proprInstanceProxyUrl agrees for valid, blank, and invalid ids', () => {
    const cases = ['abc123', 'a', 'with-hyphen', '', '   ', null, undefined, 'bad id', 'has/slash', 'under_score', 'has.dot', '-leading', 'trailing-'];
    for (const id of cases) {
      assert.equal(
        launcherProxyUrl(id as string | undefined),
        sharedProxyUrl(id as string | undefined),
        `proxy URL diverged for ${JSON.stringify(id)}`,
      );
    }
  });

  test('isValidProprInstanceId agrees across the same cases', () => {
    const cases = ['abc123', 'a', 'with-hyphen', '', '   ', 'bad id', 'has/slash', 'under_score', 'has.dot', '-leading', 'trailing-', 'A'.repeat(63), 'A'.repeat(64)];
    for (const id of cases) {
      assert.equal(
        launcherIsValidId(id),
        sharedIsValidId(id),
        `validity diverged for ${JSON.stringify(id)}`,
      );
    }
  });

  test('isProprProxyUrl agrees for proxy, non-proxy, and malformed URLs', () => {
    const cases = [
      'https://abc123.proxy.propr.dev',
      'https://abc123.proxy.propr.dev/',
      'https://app.propr.dev',
      'http://abc123.proxy.propr.dev',
      'https://abc123.example.com',
      'https://proxy.propr.dev',
      'not a url',
      '',
      null,
      undefined,
    ];
    for (const url of cases) {
      assert.equal(
        launcherIsProxyUrl(url as string | undefined),
        sharedIsProxyUrl(url as string | undefined),
        `isProprProxyUrl diverged for ${JSON.stringify(url)}`,
      );
    }
  });

  test('proprTunnelEndpoints agrees, including trailing-slash normalization', () => {
    const cases = ['https://abc123.proxy.propr.dev', 'https://abc123.proxy.propr.dev/', 'https://abc123.proxy.propr.dev///'];
    for (const url of cases) {
      assert.deepEqual(
        launcherTunnelEndpoints(url),
        sharedTunnelEndpoints(url),
        `proprTunnelEndpoints diverged for ${JSON.stringify(url)}`,
      );
    }
  });
});
