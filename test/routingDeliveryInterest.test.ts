import { after, afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DELIVERY_INTEREST_CAPABILITY,
    MAX_INTEREST_FRAME_BYTES,
    MAX_INTEREST_REPOSITORIES,
    RoutingWebSocketIntakeService,
    SUPPORTED_WEBHOOK_EVENTS,
    buildDeliveryInterest,
    closeConnection,
    getWebhookDeliveryInterest,
    initializeWebhookHandler,
    type DeliveryInterest,
    type MinimalWebSocket,
    type RoutingWebSocketIntakeServiceOptions,
} from '@propr/core';

after(async () => {
    await closeConnection();
});

class FakeWebSocket implements MinimalWebSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    constructor(public readonly address: string) { FakeWebSocket.instances.push(this); }
    on(event: string, listener: (...args: unknown[]) => void): void { (this.listeners[event] ||= []).push(listener); }
    emit(event: string, ...args: unknown[]): void { for (const l of this.listeners[event] || []) l(...args); }
    send(data: string): void { this.sent.push(data); }
    ping(): void {}
    close(): void { this.readyState = 3; }
    terminate(): void { this.readyState = 3; }
    frames(type?: string): Record<string, unknown>[] {
        return this.sent.map(s => JSON.parse(s) as Record<string, unknown>).filter(f => !type || f.type === type);
    }
}

const interestFor = (repositories: '*' | string[]): DeliveryInterest =>
    buildDeliveryInterest({ repositories, checkRunProcessorRegistered: false });

test('the declaration covers exactly the supported events with the handler-derived rules', () => {
    const interest = interestFor(['Acme/Widgets ', 'acme/widgets', 'zeta/app', 'beta/lib', ' ']);
    assert.equal(interest.version, 1);
    assert.deepEqual(interest.repositories, ['acme/widgets', 'beta/lib', 'zeta/app']);
    assert.deepEqual(Object.keys(interest.events).sort(), [...SUPPORTED_WEBHOOK_EVENTS].sort());
    assert.deepEqual(interest.events, {
        issues: {},
        issue_comment: {},
        pull_request_review_comment: {},
        pull_request: {},
        check_run: { actions: ['completed'] },
        check_suite: { actions: ['completed'], conclusions: ['success', 'neutral', 'skipped'] },
        push: { refPrefixes: ['refs/heads/'], excludeDeleted: true },
        status: { states: ['success', 'failure', 'error'] },
    });
    assert.deepEqual(buildDeliveryInterest({ repositories: [], checkRunProcessorRegistered: true }).events.check_run, {});
});

test('the declaration stays within the contract limits', () => {
    const interest = interestFor(['acme/widgets']);
    assert.ok(Object.keys(interest.events).length <= 32);
    for (const rule of Object.values(interest.events)) {
        for (const list of [rule.actions, rule.states, rule.conclusions, rule.refPrefixes]) {
            if (!list) continue;
            assert.ok(list.length <= 64);
            for (const entry of list) assert.ok(typeof entry === 'string' && entry.length <= 128);
        }
    }
});

test('repositories fall back to "*" above 1000 entries or 48 KiB', () => {
    const names = (count: number, length = 12) => Array.from({ length: count }, (_, i) => `o/${String(i).padStart(length, 'r')}`);
    assert.equal((interestFor(names(MAX_INTEREST_REPOSITORIES)).repositories as string[]).length, MAX_INTEREST_REPOSITORIES);
    assert.equal(interestFor(names(MAX_INTEREST_REPOSITORIES + 1)).repositories, '*');
    // 400 names of ~140 characters exceed 48 KiB well before 1000 entries.
    const long = names(400, 137);
    assert.equal(interestFor(long).repositories, '*');
    // Largest list that still fits keeps the list; one more entry falls back.
    let fitting = 0;
    while (interestFor(long.slice(0, fitting + 1)).repositories !== '*') fitting += 1;
    const kept = interestFor(long.slice(0, fitting));
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'hello', protocolVersion: 1, capabilities: ['account_status', DELIVERY_INTEREST_CAPABILITY], interest: kept })) <= MAX_INTEREST_FRAME_BYTES);
    assert.ok(fitting > 300 && fitting < 400);
});

test('the shared handler declares the repositories its filter accepts', async () => {
    let repos = ['Acme/Widgets'];
    await initializeWebhookHandler({
        issueProcessor: async () => {}, commentProcessor: async () => {}, commentDeletedHandler: async () => {}, commentEditedHandler: async () => {},
        repositoryFilter: Object.assign((repository: string) => repos.some(r => r.toLowerCase() === repository.toLowerCase()),
            { monitoredRepositories: () => repos.map(r => r.toLowerCase()) }),
    });
    assert.deepEqual(getWebhookDeliveryInterest().repositories, ['acme/widgets']);
    repos = [];
    assert.deepEqual(getWebhookDeliveryInterest().repositories, []);
});

