import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { EventPublisher, closeConnection } from '@propr/core';
import { ACTIVITY_UPDATE, GOAL_UPDATE, NOTIFICATION_UPDATE, USAGE_UPDATE } from '@propr/shared';
import { SocketService } from '../services/socketService.js';
import { SocketSubscriptionManager, ACTIVITY_ROOM, activityUserRoom } from '../services/socketSubscriptions.js';
import { ShellActivityBroadcaster } from '../services/shellActivityBroadcaster.js';

after(async () => closeConnection());

test('core publication reaches an authorized real socket and reconciles the changed projection', async () => {
  let state = 'pending';
  const projectedTaskStates: string[] = [];
  const http = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ state })); });
  const io = new Server(http, { transports: ['websocket'] });
  const service = Object.create(SocketService.prototype);
  Object.assign(service, { io, queueDeps: null,
    notificationProjection: { projectTaskUpdate: async (payload: { state: string }) => { projectedTaskStates.push(payload.state); } },
    taskRevisions: new Map(), taskUpdateTails: new Map(), draftUpdateTails: new Map() });
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
    for (const transport of [publisher['lifecycle'], publisher['bestEffort']]) {
      Object.assign(transport, { isInitialized: true, redis: { status: 'ready',
        publish: async (channel: string, message: string) => {
          service.handleEvent(channel, JSON.parse(message)); return 1;
        } } });
    }
    const refreshed = new Promise<{ state: string }>(resolve => client.once(ACTIVITY_UPDATE, async payload => {
      assert.equal(payload.change, 'completed');
      resolve(await (await fetch(origin)).json() as { state: string });
    }));
    state = 'completed';
    assert.equal(await publisher.publishTaskUpdate({ taskId: 'task-1', state, previousState: 'processing', repository: 'acme/app' }), true);
    assert.deepEqual(await refreshed, { state: 'completed' });
    assert.deepEqual(projectedTaskStates, ['completed'], 'the terminal event reaches the Inbox projection');

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
  const snapshots: Array<{ resource: string; data: unknown }> = [];
  let percent = 1;
  const socket = {
    rooms: new Set([ACTIVITY_ROOM]),
    data: { principal: { authorization: { source: 'local', permissions: ['instance.manage_agents'] } } },
    emit: (event: string, payload: { resource: string; data: unknown }) => {
      assert.equal(event, 'shell:snapshot');
      snapshots.push(payload);
    },
  };
  const io = { sockets: { adapter: { rooms: new Map([[ACTIVITY_ROOM, new Set(['socket'])]]) },
    sockets: new Map([['socket', socket]]) },
    to: () => ({ emit: (event: string) => events.push(event) }) };
  const broadcaster = new ShellActivityBroadcaster(io as never,
    async () => ({ daemon: 'running', timestamp: new Date().toISOString() }), async () => ({ enabled: true, agents: { claude: { name: 'claude', usage: { percent } } } }));
  await broadcaster.sample(); await broadcaster.sample();
  assert.deepEqual(events.slice().sort(), [ACTIVITY_UPDATE, USAGE_UPDATE].sort());
  assert.deepEqual(snapshots.map(snapshot => snapshot.resource).sort(), ['system', 'usage']);
  percent = 2; await broadcaster.sample();
  assert.equal(events.length, 3);
  assert.equal(events[2], USAGE_UPDATE);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots[2], {
    resource: 'usage', data: { enabled: true, agents: { claude: { name: 'claude', usage: { percent: 2 } } } },
  });
  broadcaster.close(); percent = 3; await broadcaster.sample();
  assert.equal(events.length, 3);
  assert.equal(snapshots.length, 3);
});

test('a malformed publication reaches no browser in either accepted format', () => {
  const emissions: Array<{ room: string; event: string }> = [];
  const dropped: string[] = [];
  const service = Object.create(SocketService.prototype);
  Object.assign(service, { queueDeps: null,
    io: { to: (room: string) => ({ emit: (event: string) => emissions.push({ room, event }) }) } });
  const occurredAt = new Date().toISOString();
  const warn = console.warn;
  console.warn = (message: unknown) => { dropped.push(String(message)); };
  try {
    // Both published activity formats, each carrying a timestamp nothing can
    // order by, a vocabulary the contract does not define, a scope no consumer
    // can filter on, or a terminal flag that contradicts its own change.
    // Supplying the envelope's missing `entityId` downstream normalizes the
    // frame; it does not make any of these valid.
    for (const identity of [{ entityId: 'task-1' }, { subjectId: 'task-1' }]) {
      for (const invalid of [
        { occurredAt: 'invalid', terminal: true },
        { occurredAt, terminal: false },
        { occurredAt, terminal: true, domain: 'invented' },
        { occurredAt, terminal: false, change: 'invented' },
        { occurredAt, terminal: true, repository: 7 },
      ]) {
        service.handleEvent('', { eventType: ACTIVITY_UPDATE, domain: 'task', change: 'completed',
          repository: null, ...identity, ...invalid });
      }
    }
    // A frame claiming the envelope format is held to it: `repository` is
    // required there, and only its own contract may excuse a missing field.
    service.handleEvent('', { eventType: ACTIVITY_UPDATE, domain: 'plan', change: 'created',
      entityId: 'plan-1', terminal: false, occurredAt });
    service.handleEvent('', { eventType: USAGE_UPDATE, source: 'guesswork', occurredAt });
    service.handleEvent('', { eventType: USAGE_UPDATE, occurredAt: 'invalid' });
    service.handleEvent('', { eventType: NOTIFICATION_UPDATE, change: 'read', eventId: 'event-1',
      recipientId: 'owner', unreadCount: 'three', occurredAt });
    service.handleEvent('', { eventType: NOTIFICATION_UPDATE, change: 'invented',
      recipientId: 'owner', occurredAt });
    assert.deepEqual(emissions, []);
    // Every dropped frame is reported: a publisher that broke the contract is
    // the one thing an operator can act on here.
    assert.equal(dropped.length, 15);
    assert.equal(dropped.every(message => message.includes('Dropped malformed')), true);

    // Validation is not rejection: every format the relay accepts still reaches
    // its room, including the shell shape that names no subject.
    service.handleEvent('', { eventType: ACTIVITY_UPDATE, domain: 'task', change: 'completed',
      entityId: 'task-1', repository: 'acme/app', terminal: true, occurredAt });
    service.handleEvent('', { eventType: ACTIVITY_UPDATE, domain: 'queue', change: 'updated',
      terminal: false, occurredAt });
    service.handleEvent('', { eventType: USAGE_UPDATE, source: 'agent-tank', occurredAt });
    service.handleEvent('', { eventType: USAGE_UPDATE, provider: 'agent-tank', occurredAt });
    service.handleEvent('', { eventType: NOTIFICATION_UPDATE, change: 'dismissed_all',
      recipientId: 'owner', unreadCount: 0, occurredAt });
    assert.deepEqual(emissions, [
      { room: ACTIVITY_ROOM, event: ACTIVITY_UPDATE },
      { room: ACTIVITY_ROOM, event: ACTIVITY_UPDATE },
      { room: ACTIVITY_ROOM, event: USAGE_UPDATE },
      { room: ACTIVITY_ROOM, event: USAGE_UPDATE },
      { room: activityUserRoom('owner'), event: NOTIFICATION_UPDATE },
    ]);
    assert.equal(dropped.length, 15);
  } finally { console.warn = warn; }
});
