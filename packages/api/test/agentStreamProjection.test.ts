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
