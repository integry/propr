import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import knex from 'knex';
import type { RedisClientType } from 'redis';
import { closeConnection, parseVibeConversationLog } from '@propr/core';
import type { McpPolicy, McpPrincipal } from '../mcp/policy.js';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';
import { getAgentActivity } from '../mcp/agentActivity.js';
import { parseAgentStreamOutput } from '../services/agentStreamProjection.js';
import { projectTaskLiveDetails } from '../routes/liveDetailsRoutes.js';

const directGoalId = '11111111-1111-4111-8111-111111111111';
const orchestratedGoalId = '22222222-2222-4222-8222-222222222222';
const repository = 'acme/repo';

after(async () => closeConnection());

async function createActivityDatabase() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository').notNullable();
    table.string('task_type').notNullable();
    table.timestamp('created_at');
  });
  await db.schema.createTable('goals', table => {
    table.string('goal_id').primary();
    table.string('owner_id').notNullable();
    table.string('repository').notNullable();
    table.string('current_task_id').notNullable();
    table.string('launch_strategy').notNullable();
    table.string('session_id');
    table.timestamp('started_at');
    table.timestamp('updated_at');
    table.timestamp('created_at');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id').notNullable();
    table.string('state').notNullable();
    table.timestamp('timestamp');
    table.text('metadata');
  });
  await db.schema.createTable('llm_executions', table => {
    table.string('execution_id').primary();
    table.string('task_id');
    table.string('session_id');
    table.timestamp('start_time');
    table.integer('input_tokens');
    table.integer('output_tokens');
    table.integer('cache_creation_input_tokens');
    table.integer('cache_read_input_tokens');
  });
  await db.schema.createTable('llm_execution_details', table => {
    table.increments('detail_id').primary();
    table.string('execution_id');
    table.integer('sequence_number');
    table.string('event_type');
    table.timestamp('event_timestamp');
    table.text('content');
    table.boolean('is_error');
    table.string('tool_name');
    table.text('tool_input');
    table.text('metadata');
  });
  const createdAt = '2026-09-13T10:00:00.000Z';
  await db('tasks').insert([
    { task_id: 'goal-task-direct', repository, task_type: 'goal', created_at: createdAt },
    { task_id: 'goal-task-orchestrated', repository, task_type: 'goal', created_at: createdAt },
  ]);
  await db('goals').insert([
    { goal_id: directGoalId, owner_id: 'owner-1', repository, current_task_id: 'goal-task-direct', launch_strategy: 'direct', started_at: createdAt, updated_at: createdAt, created_at: createdAt },
    { goal_id: orchestratedGoalId, owner_id: 'owner-1', repository, current_task_id: 'goal-task-orchestrated', launch_strategy: 'orchestrate', started_at: createdAt, updated_at: createdAt, created_at: createdAt },
  ]);
  await db('task_history').insert([
    { task_id: 'goal-task-direct', state: 'codex_execution', timestamp: createdAt },
    { task_id: 'goal-task-orchestrated', state: 'claude_execution', timestamp: createdAt },
  ]);
  return db;
}

