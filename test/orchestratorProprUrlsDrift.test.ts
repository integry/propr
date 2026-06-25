import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPR_UI_PROXY_SUFFIX as SHARED_PROXY_SUFFIX,
  DEFAULT_CLOUDFLARED_IMAGE as SHARED_CLOUDFLARED_IMAGE,
  proprInstanceProxyUrl as sharedProxyUrl,
  isValidProprInstanceId as sharedIsValidId,
} from '@propr/shared';

// The orchestrator is dependency-free .mjs and cannot import @propr/shared, so
// it mirrors the proxy suffix, default cloudflared image, and instance-id
// helpers as local copies. This test fails the moment those copies drift from
// the shared source of truth.
import {
  PROPR_UI_PROXY_SUFFIX as LAUNCHER_PROXY_SUFFIX,
  DEFAULT_CLOUDFLARED_IMAGE as LAUNCHER_CLOUDFLARED_IMAGE,
  proprInstanceProxyUrl as launcherProxyUrl,
  isValidProprInstanceId as launcherIsValidId,
} from '../docker/launcher/orchestrator.mjs';

describe('launcher hosted-UI constants stay in sync with @propr/shared', () => {
  test('mirrored literals match the shared constants', () => {
    assert.equal(LAUNCHER_PROXY_SUFFIX, SHARED_PROXY_SUFFIX);
    assert.equal(LAUNCHER_CLOUDFLARED_IMAGE, SHARED_CLOUDFLARED_IMAGE);
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
});
