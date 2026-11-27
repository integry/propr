/**
 * Fly dashboard launch (#3827): GitHub's device flow for relay enrollment,
 * with GitHub faked. Run with: npx tsx --test test/flyLaunchDeviceFlow.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceEnrollment, DISABLED_RECHECK_MS, HELD_TOKEN_TTL_MS } from '../src/flyLaunch/deviceEnrollment.ts';
import { DeviceFlowDisabledError, pollDeviceToken, requestDeviceCode } from '../src/flyLaunch/deviceFlow.ts';

const CODE = { device_code: 'dc-secret-value', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('only GitHub\'s own verification page and printable codes are accepted', async () => {
    for (const verification_uri of ['https://evil.example/login/device', 'http://github.com/login/device', 'https://github.com/login/device?code=x']) {
        await assert.rejects(requestDeviceCode('Iv23li', answer({ ...CODE, verification_uri })), /unexpected verification page/);
    }
    for (const user_code of ['', 'a\nb', '<b>x</b> y', 'x'.repeat(129)]) {
        await assert.rejects(requestDeviceCode('Iv23li', answer({ ...CODE, user_code })), /unexpected device code/);
    }
    const ok = await requestDeviceCode('Iv23li', answer({ ...CODE, interval: 1, expires_in: 99_999 }));
    assert.equal(ok.interval, 5, 'never faster than GitHub\'s minimum');
    assert.equal(ok.expiresIn, 900, 'bounded expiry');
});

test('device_flow_disabled is its own error; GitHub\'s other refusals never echo the response', async () => {
    await assert.rejects(requestDeviceCode('Iv23li', answer({ error: 'device_flow_disabled' }, 400)), DeviceFlowDisabledError);
    await assert.rejects(requestDeviceCode('Iv23li', answer({ error: 'incorrect_client_credentials', error_description: 'secret-ish detail' }, 400)),
        (error: Error) => !error.message.includes('secret-ish') && /did not start/.test(error.message));
    await assert.rejects(pollDeviceToken('Iv23li', 'dc', 5, answer({ error: 'device_flow_disabled' })), DeviceFlowDisabledError);
    assert.deepEqual(await pollDeviceToken('Iv23li', 'dc', 5, answer({ error: 'slow_down' })), { kind: 'slow_down', interval: 10 });
});

test('a network failure while polling keeps the code; disabled is rechecked after a while; a held token expires', async () => {
    let clock = 0;
    let mode: 'ok' | 'down' | 'disabled' = 'ok';
    const fetcher = (async (url: string) => {
        if (mode === 'down') throw new Error('ECONNRESET');
        if (mode === 'disabled') return new Response(JSON.stringify({ error: 'device_flow_disabled' }), { status: 400 });
        return new Response(JSON.stringify(String(url).endsWith('/device/code') ? CODE : { error: 'authorization_pending' }));
    }) as unknown as typeof fetch;
    const device = createDeviceEnrollment({ clientId: 'Iv23li', fetcher, now: () => clock });
    await device.start();
    clock += 5_000;
    mode = 'down';
    assert.equal((await device.poll()).kind, 'waiting', 'GitHub unreachable: keep waiting');
    clock += 5_000;
    mode = 'ok';
    assert.equal((await device.poll()).kind, 'waiting');

    mode = 'disabled';
    await assert.rejects(device.start(), DeviceFlowDisabledError);
    assert.equal(device.available(), false);
    assert.equal((await device.poll()).kind, 'none', 'the old code is dropped');
    clock += DISABLED_RECHECK_MS;
    assert.equal(device.available(), true, 'asked again later, in case the App enabled it');

    device.hold('ghu_token');
    clock += HELD_TOKEN_TTL_MS;
    assert.equal(device.takeHeld(), undefined);
    device.hold('ghu_token');
    assert.equal(device.takeHeld(), 'ghu_token');
    assert.equal(device.takeHeld(), undefined, 'once');

    assert.equal(createDeviceEnrollment({}).available(), false, 'no client ID: never offered');
});
