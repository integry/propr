import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import knex from 'knex';
import { Server as SocketServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import { GoalRepository, closeConnection } from '@propr/core';
import { up as foundation } from '../../core/src/db/migrations/20260831000000_create_goal_control_plane.js';
import { up as durable } from '../../core/src/db/migrations/20260901000000_add_durable_goal_replay.js';
import type { SocketPrincipal } from '../auth.js';
import { SocketSubscriptionManager, goalRoom } from '../services/socketSubscriptions.js';
import type { QueueDependencies } from '../services/socketService.js';
import type { TaskWatcherManager } from '../services/taskWatcher.js';

after(async () => { await closeConnection(); });

function principal(): SocketPrincipal {
  return {
    user: {
      id: 'owner', login: 'owner', username: 'owner', displayName: 'Owner',
      email: null, avatarUrl: null,
    },
    authorization: { role: 'member', permissions: [], source: 'managed' },
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('goal socket unwinds failed joins, replays, tails with ack, and evicts after revocation', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const httpServer = createServer();
  const io = new SocketServer(httpServer, { transports: ['websocket'] });
  let client: ClientSocket | undefined;
  try {
    await foundation(database);
    await durable(database);
    const repository = new GoalRepository(database);
    const goal = await repository.createGoal({
      ownerUserId: 'owner', repository: 'integry/propr', objective: 'socket replay',
      agent: 'codex', requestedModel: 'gpt-5.6-sol',
    });
    const lease = await repository.claimLease(goal.goalId, 'controller', 60_000);
    const fence = { leaseOwner: 'controller', leaseEpoch: lease.epoch };
    await repository.upsertProviderSession(goal.goalId, 'codex', {
      ...fence, turnId: 'turn', executionId: 'execution', attemptId: 'attempt',
    });
    const session = await repository.getProviderSession(goal.goalId, 'codex');
    assert(session);
    const append = (sequence: number) => repository.appendProviderEvent(goal.goalId, {
      schemaVersion: 1, type: 'provider.output',
      payload: { stream: 'stdout', outputType: 'text', chunk: `line-${sequence}` },
      idempotencyKey: `socket-${sequence}`, ...fence,
      source: {
        sessionId: session.session_id, turnId: 'turn', executionId: 'execution',
        attemptId: 'attempt', providerSequence: sequence, chunkIndex: 0,
        leaseGeneration: lease.epoch,
      },
    });
    await append(1);
    let enabled = false;
    let delayedAuthorization: Promise<void> | null = null;
    let delayedAuthorizationCalls = 0;
    let delayedAuthorizationStarted = 0;
    const manager = new SocketSubscriptionManager({
      getQueueDependencies: () => ({
        db: database, taskQueue: {} as Queue, redisClient: {} as RedisClientType,
      } as QueueDependencies),
      getQueueBroadcaster: () => null,
      taskWatcherManager: {} as TaskWatcherManager,
      isRepositoryEnabled: async () => {
        if (delayedAuthorization && delayedAuthorizationCalls > 0) {
          delayedAuthorizationCalls -= 1;
          delayedAuthorizationStarted += 1;
          await delayedAuthorization;
        }
        return enabled;
      },
      goalAcknowledgementTimeoutMs: 100,
    });
    let serverRoomPresent = false;
    io.on('connection', socket => {
      socket.data.principal = principal();
      socket.data.revalidateAuthentication = async () => true;
      manager.setup(socket);
      const timer = setInterval(() => {
        serverRoomPresent = socket.rooms.has(goalRoom(goal.goalId));
      }, 10);
      socket.once('disconnect', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    assert(address && typeof address === 'object');
    client = createClient(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'], reconnection: false,
    });
    const sequences: number[] = [];
    const errors: string[] = [];
    let subscribed = 0;
    let acknowledge = false;
    client.on('goal:events', (payload: { events: Array<{ sequence: number }> }, ack: () => void) => {
      sequences.push(...payload.events.map(event => event.sequence));
      if (acknowledge) ack();
    });
    client.on('subscription:error', (payload: { code: string }) => errors.push(payload.code));
    client.on('goal:subscribed', () => { subscribed += 1; });
    await new Promise<void>(resolve => client!.once('connect', () => resolve()));
    client.emit('subscribe:goal', { goalId: goal.goalId, cursor: null });
    await waitFor(() => errors.includes('RECONNECT_REQUIRED') && !serverRoomPresent, 'failed join was not unwound');
    errors.length = 0;
    enabled = true;
    client.emit('subscribe:goal', { goalId: goal.goalId, cursor: null });
    await waitFor(() => sequences.includes(1) && errors.includes('RECONNECT_REQUIRED') && !serverRoomPresent,
      'unacknowledged replay was not evicted');
    errors.length = 0;
    acknowledge = true;
    client.emit('subscribe:goal', { goalId: goal.goalId, cursor: null });
    await waitFor(() => sequences.filter(sequence => sequence === 1).length === 2 && serverRoomPresent,
      'acknowledged replay did not recover');
    await append(2);
    await waitFor(() => sequences.includes(2), 'live tail did not deliver');
    enabled = false;
    await waitFor(() => errors.includes('RECONNECT_REQUIRED') && !serverRoomPresent, 'revoked socket was not evicted');
    await append(3);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(sequences, [1, 1, 2]);

    enabled = true;
    let releaseUnsubscribed!: () => void;
    delayedAuthorization = new Promise<void>(resolve => { releaseUnsubscribed = resolve; });
    delayedAuthorizationCalls = 1;
    const beforeUnsubscribe = subscribed;
    client.emit('subscribe:goal', { goalId: goal.goalId, cursor: null });
    await waitFor(() => delayedAuthorizationStarted === 1, 'delayed join did not reach authorization');
    client.emit('unsubscribe:goal', goal.goalId);
    releaseUnsubscribed();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(serverRoomPresent, false);
    assert.equal(subscribed, beforeUnsubscribe);

    let releaseConcurrent!: () => void;
    delayedAuthorization = new Promise<void>(resolve => { releaseConcurrent = resolve; });
    delayedAuthorizationCalls = 1;
    const beforeConcurrent = subscribed;
    client.emit('subscribe:goal', { goalId: goal.goalId, cursor: null });
    await waitFor(() => delayedAuthorizationStarted === 2, 'first concurrent join was not delayed');
    client.emit('subscribe:goal', { goalId: goal.goalId, cursor: null });
    releaseConcurrent();
    delayedAuthorization = null;
    await waitFor(
      () => subscribed === beforeConcurrent + 1 && serverRoomPresent,
      'newest concurrent join did not exclusively own the room'
    );
  } finally {
    client?.disconnect();
    await io.close();
    if (httpServer.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
    await database.destroy();
  }
});
