import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Redis } from 'ioredis';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { Server as SocketIOServer } from 'socket.io';
import { db, liveOutputKey } from '@propr/core';
import { LiveOutputProjector, projectLiveOutput, projectLiveOutputRead, readLiveOutput, type LiveOutputRead, type LiveOutputRedis } from '../services/liveOutputStream.js';
import { TaskWatcherManager } from '../services/taskWatcher.js';
import { findLatestExecutionStartForTask } from '../services/taskWatcherLookup.js';
import { mergeFullLiveDetails } from '../../../propr-ui/src/components/TaskDetails/liveDetailsMerge.js';
import { buildLiveOutputSnapshot } from '../../core/src/claude/docker/dockerLiveOutputSnapshot.js';
import { LiveOutputLog, liveOutputMetaKey, liveOutputOrigin, writeLiveOutput } from '../../core/src/agents/impl/utils/liveOutputLog.js';
import { withLiveOutputReads } from './liveOutputRedisFake.js';

after(async () => { await db.destroy(); });

type Event = Record<string, unknown> & { id: string };
const withoutId = (event: Event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'id'));

/** The same log read whole, and read after every record between its head and `retained` was trimmed. */
function fullAndTrimmed(records: string[], retained: number) {
  const text = `${records.join('\n')}\n`;
  const base = Buffer.byteLength(`${records.slice(0, retained).join('\n')}\n`);
  const read = (from: number): LiveOutputRead => ({
    epoch: 'generation:1', base: from, end: Buffer.byteLength(text), start: 0, head: records[0], from,
    envelopes: from === 0 ? 0 : records.slice(0, retained).filter(record => record.startsWith('{')).length,
    text: Buffer.from(text).subarray(from).toString(),
  });
  const project = (from: number) => projectLiveOutputRead(read(from), 'task', null, { selectEvents: false }).events as Event[];
  return { text, full: project(0), trimmed: project(base) };
}

function assertRetainedIdsAgree(full: Event[], trimmed: Event[]) {
  const byId = new Map(full.map(event => [event.id, event]));
  for (const event of trimmed) {
    const before = byId.get(event.id);
    if (before) assert.deepEqual(withoutId(event), withoutId(before), `${event.id} names the same event before and after trimming`);
  }
}

const assistant = (content: unknown[], second: number) =>
  JSON.stringify({ type: 'assistant', timestamp: `2026-09-27T00:00:0${second}Z`, message: { content } });
const toolResults = JSON.stringify({ type: 'user', timestamp: '2026-09-27T00:00:05Z', message: { content: [
  { type: 'tool_result', tool_use_id: 'task-1', content: [{ type: 'text', text: 'Survey found two callers' }] },
  { type: 'tool_result', tool_use_id: 'bash-1', content: 'tests pass' },
] } });

test('Claude tool results keep their IDs whether or not the Task invocation before them was trimmed', () => {
  const records = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }),
    assistant([{ type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'explore', description: 'Survey' } }], 1),
    assistant([{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test' } }], 2),
    toolResults,
    assistant([{ type: 'text', text: 'Done.' }], 6),
  ];
  const { text, full, trimmed } = fullAndTrimmed(records, 3);
  assert.deepEqual(full.map(event => event.type), ['tool_use', 'tool_use', 'tool_result', 'subagent_completed', 'tool_result', 'thought']);
  assert.deepEqual(trimmed.map(event => event.type), ['tool_result', 'tool_result', 'thought'], 'no subagent completion without its invocation');
  assertRetainedIdsAgree(full, trimmed);
  const secondResult = (events: Event[]) => events.find(event => event.toolUseId === 'bash-1')!;
  assert.equal(secondResult(trimmed).id, secondResult(full).id);
  assert.equal(new Set(full.map(event => event.id)).size, full.length);

  // Incremental reads split inside the multi-result envelope agree with the full read.
  const projector = new LiveOutputProjector({ taskId: 'task', epoch: 'generation:1', offset: 0 });
  const cut = text.indexOf('Survey found');
  const incremental = [...projector.feed(text.slice(0, cut), 0), ...projector.feed(text.slice(projector.offset), projector.offset)];
  assert.deepEqual(incremental, full);
});

