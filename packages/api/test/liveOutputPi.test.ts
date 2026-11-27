import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { db } from '@propr/core';
import { LiveOutputProjector } from '../services/liveOutputStream.js';

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
