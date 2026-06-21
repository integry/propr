import { test } from 'node:test';
import assert from 'node:assert';
import { RoutingWebSocketIntakeService, type MinimalWebSocket, type RawData } from '@propr/core';

// A controllable fake `ws` socket used to drive the service in tests without a
// real network connection. Listeners are stored so the test can emit lifecycle
// events (open/message/close) on demand.
class FakeWebSocket implements MinimalWebSocket {
    static instances: FakeWebSocket[] = [];

    readyState = 1; // OPEN
    closed = false;
    terminated = false;
    pings = 0;

    private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    constructor(
        public readonly address: string,
        public readonly options?: { headers?: Record<string, string> },
    ) {
        FakeWebSocket.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
        (this.listeners[event] ||= []).push(listener);
    }

    emit(event: string, ...args: unknown[]): void {
        for (const l of this.listeners[event] || []) l(...args);
    }

    ping(): void {
        this.pings += 1;
    }

    close(): void {
        this.closed = true;
    }

    terminate(): void {
        this.terminated = true;
    }
}

function makeService(overrides: Record<string, unknown> = {}) {
    FakeWebSocket.instances = [];
    const dispatched: { payload: unknown; eventType: string; correlationId: string }[] = [];
    const service = new RoutingWebSocketIntakeService({
        routingUrl: 'wss://routing.example/v1/events',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        dispatch: async (payload, eventType, correlationId) => {
            dispatched.push({ payload, eventType, correlationId });
        },
        ...overrides,
    });
    return { service, dispatched };
}

test('start() rejects when no routing URL is configured', async () => {
    const prev = process.env.PROPR_ROUTING_URL;
    delete process.env.PROPR_ROUTING_URL;
    try {
        const service = new RoutingWebSocketIntakeService({
            webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        });
        await assert.rejects(() => service.start(), /routing URL/);
    } finally {
        if (prev !== undefined) process.env.PROPR_ROUTING_URL = prev;
    }
});

test('dispatches a supported event received over the socket', async () => {
    const { service, dispatched } = makeService();
    await service.start();

    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.address, 'wss://routing.example/v1/events');

    const payload = { action: 'opened', issue: { number: 7 } };
    socket.emit('message', JSON.stringify({ eventType: 'issues', payload }));

    // handleMessage runs asynchronously; let microtasks flush.
    await new Promise((r) => setImmediate(r));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].eventType, 'issues');
    assert.deepEqual(dispatched[0].payload, payload);
    assert.ok(dispatched[0].correlationId);

    await service.stop();
});

test('ignores unsupported event types and malformed messages', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];

    socket.emit('message', JSON.stringify({ eventType: 'deployment', payload: {} }));
    socket.emit('message', 'not json' as unknown as RawData);
    socket.emit('message', JSON.stringify({ payload: {} })); // no event type

    await new Promise((r) => setImmediate(r));
    assert.equal(dispatched.length, 0);

    await service.stop();
});

test('stop() closes the socket and prevents reconnects', async () => {
    const { service } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];

    await service.stop();
    assert.equal(socket.closed, true);

    // A close event after stop must not open a new connection.
    socket.emit('close', 1006, Buffer.from(''));
    await new Promise((r) => setImmediate(r));
    assert.equal(FakeWebSocket.instances.length, 1);
});

test('start() rejects when the routing URL has an unsupported scheme', async () => {
    const service = new RoutingWebSocketIntakeService({
        routingUrl: 'ftp://routing.example/v1/events',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
    });
    await assert.rejects(() => service.start(), /ws:\/\/, wss:\/\/, http:\/\/, or https:\/\//);
});

test('start() rejects when the routing URL is not parseable', async () => {
    const service = new RoutingWebSocketIntakeService({
        routingUrl: 'not a url',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
    });
    await assert.rejects(() => service.start(), /not a valid URL/);
});

test('sends the relay token as a Bearer Authorization header', async () => {
    const { service } = makeService({ headers: { Authorization: 'Bearer relay-secret' } });
    await service.start();

    const socket = FakeWebSocket.instances[0];
    assert.deepEqual(socket.options?.headers, { Authorization: 'Bearer relay-secret' });

    await service.stop();
});

test('omits headers when none are configured', async () => {
    const { service } = makeService({ headers: {} });
    await service.start();

    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.options, undefined);

    await service.stop();
});

test('parses Buffer, Buffer[], and ArrayBuffer message frames', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];

    const buf = Buffer.from(JSON.stringify({ eventType: 'issues', payload: { n: 1 } }));
    socket.emit('message', buf);

    const json = JSON.stringify({ eventType: 'pull_request', payload: { n: 2 } });
    const mid = Math.floor(json.length / 2);
    socket.emit('message', [Buffer.from(json.slice(0, mid)), Buffer.from(json.slice(mid))]);

    const ab = new TextEncoder().encode(JSON.stringify({ eventType: 'check_run', payload: { n: 3 } })).buffer;
    socket.emit('message', ab as unknown as RawData);

    await new Promise((r) => setImmediate(r));

    assert.deepEqual(dispatched.map((d) => d.eventType), ['issues', 'pull_request', 'check_run']);
    assert.deepEqual(dispatched.map((d) => d.payload), [{ n: 1 }, { n: 2 }, { n: 3 }]);

    await service.stop();
});

test('reconnects after an unexpected close', async () => {
    const { service } = makeService({ reconnectDelayMs: 5, maxReconnectDelayMs: 5 });
    await service.start();
    const first = FakeWebSocket.instances[0];

    first.emit('open');
    first.emit('close', 1006, Buffer.from(''));

    // Wait past the reconnect delay.
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(FakeWebSocket.instances.length >= 2, 'expected a reconnect attempt');

    await service.stop();
});