test('OpenCode and Vibe events after a duplicate keep their IDs once the earlier record is trimmed', () => {
  const tool = (id: string, status: string) => ({ type: 'tool', callID: id, tool: 'bash', state: { status, input: { command: id }, output: `${id} output` } });
  const opencode = [
    JSON.stringify({ type: 'step_start', sessionID: 'session', timestamp: '2026-09-27T00:00:00Z' }),
    JSON.stringify({ type: 'message', sessionID: 'session', timestamp: '2026-09-27T00:00:01Z', parts: [tool('a', 'running')] }),
    // Cumulative record: `a` was already emitted by the record before it.
    JSON.stringify({ type: 'message', sessionID: 'session', timestamp: '2026-09-27T00:00:01Z', parts: [tool('a', 'completed'), tool('b', 'completed')] }),
  ];
  const vibe = [
    JSON.stringify({ role: 'system', timestamp: '2026-09-27T00:00:00Z', content: 'You are Vibe.' }),
    JSON.stringify({ role: 'assistant', timestamp: '2026-09-27T00:00:01Z', content: 'Inspect the parser' }),
    JSON.stringify({ role: 'assistant', timestamp: '2026-09-27T00:00:02Z', reasoning_content: 'Inspect the parser', content: 'Update the parser' }),
  ];
  const cases = [
    { records: opencode, duplicate: (event: Event) => event.toolUseId === 'a', retained: (event: Event) => event.toolUseId === 'b' },
    { records: vibe, duplicate: (event: Event) => event.internalReasoning === true, retained: (event: Event) => event.content === 'Update the parser' },
  ];
  for (const { records, duplicate, retained } of cases) {
    const { full, trimmed } = fullAndTrimmed(records, 2);
    assert.ok(trimmed.some(duplicate), 'once trimmed, the retained record emits what it skipped as a duplicate');
    assertRetainedIdsAgree(full, trimmed);
    assert.equal(trimmed.find(retained)?.id, full.find(retained)?.id);
  }
});