let clock = 0;
beforeEach(() => {
    clock = 1_000_000;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
afterEach(() => mock.timers.reset());

function advance(ms: number): void {
    clock += ms;
    mock.timers.tick(ms);
}

async function connect(overrides: Partial<RoutingWebSocketIntakeServiceOptions> = {}) {
    FakeWebSocket.instances = [];
    const service = new RoutingWebSocketIntakeService({
        routingUrl: 'wss://routing.example',
        relayToken: 'relay-secret',
        installationId: 42,
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        dispatch: async () => {},
        now: () => clock,
        pingIntervalMs: 60_000,
        ...overrides,
    });
    await service.start();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.emit('open');
    return { service, socket };
}

test('the hello advertises delivery_interest.v1 and carries the declaration', async () => {
    const { service, socket } = await connect({ deliveryInterest: () => interestFor(['acme/widgets']) });
    assert.deepEqual(socket.frames('hello'), [{
        type: 'hello', protocolVersion: 1,
        capabilities: ['account_status', DELIVERY_INTEREST_CAPABILITY],
        interest: interestFor(['acme/widgets']),
    }]);
    // The heartbeat hello repeats the same declaration rather than resetting it.
    advance(60_000);
    assert.deepEqual(socket.frames('hello')[1], socket.frames('hello')[0]);
    await service.stop();
});

test('a custom dispatcher declares nothing, so the relay keeps forwarding everything', async () => {
    const { service, socket } = await connect();
    assert.deepEqual(socket.frames('hello'), [{ type: 'hello', protocolVersion: 1, capabilities: ['account_status'] }]);
    service.refreshDeliveryInterest();
    advance(10_000);
    assert.deepEqual(socket.frames('interest'), []);
    await service.stop();
});

test('the default dispatcher declares the shared handler interest', async () => {
    await initializeWebhookHandler({
        issueProcessor: async () => {}, commentProcessor: async () => {}, commentDeletedHandler: async () => {}, commentEditedHandler: async () => {},
    });
    const { service, socket } = await connect({ dispatch: undefined });
    assert.deepEqual(socket.frames('hello')[0].interest, getWebhookDeliveryInterest());
    await service.stop();
});

test('interest frames are sent only on change and at most once per debounce window', async () => {
    let repositories = ['acme/widgets'];
    const { service, socket } = await connect({ deliveryInterest: () => interestFor(repositories) });

    service.refreshDeliveryInterest();
    advance(10_000);
    assert.deepEqual(socket.frames('interest'), [], 'an unchanged declaration is not re-sent');

    repositories = ['acme/widgets', 'acme/gadgets'];
    service.refreshDeliveryInterest();
    assert.equal(socket.frames('interest').length, 1, 'outside the window a change is sent at once');
    assert.deepEqual(socket.frames('interest')[0], { type: 'interest', interest: interestFor(repositories) });

    repositories = ['acme/one'];
    service.refreshDeliveryInterest();
    repositories = ['acme/two'];
    service.refreshDeliveryInterest();
    advance(4_999);
    assert.equal(socket.frames('interest').length, 1, 'changes inside the window wait for it to end');
    advance(1);
    assert.equal(socket.frames('interest').length, 2);
    assert.deepEqual(socket.frames('interest')[1].interest, interestFor(['acme/two']), 'only the latest change is sent');

    repositories = ['acme/widgets'];
    service.refreshDeliveryInterest();
    repositories = ['acme/two'];
    advance(5_000);
    assert.equal(socket.frames('interest').length, 2, 'a change reverted before the window ends sends nothing');
    await service.stop();
});

test('a heartbeat hello carrying the declaration restarts the debounce window', async () => {
    let repositories = ['acme/widgets'];
    const { service, socket } = await connect({ deliveryInterest: () => interestFor(repositories) });
    advance(60_000);
    assert.equal(socket.frames('hello').length, 2, 'the heartbeat hello was sent');
    repositories = ['acme/gadgets'];
    service.refreshDeliveryInterest();
    advance(4_999);
    assert.deepEqual(socket.frames('interest'), [], 'no interest frame within 5 s of the heartbeat hello');
    advance(1);
    assert.deepEqual(socket.frames('interest'), [{ type: 'interest', interest: interestFor(['acme/gadgets']) }]);
    await service.stop();
});

test('a reconnect declares the current interest in its hello and drops a pending frame', async () => {
    let repositories = ['acme/widgets'];
    const { service, socket } = await connect({ deliveryInterest: () => interestFor(repositories), reconnectDelayMs: 10 });
    service.refreshDeliveryInterest();
    repositories = ['acme/gadgets'];
    service.refreshDeliveryInterest();
    socket.emit('close', 1006);
    advance(10);
    const next = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(next, socket);
    next.emit('open');
    advance(10_000);
    assert.deepEqual(next.frames('hello')[0].interest, interestFor(['acme/gadgets']));
    assert.deepEqual(socket.frames('interest'), []);
    assert.deepEqual(next.frames('interest'), []);
    await service.stop();
});

test('an unreadable declaration falls back to wanting every supported delivery', async () => {
    const { service, socket } = await connect({ deliveryInterest: () => { throw new Error('config unavailable'); } });
    const interest = socket.frames('hello')[0].interest as DeliveryInterest;
    assert.equal(interest.repositories, '*');
    assert.deepEqual(interest.events, Object.fromEntries(SUPPORTED_WEBHOOK_EVENTS.map(event => [event, {}])));
    await service.stop();
});