test('activity database fallback excludes unclassified legacy Vibe text', async () => {
  const db = await createActivityDatabase();
  const redisClient = { get: async () => null } as unknown as RedisClientType;
  const timestamp = '2026-09-13T10:00:01.000Z';
  const sessionId = 'vibe-persisted-session';
  // Pre-change parseVibeConversationLog output, serialized by the execution
  // writer as JSON.stringify(step.message), with no original transcript metadata.
  const legacyMessages = [
    { id: 'provider-assigned-id', content: [
      { type: 'text', text: 'Private reasoning from a legacy Vibe execution.' },
      { type: 'text', text: 'Ambiguous legacy narration.' },
      { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: {
        todos: [{ content: 'Verify persisted activity', status: 'in_progress' }],
      } },
    ], usage: { input_tokens: 10, output_tokens: 20 } },
    { id: 'vibe-assistant-1', content: [{ type: 'text', text: 'Private reasoning without narration.' }] },
  ];
  const currentMessage = parseVibeConversationLog(JSON.stringify({
    role: 'assistant', reasoning_content: 'Private reasoning from a new execution.',
    content: 'Classified Vibe narration.',
  }))[0].message;
  const claudeMessage = {
    id: 'msg-claude', type: 'message', role: 'assistant', model: 'claude',
    content: [{ type: 'text', text: 'Persisted Claude narration.' }],
  };
  try {
    await db('goals').where({ goal_id: directGoalId }).update({ session_id: sessionId });
    await db('llm_executions').insert({
      execution_id: 'vibe-execution', task_id: 'goal-task-direct', session_id: sessionId, start_time: timestamp,
    });
    await db('llm_execution_details').insert([...legacyMessages, currentMessage, claudeMessage].map((message, index) => ({
      execution_id: 'vibe-execution', sequence_number: index, event_type: 'assistant',
      event_timestamp: timestamp, content: JSON.stringify(message), metadata: null,
    })));
    const persisted = await projectTaskLiveDetails(redisClient, db, 'goal-task-direct', { sessionId });
    assert.ok(persisted?.events.some(event => event.content === legacyMessages[0].content[0].text),
      'exercise the actual execution-detail fallback, retaining legacy text for existing consumers');
    for (const target of [{ goalId: directGoalId }, { taskId: 'goal-task-direct' }]) {
      for (const includeReasoningSummaries of [false, true]) {
        const result = await getAgentActivity({ db, redisClient }, {
          repository, ...target, includeReasoningSummaries, offset: 0, limit: 20,
        }, 'owner-1');
        assert.deepEqual(result.activity, [
          { timestamp, message: 'Persisted Claude narration.' },
          { timestamp, message: 'Classified Vibe narration.' },
        ]);
        assert.equal(result.currentFocus, 'Verify persisted activity');
        assert.equal(result.nextOffset, null);
        assert.doesNotMatch(JSON.stringify(result), /Private reasoning|Ambiguous legacy narration/);
      }
    }
  } finally {
    await db.destroy();
  }
});

