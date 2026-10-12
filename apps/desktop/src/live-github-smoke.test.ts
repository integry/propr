import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { authorizeLiveGithubSmoke, isExpectedLiveSmokeAccount, LIVE_SMOKE_ACCOUNT, hasPrivateLiveSmokeDebugger } from './live-github-smoke';

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
  assert.equal(isExpectedLiveSmokeAccount(LIVE_SMOKE_ACCOUNT, 'https://staging.propr.dev', 'https://staging.propr.dev'), true);
  for (const username of ['integry', 'PROPR-ULTRAFIX', 'propr-ultrafix ', '']) {
    assert.equal(isExpectedLiveSmokeAccount({ ...LIVE_SMOKE_ACCOUNT, username }, 'https://staging.propr.dev', 'https://staging.propr.dev'), false);
  }
  assert.equal(isExpectedLiveSmokeAccount(LIVE_SMOKE_ACCOUNT, 'https://api.propr.dev', 'https://staging.propr.dev'), false);
});

test('native and harness identity pins agree and reclaimed login is rejected', async () => {
  const harness = await import(/* @vite-ignore */ '../scripts/' + 'live-github-smoke.mjs');
  assert.deepEqual(LIVE_SMOKE_ACCOUNT, harness.EXPECTED_ACCOUNT);
  assert.equal(isExpectedLiveSmokeAccount({ ...LIVE_SMOKE_ACCOUNT, id: '123' },
    'https://staging.propr.dev', 'https://staging.propr.dev'), false);
});


test('smoke authorization refuses TCP debugging and main explicitly selects libsecret', () => {
  assert.equal(hasPrivateLiveSmokeDebugger(['propr-desktop', '--remote-debugging-pipe']), true);
  for (const argv of [[], ['--remote-debugging-port=9222'],
    ['--remote-debugging-pipe', '--remote-debugging-port=9222'],
    ['--remote-debugging-pipe', '--remote-debugging-address=127.0.0.1'],
    ['--remote-debugging-pipe', '--remote-debugging-pipe'],
    ['--remote-debugging-pipe', '--remote-debugging-pipe=unexpected']]) {
    assert.equal(hasPrivateLiveSmokeDebugger(argv), false);
  }
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(liveGithubSmoke\) app\.commandLine\.appendSwitch\('password-store', 'gnome-libsecret'\)/);
  assert.ok(main.indexOf("appendSwitch('password-store'") < main.indexOf('app.whenReady()'));
});
