import { after, test } from 'node:test';
import assert from 'node:assert';
import { RoutingWebSocketIntakeService, closeConnection, type MinimalWebSocket, type RawData } from '@propr/core';

// Importing @propr/core eagerly opens the shared DB connection pool; close it so
// the test process can exit cleanly instead of hanging on the open pool.
after(async () => {
    await closeConnection();
});

// A controllable fake `ws` socket used to drive the service in tests without a
// real network connection. Listeners are stored so the test can emit lifecycle
// events (open/message/close) on demand, and frames the service sends back
// (ACK/pong) are captured for assertions.
class FakeWebSocket implements MinimalWebSocket {
    static instances: FakeWebSocket[] = [];

    readyState = 1; // OPEN
    closed = false;
    terminated = false;
    pings = 0;
    sent: string[] = [];

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

    send(data: string): void {
        this.sent.push(data);
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

    /** Parsed frames the service sent back to the relay. */
    sentFrames(): Record<string, unknown>[] {
        return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    }
}

const flush = () => new Promise((r) => setImmediate(r));

function makeService(overrides: Record<string, unknown> = {}) {
    FakeWebSocket.instances = [];
    const dispatched: { payload: unknown; eventType: string; correlationId: string }[] = [];
    const service = new RoutingWebSocketIntakeService({
        routingUrl: 'wss://routing.example',
        relayToken: 'relay-secret',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        dispatch: async (payload, eventType, correlationId) => {
            dispatched.push({ payload, eventType, correlationId });
        },
        ...overrides,
    });
    return { service, dispatched };
}

/** Build an `event` frame with an inline payload. */
function eventFrame(opts: { sequence: number; deliveryId: string; eventType: string; rawPayload: unknown }) {
    return JSON.stringify({
        type: 'event',
        sequence: opts.sequence,
        delivery: {
            deliveryId: opts.deliveryId,
            eventType: opts.eventType,
            payload: { rawPayload: opts.rawPayload },
        },
    });
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

test('start() rejects unsupported schemes and unparseable URLs', async () => {
    const bad = new RoutingWebSocketIntakeService({
        routingUrl: 'ftp://routing.example',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
    });
    await assert.rejects(() => bad.start(), /ws:\/\/, wss:\/\/, http:\/\/, or https:\/\//);

    const unparseable = new RoutingWebSocketIntakeService({
        routingUrl: 'not a url',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
    });
    await assert.rejects(() => unparseable.start(), /not a valid URL/);
});

test('connects to the /v1/connect path with a Bearer relay token', async () => {
    const { service } = makeService();
    await service.start();

    const socket = FakeWebSocket.instances[0];
    assert.equal(socket.address, 'wss://routing.example/v1/connect');
    assert.deepEqual(socket.options?.headers, { Authorization: 'Bearer relay-secret' });

    await service.stop();
});

test('processes an event frame with inline payload and ACKs only after processing', async () => {
    // Hold dispatch open with a deferred promise so we can assert the ACK is
    // withheld while processing is still pending, then released once it resolves.
    let resolveDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((r) => {
        resolveDispatch = r;
    });
    const { service, dispatched } = makeService({
        dispatch: async (payload: unknown, eventType: string) => {
            dispatched.push({ payload, eventType, correlationId: 'x' } as never);
            await dispatchGate;
        },
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const payload = { action: 'opened', issue: { number: 7 } };
    socket.emit('message', eventFrame({ sequence: 5, deliveryId: 'd1', eventType: 'issues', rawPayload: payload }));
    await flush();

    // Dispatch has started but not completed: no ACK must have been sent yet.
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].eventType, 'issues');
    assert.deepEqual(dispatched[0].payload, payload);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0, 'must not ACK while dispatch pending');

    // Let dispatch finish — now the ACK is emitted.
    resolveDispatch();
    await flush();

    const frames = socket.sentFrames();
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { type: 'ack', sequence: 5, deliveryId: 'd1' });

    await service.stop();
});

test('in-flight duplicate is not ACKed until the original processing succeeds', async () => {
    // Gate the first dispatch so a duplicate arrives while it is still in flight.
    let resolveDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((r) => {
        resolveDispatch = r;
    });
    let calls = 0;
    const { service, dispatched } = makeService({
        dispatch: async (payload: unknown, eventType: string) => {
            calls += 1;
            dispatched.push({ payload, eventType, correlationId: 'x' } as never);
            await dispatchGate;
        },
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const frame = eventFrame({ sequence: 1, deliveryId: 'inflight', eventType: 'issues', rawPayload: { n: 1 } });
    socket.emit('message', frame);
    await flush();
    // Duplicate arrives while the first attempt is still pending.
    socket.emit('message', JSON.stringify({ ...JSON.parse(frame), sequence: 2 }));
    await flush();

    // The duplicate was dropped (not reprocessed) and NOT ACKed — the original
    // attempt has not yet succeeded.
    assert.equal(calls, 1, 'in-flight duplicate must not be reprocessed');
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0, 'in-flight duplicate must not be ACKed');

    resolveDispatch();
    await flush();

    // Only the original ACKs, once, after it succeeds.
    const acks = socket.sentFrames().filter((f) => f.type === 'ack');
    assert.deepEqual(acks, [{ type: 'ack', sequence: 1, deliveryId: 'inflight' }]);

    await service.stop();
});

test('start() rejects a routing URL that carries a path', async () => {
    const withPath = new RoutingWebSocketIntakeService({
        routingUrl: 'wss://routing.example/v1',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
    });
    await assert.rejects(() => withPath.start(), /origin without a path/);
});

test('discards an event frame with no numeric sequence (no ACK)', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({
        type: 'event',
        delivery: { deliveryId: 'no-seq', eventType: 'issues', payload: { rawPayload: { n: 1 } } },
    }));
    await flush();

    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0);

