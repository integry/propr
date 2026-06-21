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

test('routing_websocket rejects a non-https routing URL', () => {
    const result = validateIntakeModePrerequisites({
        ...ROUTING_OK,
        routingUrl: 'http://routing.propr.dev',
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /PROPR_ROUTING_URL is invalid/.test(e)));
    // The shared relay URL validator backs the check, but its message is reworded
    // so the user sees the routing variable they actually set, not "relay URL".
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
