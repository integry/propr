import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { createClient, type RedisClientType } from 'redis';
import { db, liveOutputKey, liveOutputMetaKey, writeLiveOutput } from '@propr/core';
import { LiveOutputProjector, projectLiveOutput, readLiveOutput } from '../services/liveOutputStream.js';

const host = process.env.REDIS_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.REDIS_PORT ?? '6379', 10);
let writer: Redis | null = null;
let reader: RedisClientType | null = null;

before(async () => {
  const ioredis = new Redis({ host, port, lazyConnect: true, connectTimeout: 250, maxRetriesPerRequest: 1, retryStrategy: () => null });
  ioredis.on('error', () => {});
  try {
    await ioredis.connect();
    writer = ioredis;
    reader = createClient({ socket: { host, port, reconnectStrategy: false } }) as RedisClientType;
    reader.on('error', () => {});
    await reader.connect();
  } catch {
    ioredis.disconnect();
    writer = null;
  }
});

after(async () => {
  await reader?.quit().catch(() => undefined);
  writer?.disconnect();
  await db.destroy();
});

let sequence = 0;
async function freshTask(t: { skip: (message: string) => void }): Promise<string | null> {
  if (!writer || !reader) {
    t.skip('Redis is not available for live output integration testing');
    return null;
  }
  const taskId = `live-output-timestamps-${process.pid}-${Date.now()}-${sequence += 1}`;
  await writer.del(liveOutputKey(taskId), liveOutputMetaKey(taskId));
  return taskId;
}

for (const format of ['claude', 'generic'] as const) {
  test(`timestamp-free ${format} events keep their synthetic timestamps in full, incremental and trimmed reads`, async t => {
    const taskId = await freshTask(t);
    if (!taskId) return;
    const executionStart = '2026-09-27T00:00:00.000Z';
    const step = (index: number) => format === 'claude'
      ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `Step ${index}` }] } })
      : JSON.stringify({ type: 'item.completed', item: { id: `item_${index}`, type: 'agent_message', text: `Step ${index}` } });
    const head = format === 'claude'
      ? JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' })
      : JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' });
    // Plain-text records are not JSON records and take no timestamp ordinal.
    const records = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => from + offset)
      .flatMap(index => (index % 10 === 5 ? ['stderr: warning', step(index)] : [step(index)]));
    const events = (projection: Awaited<ReturnType<typeof projectLiveOutput>>) => projection!.events as Array<{ id: string; content?: string; timestamp?: string }>;
    const at = (list: Array<{ content?: string; timestamp?: string }>, index: number) => list.find(event => String(event.content).endsWith(`Step ${index}`));

    let projector: LiveOutputProjector | null = null;
    const incremental: Array<{ id: string }> = [];
    const readIncrement = async () => {
      const read = await readLiveOutput(reader!, taskId, projector?.offset ?? 0);
      assert.ok(read);
      projector ??= new LiveOutputProjector({
        taskId, epoch: read.epoch, offset: read.from, start: read.start, executionStartTimestamp: executionStart,
        retained: { offset: read.base, envelopes: read.envelopes },
      });
      incremental.push(...projector.feed(read.text, read.from));
    };
    await writeLiveOutput(writer!, taskId, `${[head, ...records(0, 20)].join('\n')}\n`, { mode: 'reset' });
    await readIncrement();
    await writeLiveOutput(writer!, taskId, `${records(20, 60).join('\n')}\n`);
    await readIncrement();
    const full = events(await projectLiveOutput(reader!, taskId, executionStart, { selectEvents: false }));
    assert.deepEqual(incremental, full);
    assert.equal(at(full, 40)?.timestamp, '2026-09-27T00:00:41.000Z', 'the head is JSON record 0');

    const size = Buffer.byteLength(`${[head, ...records(0, 60)].join('\n')}\n`);
    await writeLiveOutput(writer!, taskId, '', { maximumBytes: Math.floor(size / 2) });
    const meta = await writer!.hgetall(liveOutputMetaKey(taskId));
    assert.ok(Number(meta.envelopes) > 20, 'the trimmed JSON records are counted');
    const trimmed = events(await projectLiveOutput(reader!, taskId, executionStart, { selectEvents: false }));
    assert.equal(at(trimmed, 20), undefined, 'the middle of the output was trimmed');
    const byId = new Map(full.map(event => [event.id, event]));
    const retained = trimmed.filter(event => byId.has(event.id));
    assert.ok(retained.length > 20);
    for (const event of retained) assert.deepEqual(event, byId.get(event.id), `${event.content} keeps its timestamp after trimming`);

    // Output appended after the trim agrees between the running and a fresh projection.
    await writeLiveOutput(writer!, taskId, `${records(60, 65).join('\n')}\n`, { maximumBytes: Math.floor(size / 2) });
    await readIncrement();
    const later = events(await projectLiveOutput(reader!, taskId, executionStart, { selectEvents: false }));
    assert.deepEqual(later.slice(-5), incremental.slice(-5));
    assert.equal(at(later, 64)?.timestamp, '2026-09-27T00:01:05.000Z');
  });
}
