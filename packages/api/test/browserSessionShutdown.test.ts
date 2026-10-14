import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeConnection } from '@propr/core';
after(() => closeConnection());
import { EventEmitter } from 'node:events';
import { RedisStore } from 'connect-redis';
import { BrowserSessionLifecycle } from '../authSession.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

test('browser sessions drain admitted HTTP/Engine.IO work and pending Redis writes before disconnect', async () => {
    const lifecycle = new BrowserSessionLifecycle();
    const write = deferred(); const events: string[] = [];
    const store = new RedisStore({ client: { set: async () => { events.push('write'); await write.promise; } } });
    lifecycle.trackStore(store);
    const response = new EventEmitter();
    lifecycle.middleware({} as any, response as any, () => events.push('admitted'));
    const closing = lifecycle.close(async () => { events.push('disconnect'); });
    const refused = { statusCode: 0, end() { events.push('refused'); } };
    lifecycle.middleware({} as any, refused as any, () => assert.fail('admitted during shutdown'));
    assert.equal(refused.statusCode, 503);
    const saving = store.set('session', { cookie: {} } as any);
    await Promise.resolve();
    assert.deepEqual(events, ['admitted', 'refused', 'write']);
    response.emit('close'); // Aborted response does not release an outstanding store operation.
    await Promise.resolve();
    assert.equal(events.includes('disconnect'), false);
    let lateError: unknown;
    await store.set('late', { cookie: {} } as any, error => { lateError = error; });
    assert.ok(lateError);
    write.resolve(); await saving; await closing;
    assert.deepEqual(events, ['admitted', 'refused', 'write', 'disconnect']);
    await lifecycle.close(async () => assert.fail('closed twice'));
});

test('browser session disconnect failure stays rejected on repeated shutdown', async () => {
    const lifecycle = new BrowserSessionLifecycle();
    const failure = new Error('disconnect failed');
    await assert.rejects(lifecycle.close(async () => { throw failure; }), error => error === failure);
    await assert.rejects(lifecycle.close(async () => {}), error => error === failure);
});

test('Engine.IO upgrade response shim drains when its socket closes', async () => {
    const { createServer } = await import('node:http');
    const { Server } = await import('socket.io');
    const { io: connect } = await import('socket.io-client');
    const http = createServer();
    const io = new Server(http, { transports: ['websocket'] });
    const lifecycle = new BrowserSessionLifecycle();
    io.engine.use(lifecycle.middleware as any);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const client = connect(`http://127.0.0.1:${(http.address() as any).port}`, { transports: ['websocket'], reconnection: false });
    try {
        await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
        let disconnected = false;
        const closing = lifecycle.close(async () => { disconnected = true; });
        await Promise.resolve(); assert.equal(disconnected, false);
        await new Promise<void>(resolve => io.close(() => resolve()));
        await closing;
        assert.equal(disconnected, true);
    } finally { client.disconnect(); io.close(); }
});