test('legacy executions of one task get distinct IDs in watcher and HTTP reads, and the UI replaces the old run', async () => {
  const taskId = 'legacy-executions';
  const history = [{ state: 'claude_execution', timestamp: '2026-09-27T00:00:00.000Z' }];
  const snapshot = (...messages: string[]) =>
    messages.map(text => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`).join('');
  let output = snapshot('Old A', 'Old B');
  const redis = withLiveOutputReads({ get: async (key: string) => {
    if (key.startsWith('worker:state:')) return JSON.stringify({ history });
    return key === liveOutputKey(taskId) ? output : null;
  } });
  const payloads: Array<{ events: Event[]; todos?: unknown[]; omittedEventCount?: number }> = [];
  const io = { to: () => ({ emit: (_event: string, payload: typeof payloads[number]) => payloads.push(payload) }) } as unknown as SocketIOServer;
  const manager = new TaskWatcherManager(io);
  manager.setDeps({ redisClient: redis as unknown as RedisClientType, db: {} as Knex });
  const send = (manager as unknown as { sendRedisLiveUpdate: (id: string) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
  const httpRead = async () => (await projectLiveOutput(redis, taskId, null, {
    resolveLegacyExecution: () => findLatestExecutionStartForTask({ redisClient: redis as unknown as RedisClientType, db: {} as Knex }, taskId),
  }))!.events;
  // The UI treats a payload carrying omittedEventCount as full state (applyTaskLiveUpdate).
  type Details = Parameters<typeof mergeFullLiveDetails>[0];
  let details = { events: [], todos: [], currentTask: null, tokenUsage: null } as unknown as Details;
  const apply = (payload: typeof payloads[number]) => {
    assert.notEqual(payload.omittedEventCount, undefined, 'legacy snapshots are broadcast as full state');
    details = mergeFullLiveDetails(details, { ...payload, todos: [], currentTask: null, tokenUsage: null } as unknown as Details);
    return details.events.map(event => event.content);
  };
  try {
    await manager.startTaskWatcher(taskId);
    assert.deepEqual(apply(payloads[0]), ['Old A', 'Old B']);
    assert.deepEqual(payloads[0].events.map(event => event.id), (await httpRead()).map(event => event.id));

    history.push({ state: 'claude_execution', timestamp: '2026-09-27T01:00:00.000Z' });
    output = snapshot('New X');
    await send(taskId);
    const rerun = payloads.at(-1)!;
    assert.notEqual(rerun.events[0].id, payloads[0].events[0].id, 'the same offset in another execution is another event');
    assert.deepEqual(rerun.events.map(event => event.id), (await httpRead()).map(event => event.id), 'HTTP and watcher reads agree');
    assert.deepEqual(apply(rerun), ['New X'], 'no output of the previous execution survives');

    output = snapshot('New X', 'New Y');
    await send(taskId);
    assert.equal(payloads.at(-1)!.events[0].id, rerun.events[0].id, 'a snapshot of the same execution keeps its IDs');
    assert.deepEqual(apply(payloads.at(-1)!), ['New X', 'New Y']);
  } finally { await manager.closeAll(); }
});

test('re-published Vibe snapshots keep transcript IDs while process diagnostics grow', () => {
  const transcript = [
    JSON.stringify({ role: 'assistant', content: 'Inspect the parser', tool_calls: [{ id: 'call-1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }),
    JSON.stringify({ role: 'tool', tool_call_id: 'call-1', content: 'parser.ts' }),
    JSON.stringify({ role: 'assistant', content: 'Update the parser' }),
  ];
  const project = (snapshot: string) => projectLiveOutputRead({
    epoch: 'generation:1', base: 0, end: Buffer.byteLength(snapshot), start: 0, head: snapshot.split('\n')[0], envelopes: 0, from: 0, text: snapshot,
  }, 'task', null, { selectEvents: false }).events as Event[];
  type Details = Parameters<typeof mergeFullLiveDetails>[0];
  const details = (events: Event[]) => ({ events, todos: [], currentTask: null, tokenUsage: null } as unknown as Details);
  const thoughts = (events: Array<{ type: string; content?: unknown }>) => events.filter(event => event.type === 'thought').map(event => event.content);

  const first = project(buildLiveOutputSnapshot(`${transcript.slice(0, 2).join('\n')}\n`, '', 'Starting vibe').text);
  // More stderr (and stdout) arrives while the transcript is unchanged, then the transcript grows.
  const grown = project(buildLiveOutputSnapshot(`${transcript.slice(0, 2).join('\n')}\n`, 'progress', 'Starting vibe\nwarning: slow network').text);
  const extended = project(buildLiveOutputSnapshot(`${transcript.join('\n')}\n`, 'progress', 'Starting vibe\nwarning: slow network\nretrying').text);
  const inspect = (events: Event[]) => events.find(event => event.content === 'Inspect the parser')?.id;
  assert.ok(inspect(first));
  assert.equal(inspect(grown), inspect(first));
  assert.equal(inspect(extended), inspect(first));

  let merged = mergeFullLiveDetails(details([]), details(first));
  merged = mergeFullLiveDetails(merged, details(grown));
  merged = mergeFullLiveDetails(merged, details(extended));
  assert.deepEqual(thoughts(merged.events), ['Inspect the parser', 'Update the parser'], 'no readable message is duplicated');
});

test('snapshot diagnostics never push the transcript out of the byte budget', () => {
  const transcript = `${JSON.stringify({ role: 'assistant', content: 'Keep me' })}\n`;
  const { text: snapshot, discarded } = buildLiveOutputSnapshot(transcript, 'x'.repeat(40), `${'diagnostic\n'.repeat(20)}`, 128);
  assert.ok(Buffer.byteLength(snapshot) <= 128);
  assert.ok(snapshot.startsWith(transcript), 'the transcript keeps its offsets');
  assert.equal(discarded, '');
  assert.ok(snapshot.endsWith('diagnostic\n'), 'diagnostics keep their most recent records');
});

test('bounded Vibe snapshots keep every message identity once the transcript outgrows the budget', () => {
  const records = [
    JSON.stringify({ role: 'system', content: 'You are Vibe.' }),
    ...Array.from({ length: 14 }, (_, index) => JSON.stringify({ role: 'assistant', content: `Message ${index} ${'.'.repeat(40)}` })),
  ];
  type Details = Parameters<typeof mergeFullLiveDetails>[0];
  const details = (events: Event[]) => ({ events, todos: [], currentTask: null, tokenUsage: null } as unknown as Details);
  const offsetKey = (id: string) => id.split(':').slice(-2).join(':');
  // Each publication replaces the previous snapshot, as the append script stores it.
  let base = 0;
  let previousStart = -1;
  let merged = details([]);
  const identity = new Map<string, string>();
  for (let count = 1; count <= records.length; count += 1) {
    const transcript = `${records.slice(0, count).join('\n')}\n`;
    const { text, discarded } = buildLiveOutputSnapshot(transcript, 'progress', 'Starting vibe', 600);
    const origin = liveOutputOrigin(discarded);
    if (origin && base - origin.offset <= previousStart) base = previousStart + origin.offset + 1;
    const start = base - (origin?.offset ?? 0);
    assert.ok(start > previousStart, 'every snapshot moves the start, so readers resynchronize');
    const read: LiveOutputRead = {
      epoch: 'generation:1', base, end: base + Buffer.byteLength(text), start, head: origin?.head ?? '',
      envelopes: origin?.envelopes ?? 0, from: base, text,
    };
    const events = projectLiveOutputRead(read, 'task', null, { selectEvents: false }).events as Event[];
    // The whole transcript, published unbounded, defines each message's identity.
    const whole = buildLiveOutputSnapshot(transcript, 'progress', 'Starting vibe', 1 << 20).text;
    for (const event of projectLiveOutputRead({ ...read, base: 0, end: Buffer.byteLength(whole), start: 0, head: '', envelopes: 0, from: 0, text: whole }, 'task', null, { selectEvents: false }).events) {
      if (event.type === 'thought') identity.set(String(event.content), offsetKey(event.id));
    }
    for (const event of events.filter(event => event.type === 'thought')) {
      assert.equal(offsetKey(event.id), identity.get(String(event.content)), `${String(event.content).slice(0, 10)} keeps its ID with ${count} records`);
    }
    merged = mergeFullLiveDetails(merged, details(events));
    previousStart = start;
    base += Buffer.byteLength(text);
  }
  assert.ok(liveOutputOrigin(buildLiveOutputSnapshot(`${records.join('\n')}\n`, '', '', 600).discarded), 'the transcript outgrew the budget');
  const thoughts = merged.events.filter(event => event.type === 'thought').map(event => String(event.content).split(' ').slice(0, 2).join(' '));
  assert.deepEqual(thoughts, Array.from({ length: 14 }, (_, index) => `Message ${index}`), 'no message is lost or replaced');
});

test('a whole transcript is numbered by index only when read from the execution start', () => {
  const transcript = JSON.stringify([{ role: 'assistant', content: 'Later message' }], null, 2);
  const read = (base: number): LiveOutputRead => ({
    epoch: 'generation:1', base, end: base + Buffer.byteLength(transcript), start: 0, head: '', envelopes: 0, from: base, text: transcript,
  });
  const whole = projectLiveOutputRead(read(0), 'task', null, { selectEvents: false }).events;
  assert.match(whole[0].id, /:vibe:0:0$/);
  // The same text as the tail of a bounded snapshot must not take the first message's index.
  const tail = projectLiveOutputRead(read(120), 'task', null, { selectEvents: false }).events;
  assert.ok(tail.every(event => !event.id.includes(':vibe:')), 'a bounded tail is projected by record offset');
});

test('reads report their live output position; legacy output has none', () => {
  const text = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })}\npartial`;
  const read = (epoch: string): LiveOutputRead => ({ epoch, base: 10, end: 10 + Buffer.byteLength(text), start: 10, head: '', envelopes: 0, from: 10, text });
  const projected = projectLiveOutputRead(read('generation:1'), 'task');
  assert.deepEqual(projected.projector.position(), { epoch: 'generation:1', offset: 10 + text.indexOf('\n') + 1 }, 'up to the last complete record');
  assert.equal(projectLiveOutputRead(read('legacy'), 'task', null, { legacyExecution: 'run-1' }).projector.position(), null);
});

test('watcher updates and HTTP reads carry positions that order them within an execution', async () => {
  const taskId = 'positions';
  const delta = (content: string) => `${JSON.stringify({ type: 'message', role: 'assistant', delta: true, content })}\n`;
  let data = delta('Checking');
  const redis = {
    get: async () => JSON.stringify({ history: [{ state: 'claude_execution', timestamp: '2026-09-27T00:00:00Z' }] }),
    eval: async (_script: string, options: { arguments: string[] }) => {
      const from = Math.min(Number(options.arguments[0]), Buffer.byteLength(data));
      return ['0', 'generation:1', '0', '', String(from), Buffer.from(data).subarray(from).toString(), String(Buffer.byteLength(data)), '0'];
    },
  } as unknown as RedisClientType;
  const emitted: Array<{ events: Array<{ id: string; content?: string }>; liveOutputPosition?: { epoch: string; offset: number } }> = [];
  const io = { to: () => ({ emit: (_event: string, payload: typeof emitted[number]) => emitted.push(payload) }) } as unknown as SocketIOServer;
  const manager = new TaskWatcherManager(io);
  manager.setDeps({ redisClient: redis, db: {} as Knex });
  const send = (manager as unknown as { sendRedisLiveUpdate: (id: string) => Promise<void> }).sendRedisLiveUpdate.bind(manager);
  try {
    await manager.startTaskWatcher(taskId);
    data += delta(' the');
    await send(taskId);
    const socket = emitted.at(-1)!;
    assert.equal(socket.events.at(-1)?.content, 'Checking the');
    assert.deepEqual(socket.liveOutputPosition, { epoch: 'generation:1', offset: Buffer.byteLength(data) });
    // The provider appends again before the HTTP handler reads: same event, newer content, later position.
    data += delta(' parser');
    const http = (await projectLiveOutput(redis as unknown as LiveOutputRedis, taskId))!;
    assert.equal(http.events.at(-1)?.id, socket.events.at(-1)?.id);
    assert.equal(http.events.at(-1)?.content, 'Checking the parser');
    assert.equal(http.projector.position()!.epoch, socket.liveOutputPosition!.epoch);
    assert.ok(http.projector.position()!.offset > socket.liveOutputPosition!.offset);
  } finally { await manager.closeAll(); }
});

test('bounded Vibe snapshots published through the log keep each message identity', async t => {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
    lazyConnect: true, connectTimeout: 250, maxRetriesPerRequest: 1, retryStrategy: () => null,
  });
  redis.on('error', () => {});
  try { await redis.connect(); } catch {
    redis.disconnect();
    t.skip('Redis is not available for live output integration testing');
    return;
  }
  const id = `bounded-vibe-${process.pid}-${Date.now()}`;
  const reader: LiveOutputRedis = { eval: (script, { keys, arguments: args }) => redis.eval(script, keys.length, ...keys, ...args) };
  const records = [
    JSON.stringify({ role: 'system', content: 'You are Vibe.' }),
    ...Array.from({ length: 12 }, (_, index) => JSON.stringify({ role: 'assistant', content: `Message ${index} ${'.'.repeat(40)}` })),
  ];
  const log = new LiveOutputLog(id, { reset: true, redis });
  const ids = new Map<string, string>();
  try {
    for (let count = 1; count <= records.length; count += 1) {
      const snapshot = buildLiveOutputSnapshot(`${records.slice(0, count).join('\n')}\n`, 'progress', 'Starting vibe', 500);
      log.replace(snapshot.text, { discarded: snapshot.discarded });
      await log.flush();
      const projected = await projectLiveOutput(reader, id, null, { selectEvents: false });
      for (const event of projected!.events.filter(event => event.type === 'thought')) {
        const content = String(event.content);
        assert.equal(event.id, ids.get(content) ?? event.id, `${content.slice(0, 10)} keeps its ID with ${count} records`);
        ids.set(content, event.id);
      }
      if (count === records.length) assert.ok(projected!.truncated, 'the transcript outgrew the snapshot budget');
    }
    assert.equal(ids.size, 12);
    assert.equal(new Set(ids.values()).size, ids.size, 'no two messages share an ID');
  } finally {
    await log.close();
    await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
    redis.disconnect();
  }
});

