/**
 * Device sign-in (#3867): a start whose GitHub code request is answered after
 * a newer start (another tab of the same browser) must neither show its code
 * nor displace the newer attempt, whether GitHub answered with a code or an
 * error. A Cancel for an attempt the pending start replaced must not affect it. Run with:
 * `NODE_ENV=test npx tsx --test packages/api/test/deviceAuthStartRaces.test.ts`
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  ACCESS_TOKEN,
  Browser,
  REFRESH_TOKEN,
  hold,
  startHarness,
  tokenCalls,
  until,
  type Harness,
} from './deviceAuthHarness.js';

after(async () => {
  await closeConnection();
});

const AUTHORIZED = { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28_800 };
const OLDER_CODE = {
  device_code: 'older-device-code', user_code: 'OLDR-CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
};
const NEWER_CODE = {
  device_code: 'newer-device-code', user_code: 'NEWR-CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
};
const DISABLED = { error: 'device_flow_disabled', error_description: 'Device flow is disabled' };

function codeRequests(harness: Harness): number {
  return harness.github.calls.filter(call => call.url === 'https://github.com/login/device/code').length;
}

/** Tab A starts and GitHub holds its code request until `interrupt` has finished. */
async function startAcross(
  harness: Harness,
  tabA: Browser,
  olderAnswer: Record<string, unknown>,
  interrupt: () => Promise<unknown>,
) {
  const before = codeRequests(harness);
  const gate = hold();
  harness.github.deviceCodeRequests.push({ answer: olderAnswer, hold: gate.promise });
  const older = tabA.post('/api/auth/device/start');
  await until(() => codeRequests(harness) === before + 1);
  await interrupt();
  gate.release();
  return older;
}

for (const [label, olderAnswer] of [['code', OLDER_CODE], ['error', DISABLED]] as const) {
  test(`device sign-in: an older start answered late with a ${label} does not displace the newer start`, async () => {
    const harness = await startHarness();
    const tabA = new Browser(harness.origin);
    try {
      // An established session that both tabs share.
      await tabA.post('/api/auth/device/start');
      assert.ok(tabA.cookie, 'the session cookie is set');
      const tabB = tabA.tab();
      let newer: Awaited<ReturnType<Browser['post']>> | undefined;
      const older = await startAcross(harness, tabA, olderAnswer, async () => {
        harness.github.deviceCodeRequests.push({ answer: NEWER_CODE });
        newer = await tabB.post('/api/auth/device/start');
      });
      assert.equal(newer?.status, 200, newer?.text);
      assert.equal(newer?.body.userCode, 'NEWR-CODE');

      assert.equal(older.status, 409, older.text);
      assert.equal(older.body.error, 'device_login_missing');
      assert.ok(!older.text.includes('OLDR-CODE'), 'the superseded code is never shown');

      // Tab B's attempt is intact and completes with its own device code.
      harness.clock.now += 5_000;
      harness.github.tokenAnswers.push(AUTHORIZED);
      const done = await tabB.post('/api/auth/device/poll', { attempt: newer?.body.attempt });
      assert.deepEqual(done.body, { status: 'complete' }, done.text);
      assert.equal(new URLSearchParams(tokenCalls(harness.github)[0]?.body).get('device_code'), 'newer-device-code');
      assert.deepEqual(await tabB.get('/me'), { authenticated: true, login: 'octocat', source: 'connect' });
    } finally {
      await harness.close();
    }
  });

  test(`device sign-in: a stale tab's Cancel while a newer start waits on GitHub leaves that start's ${label} intact`, async () => {
    const harness = await startHarness();
    const tabA = new Browser(harness.origin);
    try {
      const shown = await tabA.post('/api/auth/device/start');
      assert.ok(tabA.cookie, 'the session cookie is set');
      // Tab B still shows the first attempt, which tab A's new start replaces.
      const tabB = tabA.tab();
      const newer = await startAcross(harness, tabA, olderAnswer, async () => {
        assert.deepEqual((await tabB.post('/api/auth/device/cancel', { attempt: shown.body.attempt })).body, { status: 'cancelled' });
      });
      if (label === 'error') {
        // Still the latest start, so GitHub's own error is reported.
        assert.equal(newer.body.error, 'device_flow_disabled', newer.text);
        return;
      }
      assert.equal(newer.status, 200, newer.text);
      assert.equal(newer.body.userCode, 'OLDR-CODE');
      harness.clock.now += 5_000;
      harness.github.tokenAnswers.push(AUTHORIZED);
      const done = await tabA.post('/api/auth/device/poll', { attempt: newer.body.attempt });
      assert.deepEqual(done.body, { status: 'complete' }, done.text);
      assert.equal(new URLSearchParams(tokenCalls(harness.github)[0]?.body).get('device_code'), 'older-device-code');
    } finally {
      await harness.close();
    }
  });
}

test('device sign-in: a start that is still the latest commits its GitHub error and allows a retry', async () => {
  const harness = await startHarness();
  const browser = new Browser(harness.origin);
  try {
    harness.github.deviceCodeRequests.push({ answer: DISABLED });
    const failed = await browser.post('/api/auth/device/start');
    assert.equal(failed.status, 400);
    assert.equal(failed.body.error, 'device_flow_disabled');
    const retry = await browser.post('/api/auth/device/start');
    assert.equal(retry.status, 200, retry.text);
    harness.clock.now += 5_000;
    harness.github.tokenAnswers.push(AUTHORIZED);
    const done = await browser.post('/api/auth/device/poll', { attempt: retry.body.attempt });
    assert.deepEqual(done.body, { status: 'complete' }, done.text);
  } finally {
    await harness.close();
  }
});
