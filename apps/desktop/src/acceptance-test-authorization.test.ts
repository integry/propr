import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorizePackagedAcceptanceTest } from './acceptance-test-authorization';

const input = {
  argv: ['app', '--propr-acceptance-test', '--user-data-dir=/tmp/propr-desktop-acceptance-a1'],
  defaultUserDataDirectory: '/tmp/default',
  environmentTriggered: true,
  isPackaged: true,
  platform: 'linux' as const,
};

describe('packaged acceptance authorization', () => {
  it('accepts only the dual-trigger packaged Linux launch with an isolated profile', () => {
    assert.equal(authorizePackagedAcceptanceTest(input), '/tmp/propr-desktop-acceptance-a1');
    assert.equal(authorizePackagedAcceptanceTest({ ...input, argv: ['app'], environmentTriggered: false }), null);
  });

  it('fails closed for partial triggers, other platforms, and the default profile', () => {
    assert.throws(() => authorizePackagedAcceptanceTest({ ...input, environmentTriggered: false }), /both/);
    assert.throws(() => authorizePackagedAcceptanceTest({ ...input, platform: 'darwin' }), /Linux/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', '--user-data-dir=/tmp/default'],
    }), /must use/);
  });
});
