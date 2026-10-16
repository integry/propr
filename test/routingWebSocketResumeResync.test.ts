import { after, test } from 'node:test';
import assert from 'node:assert';
import {
    closeConnection,
    InMemoryResumeResyncStore,
    RoutingResumeResyncCoordinator,
    RoutingWebSocketIntakeService,
    type MinimalWebSocket,
    type ResumeResyncReconciler,
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

    constructor(public readonly address: string) {
        FakeWebSocket.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
        (this.listeners[event] ||= []).push(listener);
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners[event] || []) listener(...args);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    ping(): void {}
    close(): void {}
    terminate(): void {}

    frames(): Record<string, unknown>[] {
        return this.sent.map(item => JSON.parse(item) as Record<string, unknown>);
    }
}

const GAP = { gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z' };
const generation = { version: 1, installationId: 42, routingGeneration: 1, resumeGeneration: 1 };

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function makeService(options: { resync?: boolean; reconciler?: ResumeResyncReconciler } = {}) {
    FakeWebSocket.instances = [];
    const dispatched: string[] = [];
    const steps: string[] = [];
    const reconciler: ResumeResyncReconciler = options.reconciler ?? {
        listRepositories: () => ['acme/api'],
        repositorySteps: [{ family: 'labelled_issues', run: async ctx => { steps.push(ctx.repository); } }],
        installationSteps: [],
    };
    const resumeResync = options.resync === false ? undefined : new RoutingResumeResyncCoordinator({
        installationId: 42, store: new InMemoryResumeResyncStore(), reconciler,
    });
    const serviceOptions: RoutingWebSocketIntakeServiceOptions = {
        routingUrl: 'wss://routing.example',
        relayToken: 'relay-secret',
        installationId: 42,
        webSocketFactory: FakeWebSocket as unknown as new (address: string) => MinimalWebSocket,
        reconnectDelayMs: 1,
        dispatch: async (payload) => { dispatched.push((payload as { id: string }).id); },
        ...(resumeResync ? { resumeResync } : {}),
    };
    return { service: new RoutingWebSocketIntakeService(serviceOptions), dispatched, steps };
}

function send(socket: FakeWebSocket, frame: Record<string, unknown>): void {
    socket.emit('message', JSON.stringify(frame));
}

function eventFrame(sequence: number, deliveryId: string) {
    return { type: 'event', sequence, delivery: { deliveryId, eventType: 'issues', payload: { rawPayload: { id: deliveryId } } } };
}

test('without a coordinator the hello and frame handling stay backward compatible', async () => {
    const { service } = makeService({ resync: false });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    assert.deepEqual(socket.frames()[0], { type: 'hello', protocolVersion: 1, capabilities: ['account_status'] });
    send(socket, { type: 'resync_required', ...generation, ...GAP });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(socket.frames().length, 1, 'unknown control frames are ignored, never answered');
    assert.equal(service.getStatus().resync, undefined);
    await service.stop();
});

test('advertises installation_resume_resync_v1 and completes only after reconciliation', async () => {
    const { service, steps } = makeService();
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    assert.deepEqual(socket.frames()[0], {
        type: 'hello', protocolVersion: 1, capabilities: ['account_status', 'installation_resume_resync_v1'],
    });
    send(socket, { type: 'resume_pending', ...generation, gapStartedAt: GAP.gapStartedAt });
    await waitFor(() => service.getStatus().resync?.state === 'pending', 'pending');
    assert.equal(service.getStatus().resync?.intakeWaiting, true);

    send(socket, { type: 'resync_required', ...generation, ...GAP });
    await waitFor(() => socket.frames().some(item => item.type === 'resync_complete'), 'resync_complete');
    assert.deepEqual(steps, ['acme/api']);
    const complete = socket.frames().find(item => item.type === 'resync_complete') as Record<string, unknown>;
    assert.equal(complete.resumeGeneration, 1);

    send(socket, { type: 'resync_accepted', ...generation, completionId: complete.completionId });
    await waitFor(() => service.getStatus().resync?.state === 'acknowledged', 'acknowledged');
    assert.equal(service.getStatus().resync?.intakeWaiting, false);
    await service.stop();
});

test('events right after unsuspension overlap safely with catch-up and later replay', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { service, dispatched } = makeService({
        reconciler: {
            listRepositories: () => ['acme/api'],
            repositorySteps: [{ family: 'labelled_issues', run: async () => { await gate; } }],
            installationSteps: [],
        },
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    send(socket, { type: 'resync_required', ...generation, ...GAP });
    await waitFor(() => service.getStatus().resync?.running === true, 'reconciliation running');

    // A delivery arriving while reconciliation runs is processed and ACKed normally.
    send(socket, eventFrame(1, 'delivery-1'));
    await waitFor(() => socket.frames().some(item => item.type === 'ack'), 'ack during resync');
    assert.deepEqual(dispatched, ['delivery-1']);
    release();
    await waitFor(() => socket.frames().some(item => item.type === 'resync_complete'), 'resync_complete');

    // Routing replays its cached post-resume events after accepting the completion:
    // the already-processed delivery is re-ACKed without being dispatched again.
    send(socket, eventFrame(2, 'delivery-1'));
    send(socket, eventFrame(3, 'delivery-2'));
    await waitFor(() => socket.frames().filter(item => item.type === 'ack').length === 3, 'replay acks');
    assert.deepEqual(dispatched, ['delivery-1', 'delivery-2']);
    const acks = socket.frames().filter(item => item.type === 'ack');
    assert.deepEqual(acks.map(item => [item.sequence, item.deliveryId, item.status]), [
        [1, 'delivery-1', 'accepted'], [2, 'delivery-1', 'accepted'], [3, 'delivery-2', 'accepted'],
    ]);
    await service.stop();
});

test('a reconnect resends an unaccepted completion over the new socket only', async () => {
    const { service, steps } = makeService();
    await service.start();
    const first = FakeWebSocket.instances[0];
    first.emit('open');
    send(first, { type: 'resync_required', ...generation, ...GAP });
    await waitFor(() => first.frames().some(item => item.type === 'resync_complete'), 'first completion');
    const completionId = first.frames().find(item => item.type === 'resync_complete')?.completionId;

    first.emit('close', 1006, Buffer.from(''));
    await waitFor(() => FakeWebSocket.instances.length === 2, 'reconnect');
    const second = FakeWebSocket.instances[1];
    // A late control frame from the superseded socket is ignored.
    send(first, { type: 'resync_accepted', ...generation, completionId });
    second.emit('open');
    await waitFor(() => second.frames().some(item => item.type === 'resync_complete'), 'resent completion');
    assert.equal(second.frames()[0].type, 'hello', 'the capability is renegotiated before the resend');
    assert.equal(second.frames().find(item => item.type === 'resync_complete')?.completionId, completionId);
    assert.equal(service.getStatus().resync?.state, 'completed');
    assert.deepEqual(steps, ['acme/api'], 'reconnecting did not rerun reconciliation');
    await service.stop();
});