    await service.stop();
});

test('deduplicates by deliveryId: a duplicate is ACKed but not reprocessed', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const frame = eventFrame({ sequence: 1, deliveryId: 'dup', eventType: 'issues', rawPayload: { n: 1 } });
    socket.emit('message', frame);
    await flush();
    socket.emit('message', frame);
    await flush();

    assert.equal(dispatched.length, 1, 'duplicate delivery must not be reprocessed');
    // Both deliveries are ACKed so the relay can advance even after a lost ACK.
    const acks = socket.sentFrames().filter((f) => f.type === 'ack');
    assert.equal(acks.length, 2);

    await service.stop();
});

test('ignores unsupported event types (but ACKs) and discards malformed frames', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', eventFrame({ sequence: 1, deliveryId: 'u1', eventType: 'deployment', rawPayload: {} }));
    socket.emit('message', 'not json' as unknown as RawData);
    socket.emit('message', JSON.stringify({ type: 'event', sequence: 2, delivery: { deliveryId: 'u2' } })); // no type
    await flush();

    assert.equal(dispatched.length, 0);
    // The unsupported-but-identified delivery is ACKed; the no-event-type one too.
    const acks = socket.sentFrames().filter((f) => f.type === 'ack');
    assert.deepEqual(acks.map((a) => a.deliveryId).sort(), ['u1', 'u2']);

    await service.stop();
});

test('pulls the payload over HTTP when no inline payload is present', async () => {
    let pulledUrl = '';
    let authHeader = '';
    const fakeFetch = async (url: string, init?: RequestInit) => {
        pulledUrl = url;
        authHeader = (init?.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ rawPayload: { action: 'opened', pulled: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 9,
        delivery: { deliveryId: 'pull-1', eventType: 'pull_request', installationToken: 'inst-token-123' },
    }));
    await flush();
    await flush();

    assert.equal(pulledUrl, 'https://routing.example/v1/delivery/pull-1');
    assert.equal(authHeader, 'Bearer inst-token-123');
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].payload, { action: 'opened', pulled: true });
    assert.deepEqual(socket.sentFrames()[0], { type: 'ack', sequence: 9, deliveryId: 'pull-1' });

    await service.stop();
});

test('uses an installation token from a token frame when the event omits one', async () => {
    let authHeader = '';
    const fakeFetch = async (_url: string, init?: RequestInit) => {
        authHeader = (init?.headers as Record<string, string>).authorization;
        return new Response(JSON.stringify({ rawPayload: { ok: true } }), { status: 200 });
    };
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({ type: 'token', installationId: 42, token: 'cached-token' }));
    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 3,
        delivery: { deliveryId: 'pull-2', eventType: 'issues', installationId: 42 },
    }));
    await flush();
    await flush();

    assert.equal(authHeader, 'Bearer cached-token');
    assert.equal(dispatched.length, 1);

    await service.stop();
});

test('does not ACK when payload pull fails (relay may redeliver)', async () => {
    const fakeFetch = async () => new Response('nope', { status: 500 });
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 7,
        delivery: { deliveryId: 'fail-1', eventType: 'issues', installationToken: 't' },
    }));
    await flush();
    await flush();

    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0);

    // A redelivery after a transient failure is reprocessed (id was released).
    socket.emit('message', eventFrame({ sequence: 8, deliveryId: 'fail-1', eventType: 'issues', rawPayload: { retried: true } }));
    await flush();
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].payload, { retried: true });

    await service.stop();
});

test('does not ACK when the webhook handler throws', async () => {
    const { service } = makeService({
        dispatch: async () => {
            throw new Error('handler boom');
        },
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', eventFrame({ sequence: 1, deliveryId: 'boom', eventType: 'issues', rawPayload: {} }));
    await flush();

    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0);

    await service.stop();
});

test('answers a ping frame with a pong frame', async () => {
    const { service } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({ type: 'ping' }));
    await flush();

    assert.deepEqual(socket.sentFrames(), [{ type: 'pong' }]);

    await service.stop();
});

test('logs error frames without crashing', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({ type: 'error', code: 'BAD', message: 'something failed' }));
    await flush();

    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().length, 0);

    await service.stop();
});

test('parses Buffer, Buffer[], and ArrayBuffer event frames', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    const buf = Buffer.from(eventFrame({ sequence: 1, deliveryId: 'b1', eventType: 'issues', rawPayload: { n: 1 } }));
    socket.emit('message', buf);

    const json = eventFrame({ sequence: 2, deliveryId: 'b2', eventType: 'pull_request', rawPayload: { n: 2 } });
    const mid = Math.floor(json.length / 2);
    socket.emit('message', [Buffer.from(json.slice(0, mid)), Buffer.from(json.slice(mid))]);

    const ab = new TextEncoder().encode(eventFrame({ sequence: 3, deliveryId: 'b3', eventType: 'check_run', rawPayload: { n: 3 } })).buffer;
    socket.emit('message', ab as unknown as RawData);

    await flush();

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
