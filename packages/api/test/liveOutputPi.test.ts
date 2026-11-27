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

test('Pi text and thinking keep their IDs when retention leaves only their end or final-message copy', () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
  const update = (assistantMessageEvent: Record<string, unknown>) => JSON.stringify({ type: 'message_update', usage, assistantMessageEvent });
  const timestamp = 1795790301000;
  const records = [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: '2026-11-27T00:00:00.000Z', cwd: '/w' }),
    JSON.stringify({ type: 'message_start', message: { role: 'assistant', timestamp, stopReason: 'pending', content: [] } }),
    update({ type: 'thinking_start', contentIndex: 0 }),
    update({ type: 'thinking_delta', contentIndex: 0, delta: 'Weighing the ' }),
    update({ type: 'thinking_end', contentIndex: 0, content: 'Weighing the options.' }),
    update({ type: 'text_start', contentIndex: 1 }),
    update({ type: 'text_delta', contentIndex: 1, delta: 'All ' }),
    update({ type: 'text_end', contentIndex: 1, content: 'All checks pass.' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', timestamp, stopReason: 'error', errorMessage: 'overloaded', content: [
      { type: 'thinking', thinking: 'Weighing the options.' }, { type: 'text', text: 'All checks pass.' },
    ] } }),
  ];
  const uninterrupted = new LiveOutputProjector({ taskId: 'pi', epoch: 'generation:1', offset: 0 });
  const watched: Event[] = [];
  for (const record of records) {
    const pendingId = uninterrupted.pending()?.id;
    const emitted = uninterrupted.feed(`${record}\n`, uninterrupted.offset) as Event[];
    if (pendingId && emitted.length) assert.equal(emitted[0].id, pendingId, 'a completed block keeps the ID it streamed under');
    watched.push(...emitted);
  }
  const narration = (events: Event[]) => events.filter(event => event.type === 'thought');
  assert.deepEqual(narration(watched).map(event => [event.content, event.internalReasoning ?? false]), [
    ['Weighing the options.', true], ['All checks pass.', false], ['Pi stopped (error): overloaded', false],
  ]);

  // Retained reads starting at a delta, at thinking_end, at text_end and at message_end.
  for (const retained of [3, 4, 7, 8]) {
    const { full, trimmed } = fullAndTrimmed(records, retained);
    assert.deepEqual(watched, full);
    // The final message still carries every block, so each read has all of them, once and under the same IDs.
    assert.deepEqual(trimmed, full, `the read from record ${retained} names what the watcher emitted`);
  }
});

test('a Pi block streaming when a watcher starts past its message_start is not published until message_end names it', () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
  const update = (assistantMessageEvent: Record<string, unknown>) => JSON.stringify({ type: 'message_update', usage, assistantMessageEvent });
  const timestamp = 1795790301000;
  const records = [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: '2026-11-27T00:00:00.000Z', cwd: '/w' }),
    JSON.stringify({ type: 'message_start', message: { role: 'assistant', timestamp, stopReason: 'pending', content: [] } }),
    update({ type: 'thinking_start', contentIndex: 0 }),
    update({ type: 'thinking_delta', contentIndex: 0, delta: 'Weighing the ' }),
    update({ type: 'thinking_delta', contentIndex: 0, delta: 'options' }),
    update({ type: 'thinking_end', contentIndex: 0, content: 'Weighing the options.' }),
    update({ type: 'text_start', contentIndex: 1 }),
    update({ type: 'text_delta', contentIndex: 1, delta: 'All ' }),
  ];
  const end = JSON.stringify({ type: 'message_end', message: { role: 'assistant', timestamp, stopReason: 'stop', content: [
    { type: 'thinking', thinking: 'Weighing the options.' }, { type: 'text', text: 'All checks pass.' },
  ] } });
  const all = [...records, end];
  const text = `${all.join('\n')}\n`;
  const midMessage = Buffer.byteLength(`${records.join('\n')}\n`);
  const full = new LiveOutputProjector({ taskId: 'pi', epoch: 'generation:1', offset: 0 }).feed(text, 0) as Event[];

  // Retention trimmed the message_start: the watcher's first read starts at a delta.
  for (const retained of [3, 4, 7]) {
    const base = Buffer.byteLength(`${all.slice(0, retained).join('\n')}\n`);
    const read: LiveOutputRead = {
      epoch: 'generation:1', base, end: midMessage, start: 0, head: all[0], from: base, envelopes: retained,
      text: Buffer.from(text).subarray(base, midMessage).toString(),
    };
    const projection = projectLiveOutputRead(read, 'pi', null, { selectEvents: false });
    const watched = projection.events as Event[];
    assert.deepEqual(watched, [], `the read from record ${retained} publishes no unidentified block`);
    assert.equal(projection.projector.pending(), null, `the read from record ${retained} has no pending block to show`);

    const completed = projection.projector.feed(`${end}\n`, projection.projector.offset) as Event[];
    const shown = [...watched, ...completed];
    assert.equal(new Set(shown.map(event => event.id)).size, shown.length, 'no block is shown twice');
    assert.deepEqual(completed.map(event => event.content), ['Weighing the options.', 'All checks pass.']);
    assert.deepEqual(completed, full.filter(event => event.type === 'thought'), 'message_end names each block as a full read does');
  }
});

