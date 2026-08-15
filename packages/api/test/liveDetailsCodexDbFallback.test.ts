import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import type { ExecutionDetailRow } from '../routes/liveDetailsExecutionParser.js';

process.env.NODE_ENV = 'test';
process.env.PROPR_DEMO_MODE = 'true';

const { parseCodexOutputToConversationResult } = await import('../routes/liveDetailsCodexParser.js');
const { parseExecutionDetailsRows } = await import('../routes/liveDetailsExecutionParser.js');
const { createLiveDetailsRoutes } = await import('../routes/liveDetailsRoutes.js');

after(async () => {
  const { db } = await import('@propr/core');
  await db.destroy();
});

interface CodexFixtureEvent {
  type: string;
  timestamp: string;
  role?: string;
  content?: string;
  message?: string;
  result?: string;
  status?: string;
  is_error?: boolean;
  usage?: Record<string, number>;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    items?: Array<{ text: string; completed?: boolean; status?: string }>;
  };
}

function rowFromCodexEvent(event: CodexFixtureEvent): ExecutionDetailRow {
  const item = event.item;
  const isCommand = item?.type === 'command_execution';
  const content = isCommand
    ? item.aggregated_output ?? JSON.stringify(event)
    : (item?.type === 'reasoning' || item?.type === 'agent_message')
      ? item.text ?? null
      : event.type === 'message' && event.role === 'assistant'
        ? event.content ?? null
        : event.type === 'error'
          ? event.message ?? null
          : JSON.stringify(event);
  return {
    event_type: event.type,
    event_timestamp: event.timestamp,
    content,
    is_error: event.type === 'error' || (item?.exit_code != null && item.exit_code !== 0),
    tool_name: isCommand ? 'command_execution' : null,
    tool_input: isCommand && item.command ? JSON.stringify({ command: item.command }) : null,
    metadata: JSON.stringify(event)
  };
}

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 7, 15, 10, 0, index)).toISOString();
}

test('Codex database lifecycle fallback has exact canonical event parity', () => {
  const fixture: CodexFixtureEvent[] = [
    { type: 'thread.started', thread_id: 'thread-parity', timestamp: timestamp(0) },
    { type: 'turn.started', timestamp: timestamp(1) }
  ];
  for (let index = 0; index < 22; index += 1) {
    const command = `printf command-${index}`;
    fixture.push({
      type: 'item.started',
      timestamp: timestamp(index + 2),
      item: { id: `command-${index}`, type: 'command_execution', command }
    });
    fixture.push({
      type: 'item.completed',
      timestamp: timestamp(index + 2),
      item: { id: `command-${index}`, type: 'command_execution', command, aggregated_output: `output-${index}`, exit_code: 0 }
    });
  }
  for (let index = 0; index < 4; index += 1) {
    fixture.push({
      type: 'item.completed',
      timestamp: timestamp(index + 24),
      item: { id: `reasoning-${index}`, type: 'reasoning', text: `Reasoning ${index}` }
    });
  }
  fixture.push({
    type: 'item.completed',
    timestamp: timestamp(28),
    item: { id: 'agent-message', type: 'agent_message', text: 'Done' }
  });
  fixture.push({
    type: 'turn.completed',
    timestamp: timestamp(29),
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10 }
  });

  const canonical = parseCodexOutputToConversationResult(fixture.map(event => JSON.stringify(event)).join('\n'));
  const fallback = parseExecutionDetailsRows(fixture.map(rowFromCodexEvent));

  assert.ok(canonical);
  assert.deepEqual(fallback.events, canonical.events);
  assert.equal(fallback.events.length, 49);
  assert.deepEqual(
    Object.fromEntries(['thought', 'tool_use', 'tool_result'].map(type => [type, fallback.events.filter(event => event.type === type).length])),
    { thought: 5, tool_use: 22, tool_result: 22 }
  );
  assert.equal(fallback.events.some(event => JSON.stringify(event).includes('thread.started')), false);
  assert.equal(fallback.events.some(event => JSON.stringify(event).includes('item.completed')), false);
});

test('Codex command lifecycle pairs starts and completions and recovers an unmatched completion', () => {
  const rows = [
    rowFromCodexEvent({
      type: 'item.started', timestamp: timestamp(0),
      item: { id: 'paired', type: 'command_execution', command: 'npm test' }
    }),
    rowFromCodexEvent({
      type: 'item.completed', timestamp: timestamp(1),
      item: { id: 'paired', type: 'command_execution', command: 'npm test', aggregated_output: 'passed', exit_code: 0 }
    }),
    rowFromCodexEvent({
      type: 'item.completed', timestamp: timestamp(2),
      item: { id: 'unmatched', type: 'command_execution', command: 'npm run lint', aggregated_output: '', exit_code: 1 }
    })
  ];

  assert.deepEqual(parseExecutionDetailsRows(rows).events, [
    { type: 'tool_use', toolName: 'command_execution', input: { command: 'npm test' }, timestamp: timestamp(0) },
    { type: 'tool_result', result: 'passed', isError: false, timestamp: timestamp(1) },
    { type: 'tool_use', toolName: 'command_execution', input: { command: 'npm run lint' }, timestamp: timestamp(2) },
    { type: 'tool_result', result: '', isError: true, timestamp: timestamp(2) }
  ]);
});

