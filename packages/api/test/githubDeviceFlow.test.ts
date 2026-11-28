/**
 * The shared GitHub device flow steps (#3867). Run with:
 * `NODE_ENV=test npx tsx --test packages/api/test/githubDeviceFlow.test.ts`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollGitHubDeviceToken, requestGitHubDeviceCode, runGitHubDeviceFlow } from '@propr/shared';

test('device flow protocol: slow_down without an interval adds five seconds; foreign verification URIs are ignored', async () => {
  const answer = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch;
  assert.deepEqual(
    await pollGitHubDeviceToken({ clientId: 'c', deviceCode: 'd', intervalSeconds: 5, fetchImpl: answer({ error: 'slow_down' }) }),
    { status: 'slow_down', intervalSeconds: 10 },
  );
  assert.deepEqual(
    await pollGitHubDeviceToken({ clientId: 'c', deviceCode: 'd', intervalSeconds: 5, fetchImpl: answer({ error: 'something_new' }) }),
    { status: 'failed', error: 'invalid_response' },
  );
  const code = await requestGitHubDeviceCode({
    clientId: 'c',
    fetchImpl: answer({ device_code: 'd', user_code: 'ABCD-EFGH', verification_uri: 'https://evil.example/device', expires_in: 900, interval: 5 }),
  });
  assert.equal(code.verificationUri, 'https://github.com/login/device');
  await assert.rejects(
    requestGitHubDeviceCode({ clientId: 'c', fetchImpl: answer({ error: 'device_flow_disabled' }) }),
    (error: Error & { code?: string }) => error.code === 'device_flow_disabled' && /isn't enabled/.test(error.message),
  );
});

test('device flow protocol: the full loop honours the interval and stops at expiry', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const answers: unknown[] = [
    { device_code: 'd', user_code: 'ABCD-EFGH', expires_in: 30, interval: 5 },
    { error: 'authorization_pending' },
    { error: 'slow_down', interval: 10 },
    { access_token: 'ghu_x', expires_in: 28800 },
  ];
  const fetchImpl = (async () => Response.json(answers.shift())) as unknown as typeof fetch;
  const shown: string[] = [];
  const token = await runGitHubDeviceFlow({
    clientId: 'c',
    fetchImpl,
    onCode: code => { shown.push(code.userCode); },
    sleep: async ms => { sleeps.push(ms); now += ms; },
    now: () => now,
  });
  assert.deepEqual(shown, ['ABCD-EFGH']);
  assert.deepEqual(sleeps, [5000, 5000, 10000]);
  assert.equal(token.accessToken, 'ghu_x');

  now = 0;
  const pending = [{ device_code: 'd', user_code: 'ABCD-EFGH', expires_in: 8, interval: 5 }, { error: 'authorization_pending' }];
  await assert.rejects(runGitHubDeviceFlow({
    clientId: 'c',
    fetchImpl: (async () => Response.json(pending.shift() ?? { error: 'authorization_pending' })) as unknown as typeof fetch,
    onCode: () => {},
    sleep: async ms => { now += ms; },
    now: () => now,
  }), (error: Error & { code?: string }) => error.code === 'expired_token');
});