test('get_agent_activity returns compact newest-first narration for direct and orchestrated goals', async () => {
  const db = await createActivityDatabase();
  const emittedAtMs = Date.parse('2026-09-13T10:00:00.000Z');
  const directOutput = [
    { method: 'turn/plan/updated', params: { plan: [{ step: 'Implement the MCP activity projection', status: 'inProgress' }] }, emittedAtMs },
    { method: 'item/completed', params: { item: { type: 'reasoning', summary: ['Hidden provider reasoning'] } }, emittedAtMs },
    { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'cat .env', aggregatedOutput: 'secret tool output', exitCode: 0 } }, emittedAtMs: emittedAtMs + 1_000 },
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Inspecting packages/api/mcp/tools.ts before wiring the activity projection.' } }, emittedAtMs: emittedAtMs + 2_000 },
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: `Verified direct goal activity.\n\n${'Bounded detail. '.repeat(50)}` } }, emittedAtMs: emittedAtMs + 3_000 },
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: JSON.stringify({ checkpointReady: true, message: 'feat(mcp): expose agent activity', summary: 'Direct activity is ready.' }) } }, emittedAtMs: emittedAtMs + 4_000 },
  ].map(event => JSON.stringify(event)).join('\n');
  const orchestratedOutput = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-13T10:01:00.000Z',
    message: { content: [
      { type: 'thinking', thinking: 'Hidden Claude reasoning' },
      { type: 'text', text: 'Reviewing the orchestrated task state and its persisted events.' },
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Verify orchestrated activity', status: 'in_progress' }] } },
      { type: 'tool_use', name: 'Bash', input: { command: 'printenv' } },
    ] },
  });
  const redisClient = {
    get: async (key: string) => {
      if (key === 'agent:output:goal-task-direct') return directOutput;
      if (key === 'agent:output:goal-task-orchestrated') return orchestratedOutput;
      if (key.startsWith('worker:state:')) return JSON.stringify({ history: [{ state: 'codex_execution', timestamp: '2026-09-13T10:00:00.000Z' }] });
      return null;
    },
  } as unknown as RedisClientType;
  const deps = {
    db,
    redisClient,
    policy: {} as McpPolicy,
    taskQueue: {} as never,
    runtimeBuildQueue: {} as never,
  } satisfies ToolDeps;
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'get_agent_activity');
  assert.ok(tool);
  const principal = { user: { id: 'owner-1' } } as McpPrincipal;

  try {
    const defaults = tool.schema.parse({ repository, goalId: directGoalId });
    assert.equal(defaults.includeReasoningSummaries, false);
    const direct = (await tool.run({ principal, args: defaults })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(direct.target, {
      type: 'goal', goalId: directGoalId, taskId: 'goal-task-direct', launchStrategy: 'direct',
    });
    assert.equal(direct.order, 'newest_first');
    assert.equal(direct.nextOffset, null);
    assert.equal(direct.currentFocus, 'Implement the MCP activity projection');
    assert.deepEqual(direct.activity[0], {
      timestamp: '2026-09-13T10:00:04.000Z',
      message: 'Checkpoint ready: feat(mcp): expose agent activity. Direct activity is ready.',
    });
    assert.equal(direct.activity[1].timestamp, '2026-09-13T10:00:03.000Z');
    assert.match(direct.activity[1].message, /^Verified direct goal activity\./);
    assert.equal(direct.activity[1].message.length, 500);
    assert.match(direct.activity[1].message, /…$/);
    assert.deepEqual(direct.activity[2], {
      timestamp: '2026-09-13T10:00:02.000Z',
      message: 'Inspecting packages/api/mcp/tools.ts before wiring the activity projection.',
    });
    assert.doesNotMatch(JSON.stringify(direct), /Hidden provider reasoning|secret tool output|cat \.env/);

    const firstPageArgs = tool.schema.parse({ repository, goalId: directGoalId, limit: 1 });
    const firstPage = (await tool.run({ principal, args: firstPageArgs })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(firstPage.activity.length, 1);
    assert.equal(firstPage.nextOffset, 1);
    const secondPageArgs = tool.schema.parse({ repository, goalId: directGoalId, limit: 1, offset: 1 });
    const secondPage = (await tool.run({ principal, args: secondPageArgs })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(secondPage.activity[0].timestamp, '2026-09-13T10:00:03.000Z');

    const orchestratedArgs = tool.schema.parse({ repository, goalId: orchestratedGoalId, includeReasoningSummaries: true });
    const orchestrated = (await tool.run({ principal, args: orchestratedArgs })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(orchestrated.target.launchStrategy, 'orchestrate');
    assert.equal(orchestrated.currentFocus, 'Verify orchestrated activity');
    assert.deepEqual(orchestrated.activity, [{
      timestamp: '2026-09-13T10:01:00.000Z',
      message: 'Reviewing the orchestrated task state and its persisted events.',
    }]);
    assert.doesNotMatch(JSON.stringify(orchestrated), /Hidden Claude reasoning|printenv/);

    const taskArgs = tool.schema.parse({ repository, taskId: 'goal-task-orchestrated' });
    const task = (await tool.run({ principal, args: taskArgs })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(task.target.type, 'task');
    assert.equal(task.target.goalId, orchestratedGoalId);
    await assert.rejects(
      () => tool.run({ principal: { user: { id: 'owner-2' } } as McpPrincipal, args: taskArgs }),
      /Target not found/,
    );
    assert.throws(
      () => tool.schema.parse({ repository, goalId: directGoalId, taskId: 'goal-task-direct' }),
      /Provide exactly one/,
    );
  } finally {
    await db.destroy();
  }
});

test('get_agent_activity opts in to only Codex summaries for live and persisted activity', async () => {
  const db = await createActivityDatabase();
  const summary = `Inspecting the parser.\n\n${'Checking narration. '.repeat(40)}`;
  const output = [
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Starting the task.' } }, emittedAtMs: Date.parse('2026-09-13T10:00:00.000Z') },
    { method: 'item/completed', params: { item: { type: 'reasoning', summary: [summary], content: ['Hidden raw content'], text: 'Hidden raw text' } }, emittedAtMs: Date.parse('2026-09-13T10:00:01.000Z') },
    { method: 'item/completed', params: { item: { type: 'reasoning', summary: [], content: ['Hidden content without summary'], text: 'Hidden text without summary' } } },
    { type: 'item.completed', item: { type: 'reasoning', text: 'Hidden legacy reasoning' } },
    { method: 'item/reasoning/textDelta', params: { delta: 'Hidden reasoning delta' } },
    { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'Hidden command', aggregatedOutput: 'Hidden output' } } },
  ].map(event => JSON.stringify(event));
  let live = true;
  const redisClient = {
    get: async (key: string) => live && key === 'agent:output:goal-task-direct' ? output.join('\n') : null,
  } as unknown as RedisClientType;
  const tool = createToolCatalog({
    db, redisClient, policy: {} as McpPolicy, taskQueue: {} as never, runtimeBuildQueue: {} as never,
  }).find(candidate => candidate.name === 'get_agent_activity');
  assert.ok(tool);
  const principal = { user: { id: 'owner-1' } } as McpPrincipal;
  const read = async (args: Record<string, unknown>) =>
    (await tool.run({ principal, args: tool.schema.parse({ repository, ...args }) })).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  try {
    await db('task_history').where({ task_id: 'goal-task-direct' }).update({
      metadata: JSON.stringify({ goalOutputRecords: output }),
    });
    for (const useLiveOutput of [true, false]) {
      live = useLiveOutput;
      for (const target of [{ goalId: directGoalId }, { taskId: 'goal-task-direct' }]) {
        for (const option of [{}, { includeReasoningSummaries: false }]) {
          const defaults = await read({ ...target, ...option });
          assert.deepEqual(defaults.activity, [{ timestamp: '2026-09-13T10:00:00.000Z', message: 'Starting the task.' }]);
        }
        const included = await read({ ...target, includeReasoningSummaries: true });
        assert.equal(included.activity.length, 2);
        assert.equal(included.activity[0].timestamp, '2026-09-13T10:00:01.000Z');
        assert.match(included.activity[0].message, /^Inspecting the parser\. Checking narration\./);
        assert.equal(included.activity[0].message.length, 500);
        assert.match(included.activity[0].message, /…$/);
        assert.doesNotMatch(JSON.stringify(included), /Hidden/);
        const first = await read({ ...target, includeReasoningSummaries: true, limit: 1 });
        assert.deepEqual(first.activity, [included.activity[0]]);
        assert.equal(first.nextOffset, 1);
        const second = await read({ ...target, includeReasoningSummaries: true, limit: 1, offset: first.nextOffset });
        assert.deepEqual(second.activity, [included.activity[1]]);
        assert.equal(second.nextOffset, null);
      }
    }
    assert.throws(() => tool.schema.parse({ repository, goalId: directGoalId, includeReasoningSummaries: 'true' }));
  } finally {
    await db.destroy();
  }
});


test('activity paginates all Claude narration before the mixed live event limit', async () => {
  const db = await createActivityDatabase();
  const start = Date.parse('2026-09-13T10:00:00.000Z');
  const narration = Array.from({ length: 105 }, (_, index) => ({
    type: 'assistant',
    timestamp: new Date(start + index * 1000).toISOString(),
    message: { content: [{ type: 'text', text: `Verified parser case ${index}.` }] },
  }));
  const tools = Array.from({ length: 100 }, (_, index) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: { command: 'npm test' } }] },
  }));
  const output = [...narration, ...tools].map(event => JSON.stringify(event)).join('\n');
  const redisClient = {
    get: async (key: string) => key.startsWith('agent:output:') ? output : null,
  } as unknown as RedisClientType;
  try {
    const ui = parseAgentStreamOutput(output);
    assert.equal(ui.totalEventCount, 205);
    assert.equal(ui.events.length, 100);
    assert.ok(ui.events.every(event => event.type === 'tool_use'));
    for (const target of [{ goalId: directGoalId }, { taskId: 'goal-task-orchestrated' }]) {
      const read = (offset: number) => getAgentActivity(
        { db, redisClient }, { repository, ...target, offset, limit: 50 }, 'owner-1',
      );
      const first = await read(0);
      assert.equal(first.activity.length, 50);
      assert.deepEqual(first.activity[0], {
        timestamp: narration[104].timestamp, message: 'Verified parser case 104.',
      });
      assert.equal(first.nextOffset, 50);
      const second = await read(first.nextOffset);
      assert.equal(second.activity.length, 50);
      assert.equal(second.nextOffset, 100);
      const third = await read(second.nextOffset);
      assert.equal(third.activity.length, 5);
      assert.equal(third.nextOffset, null);
      assert.deepEqual([...first.activity, ...second.activity, ...third.activity].map(entry => entry.message),
        narration.map(event => event.message.content[0].text).reverse());
      assert.deepEqual((await read(105)).activity, []);
    }
  } finally {
    await db.destroy();
  }
});

