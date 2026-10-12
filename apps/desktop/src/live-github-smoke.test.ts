import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeLiveGithubSmoke, isExpectedLiveSmokeAccount } from './live-github-smoke';

const base = {
  argv: ['propr-desktop'], environment: {}, isPackaged: true, platform: 'linux', appData: '/home/user/.config',
};
test('ordinary Desktop launches have no live smoke bridge', () => {
  assert.equal(authorizeLiveGithubSmoke(base), null);
});
test('live smoke requires both explicit authorization and private packaged Linux paths', () => {
  for (const options of [
    { ...base, argv: ['propr-desktop', '--propr-live-github-smoke'] },
    { ...base, environment: { PROPR_DESKTOP_LIVE_GITHUB_SMOKE: '1' } },
    { ...base, argv: ['propr-desktop', '--propr-live-github-smoke'], isPackaged: false,
      environment: { PROPR_DESKTOP_LIVE_GITHUB_SMOKE: '1', PROPR_LIVE_PRIVATE_DBUS: '1' } },
    { ...base, argv: ['propr-desktop', '--propr-live-github-smoke'], platform: 'darwin',
      environment: { PROPR_DESKTOP_LIVE_GITHUB_SMOKE: '1', PROPR_LIVE_PRIVATE_DBUS: '1' } },
  ]) assert.throws(() => authorizeLiveGithubSmoke(options), /^Error: Live GitHub smoke authorization rejected$/);
});
test('native confirmed identity is exact and bound to the configured staging endpoint', () => {
  assert.equal(isExpectedLiveSmokeAccount('propr-ultrafix', 'https://staging.propr.dev', 'https://staging.propr.dev'), true);
  for (const username of ['integry', 'PROPR-ULTRAFIX', 'propr-ultrafix ', '']) {
    assert.equal(isExpectedLiveSmokeAccount(username, 'https://staging.propr.dev', 'https://staging.propr.dev'), false);
  }
  assert.equal(isExpectedLiveSmokeAccount('propr-ultrafix', 'https://api.propr.dev', 'https://staging.propr.dev'), false);
});
