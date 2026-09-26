import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { EventPublisher, closeConnection } from '@propr/core';
import { ACTIVITY_UPDATE, GOAL_UPDATE, NOTIFICATION_UPDATE } from '@propr/shared';
import { SocketService } from '../services/socketService.js';
import { SocketSubscriptionManager, ACTIVITY_ROOM, activityUserRoom } from '../services/socketSubscriptions.js';
import { ShellActivityBroadcaster } from '../services/shellActivityBroadcaster.js';

after(async () => closeConnection());

test('core publication reaches an authorized real socket and reconciles the changed projection', async () => {
  let state = 'pending';
  const http = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ state })); });
  const io = new Server(http, { transports: ['websocket'] });
  const service = Object.create(SocketService.prototype);
  Object.assign(service, { io, queueDeps: null, taskRevisions: new Map(), taskUpdateTails: new Map(), draftUpdateTails: new Map() });
  const manager = new SocketSubscriptionManager({ getQueueDependencies: () => null, getQueueBroadcaster: () => null,
    taskWatcherManager: { stopTaskWatcherIfEmpty: async () => {} } as never });
  io.on('connection', socket => {
    socket.data.principal = { user: { id: 'owner' }, authorization: { permissions: [] } };
    socket.data.revalidateAuthentication = async () => true;
    manager.setup(socket);

  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const client = connect(origin, { transports: ['websocket'] });
  try {
    await once(client, 'connect');
    const ready = once(client, 'activity:ready');
    client.emit('subscribe:activity');
    await ready;
    const publisher = new EventPublisher();
    // Replace only Redis transport: use the production publisher, relay, rooms,
    // Socket.IO transport and a client reconciliation read.
    Object.assign(publisher, { isInitialized: true, redis: { status: 'ready',
      publish: async (channel: string, message: string) => {
        service.handleEvent(channel, JSON.parse(message)); return 1;
      } } });
    const refreshed = new Promise<{ state: string }>(resolve => client.once(ACTIVITY_UPDATE, async payload => {
      assert.equal(payload.change, 'completed');
      resolve(await (await fetch(origin)).json() as { state: string });
    }));
    state = 'completed';
    assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state, previousState: 'processing', repository: 'acme/app' }), true);
    assert.deepEqual(await refreshed, { state: 'completed' });

    service.queueDeps = { db: () => ({ where: () => ({ first: async () => ({ owner_id: 'owner', repository: 'acme/app', result_state: 'completed' }) }) }) };
    const goal = once(client, GOAL_UPDATE);
    await publisher.publishGoalUpdate({ goalId: 'goal-1' });
    assert.equal((await goal)[0].resultState, 'completed');
    const notification = once(client, NOTIFICATION_UPDATE);
    await publisher.publishNotificationUpdate({ recipientIds: ['owner', 'someone-else'], eventId: 'event-1', change: 'read', repository: null });
    // Narrowed, not stripped: the frame still satisfies its published contract,
    // and it names only the recipient receiving it.
    assert.deepEqual((await notification)[0].recipientIds, ['owner']);
  } finally { client.disconnect(); await io.close(); http.close(); }
});

test('goal and notification events never enter public activity rooms', async () => {
  const emissions: Array<{ room: string; event: string; payload: unknown }> = [];
  const service = Object.create(SocketService.prototype);
  Object.assign(service, { io: { to: (room: string) => ({ emit: (event: string, payload: unknown) => emissions.push({ room, event, payload }) }) },
    queueDeps: { db: () => ({ where: () => ({ first: async () => ({ owner_id: 'alice', repository: 'acme/private', result_state: 'failed' }) }) }) } });
  await service.handleGoalUpdate({ goalId: 'private-goal', occurredAt: new Date().toISOString() });
  // Whole frame: an announcement that does not satisfy its published contract is
  // dropped at the trust boundary rather than forwarded to a browser.
  service.handleEvent('', { eventType: NOTIFICATION_UPDATE, recipientIds: ['bob'], eventId: 'private-event',
    change: 'created', repository: null, occurredAt: new Date().toISOString() });
  // Two frames each - the producer event and the activity envelope derived from
  // it - and every one of them inside the addressed user's own room.
  assert.deepEqual(emissions.map(({ room }) => room), [activityUserRoom('alice'), activityUserRoom('alice'),
    activityUserRoom('bob'), activityUserRoom('bob')]);
});

test('activity unsubscribe wins across an awaited adapter join', async () => {
  const handlers = new Map<string, () => Promise<void>>();
  const rooms = new Set<string>();
  let release!: () => void;
  let entered!: () => void;
  const joining = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const socket = { connected: true, data: { principal: { user: { id: 'owner' } }, revalidateAuthentication: async () => true }, rooms,
    on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler), emit: () => {},
    join: async (room: string) => { if (room === ACTIVITY_ROOM) { entered(); await gate; } rooms.add(room); },
    leave: async (room: string) => { rooms.delete(room); } };
  new SocketSubscriptionManager({ getQueueDependencies: () => null, getQueueBroadcaster: () => null, taskWatcherManager: {} as never }).setup(socket as never);
  const pending = handlers.get('subscribe:activity')!(); await joining;
  const leaving = handlers.get('unsubscribe:activity')!(); release(); await Promise.all([pending, leaving]);
  assert.equal(rooms.has(ACTIVITY_ROOM), false); assert.equal(rooms.has(activityUserRoom('owner')), false);
});

test('activity subscriptions require successful authentication revalidation', async () => {
  const handlers = new Map<string, () => Promise<void>>();
  const rooms = new Set<string>();
  const socket = { connected: true, data: { principal: { user: { id: 'owner' } }, revalidateAuthentication: async () => false }, rooms,
    on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler), emit: () => {},
    join: async (room: string) => { rooms.add(room); }, leave: async (room: string) => { rooms.delete(room); } };
  new SocketSubscriptionManager({ getQueueDependencies: () => null, getQueueBroadcaster: () => null, taskWatcherManager: {} as never }).setup(socket as never);
  await handlers.get('subscribe:activity')!();
  assert.equal(rooms.has(ACTIVITY_ROOM), false);
  assert.equal(rooms.has(activityUserRoom('owner')), false);
});

test('shell snapshots emit only real changes and stop after close', async () => {
  const events: string[] = [];
  let percent = 1;
  const io = { sockets: { adapter: { rooms: new Map([[ACTIVITY_ROOM, new Set(['socket'])]]) } },
    to: () => ({ emit: (event: string) => events.push(event) }) };
  const broadcaster = new ShellActivityBroadcaster(io as never,
    async () => ({ daemon: 'running', timestamp: new Date().toISOString() }), async () => ({ percent }));
  await broadcaster.sample(); await broadcaster.sample();
  assert.equal(events.length, 2);
  percent = 2; await broadcaster.sample(); assert.equal(events.length, 3);
  broadcaster.close(); percent = 3; await broadcaster.sample(); assert.equal(events.length, 3);
});