const streams = {
  // The first retained record once the ceiling cuts the log mid-message is one of these.
  'stream deltas': {
    head: JSON.stringify({ type: 'init', model: 'gemini-2.5-pro' }),
    delta: (content: string) => JSON.stringify({ type: 'message', role: 'assistant', delta: true, content }),
    tool: (id: string) => JSON.stringify({ type: 'tool_use', tool_name: 'Bash', tool_id: id, parameters: { command: `echo ${'x'.repeat(60)}` } }),
  },
  'OpenCode text parts': {
    head: JSON.stringify({ type: 'step_start', sessionID: 'session', part: { type: 'step-start' } }),
    delta: (content: string) => JSON.stringify({ type: 'text', sessionID: 'session', part: { type: 'text', text: content } }),
    tool: (id: string) => JSON.stringify({ type: 'tool_use', sessionID: 'session', part: { type: 'tool', callID: id, tool: 'bash', state: { status: 'running', input: { command: `echo ${'x'.repeat(60)}` } } } }),
  },
};

for (const [name, { head, delta, tool }] of Object.entries(streams)) {
  for (const duplicate of name === 'OpenCode text parts' ? ['none', 'part', 'parts', 'top-level'] : ['none']) {
  test(`a buffered message of ${name} (${duplicate} duplicate) keeps its identity when the log is trimmed before it completes`, async t => {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
      lazyConnect: true, connectTimeout: 250, maxRetriesPerRequest: 1, retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try { await redis.connect(); } catch {
      redis.disconnect();
      t.skip('Redis is not available for live output integration testing');
      return;
    }
    const id = `trimmed-message-${process.pid}-${Date.now()}-${name.length}`;
    const reader: LiveOutputRedis = { eval: (script, { keys, arguments: args }) => redis.eval(script, keys.length, ...keys, ...args) };
    const thoughts = (events: Array<{ type: string }>) => events.filter(event => event.type === 'thought') as unknown as Array<{ id: string; content: string }>;
    const earlier = `${[head, ...Array.from({ length: 12 }, (_, index) => tool(`tool-${index}`))].join('\n')}\n`;
    const parts = Array.from({ length: duplicate === 'none' ? 30 : 60 }, (_, index) => `part ${String(index).padStart(2, '0')} of the message, `);
    const message = parts.join('');
    const repeated = JSON.parse(tool('tool-0'));
    if (duplicate === 'parts') {
      // A parts envelope is a message, not an additional anonymous top-level tool.
      repeated.type = 'message';
      repeated.parts = [repeated.part];
      delete repeated.part;
    }
    if (duplicate === 'top-level') { Object.assign(repeated, repeated.part); delete repeated.part; }
    const began = `${[delta(parts[0]), ...(duplicate === 'none' ? [] : [JSON.stringify(repeated)]), ...parts.slice(1, 3).map(delta)].join('\n')}\n`;
    const went = `${parts.slice(3).map(delta).join('\n')}\n`;
    // The ceiling's cut falls inside the third delta, so the log would begin at the fourth.
    const length = Buffer.byteLength(earlier + began + went);
    const keep = Buffer.byteLength(went) + 10;
    const maximumBytes = Math.ceil(keep * 4 / 3);
    assert.ok(maximumBytes < length && Math.floor(maximumBytes * 3 / 4) === keep);

    // What the running watcher and the page it feeds hold before the trim.
    let projector: LiveOutputProjector | null = null;
    const watched: Array<{ id: string; type: string }> = [];
    const watch = async () => {
      const read = (await readLiveOutput(reader, id, projector?.offset ?? 0))!;
      projector ??= new LiveOutputProjector({ taskId: id, epoch: read.epoch, offset: read.from, start: read.start, retained: { offset: read.base, envelopes: read.envelopes } });
      watched.push(...projector.feed(read.text, read.from));
      return projector.pending() as { id: string; content: string } | null;
    };
    type Details = Parameters<typeof mergeFullLiveDetails>[0];
    const details = (events: unknown[]) => ({ events, todos: [], currentTask: null, tokenUsage: null }) as unknown as Details;
    try {
      await writeLiveOutput(redis, id, earlier + began, { mode: 'reset' });
      const first = (await watch())!;
      assert.equal(first.id.split(':').at(-2), String(Buffer.byteLength(earlier)), 'the message is identified by its first delta');
      await writeLiveOutput(redis, id, went);
      const buffered = (await watch())!;
      assert.deepEqual([buffered.id, buffered.content], [first.id, message]);
      const page = details([...watched, buffered]);

      await writeLiveOutput(redis, id, '', { maximumBytes });
      const fresh = (await projectLiveOutput(reader, id, null, { selectEvents: false }))!;
      assert.ok(fresh.truncated, 'the output before the message was trimmed');
      assert.deepEqual(thoughts(fresh.events).map(event => [event.id, event.content]), [[first.id, message]], 'a fresh read names the message as the running one does');
      const merged = mergeFullLiveDetails(page, details(fresh.events));
      assert.deepEqual(thoughts(merged.events).map(event => [event.id, event.content]), [[first.id, message]], 'the page shows the message once');

      // Its completion carries the same ID in the running projection and in a fresh read.
      await writeLiveOutput(redis, id, `${tool('last')}\n`, { maximumBytes });
      assert.equal(await watch(), null);
      assert.deepEqual(thoughts(watched).map(event => [event.id, event.content]), [[first.id, message]]);
      const completed = (await projectLiveOutput(reader, id, null, { selectEvents: false }))!;
      assert.deepEqual(thoughts(completed.events).map(event => [event.id, event.content]), [[first.id, message]]);
      const final = mergeFullLiveDetails(mergeFullLiveDetails(page, details(fresh.events)), details(completed.events));
      assert.deepEqual(thoughts(final.events).map(event => event.id), [first.id]);
    } finally {
      await redis.del(liveOutputKey(id), liveOutputMetaKey(id));
      redis.disconnect();
    }
  });
  }
}

