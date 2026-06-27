import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PROPR_UI_PROXY_SUFFIX as SHARED_PROXY_SUFFIX,
  DEFAULT_CLOUDFLARED_IMAGE as SHARED_CLOUDFLARED_IMAGE,
  DEFAULT_PROPR_UI_ORIGIN as SHARED_PROPR_UI_ORIGIN,
  PROPR_VERSION,
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
      'https://foo.bar.proxy.propr.dev',
      'https://.proxy.propr.dev',
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

// The release version and the pinned cloudflared tag are duplicated across the
// launcher manifest and shared constants. A release bump (or image re-pin) that
// updates one but not the others would ship inconsistent metadata, so assert the
// single sources of truth agree with the manifest.
describe('release metadata stays in sync with the launcher manifest', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url)), 'utf8'),
  ) as { version: string; images: { cloudflared: string } };
  const sharedPkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../packages/shared/package.json', import.meta.url)), 'utf8'),
  ) as { version: string };

  test('PROPR_VERSION matches manifest.version', () => {
    assert.equal(PROPR_VERSION, manifest.version);
  });

  // PROPR_VERSION is hand-maintained in proprCompatibility.ts, but the real
  // release source of truth is the package version. Asserting both ends here
  // means a release bump that updates package.json (or the manifest) but forgets
  // the constant fails CI instead of silently shipping a stale public version.
  test('PROPR_VERSION matches the shared package.json version', () => {
    assert.equal(PROPR_VERSION, sharedPkg.version);
  });

  test('manifest cloudflared image matches DEFAULT_CLOUDFLARED_IMAGE', () => {
    assert.equal(manifest.images.cloudflared, SHARED_CLOUDFLARED_IMAGE);
  });
});