/*
 * Every live event ID comes from data its record carries, so it cannot depend
 * on where a read starts. These checks run the whole class of retention cases
 * the one-off regressions above cover, for every start line of a real Pi
 * capture and of a stream with several streamed text and thinking deltas
 * (hand-built from Pi 1.6.1 record shapes).
 */
function fixtureRecords(name: string): string[] {
  return readFileSync(new URL(`../../../test/fixtures/pi/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
}

/** Streams Pi should not produce, but whose IDs must not depend on the read start either. */
function irregularRecords(): string[] {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
  const update = (assistantMessageEvent: Record<string, unknown>) => JSON.stringify({ type: 'message_update', usage, assistantMessageEvent });
  const start = (message: Record<string, unknown>) => JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending', ...message } });
  const end = (message: Record<string, unknown>) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage, ...message } });
  return [
    JSON.stringify({ type: 'session', version: 3, id: 'session-irregular', timestamp: '2026-11-27T00:00:00.000Z', cwd: '/w' }),
    // A block starts before the previous one ended; message_end carries both.
    start({ timestamp: 1795790401000 }),
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'First ' }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'half' }),
    update({ type: 'thinking_start', contentIndex: 1 }),
    update({ type: 'thinking_delta', contentIndex: 1, delta: 'Then ' }),
    update({ type: 'thinking_delta', contentIndex: 1, delta: 'think' }),
    update({ type: 'thinking_end', contentIndex: 1, content: 'Then think.' }),
    end({ timestamp: 1795790401000, stopReason: 'stop', content: [{ type: 'text', text: 'First half, complete.' }, { type: 'thinking', thinking: 'Then think.' }] }),
    // A message that never ends, then one with no timestamp, named by its responseId.
    start({ timestamp: 1795790402000 }),
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Abandoned ' }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'draft' }),
    start({}),
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Unstamped ' }),
    update({ type: 'text_end', contentIndex: 0, content: 'Unstamped reply.' }),
    end({ responseId: 'resp-9', stopReason: 'error', errorMessage: 'overloaded', content: [{ type: 'text', text: 'Unstamped reply.' }] }),
  ];
}

const RETENTION_STREAMS: Array<[string, () => string[], { wellFormed: boolean }]> = [
  ['pi-1.6.1-json-tool-task.jsonl', () => fixtureRecords('pi-1.6.1-json-tool-task.jsonl'), { wellFormed: true }],
  ['pi-1.6.1-json-streamed-blocks.jsonl', () => fixtureRecords('pi-1.6.1-json-streamed-blocks.jsonl'), { wellFormed: true }],
  ['an irregular stream', irregularRecords, { wellFormed: false }],
];

/** The `toolCallId` a call's or a result's live ID is derived from. */
function toolCallIdOf(event: Event): string | null {
  const match = /:(?:tool_use:external|pi:tool_result):([^:]+)(?::0)?$/.exec(event.id);
  return match ? decodeURIComponent(match[1]) : null;
}

function assertNoDuplicateIds(events: Event[], label: string): void {
  const seen = new Set<string>();
  for (const event of events) {
    assert.ok(!seen.has(event.id), `${label}: ${event.id} appears twice`);
    seen.add(event.id);
  }
}

/**
 * Checks 1–3 of a read against the uninterrupted one. In a stream that is not
 * `wellFormed` (as Pi writes: every message stamped and ended), an unstamped
 * message takes the time of the latest stamped record, which depends on the
 * read start.
 */
function assertNamesAsUninterrupted(events: Event[], full: Map<string, Event>, label: string, wellFormed: boolean): void {
  assertNoDuplicateIds(events, label);
  for (const event of events) {
    const before = full.get(event.id);
    assert.ok(before, `${label}: ${event.id} is an ID of the uninterrupted parse`);
    assert.equal(event.type, before.type, `${label}: ${event.id} names the same kind of event`);
    if (event.type === 'thought') {
      const time = (thought: Event) => wellFormed ? thought : { ...thought, timestamp: null };
      assert.deepEqual(time(event), time(before), `${label}: a completed block has the uninterrupted ID, text and time`);
    } else if (event.type === 'tool_use') {
      assert.ok(toolCallIdOf(event), `${label}: a call's ID is its toolCallId`);
    } else if (event.type === 'tool_result') {
      assert.equal(toolCallIdOf(event), event.toolUseId, `${label}: a result's ID is its call's toolCallId`);
      assert.deepEqual([event.result, event.isError], [before.result, before.isError], `${label}: ${event.id} is the same result`);
    }
  }
  const calls = new Map(events.filter(event => event.type === 'tool_use').map(event => [toolCallIdOf(event), event]));
  for (const result of events.filter(event => event.type === 'tool_result')) {
    const call = calls.get(result.toolUseId as string);
    assert.ok(call, `${label}: result ${result.id} has its call in the same read`);
    assert.equal(toolCallIdOf(call), toolCallIdOf(result), `${label}: a call and its result share one toolCallId identity`);
  }
}