test('Codex database fallback ignores envelopes while retaining text, errors, and todos', () => {
  const events: CodexFixtureEvent[] = [
    { type: 'thread.started', thread_id: 'thread-focused', timestamp: timestamp(0) },
    { type: 'turn.started', timestamp: timestamp(1) },
    { type: 'item.started', timestamp: timestamp(2), item: { id: 'reasoning', type: 'reasoning', text: 'partial' } },
    { type: 'item.completed', timestamp: timestamp(3), item: { id: 'reasoning', type: 'reasoning', text: 'Inspecting files' } },
    { type: 'message', role: 'assistant', content: 'Implementing fix', timestamp: timestamp(4) },
    {
      type: 'item.updated', timestamp: timestamp(5),
      item: { type: 'todo_list', items: [{ text: 'Inspect', completed: true }, { text: 'Test', status: 'in_progress' }] }
    },
    { type: 'error', message: 'command failed', timestamp: timestamp(6) },
    { type: 'turn.completed', timestamp: timestamp(7), usage: { input_tokens: 10, output_tokens: 2 } }
  ];

  const parsed = parseExecutionDetailsRows(events.map(rowFromCodexEvent));

  assert.deepEqual(parsed.events, [
    { type: 'thought', content: 'Inspecting files', timestamp: timestamp(3) },
    { type: 'thought', content: 'Implementing fix', timestamp: timestamp(4) },
    { type: 'tool_result', result: 'command failed', isError: true, timestamp: timestamp(6) }
  ]);
  assert.deepEqual(parsed.todos, [
    { status: 'completed', content: 'Inspect' },
    { status: 'in_progress', content: 'Test' }
  ]);
  assert.equal(parsed.currentTask, 'Test');
});

async function createFallbackDatabase(): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  });
  await database.schema.createTable('llm_executions', table => {
    table.text('execution_id').notNullable();
    table.text('task_id').notNullable();
    table.text('session_id').notNullable();
    table.text('start_time').notNullable();
    table.integer('input_tokens');
    table.integer('output_tokens');
    table.integer('cache_creation_input_tokens');
    table.integer('cache_read_input_tokens');
  });
  await database.schema.createTable('llm_execution_details', table => {
    table.text('execution_id').notNullable();
    table.integer('sequence_number').notNullable();
    table.text('event_type').notNullable();
    table.text('event_timestamp').notNullable();
    table.text('content');
    table.boolean('is_error');
    table.text('tool_name');
    table.text('tool_input');
    table.text('metadata');
  });
  return database;
}

function createJsonResponse(): { response: ExpressResponse; body: () => Record<string, unknown> } {
  let payload: Record<string, unknown> = {};
  const response = {
    status() { return response; },
    json(value: Record<string, unknown>) { payload = value; return response; }
  } as unknown as ExpressResponse;
  return { response, body: () => payload };
}

test('live-details database fallback preserves token usage and stable event IDs', async () => {
  const database = await createFallbackDatabase();
  const taskId = 'integry-propr-1915-codex';
  const sessionId = 'codex-db-session';
  try {
    await database('llm_executions').insert({
      execution_id: 'execution-1915', task_id: taskId, session_id: sessionId,
      start_time: timestamp(0), input_tokens: 90, output_tokens: 20,
      cache_creation_input_tokens: 3, cache_read_input_tokens: 10
    });
    const fixture = [
      rowFromCodexEvent({ type: 'item.started', timestamp: timestamp(1), item: { id: 'route-command', type: 'command_execution', command: 'npm test' } }),
      rowFromCodexEvent({ type: 'item.completed', timestamp: timestamp(2), item: { id: 'route-command', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } })
    ];
    await database('llm_execution_details').insert(fixture.map((row, sequenceNumber) => ({
      execution_id: 'execution-1915', sequence_number: sequenceNumber, ...row
    })));
    const redisClient = { get: async () => null } as unknown as RedisClientType;
    const { getLiveDetails } = createLiveDetailsRoutes({ redisClient, db: database });
    const request = { params: { taskId } } as unknown as FlatRequest;

    const firstResponse = createJsonResponse();
    await getLiveDetails(request, firstResponse.response);
    const secondResponse = createJsonResponse();
    await getLiveDetails(request, secondResponse.response);

    const first = firstResponse.body() as { events: Array<Record<string, unknown>>; tokenUsage: Record<string, number> };
    const second = secondResponse.body() as { events: Array<Record<string, unknown>> };
    assert.equal(first.events.length, 2);
    assert.deepEqual(first.events.map(event => event.id), second.events.map(event => event.id));
    assert.deepEqual(first.events.map(event => event.id), [
      `live:${taskId}:database:${sessionId}:tool_use:sequence:0`,
      `live:${taskId}:database:${sessionId}:tool_result:sequence:1`
    ]);
    assert.deepEqual(first.tokenUsage, {
      input_tokens: 90,
      output_tokens: 20,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 10
    });
  } finally {
    await database.destroy();
  }
});
