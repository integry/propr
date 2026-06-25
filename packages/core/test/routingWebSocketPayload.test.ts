import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWebhookPayload } from '../src/intake/webhookPayload.js';

// Regression for the routing-intake bug where GitHub events were ACKed but
// silently dropped: the relay delivers the webhook body as a raw JSON *string*
// (`rawPayload: string`), but `processWebhookEvent`'s type guards expect a
// parsed object (the shape the direct-webhook intake produces). Without parsing,
// every event no-ops while still being ACKed. These lock the string -> object
// materialization in place.
//
// Imported from the dependency-free `webhookPayload` module on purpose: pulling
// in `routingWebSocketProtocol` would drag in the full webhook-handler stack
// (background timers) and hang the test runner on exit.

test('parseWebhookPayload parses a JSON string into an object', () => {
    const parsed = parseWebhookPayload('{"action":"created","issue":{"number":1611}}') as Record<string, unknown>;
    assert.equal(typeof parsed, 'object');
    assert.equal(parsed.action, 'created');
    assert.deepEqual(parsed.issue, { number: 1611 });
});

test('parseWebhookPayload passes an already-materialized object through unchanged', () => {
    const obj = { action: 'created' };
    assert.strictEqual(parseWebhookPayload(obj), obj);
});

test('parseWebhookPayload throws on a non-JSON string so the ACK is withheld', () => {
    assert.throws(() => parseWebhookPayload('not json'), /not valid JSON/);
});
