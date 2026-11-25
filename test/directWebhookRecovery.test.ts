import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '@propr/core';
import { recoverDirectWebhooks } from '../src/daemon/directWebhookRecovery.js';

after(closeConnection);
const stop = '2026-11-25T16:35:00Z';
function delivery(id: number, guid: string, status_code = 500, status = 'Failure', delivered_at = stop) {
    return { id, guid, status_code, status, delivered_at };
}

test('requests the newest unresolved attempt per GUID across cursors, through the inclusive stop margin', async () => {
    const cursors: Array<string | undefined> = [];
    const requested: number[] = [];
    const result = await recoverDirectWebhooks(stop, {
        async list(cursor) {
            cursors.push(cursor);
            return cursor ? {
                deliveries: [
                    delivery(5, 'timeout'), delivery(4, 'resolved'), delivery(3, 'http-error', 400, 'OK'),
                    delivery(2, 'boundary', 200, 'Failure', '2026-11-25T16:33:00Z'),
                    delivery(1, 'too-old', 500, 'Failure', '2026-11-25T16:32:59Z'),
                ], next: 'older', exhausted: false,
            } : {
                deliveries: [delivery(7, 'resolved', 200, 'OK'), delivery(6, 'timeout', 0, 'OK')],
                next: 'page2', exhausted: false,
            };
        },
        async redeliver(id) { requested.push(id); return false; },
    }, async () => {});
    assert.deepEqual(cursors, [undefined, 'page2']);
    assert.deepEqual(requested, [6, 3, 2]);
    assert.deepEqual(result, { scanned: 6, failed: 5, redelivered: 3, skipped: 2 });
});

test('caps requests and reports skipped attempts', async () => {
    const requested: number[] = [];
    const result = await recoverDirectWebhooks(stop, {
        async list(cursor) {
            const start = Number(cursor ?? 0);
            const deliveries = Array.from({ length: 100 }, (_, i) => delivery(start + i, String(start + i)));
            return { deliveries, next: start === 200 ? null : String(start + 100), exhausted: false };
        },
        async redeliver(id) { requested.push(id); return false; },
    }, async () => {});
    assert.equal(new Set(requested).size, 200);
    assert.deepEqual(result, { scanned: 300, failed: 300, redelivered: 200, skipped: 100 });
});

test('stops sending requests when GitHub reports no remaining quota', async () => {
    const requested: number[] = [];
    const result = await recoverDirectWebhooks(stop, {
        async list() {
            return { deliveries: [delivery(2, 'a'), delivery(1, 'b')], next: null, exhausted: false };
        },
        async redeliver(id) { requested.push(id); return true; },
    });
    assert.deepEqual(requested, [2]);
    assert.equal(result.skipped, 1);
    assert.match(result.error!, /rate limit/);
});
