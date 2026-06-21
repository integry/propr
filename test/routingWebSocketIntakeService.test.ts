import { after, test } from 'node:test';
import assert from 'node:assert';
import {
    RoutingWebSocketIntakeService,
    closeConnection,
    type MinimalWebSocket,
    type RawData,
    type RoutingWebSocketIntakeServiceOptions,
} from '@propr/core';

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

function makeService(overrides: Partial<RoutingWebSocketIntakeServiceOptions> = {}) {
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

test('start() falls back to the hosted routing relay when no routing URL is configured', async () => {
    const prev = process.env.PROPR_ROUTING_URL;
    delete process.env.PROPR_ROUTING_URL;
    FakeWebSocket.instances = [];
    try {
        const service = new RoutingWebSocketIntakeService({
            relayToken: 'relay-secret',
            webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        });
        await service.start();
        const socket = FakeWebSocket.instances[0];
        assert.equal(socket.address, 'wss://webhook.propr.dev/v1/connect');
        await service.stop();
    } finally {
        if (prev !== undefined) process.env.PROPR_ROUTING_URL = prev;
    }
});

test('start() rejects when no relay token is configured', async () => {
    FakeWebSocket.instances = [];
    const prev = process.env.PROPR_GH_RELAY_TOKEN;
    delete process.env.PROPR_GH_RELAY_TOKEN;
    try {
        const service = new RoutingWebSocketIntakeService({
            routingUrl: 'wss://routing.example',
            webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        });
        await assert.rejects(() => service.start(), /relay token/);
        // The failure must be fast, before any socket is dialed.
        assert.equal(FakeWebSocket.instances.length, 0, 'no connection may be attempted without a relay token');
    } finally {
        if (prev !== undefined) process.env.PROPR_GH_RELAY_TOKEN = prev;
    }
});

test('start() rejects unsupported schemes and unparseable URLs', async () => {
    const bad = new RoutingWebSocketIntakeService({
        routingUrl: 'ftp://routing.example',
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
    });
    await assert.rejects(() => bad.start(), /wss:\/\/ or https:\/\//);

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
        dispatch: async (payload, eventType) => {
            dispatched.push({ payload, eventType, correlationId: 'x' });
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
        dispatch: async (payload, eventType) => {
            calls += 1;
            dispatched.push({ payload, eventType, correlationId: 'x' });
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

test('discards an event frame with no delivery id (no dispatch, no ACK)', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    // Two unaddressable event frames: one whose `delivery` carries no deliveryId,
    // and one with no `delivery` at all. With no id there is nothing to ACK by, so
    // both must be dropped without dispatching or ACKing.
    socket.emit('message', JSON.stringify({ type: 'event', sequence: 1, delivery: { eventType: 'issues' } }));
    socket.emit('message', JSON.stringify({ type: 'event', sequence: 2 }));
    await flush();

    assert.equal(dispatched.length, 0);
    assert.equal(
        socket.sentFrames().filter((f) => f.type === 'ack').length,
        0,
        'an event frame with no delivery id must not be ACKed',
    );

    await service.stop();
});

test('ignores a token frame missing its installationId or token', async () => {
    let fetchCalls = 0;
    const fakeFetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ rawPayload: { ok: true } }), { status: 200 });
    };
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    // Neither frame is a usable credential, so nothing is cached for installation 5.
    socket.emit('message', JSON.stringify({ type: 'token', installationId: 5 })); // no token
    socket.emit('message', JSON.stringify({ type: 'token', token: 'orphan' })); // no installationId
    // An event that can only be authenticated with installation 5's token now has
    // none available: it must not pull and must not ACK (the relay may redeliver
    // once a well-formed token frame arrives).
    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 1,
        delivery: { deliveryId: 'no-tok', eventType: 'issues', installationId: 5 },
    }));
    await flush();
    await flush();

    assert.equal(fetchCalls, 0, 'no pull may run without a cached token');
    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0, 'no ACK without a usable token');

    await service.stop();
});

test('ignores routing frames with an unknown type without crashing', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    // An unrecognized `type` and a frame with no `type` field at all are both
    // ignored: no dispatch, and nothing is sent back to the relay.
    socket.emit('message', JSON.stringify({ type: 'mystery', whatever: true }));
    socket.emit('message', JSON.stringify({ nope: 1 }));
    await flush();

    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().length, 0, 'an unknown frame produces no response');

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

