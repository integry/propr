import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeConnection } from '@propr/core';
after(() => closeConnection());
import { EventEmitter } from 'node:events';
import { RedisStore } from 'connect-redis';
import session from 'express-session';
import type { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
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
    lifecycle.middleware({} as Request, response as unknown as Response, () => events.push('admitted'));
    const closing = lifecycle.close(async () => { events.push('disconnect'); });
    const refused = { statusCode: 0, end() { events.push('refused'); } };
    lifecycle.middleware({} as Request, refused as unknown as Response, () => assert.fail('admitted during shutdown'));
    assert.equal(refused.statusCode, 503);
    const saving = store.set('session', { cookie: new session.Cookie() });
    await Promise.resolve();
    assert.deepEqual(events, ['admitted', 'refused', 'write']);
    response.emit('close'); // Aborted response does not release an outstanding store operation.
    await Promise.resolve();
    assert.equal(events.includes('disconnect'), false);
    let lateError: unknown;
    await store.set('late', { cookie: new session.Cookie() }, error => { lateError = error; });
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
    io.engine.use(lifecycle.middleware as Parameters<typeof io.engine.use>[0]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const client = connect(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, { transports: ['websocket'], reconnection: false });
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


test('ordinary MemoryStore retains its optional methods and callback results', async () => {
    const lifecycle = new BrowserSessionLifecycle();
    const store = new session.MemoryStore();
    lifecycle.trackStore(store);
    assert.equal('ids' in store, false);
    const data = { cookie: { maxAge: 60_000 }, marker: 'saved' } as unknown as session.SessionData;
    await new Promise<void>((resolve, reject) => {
        store.set('session', data, error => error ? reject(error) : resolve());
    });
    const saved = await new Promise<session.SessionData | null | undefined>((resolve, reject) => {
        store.get('session', (error, value) => error ? reject(error) : resolve(value));
    });
    assert.deepEqual(saved, data);
    await lifecycle.close(async () => {});
    await new Promise<void>(resolve => {
        store.set('late', data, error => {
            assert.match(error.message, /Browser sessions are closed/);
            resolve();
        });
    });
    assert.equal('ids' in store, false);
});

for (const name of ['get', 'set', 'touch', 'destroy', 'clear', 'length', 'ids', 'all']) {
    test(`partial store ${name} preserves receiver, callbacks, promises and shutdown fencing`, async () => {
        const lifecycle = new BrowserSessionLifecycle();
        const work = deferred();
        const events: string[] = [];
        const result = { session: 'value' };
        const store = {
            [name]: async function (key: string, callback?: (error: null, value: typeof result) => void) {
                assert.equal(this, store);
                assert.equal(key, 'session');
                events.push('started');
                await work.promise;
                callback?.(null, result);
                return result;
            },
        };
        // Non-callable extensions must also remain untouched.
        Object.defineProperty(store, 'length' === name ? 'ids' : 'length', { value: null });
        const keys = Reflect.ownKeys(store);
        lifecycle.trackStore(store as unknown as session.Store);
        assert.deepEqual(Reflect.ownKeys(store), keys);
        const operation = store[name]('session', (error, value) => {
            assert.equal(error, null);
            assert.equal(value, result);
            events.push('callback');
        });
        const closing = lifecycle.close(async () => { events.push('disconnect'); });
        await Promise.resolve();
        assert.deepEqual(events, ['started']);
        await assert.rejects(store[name]('late'), /Browser sessions are closed/);
        work.resolve();
        assert.equal(await operation, result);
        await closing;
        assert.deepEqual(events, ['started', 'callback', 'disconnect']);
    });
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const name of ['get', 'set', 'touch', 'destroy', 'clear', 'length', 'ids', 'all']) {
    test(`synchronous ${name} failure before callback releases shutdown exactly once`, { timeout: 2_000 }, async () => {
        const lifecycle = new BrowserSessionLifecycle();
        const failure = new Error('synchronous store failure');
        const data = { cookie: {} };
        const args = ['clear', 'length', 'ids', 'all'].includes(name) ? []
            : ['set', 'touch'].includes(name) ? ['session', data] : ['session'];
        let invocations = 0;
        let callbacks = 0;
        let disconnects = 0;
        const store = {
            [name]: function (...received: unknown[]) {
                assert.equal(this, store);
                assert.equal(typeof received.pop(), 'function');
                assert.deepEqual(received, args);
                invocations++;
                throw failure;
            },
        };
        lifecycle.trackStore(store as unknown as session.Store);
        const response = new EventEmitter();
        lifecycle.middleware({} as Request, response as unknown as Response, () => {});
        const result = store[name](...args, () => { callbacks++; });
        const closing = lifecycle.close(async () => { disconnects++; });
        const repeatedClose = lifecycle.close(async () => assert.fail('disconnected twice'));
        assert.equal(repeatedClose, closing);
        response.emit('close');
        response.emit('finish');
        await assert.rejects(Promise.resolve(result), error => error === failure);
        await closing;
        await repeatedClose;
        await lifecycle.close(async () => assert.fail('disconnected twice'));
        assert.equal(invocations, 1);
        assert.equal(callbacks, 0);
        assert.equal(disconnects, 1);
    });
}

for (const name of ['get', 'set', 'touch', 'destroy', 'clear', 'length', 'ids', 'all']) {
    test(`callback-only ${name} drains after an admitted response aborts`, async () => {
        const lifecycle = new BrowserSessionLifecycle();
        const events: string[] = [];
        const data = { cookie: {}, marker: 'saved' };
        const args = ['clear', 'length', 'ids', 'all'].includes(name) ? []
            : ['set', 'touch'].includes(name) ? ['session', data] : ['session'];
        const callbackReceiver = {};
        const callbackResult = {};
        const callbackError = new Error('persistence failed');
        let complete!: (...results: unknown[]) => unknown;
        const store = {
            [name]: function (...received: unknown[]) {
                assert.equal(this, store);
                complete = received.pop() as typeof complete;
                assert.deepEqual(received, args);
                events.push('write');
                return undefined;
            },
        };
        lifecycle.trackStore(store as unknown as session.Store);
        const response = new EventEmitter();
        lifecycle.middleware({} as Request, response as unknown as Response, () => events.push('admitted'));
        const result = store[name](...args, function (this: unknown, ...results: unknown[]) {
            assert.equal(this, callbackReceiver);
            assert.deepEqual(results, [callbackError, data, 'extra']);
            events.push('callback');
            return callbackResult;
        });
        await result; // Returning undefined from the store is not completion evidence.
        const closing = lifecycle.close(async () => { events.push('disconnect'); });
        response.emit('close');
        response.emit('finish'); // Request release must remain idempotent.
        await nextTurn();
        assert.deepEqual(events, ['admitted', 'write']);
        let refusals = 0;
        await store[name](...args, (error: Error) => {
            assert.match(error.message, /Browser sessions are closed/);
            refusals++;
        });
        assert.equal(refusals, 1);
        await assert.rejects(Promise.resolve(store[name](...args)), /Browser sessions are closed/);
        assert.equal(complete.call(callbackReceiver, callbackError, data, 'extra'), callbackResult);
        await closing;
        assert.deepEqual(events, ['admitted', 'write', 'callback', 'disconnect']);
        await lifecycle.close(async () => assert.fail('disconnected twice'));
    });
}

for (const callbackFirst of [false, true]) {
    for (const rejects of [false, true]) {
        test(`dual store waits for both signals: callbackFirst=${callbackFirst}, rejects=${rejects}`, async () => {
            const lifecycle = new BrowserSessionLifecycle();
            const work = deferred();
            const value = { result: 'promise result' };
            const failure = new Error('promise failure');
            let complete!: () => void;
            let callbacks = 0;
            let disconnects = 0;
            const store = {
                set(_id: string, _data: unknown, callback: () => void) {
                    assert.equal(this, store);
                    complete = callback;
                    return work.promise.then(() => {
                        if (rejects) throw failure;
                        return value;
                    });
                },
            };
            lifecycle.trackStore(store as unknown as session.Store);
            const result = store.set('session', {}, () => { callbacks++; });
            const checked = rejects ? assert.rejects(result, error => error === failure)
                : result.then(actual => { assert.equal(actual, value); });
            const closing = lifecycle.close(async () => { disconnects++; });
            await nextTurn();
            if (callbackFirst) {
                complete();
                complete(); // Repeated callbacks must not release the promise obligation.
            } else {
                work.resolve();
                await checked; // The caller receives its result before the callback.
            }
            await nextTurn();
            assert.equal(disconnects, 0);
            if (callbackFirst) work.resolve();
            else complete();
            await checked;
            await closing;
            assert.equal(callbacks, callbackFirst ? 2 : 1);
            assert.equal(disconnects, 1);
            await lifecycle.close(async () => assert.fail('disconnected twice'));
        });
    }
}

for (const rejects of [false, true]) {
    test(`promise-only store preserves settlement: rejects=${rejects}`, async () => {
        const lifecycle = new BrowserSessionLifecycle();
        const work = deferred();
        const value = {};
        const failure = new Error('write failed');
        let disconnected = false;
        const store = { set: () => work.promise.then(() => {
            if (rejects) throw failure;
            return value;
        }) };
        lifecycle.trackStore(store as unknown as session.Store);
        const result = store.set();
        const checked = rejects ? assert.rejects(result, error => error === failure)
            : result.then(actual => { assert.equal(actual, value); });
        const closing = lifecycle.close(async () => { disconnected = true; });
        await nextTurn();
        assert.equal(disconnected, false);
        work.resolve();
        await checked;
        await closing;
        assert.equal(disconnected, true);
    });
}

test('callback throws propagate and still release a callback-only operation', async () => {
    const lifecycle = new BrowserSessionLifecycle();
    const failure = new Error('callback failed');
    let complete!: () => void;
    const store = { set(callback: () => void) { complete = callback; } };
    lifecycle.trackStore(store as unknown as session.Store);
    await store.set(() => { throw failure; });
    const closing = lifecycle.close(async () => {});
    assert.throws(() => complete(), error => error === failure);
    await closing;
});

test('synchronous callbacks preserve their return value and cannot release another write', async () => {
    const lifecycle = new BrowserSessionLifecycle();
    const value = {};
    let complete!: () => void;
    let disconnected = false;
    const store = {
        set(id: string, callback: () => unknown) {
            if (id === 'deferred') { complete = callback; return undefined; }
            return callback();
        },
    };
    lifecycle.trackStore(store as unknown as session.Store);
    await store.set('deferred', () => {});
    assert.equal(await store.set('synchronous', () => value), value);
    const closing = lifecycle.close(async () => { disconnected = true; });
    await nextTurn();
    assert.equal(disconnected, false);
    complete();
    complete();
    await closing;
    assert.equal(disconnected, true);
});
