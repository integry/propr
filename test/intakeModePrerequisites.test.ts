import assert from 'node:assert/strict';
import test from 'node:test';

import { validateIntakeModePrerequisites } from '../packages/shared/src/intakeModePrerequisites.js';

const ROUTING_OK = {
  intakeMode: 'routing_websocket' as const,
  authMode: 'relay' as const,
  routingUrl: 'https://routing.propr.dev',
  relayUrl: 'https://relay.propr.dev/v1',
  relayToken: 'tok_123',
};

test('valid routing_websocket config passes with no errors', () => {
    const result = validateIntakeModePrerequisites(ROUTING_OK);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
});

test('routing_websocket fails without routing URL, relay URL, or relay token', () => {
    const result = validateIntakeModePrerequisites({
        intakeMode: 'routing_websocket',
        authMode: 'relay',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /PROPR_ROUTING_URL must be set/.test(e)));
    assert.ok(result.errors.some((e) => /PROPR_GH_RELAY_URL must be set/.test(e)));
    assert.ok(result.errors.some((e) => /PROPR_GH_RELAY_TOKEN must be set/.test(e)));
});

test('routing_websocket requires relay auth mode', () => {
    const result = validateIntakeModePrerequisites({ ...ROUTING_OK, authMode: 'app' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /requires relay auth mode/.test(e)));
});

test('routing_websocket accepts the documented default wss:// routing URL', () => {
    // The default in .env.example is wss://routing.propr.dev; it must pass the
    // boot/CLI check or fresh installs would fail `propr check` out of the box.
    const result = validateIntakeModePrerequisites({
        ...ROUTING_OK,
        routingUrl: 'wss://routing.propr.dev',
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test('routing_websocket rejects an insecure non-localhost routing URL', () => {
    const result = validateIntakeModePrerequisites({
        ...ROUTING_OK,
        routingUrl: 'http://routing.propr.dev',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /PROPR_ROUTING_URL is invalid/.test(e)));
    // The shared routing URL validator backs the check; its message names the
    // routing variable the user actually set, never "relay URL".
    assert.ok(result.errors.every((e) => !/relay url/i.test(e)));
});

test('routing_websocket allows an http localhost routing URL', () => {
    const result = validateIntakeModePrerequisites({
        ...ROUTING_OK,
        routingUrl: 'http://localhost:8080',
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test('direct_webhook requires app auth mode and a webhook secret', () => {
    const result = validateIntakeModePrerequisites({
        intakeMode: 'direct_webhook',
        authMode: 'relay',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /requires app auth mode/.test(e)));
    assert.ok(result.errors.some((e) => /GH_WEBHOOK_SECRET must be set/.test(e)));
});

test('direct_webhook passes with app auth mode and a webhook secret', () => {
    const result = validateIntakeModePrerequisites({
        intakeMode: 'direct_webhook',
        authMode: 'app',
        webhookSecret: 'whsec_123',
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test('direct_webhook fails when only auth mode is correct', () => {
    const result = validateIntakeModePrerequisites({
        intakeMode: 'direct_webhook',
        authMode: 'app',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /GH_WEBHOOK_SECRET must be set/.test(e)));
});

test('polling accepts relay auth mode', () => {
    const result = validateIntakeModePrerequisites({ intakeMode: 'polling', authMode: 'relay' });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test('polling accepts app auth mode', () => {
    const result = validateIntakeModePrerequisites({ intakeMode: 'polling', authMode: 'app' });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
});

test('polling fails without usable GitHub auth', () => {
    const result = validateIntakeModePrerequisites({ intakeMode: 'polling', authMode: 'none' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /requires usable GitHub auth/.test(e)));
});

test('demo auth mode short-circuits with no errors for any intake mode', () => {
    for (const intakeMode of ['routing_websocket', 'polling', 'direct_webhook'] as const) {
        const result = validateIntakeModePrerequisites({ intakeMode, authMode: 'demo' });
        assert.equal(result.valid, true);
        assert.deepEqual(result.errors, []);
    }
});
