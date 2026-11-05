import { createServer } from 'node:http';
import knex from 'knex';
import { Server } from 'socket.io';

/** Real room routing and authorization; only infrastructure/producers are fixtures. */
export async function goalLifecycleServer() {
  // Server modules validate GitHub configuration on import. This local routing
  // fixture never contacts GitHub or a worker.
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.DB_FILENAME = ':memory:';
  const { SocketService } = await import('../../packages/api/services/socketService.ts');
  const { INSTANCE_OPERATIONAL_ROOM, SocketSubscriptionManager } = await import('../../packages/api/services/socketSubscriptions.ts');
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('goals', table => {
    table.string('goal_id').primary();
    table.string('owner_id');
    table.string('current_task_id');
    table.string('result_state');
    table.integer('final_pr_number');
  });
  await db.schema.createTable('tasks', table => { table.string('task_id').primary(); });
  await db('goals').insert([
    { goal_id: 'goal-1', owner_id: 'user-1', current_task_id: 'goal-task-1' },
    { goal_id: 'unrelated', owner_id: 'other-user', current_task_id: 'goal-unrelated' },
  ]);
  await db('tasks').insert([{ task_id: 'goal-task-1' }, { task_id: 'goal-unrelated' }]);
  const http = createServer();
  const io = new Server(http);
  const deps = { db, redisClient: { get: async () => null } };
  const subscriptions = new SocketSubscriptionManager({
    getQueueDependencies: () => deps,
    getQueueBroadcaster: () => null,
    taskWatcherManager: {
      startTaskWatcher: async () => {}, sendTaskLiveUpdate: async () => {}, stopTaskWatcherIfEmpty: async () => {},
    },
  });
  let client;
  const requests = [];
  io.on('connection', socket => {
    client = socket;
    socket.data.principal = {
      user: { id: 'user-1', login: 'operator', username: 'operator' },
      authorization: { role: 'member', permissions: [], source: 'managed' },
    };
    socket.data.revalidateAuthentication = async () => true;
    socket.onAny((event, id) => requests.push(`${event}:${id}`));
    subscriptions.setup(socket);
    // This branch grants ambient operational membership on connection. Remove
    // it in the fixture to prove delivery does not depend on that broad room.
    void socket.leave(INSTANCE_OPERATIONAL_ROOM);
  });
  const service = Object.create(SocketService.prototype);
  Object.assign(service, { io, queueDeps: deps, taskRevisions: new Map() });
  // Deliberately lose best-effort goal publications, including the derived one;
  // retain the production task revision gate and Socket.IO room broadcaster.
  service.handleGoalUpdate = async () => {};
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${http.address().port}/socket.io/?EIO=4&transport=websocket`,
    requests,
    reconnect: () => client?.conn.close(),
    rooms: () => [...(client?.rooms ?? [])],
    read: () => db('goals').where({ goal_id: 'goal-1' }).first(),
    settle: async () => {
      await db('goals').where({ goal_id: 'goal-1' }).update({ result_state: 'completed', final_pr_number: 8 });
      // An unauthorized task's frame goes through the same real broadcaster.
      // The owner's client must receive only its own later terminal frame.
      await service.handleTaskUpdate({
        eventType: 'task:update', taskId: 'goal-unrelated', state: 'completed',
        previousState: 'claude_execution', timestamp: '2026-10-14T01:02:18Z', version: 2,
      });
      await service.handleTaskUpdate({
        eventType: 'task:update', taskId: 'goal-task-1', state: 'completed',
        previousState: 'claude_execution', timestamp: '2026-10-14T01:02:18Z', version: 2,
      });
    },
    close: async () => {
      await new Promise(resolve => io.close(() => resolve()));
      await db.destroy();
    },
  };
}