for (const toolType of ['tool', 'tool_result']) {
  test(`trimmed OpenCode ${toolType} identities seed deduplication without completing buffered text`, () => {
    const head = streams['OpenCode text parts'].head;
    const tool = JSON.stringify({ type: 'tool_use', sessionID: 'session', part: {
      type: toolType, callID: 'a', tool: 'bash', state: { status: 'completed', output: 'ok' }, output: 'ok',
    } });
    const delta = streams['OpenCode text parts'].delta;
    const prefix = `${head}\n${tool}\n`;
    const tail = `${delta('Checking ')}\n${tool}\n${delta('the parser')}\n`;
    const options = { taskId: 'seed', epoch: '1', offset: 0, executionStartTimestamp: '2026-09-28T00:00:00Z' };
    const running = new LiveOutputProjector(options);
    running.feed(prefix + tail, 0);
    const read = projectLiveOutputRead({
      epoch: '1', start: 0, base: Buffer.byteLength(prefix), from: Buffer.byteLength(prefix),
      end: Buffer.byteLength(prefix + tail), head, text: tail, envelopes: 2,
      openCodeTools: { uses: toolType === 'tool' ? { a: true } : {}, results: { a: true } },
    }, 'seed', options.executionStartTimestamp);
    assert.deepEqual(read.events.filter(event => event.type === 'thought'), [running.pending()]);
    assert.equal(read.events.filter(event => event.type === 'thought').length, 1);
    assert.equal(read.events.find(event => event.type === 'thought')?.content, 'Checking the parser');
  });
}