for (const [fixture, load, { wellFormed }] of RETENTION_STREAMS) {
  test(`Pi live IDs of ${fixture} do not depend on which line a retained read starts on`, () => {
    const records = load();
    const { full } = fullAndTrimmed(records, 0);
    assertNoDuplicateIds(full, 'uninterrupted');
    if (load !== irregularRecords) assert.ok(full.some(event => event.type === 'tool_result'), 'the fixture has tool results');
    assert.ok(full.some(event => event.type === 'thought'), 'the fixture has assistant blocks');
    const byId = new Map(full.map(event => [event.id, event]));

    // A watcher fed one record at a time names everything as the full read does.
    const watcher = new LiveOutputProjector({ taskId: 'pi', epoch: 'generation:1', offset: 0 });
    assert.deepEqual(records.flatMap(record => watcher.feed(`${record}\n`, watcher.offset)), full);

    for (let i = 1; i < records.length; i++) {
      const { trimmed } = fullAndTrimmed(records, i);
      assertNamesAsUninterrupted(trimmed, byId, `read from line ${i}`, wellFormed);
    }
  });

  test(`an incremental Pi read of ${fixture} merged with a later retained read has no duplicates`, () => {
    const records = load();
    const { full } = fullAndTrimmed(records, 0);
    const byId = new Map(full.map(event => [event.id, event]));
    for (let k = 1; k <= records.length; k++) {
      // The watcher read lines 0..k-1, then lost its place; the next read starts at j ≤ k after retention.
      const watcher = new LiveOutputProjector({ taskId: 'pi', epoch: 'generation:1', offset: 0 });
      const published = records.slice(0, k).flatMap(record => watcher.feed(`${record}\n`, watcher.offset)) as Event[];
      const pending = watcher.pending() as Event | null;
      if (pending) {
        // A block of a message that never ends is never completed.
        const final = byId.get(pending.id);
        if (wellFormed) assert.ok(final, `lines 0..${k - 1}: the streaming block's ID is the one it completes under`);
        if (final) assert.equal(final.type, 'thought');
      }
      for (let j = 1; j <= k && j < records.length; j++) {
        const { trimmed } = fullAndTrimmed(records, j);
        const label = `lines 0..${k - 1} then ${j}..end`;
        const merged = new Map<string, Event>();
        for (const event of [...published, ...trimmed]) merged.set(event.id, event);
        assertNamesAsUninterrupted([...merged.values()], byId, label, wellFormed);
        // Each call, result and block appears once, however the two reads overlap.
        const identities = [...merged.values()].map(event => event.type === 'thought' ? `thought:${event.content}` : `${event.type}:${toolCallIdOf(event)}`);
        assert.equal(new Set(identities).size, identities.length, `${label}: no event appears under two IDs`);
        for (const event of published) {
          const later = trimmed.find(other => other.id === event.id);
          if (later?.type === 'thought') assert.deepEqual(later.content, event.content, `${label}: a block both reads have is identical`);
        }
      }
    }
  });
}
