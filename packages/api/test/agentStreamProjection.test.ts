import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.GH_APP_ID = process.env.GH_APP_ID || '1';
process.env.GH_PRIVATE_KEY_PATH = process.env.GH_PRIVATE_KEY_PATH || '/tmp/missing-key.pem';
process.env.GH_INSTALLATION_ID = process.env.GH_INSTALLATION_ID || '1';

const { parseAgentStreamOutput } = await import('../services/agentStreamProjection.js');

after(async () => {
  const { db } = await import('@propr/core');
  await db.destroy();
});

const claudeStreamOutput = [
  'Claude config directory mounted',
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-opus-5' }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Inspecting the repository.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
      ],
      usage: { input_tokens: 12, output_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 }
    }
  }),
  JSON.stringify({
    type: 'user',
    session_id: 'session-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'package.json' }] }
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_2',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Fix the parser', status: 'in_progress' }] }
      }]
    }
  })
].join('\n');

test('Claude stream-json output keeps tool calls, todos and cache token usage', () => {
  const result = parseAgentStreamOutput(claudeStreamOutput);

  assert.equal(result.totalEventCount, 4);
  assert.deepEqual(result.events.map(event => event.type), ['thought', 'tool_use', 'tool_result', 'tool_use']);
  assert.equal(result.events[1].toolName, 'Bash');
  assert.equal(result.currentTask, 'Fix the parser');
  assert.deepEqual(result.tokenUsage, {
    input_tokens: 12,
    output_tokens: 4,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 900
  });
});

test('Claude live events get stable monotonic timestamps from the execution start', () => {
  const options = { executionStartTimestamp: '2026-09-12T10:00:00.000Z' };
  const result = parseAgentStreamOutput(claudeStreamOutput, options);

  // Envelope 0 is the system init record; the events come from envelopes 1-3,
  // each stamped one second apart from the execution start.
  assert.deepEqual(result.events.map(event => event.timestamp), [
    '2026-09-12T10:00:01.000Z',
    '2026-09-12T10:00:01.000Z',
    '2026-09-12T10:00:02.000Z',
    '2026-09-12T10:00:03.000Z'
  ]);

  const reparsed = parseAgentStreamOutput(claudeStreamOutput, options);
  assert.deepEqual(reparsed.events, result.events);
});

test('Claude envelopes that already carry timestamps keep them', () => {
  const output = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-12T09:59:59.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
  });

  const result = parseAgentStreamOutput(output, { executionStartTimestamp: '2026-09-12T10:00:00.000Z' });

  assert.equal(result.events[0].timestamp, '2026-09-12T09:59:59.000Z');
});

test('Claude streams without ProPR goal snapshots project nativeGoal null', () => {
  const result = parseAgentStreamOutput(claudeStreamOutput, { executionStartTimestamp: '2026-09-12T10:00:00.000Z' });

  assert.equal(result.nativeGoal, null);
  assert.equal(result.totalEventCount, 4);
  assert.equal(result.currentTask, 'Fix the parser');
});

test('Claude native /goal snapshots written by the worker populate nativeGoal', () => {
  const snapshot = (status: string, updatedAt: number) => JSON.stringify({
    type: 'system', subtype: 'propr_native_goal',
    goal: { objective: 'Ship it', status, iterations: 2, setAt: 1_000_000, updatedAt },
  });
  const output = [claudeStreamOutput, snapshot('active', 1_030_000), snapshot('complete', 1_095_000)].join('\n');

  const result = parseAgentStreamOutput(output, { executionStartTimestamp: '2026-09-12T10:00:00.000Z' });

  const usage = result.tokenUsage!;
  assert.deepEqual(result.nativeGoal, {
    objective: 'Ship it', status: 'complete', tokenBudget: null,
    tokensUsed: usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
    timeUsedSeconds: 95,
  });
  assert.equal(result.totalEventCount, 4, 'goal snapshots are not conversation events');
});

test('Codex stream output still uses the Redis parser', () => {
  const output = [
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'Planning the change' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'src', exit_code: 0 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 } })
  ].join('\n');

  const result = parseAgentStreamOutput(output);

  assert.deepEqual(result.events.map(event => event.type), ['thought', 'tool_use', 'tool_result']);
  assert.equal(result.tokenUsage?.output_tokens, 3);
});

test('Codex app-server goal records still populate nativeGoal through the projection', () => {
  const output = [
    JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Working on the goal' } } }),
    JSON.stringify({ method: 'thread/goal/updated', params: { goal: { objective: 'Ship the fix', status: 'in_progress', tokenBudget: 1000, tokensUsed: 10, timeUsedSeconds: 5 } } })
  ].join('\n');

  const result = parseAgentStreamOutput(output);

  assert.deepEqual(result.nativeGoal, {
    objective: 'Ship the fix',
    status: 'in_progress',
    tokenBudget: 1000,
    tokensUsed: 10,
    timeUsedSeconds: 5
  });
});