test('an expired cached installation token is not used for a payload pull', async () => {
    let fetchCalls = 0;
    const fakeFetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ rawPayload: { ok: true } }), { status: 200 });
    };
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    // Token already expired (expiresAt in the distant past): the cache must treat
    // it as a miss so the stale credential is never sent to the relay.
    socket.emit('message', JSON.stringify({ type: 'token', installationId: 7, token: 'stale', expiresAt: 1 }));
    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 1,
        delivery: { deliveryId: 'exp-1', eventType: 'issues', installationId: 7 },
    }));
    await flush();
    await flush();

    assert.equal(fetchCalls, 0, 'no pull may be attempted without a valid token');
    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0, 'no ACK without a valid token');

    await service.stop();
});

test('a token frame with an unparseable expiry is not cached (avoids a forever-stale token)', async () => {
    let fetchCalls = 0;
    const fakeFetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ rawPayload: { ok: true } }), { status: 200 });
    };
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    // expiresAt is present but unparseable: caching it as non-expiring would leave a
    // stale credential forever, so the frame must be dropped (treated as a miss).
    socket.emit('message', JSON.stringify({
        type: 'token',
        installationId: 9,
        token: 'corrupt',
        expiresAt: 'not-a-date',
    }));
    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 1,
        delivery: { deliveryId: 'corrupt-1', eventType: 'issues', installationId: 9 },
    }));
    await flush();
    await flush();

    assert.equal(fetchCalls, 0, 'a token with a corrupt expiry must not be used for a pull');
    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0, 'no ACK without a usable token');

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

test('does not ACK when the pulled payload is malformed JSON (relay may redeliver)', async () => {
    let calls = 0;
    const fakeFetch = async () => {
        calls += 1;
        // First pull returns an unparseable body; the retry returns valid JSON.
        if (calls === 1) {
            return new Response('not json{', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ rawPayload: { retried: true } }), { status: 200 });
    };
    const { service, dispatched } = makeService({ fetchImpl: fakeFetch });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 11,
        delivery: { deliveryId: 'bad-json', eventType: 'issues', installationToken: 't' },
    }));
    await flush();
    await flush();

    // Malformed body must not be dispatched and must not be ACKed.
    assert.equal(dispatched.length, 0);
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0);

    // A redelivery is reprocessed (the id was released on failure).
    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence: 12,
        delivery: { deliveryId: 'bad-json', eventType: 'issues', installationToken: 't' },
    }));
    await flush();
    await flush();
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].payload, { retried: true });

    await service.stop();
});

test('a throwing socket.send during ACK does not crash; the delivery is re-ACKed on redelivery', async () => {
    const { service, dispatched } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    // Make the ACK send throw on the first delivery. The service must swallow it
    // (the delivery stays accepted in memory) rather than crashing the handler.
    const realSend = socket.send.bind(socket);
    socket.send = () => {
        throw new Error('socket send boom');
    };

    socket.emit('message', eventFrame({ sequence: 1, deliveryId: 'send-fail', eventType: 'issues', rawPayload: { n: 1 } }));
    await flush();

    assert.equal(dispatched.length, 1, 'delivery is still processed even though the ACK send failed');
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0, 'no ACK was captured (send threw)');

    // Restore send; a redelivery of the accepted id re-ACKs without reprocessing.
    socket.send = realSend;
    socket.emit('message', eventFrame({ sequence: 2, deliveryId: 'send-fail', eventType: 'issues', rawPayload: { n: 1 } }));
    await flush();

    assert.equal(dispatched.length, 1, 'accepted delivery must not be reprocessed');
    assert.deepEqual(socket.sentFrames().filter((f) => f.type === 'ack'), [
        { type: 'ack', sequence: 2, deliveryId: 'send-fail' },
    ]);

    await service.stop();
});

