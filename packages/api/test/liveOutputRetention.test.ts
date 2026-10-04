import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Server as SocketIOServer } from 'socket.io';
import { db } from '@propr/core';
import { createClaudeStreamProjection } from '../routes/liveDetailsCodexParser.js';
import { projectTaskLiveDetails } from '../routes/liveDetailsRoutes.js';
import { LiveOutputProjector } from '../services/liveOutputStream.js';
import { createRedisOutputProjection } from '../services/redisOutputParser.js';
import { TaskWatcherManager } from '../services/taskWatcher.js';

after(async () => {
  await db.destroy();
});

const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const codexMessage = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

test('an incremental Claude projection releases emitted events but keeps what later records need', () => {
  const projection = createClaudeStreamProjection({ retainEvents: false });
  projection.feed(JSON.stringify({ type: 'assistant', timestamp: '2026-09-28T00:00:00Z', message: {
    content: [
      { type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'explorer', description: 'Look around' } },
      { type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ status: 'in_progress', content: 'Explore' }] } },
    ],
    usage: { input_tokens: 5, output_tokens: 1 },
  } }));
  const completed = projection.feed(JSON.stringify({ type: 'user', timestamp: '2026-09-28T00:00:10Z', message: {
    content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'Found it' }],
  } }));
  assert.deepEqual(completed.map(event => event.type), ['tool_result', 'subagent_completed'], 'a subagent started by an earlier record still completes');
  assert.deepEqual(projection.result().events, [], 'emitted events are not retained');
  assert.deepEqual(projection.metadata(), {
    todos: [{ status: 'in_progress', content: 'Explore' }],
    currentTask: 'Explore',
    tokenUsage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
});

test('an incremental generic projection releases emitted events but keeps a buffered message', () => {
  const projection = createRedisOutputProjection({ retainEvents: false });
  const delta = (content: string) => JSON.stringify({ type: 'message', role: 'assistant', delta: true, content });
  assert.deepEqual(projection.feed(delta('Checking '), '0').events, []);
  assert.deepEqual(projection.feed(delta('the parser'), '10').events, []);
  assert.equal(projection.pendingEvent()?.key, '0');
  const flushed = projection.feed(JSON.stringify({ type: 'tool_use', tool_name: 'Bash', tool_id: 'tool-1', parameters: { command: 'ls' } }), '20');
  assert.deepEqual(flushed.events.map(({ event, key }) => [event.type, key]), [['thought', '0'], ['tool_use', '20']]);
  assert.equal((flushed.events[0].event as { content?: string }).content, 'Checking the parser');
  assert.deepEqual(projection.result().events, [], 'emitted events are not retained');
  projection.feed(delta('Next'), '30');
  assert.deepEqual(projection.result().events.map(event => (event as { content?: string }).content), ['Next'], 'only the buffered message remains');
});

function collectGarbage(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

for (const [provider, record] of [['claude', assistant], ['generic', codexMessage]] as const) {
  test(`a watcher's ${provider} projector does not retain the bodies of events it emitted`, () => {
    const gc = collectGarbage();
    const projector = new LiveOutputProjector({ taskId: 'retention', epoch: '1', offset: 0 });
    const body = 'x'.repeat(1024);
    let offset = 0;
    let emitted = 0;
    const feedBatch = (first: number) => {
      const text = Array.from({ length: 1000 }, (_, index) => `${record(`${first + index} ${body}`)}\n`).join('');
      emitted += projector.feed(text, offset).length;
      offset += Buffer.byteLength(text);
    };
    if (provider === 'claude') {
      const init = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' })}\n`;
      projector.feed(init, offset);
      offset += Buffer.byteLength(init);
    }
    feedBatch(0);
    gc();
    const baseline = process.memoryUsage().heapUsed;
    for (let batch = 1; batch <= 60; batch += 1) {
      feedBatch(batch * 1000);
      projector.snapshot();
    }
    gc();
    const growth = process.memoryUsage().heapUsed - baseline;
    assert.equal(emitted, 61_000);
    assert.ok(growth < 16 * 1024 * 1024, `60 MiB of emitted events grew the heap by ${Math.round(growth / 1024 / 1024)} MiB`);
  });
}

/** A live log whose first `base` bytes were trimmed; `head` keeps the execution's first record. */
function trimmedLiveOutput(records: string[]) {
  const head = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' });
  const state = { base: 4096, text: records.map(line => `${line}\n`).join('') };
  const redis = {
    get: async (key: string) => key.startsWith('worker:state:')
      ? JSON.stringify({ history: [{ state: 'claude_execution', timestamp: '2026-09-28T00:00:00Z' }] })
      : null,
    eval: async (_script: string, options: { arguments: string[] }) => {
      const from = Math.max(state.base, Number(options.arguments[0]));
      const text = Buffer.from(state.text).subarray(from - state.base).toString();
      return [String(state.base), '1', '0', head, String(from), text, String(Buffer.byteLength(state.text)), '3'];
    },
  };
  return { redis: redis as unknown as RedisClientType, state };
}

const unavailableDb = (() => { throw new Error('database unavailable'); }) as unknown as Knex;

test('a live read of trimmed output reports the discarded history apart from its selection count', async () => {
  const { redis } = trimmedLiveOutput([assistant('Still working')]);
  const details = await projectTaskLiveDetails(redis, unavailableDb, 'trimmed-http') as { omittedEventCount?: number; historyTruncated?: boolean; events: unknown[] } | null;
  assert.equal(details?.events.length, 1);
  assert.equal(details?.omittedEventCount, 0, 'the retained tail fit the selection');
  assert.equal(details?.historyTruncated, true);

  const { redis: complete } = trimmedLiveOutput([assistant('Still working')]);
  (complete as unknown as { eval: (script: string, options: { arguments: string[] }) => Promise<string[]> }).eval = async () =>
    ['0', '1', '0', '', '0', `${assistant('Still working')}\n`, String(Buffer.byteLength(`${assistant('Still working')}\n`)), '0'];
  const untrimmed = await projectTaskLiveDetails(complete, unavailableDb, 'untrimmed-http') as { historyTruncated?: boolean } | null;
  assert.equal(untrimmed?.historyTruncated, undefined);
});

test('the watcher marks full state of trimmed output as truncated, and not its increments', async () => {
  const { redis, state } = trimmedLiveOutput([assistant('First retained')]);
  const emitted: Array<{ events: Array<{ content?: string }>; omittedEventCount?: number; historyTruncated?: boolean }> = [];
  const io = {
    to: () => ({ emit: (_event: string, payload: typeof emitted[number]) => { emitted.push(payload); } }),
    sockets: { adapter: { rooms: new Map() } },
  } as unknown as SocketIOServer;
  const manager = new TaskWatcherManager(io);
  manager.setDeps({ redisClient: redis, db: unavailableDb });
  const send = (manager as unknown as { sendRedisLiveUpdate: (id: string) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
  try {
    await manager.startTaskWatcher('trimmed-watcher');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].omittedEventCount, 0);
    assert.equal(emitted[0].historyTruncated, true, 'full state discloses the discarded history');

    state.text += `${assistant('Appended')}\n`;
    await send('trimmed-watcher');
    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[1].events.map(event => event.content), ['Appended']);
    assert.equal(emitted[1].omittedEventCount, undefined, 'an increment, not full state');
    assert.equal(emitted[1].historyTruncated, undefined);
  } finally {
    await manager.closeAll();
  }
});