test('activity removes fenced payloads and retains bracket-prefixed prose in live and stored output', async () => {
  const db = await createActivityDatabase();
  const cases: Array<[string, string | null]> = [
    ['```json\n{"raw":"payload"}\n```', null],
    ['```ts\nconst raw = "payload";\n```', null],
    ['**Result:** ```json\n{"raw":"payload"}\n```', null],
    ['~~~json\n["raw", "payload"]\n~~~', null],
    ['Before the change.\n```ts\nconst raw = 1;\n```\nTests passed.', 'Before the change. Tests passed.'],
    ['Updated parser.\n> ~~~ts\n> const raw = 1;\n> ~~~', 'Updated parser.'],
    ['Before the change.\n> > ```ts\n> > const raw = 1;\n> > ```\nTests passed.', 'Before the change. Tests passed.'],
    ['> ```ts\n> const raw = 1;\n> ```', null],
    ['- Updated parser.\n    ~~~ts\n    const raw = 1;\n    ~~~\nTests passed.', '- Updated parser. Tests passed.'],
    ['Updated parser.\n- ```ts\n  const raw = 1;\n  ```\nTests passed.', 'Updated parser. Tests passed.'],
    ['1. Updated parser.\n   - Checked types.\n       ```ts\n       const raw = 1;\n       ```\nTests passed.', '1. Updated parser. - Checked types. Tests passed.'],
    ['Updated parser.\n> 1. ~~~ts\n>    const raw = 1;\n>    ~~~\nTests passed.', 'Updated parser. Tests passed.'],
    ['Updated parser.\n- > ```ts\n  > const raw = 1;\n  > ```\nTests passed.', 'Updated parser. Tests passed.'],
    ['Updated parser.\n> ```ts\n> const unfinished =', 'Updated parser.'],
    ['- Updated parser.\n    ~~~ts\n    const unfinished =', '- Updated parser.'],
    ['Updated parser.\n> ````md\n> ```ts\n> const raw = 1;\n> ```\n> ````\nTests passed.', 'Updated parser. Tests passed.'],
    ['```json\n{"raw":1}\n```\nUpdated the parser.\n~~~sh\ncat .env\n~~~', 'Updated the parser.'],
    ['Still working.\n```json\n{"unfinished":', 'Still working.'],
    ['```ts\nconst unfinished =', null],
    ['````md\n```json\n{"raw":1}\n```\n````', null],
    ['```json\n{"checkpointReady":true,"message":"Parser updated","summary":"Tests passed."}\n```',
      'Checkpoint ready: Parser updated. Tests passed.'],
    ['{"checkpointReady":true,"message":"Parser updated"}', 'Checkpoint ready: Parser updated.'],
    ...[
      ['Parser updated', '~~~ts\nconst raw = 1;\n~~~', 'Checkpoint ready: Parser updated.'],
      ['Parser updated\n```ts\nconst raw = 1;\n```', 'Tests passed.\n~~~ts\nconst raw = 2;\n~~~',
        'Checkpoint ready: Parser updated. Tests passed.'],
      ['Parser updated', '{"raw":"payload"}', 'Checkpoint ready: Parser updated.'],
      ['```ts\nconst raw = 1;\n```', 'Tests passed.', null],
      ['{"raw":"payload"}', 'Tests passed.', null],
    ].flatMap(([message, summary, expected]): Array<[string, string | null]> => {
      const checkpoint = JSON.stringify({ checkpointReady: true, message, summary });
      return [[checkpoint, expected], [`\`\`\`json\n${checkpoint}\n\`\`\``, expected]];
    }),
    ['{"raw":"payload"}', null],
    ['["raw", "payload"]', null],
    ['[{"unfinished":', null],
    ['[parser.ts](src/parser.ts) is updated; tests passed.', '[parser.ts](src/parser.ts) is updated; tests passed.'],
    ['[done] Parser updated; tests passed.', '[done] Parser updated; tests passed.'],
    ['[1/3] Updating the parser.', '[1/3] Updating the parser.'],
  ];
  let output: string | null = null;
  const redisClient = {
    get: async (key: string) => key === 'agent:output:goal-task-direct' ? output : null,
  } as unknown as RedisClientType;
  const timestamp = '2026-09-13T10:00:00.000Z';
  try {
    for (const [content, expected] of cases) {
      const record = JSON.stringify({
        method: 'item/completed', params: { item: { type: 'agentMessage', text: content } },
        emittedAtMs: Date.parse(timestamp),
      });
      await db('task_history').where({ task_id: 'goal-task-direct' }).update({
        metadata: JSON.stringify({ goalOutputRecords: [record] }),
      });
      for (const live of [true, false]) {
        output = live ? record : null;
        const result = await getAgentActivity(
          { db, redisClient }, { repository, goalId: directGoalId, offset: 0, limit: 20 }, 'owner-1',
        );
        assert.deepEqual(result.activity, expected ? [{ timestamp, message: expected }] : [],
          `${live ? 'live' : 'stored'}: ${content}`);
        assert.equal(result.nextOffset, null);
      }
    }
  } finally {
    await db.destroy();
  }
});