test('stop() drains in-flight work and lets its ACK reach the relay before closing the socket', async () => {
    let resolveDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((r) => {
        resolveDispatch = r;
    });
    const { service } = makeService({
        dispatch: async () => {
            await dispatchGate;
        },
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', eventFrame({ sequence: 4, deliveryId: 'drain-1', eventType: 'issues', rawPayload: {} }));
    await flush();
    // Dispatch is gated: no ACK yet, socket still open.
    assert.equal(socket.sentFrames().filter((f) => f.type === 'ack').length, 0);

    const stopPromise = service.stop();
    await flush();
    // stop() is blocked draining the in-flight delivery; the socket is not closed yet.
    assert.equal(socket.closed, false, 'socket must stay open until in-flight work drains');

    resolveDispatch();
    await stopPromise;

    // The ACK was sent over the still-open socket, then the socket was closed.
    assert.deepEqual(socket.sentFrames().filter((f) => f.type === 'ack'), [
        { type: 'ack', sequence: 4, deliveryId: 'drain-1' },
    ]);
    assert.equal(socket.closed, true);
});

test('stop() does not hang forever when in-flight work never completes', async () => {
    // Dispatch never resolves: stop() must give up after the drain timeout and
    // close the socket anyway rather than blocking the daemon's signal handler.
    const { service } = makeService({
        shutdownDrainTimeoutMs: 20,
        dispatch: () => new Promise<void>(() => {}),
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', eventFrame({ sequence: 1, deliveryId: 'hang-1', eventType: 'issues', rawPayload: {} }));
    await flush();

    // Bound the assertion so a regression (an unbounded drain) fails the test
    // instead of hanging the whole run.
    const timedOut = Symbol('timedOut');
    const result = await Promise.race([
        service.stop().then(() => 'stopped'),
        new Promise((r) => setTimeout(() => r(timedOut), 1_000)),
    ]);
    assert.equal(result, 'stopped', 'stop() must resolve despite the wedged dispatch');
    assert.equal(socket.closed, true, 'socket is closed after the drain times out');
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

test('does not ACK on a reconnected socket for work started on a dropped connection', async () => {
    // Gate dispatch so the delivery is still in flight when its connection drops.
    let resolveDispatch: () => void = () => {};
    const dispatchGate = new Promise<void>((r) => {
        resolveDispatch = r;
    });
    const { service } = makeService({
        reconnectDelayMs: 5,
        maxReconnectDelayMs: 5,
        dispatch: async () => {
            await dispatchGate;
        },
    });
    await service.start();
    const first = FakeWebSocket.instances[0];
    first.emit('open');

    first.emit('message', eventFrame({ sequence: 9, deliveryId: 'reconn-1', eventType: 'issues', rawPayload: {} }));
    await flush();

    // The first connection drops mid-dispatch and the service reconnects.
    first.emit('close', 1006, Buffer.from(''));
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(FakeWebSocket.instances.length >= 2, 'expected a reconnect attempt');
    const second = FakeWebSocket.instances[1];
    second.emit('open');

    // Dispatch finishes only now — the original connection is gone. The ACK (whose
    // sequence is scoped to the dropped connection) must NOT be sent on either the
    // old socket or the new one.
    resolveDispatch();
    await flush();
    await flush();

    assert.equal(first.sentFrames().filter((f) => f.type === 'ack').length, 0, 'no ACK on the dropped socket');
    assert.equal(second.sentFrames().filter((f) => f.type === 'ack').length, 0, 'no ACK on the reconnected socket');

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

test('getStatus() reports connectivity, last delivery id, and last ACK', async () => {
    // A fixed clock so the reported last-ACK timestamp is deterministic.
    const fixedNow = Date.parse('2026-06-21T03:00:00.000Z');
    const { service } = makeService({ now: () => fixedNow });

    // Before connecting: disconnected, no deliveries, routing URL surfaced.
    let status = service.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.routingUrl, 'wss://routing.example');
    assert.equal(status.lastDeliveryId, null);
    assert.equal(status.lastAckAt, null);

    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');

    status = service.getStatus();
    assert.equal(status.connected, true, 'connected after open');

    // Process and ACK an event — last delivery id and last ACK are recorded.
    socket.emit('message', eventFrame({ sequence: 1, deliveryId: 'd-status', eventType: 'issues', rawPayload: { n: 1 } }));
    await flush();

    status = service.getStatus();
    assert.equal(status.lastDeliveryId, 'd-status');
    assert.equal(status.lastAckAt, new Date(fixedNow).toISOString());

    // After the socket closes, connectivity flips back to disconnected but the
    // last-delivery diagnostics are retained.
    socket.emit('close', 1006, Buffer.from(''));
    status = service.getStatus();
    assert.equal(status.connected, false, 'disconnected after close');
    assert.equal(status.lastDeliveryId, 'd-status');

    await service.stop();
});

test('getStatus() does not record an ACK time when the socket cannot send', async () => {
    const fixedNow = Date.parse('2026-06-21T03:00:00.000Z');
    const { service } = makeService({ now: () => fixedNow });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    // Never emit 'open'; the socket is not the OPEN state for sending here.
    socket.readyState = 0; // CONNECTING — send() refuses, so no ACK is recorded.

    socket.emit('message', eventFrame({ sequence: 1, deliveryId: 'd-noack', eventType: 'issues', rawPayload: { n: 1 } }));
    await flush();

    const status = service.getStatus();
    assert.equal(status.lastAckAt, null, 'no ACK time when the ACK could not be sent');

    await service.stop();
});
