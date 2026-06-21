import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { resolveGithubEventIntakeMode } from '../packages/shared/src/githubEventIntakeMode.js';
import {
    startEventIntake,
    type EventIntakeStartupDeps,
} from '../src/daemon/eventIntakeStartup.js';

// These tests exercise the central daemon mode switch in isolation. They never open
// real Redis, GitHub, or WebSocket connections: every side-effecting dependency is a
// node:test mock, and `scheduleInterval` is injected so no real timer is armed.

const FAKE_INTERVAL = { __fake: 'interval' } as unknown as NodeJS.Timeout;

/** Build a deps object where every dependency is a recording mock. */
function makeDeps(overrides: Partial<EventIntakeStartupDeps> = {}): EventIntakeStartupDeps {
    const routingService = {
        start: mock.fn(async () => {}),
        stop: mock.fn(async () => {}),
        getStatus: mock.fn(() => ({})),
    };
    const statusPublisher = { stop: mock.fn(async () => {}) };

    return {
        safePoll: mock.fn(() => {}),
        pollingIntervalMs: 60000,
        scheduleInterval: mock.fn(() => FAKE_INTERVAL),
        initWebhookHandler: mock.fn(async () => {}),
        createRoutingService: mock.fn(() => routingService as never),
        startRoutingStatusPublisher: mock.fn(async () => statusPublisher as never),
        ...overrides,
    };
}

test('polling mode calls safePoll and schedules the interval, without webhook/routing setup', async () => {
    const deps = makeDeps();

    const result = await startEventIntake('polling', deps);

    const safePoll = deps.safePoll as ReturnType<typeof mock.fn>;
    const scheduleInterval = deps.scheduleInterval as ReturnType<typeof mock.fn>;

    // safePoll runs once immediately, then the recurring poll is scheduled.
    assert.equal(safePoll.mock.calls.length, 1);
    assert.equal(scheduleInterval.mock.calls.length, 1);
    assert.equal(scheduleInterval.mock.calls[0].arguments[0], deps.safePoll);
    assert.equal(scheduleInterval.mock.calls[0].arguments[1], 60000);
    assert.equal(result.intervalId, FAKE_INTERVAL);

    // Polling does not touch the webhook handler or routing path.
    assert.equal((deps.initWebhookHandler as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal((deps.createRoutingService as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal((deps.startRoutingStatusPublisher as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal(result.routingService, null);
    assert.equal(result.routingStatusPublisher, null);
});

test('direct_webhook mode initializes the webhook handler and does not poll', async () => {
    const deps = makeDeps();

    const result = await startEventIntake('direct_webhook', deps);

    assert.equal((deps.initWebhookHandler as ReturnType<typeof mock.fn>).mock.calls.length, 1);

    // No polling and no routing service in direct webhook mode.
    assert.equal((deps.safePoll as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal((deps.scheduleInterval as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal((deps.createRoutingService as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal((deps.startRoutingStatusPublisher as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal(result.intervalId, null);
    assert.equal(result.routingService, null);
});

test('routing_websocket mode initializes the handler and starts the routing service', async () => {
    const deps = makeDeps();

    const result = await startEventIntake('routing_websocket', deps);

    // Handler is initialized before the connection so no events are dropped.
    assert.equal((deps.initWebhookHandler as ReturnType<typeof mock.fn>).mock.calls.length, 1);

    const createRoutingService = deps.createRoutingService as ReturnType<typeof mock.fn>;
    assert.equal(createRoutingService.mock.calls.length, 1);

    // The constructed service is started and handed to the status publisher.
    const service = createRoutingService.mock.calls[0].result as { start: ReturnType<typeof mock.fn> };
    assert.equal(service.start.mock.calls.length, 1);
    const startRoutingStatusPublisher = deps.startRoutingStatusPublisher as ReturnType<typeof mock.fn>;
    assert.equal(startRoutingStatusPublisher.mock.calls.length, 1);
    assert.equal(startRoutingStatusPublisher.mock.calls[0].arguments[0], service);

    assert.ok(result.routingService);
    assert.ok(result.routingStatusPublisher);

    // Routing mode never polls.
    assert.equal((deps.safePoll as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal((deps.scheduleInterval as ReturnType<typeof mock.fn>).mock.calls.length, 0);
    assert.equal(result.intervalId, null);
});

test('legacy ENABLE_GITHUB_WEBHOOKS alone resolves to routing mode, not direct webhook', async () => {
    // Guards against a regression that re-wires the deprecated boolean to select
    // direct webhook mode: the resolver must keep returning routing_websocket...
    const resolved = resolveGithubEventIntakeMode({ enableGithubWebhooks: 'true' });
    assert.equal(resolved.mode, 'routing_websocket');
    assert.notEqual(resolved.mode, 'direct_webhook');

    // ...and feeding that resolved mode through the daemon switch must start the
    // routing path, never the direct webhook-only path.
    const deps = makeDeps();
    await startEventIntake(resolved.mode, deps);

    assert.equal((deps.createRoutingService as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal((deps.safePoll as ReturnType<typeof mock.fn>).mock.calls.length, 0);
});
