import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { db } from '@propr/core';
import { LiveOutputProjector, projectLiveOutputRead, type LiveOutputRead } from '../services/liveOutputStream.js';

after(async () => {
  await db.destroy();
});

test('Pi JSON records are projected live, one record at a time, with the IDs of a full read', () => {
  const fixture = readFileSync(new URL('../../../test/fixtures/pi/pi-1.6.1-json-tool-task.jsonl', import.meta.url), 'utf8');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
  const streamed = [
    JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending', timestamp: 1795790317000 } }),
    JSON.stringify({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } }),
    JSON.stringify({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Checking ' } }),
    JSON.stringify({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'once more' } }),
  ];
  const ended = JSON.stringify({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Checking once more.' } });
  const lines = ['Starting pi', ...fixture.split('\n').filter(Boolean), ...streamed, ended];
  const options = { taskId: 'pi', epoch: '1', offset: 0 };

  const full = new LiveOutputProjector(options).feed(lines.join('\n') + '\n', 0);
  assert.deepEqual(full.filter(event => event.type === 'tool_result').map(event => [event.toolUseId, event.isError]), [
    ['4vK53wBZb', true], ['6UNoPXH4u', false], ['HEFIeQfFW', false],
  ]);
  assert.equal(full.at(-1)?.content, 'Checking once more.');

  const incremental = new LiveOutputProjector(options);
  const events = lines.slice(0, -1).flatMap(line => incremental.feed(line + '\n', incremental.offset));
  assert.equal(incremental.pending()?.content, 'Checking once more', 'deltas show while the block streams');
  const pendingId = incremental.pending()?.id;
  events.push(...incremental.feed(ended + '\n', incremental.offset));
  assert.deepEqual(events, full);
  assert.equal(events.at(-1)?.id, pendingId, 'the completed block keeps the ID it streamed under');
  assert.equal(incremental.snapshot().tokenUsage?.output_tokens, 229);
});

type Event = Record<string, unknown> & { id: string };

/** The same Pi log read whole, and fresh after every record before `retained` was trimmed. */
function fullAndTrimmed(records: string[], retained: number) {
  const text = `${records.join('\n')}\n`;
  const base = Buffer.byteLength(`${records.slice(0, retained).join('\n')}\n`);
  const read = (from: number): LiveOutputRead => ({
    epoch: 'generation:1', base: from, end: Buffer.byteLength(text), start: 0, head: records[0], from,
    envelopes: from === 0 ? 0 : retained,
    text: Buffer.from(text).subarray(from).toString(),
  });
  const project = (from: number) => projectLiveOutputRead(read(from), 'pi', null, { selectEvents: false }).events as Event[];
  return { full: project(0), trimmed: project(base) };
}

test('a Pi tool result keeps its ID when retention leaves only a later copy of it', () => {
  const result = { content: [{ type: 'text', text: 'tests pass' }], isError: false };
  const records = [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: '2026-11-27T00:00:00.000Z', cwd: '/w' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', timestamp: 1795790301000, stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } },
    ] } }),
    JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'npm test' } }),
    JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result, isError: false }),
    JSON.stringify({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', timestamp: 1795790302000, ...result } }),
    JSON.stringify({ type: 'turn_end', toolResults: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', ...result }] }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', timestamp: 1795790303000, stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] } }),
  ];
  const uninterrupted = new LiveOutputProjector({ taskId: 'pi', epoch: 'generation:1', offset: 0 });
  const watched = records.flatMap(record => uninterrupted.feed(`${record}\n`, uninterrupted.offset)) as Event[];
  const { full, trimmed } = fullAndTrimmed(records, 4);
  assert.deepEqual(watched, full);

  for (const events of [full, trimmed]) {
    assert.equal(events.filter(event => event.type === 'tool_result').length, 1, 'one result per call');
  }
  const resultId = (events: Event[]) => events.find(event => event.type === 'tool_result')?.id;
  assert.ok(resultId(full));
  assert.equal(resultId(trimmed), resultId(full), 'the retained copy names the result the watcher emitted');
  const byId = new Map(full.map(event => [event.id, event]));
  for (const event of trimmed) {
    const before = byId.get(event.id);
    assert.ok(before, `${event.id} is an event the uninterrupted projection emitted`);
    // The retained copy carries its own timestamp, and the call it announces lacks the arguments.
    if (event.type === 'tool_result') assert.deepEqual({ ...event, timestamp: null }, { ...before, timestamp: null });
    else if (event.type !== 'tool_use') assert.deepEqual(event, before);
  }
});
