/**
 * Device sign-in (#3867): cancelling or replacing an attempt while its poll is
 * waiting on GitHub must neither sign the browser in nor bring the attempt
 * back. Run with: `NODE_ENV=test npx tsx --test packages/api/test/deviceAuthAttemptRaces.test.ts`
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
  type TokenAnswer,
} from './deviceAuthHarness.js';

after(async () => {
  await closeConnection();
});

const AUTHORIZED = { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 28_800 };

/**
 * Start an attempt, then send a poll that GitHub holds at `stage` until
 * `interrupt` (a cancel or a new start) has finished.
 */
async function pollAcross(
  harness: Harness,
  browser: Browser,
  held: { answer: TokenAnswer; stage: 'tokenPoll' | 'installations' },
  interrupt: () => Promise<unknown>,
) {
  const { answer, stage } = held;
  const start = await browser.post('/api/auth/device/start');
  const attempt = start.body.attempt;
  harness.clock.now += 5_000;
  harness.github.tokenAnswers.push(answer);
  const gate = hold();
  harness.github.holds[stage] = gate.promise;
  const reached = stage === 'tokenPoll'
    ? () => tokenCalls(harness.github).length === 1
    : () => harness.github.calls.some(call => call.url.includes('/user/installations'));
  const poll = browser.post('/api/auth/device/poll', { attempt });
  await until(reached);
  await interrupt();
  gate.release();
  return { attempt, poll: await poll };
}

for (const [label, answer, stage] of [
  ['a pending poll', { error: 'authorization_pending' }, 'tokenPoll'],
  ['an authorized poll', AUTHORIZED, 'tokenPoll'],
  ['an authorized poll held at the installation check', AUTHORIZED, 'installations'],
] as const) {
  test(`device sign-in: ${label} answered after Cancel neither signs in nor restores the attempt`, async () => {
    const harness = await startHarness();
    const browser = new Browser(harness.origin);
    try {
      const { attempt, poll } = await pollAcross(harness, browser, { answer, stage }, async () => {
        assert.deepEqual((await browser.post('/api/auth/device/cancel')).body, { status: 'cancelled' });
      });
      assert.equal(poll.status, 409, poll.text);
      assert.equal(poll.body.error, 'device_login_missing');
      assert.ok(!poll.text.includes(ACCESS_TOKEN));
      assert.deepEqual(await browser.get('/me'), { authenticated: false });
      // The cancelled attempt stays gone: no later poll reaches GitHub for it.
      harness.clock.now += 60_000;
      const calls = tokenCalls(harness.github).length;
      const again = await browser.post('/api/auth/device/poll', { attempt });
      assert.equal(again.body.error, 'device_login_missing');
      assert.equal(tokenCalls(harness.github).length, calls);
    } finally {
      await harness.close();
    }
  });

  test(`device sign-in: ${label} of a replaced attempt neither signs in nor displaces the new one`, async () => {
    const harness = await startHarness();
    const browser = new Browser(harness.origin);
    try {
      let replacement = '';
      const { poll } = await pollAcross(harness, browser, { answer, stage }, async () => {
        const second = await browser.post('/api/auth/device/start');
        assert.equal(second.status, 200);
        replacement = String(second.body.attempt);
      });
      assert.equal(poll.body.error, 'device_login_missing', poll.text);
      assert.deepEqual(await browser.get('/me'), { authenticated: false });

      // The new attempt is intact and completes normally.
      delete harness.github.holds.tokenPoll;
      delete harness.github.holds.installations;
      harness.clock.now += 5_000;
      harness.github.tokenAnswers.length = 0;
      harness.github.tokenAnswers.push(AUTHORIZED);
      const done = await browser.post('/api/auth/device/poll', { attempt: replacement });
      assert.deepEqual(done.body, { status: 'complete' }, done.text);
      assert.deepEqual(await browser.get('/me'), { authenticated: true, login: 'octocat', source: 'connect' });
    } finally {
      await harness.close();
    }
  });
}
