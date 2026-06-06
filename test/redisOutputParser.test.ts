import { test } from 'node:test';
import assert from 'node:assert';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';

test('parseRedisOutput normalizes Antigravity stream JSON events', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'init', timestamp: '2026-06-05T13:00:00.000Z', session_id: 'session-1', model: 'antigravity-gemini-3-pro-preview' }),
        JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'I will ', timestamp: '2026-06-05T13:00:01.000Z' }),
        JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'inspect the repo.', timestamp: '2026-06-05T13:00:02.000Z' }),
        JSON.stringify({ type: 'tool_use', tool_name: 'read_file', tool_id: 'tool-1', parameters: { path: 'package.json' }, timestamp: '2026-06-05T13:00:03.000Z' }),
        JSON.stringify({ type: 'tool_result', tool_id: 'tool-1', status: 'success', result: 'package.json contents', timestamp: '2026-06-05T13:00:04.000Z' }),
        JSON.stringify({ type: 'message', role: 'assistant', content: 'Done.', timestamp: '2026-06-05T13:00:05.000Z' }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 }, timestamp: '2026-06-05T13:00:06.000Z' })
    ]);

    assert.deepStrictEqual(parsed.events, [
        { type: 'thought', content: 'I will inspect the repo.', timestamp: '2026-06-05T13:00:03.000Z' },
        { type: 'tool_use', toolName: 'read_file', input: { path: 'package.json' }, id: 'tool-1', timestamp: '2026-06-05T13:00:03.000Z' },
        { type: 'tool_result', toolUseId: 'tool-1', result: 'package.json contents', isError: false, timestamp: '2026-06-05T13:00:04.000Z' },
        { type: 'thought', content: 'Done.', timestamp: '2026-06-05T13:00:05.000Z' }
    ]);
    assert.deepStrictEqual(parsed.tokenUsage, {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    });
});

test('parseRedisOutput handles Antigravity tool_result output and error status', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'tool_result', tool_id: 'tool-2', status: 'error', output: 'command failed', timestamp: '2026-06-05T13:00:04.000Z' })
    ]);

    assert.deepStrictEqual(parsed.events, [
        { type: 'tool_result', toolUseId: 'tool-2', result: 'command failed', isError: true, timestamp: '2026-06-05T13:00:04.000Z' }
    ]);
});

test('parseRedisOutput keeps generic Codex JSONL events out of Antigravity routing', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'message', role: 'assistant', content: 'Task completed.', timestamp: '2026-06-05T13:00:01.000Z' }),
        JSON.stringify({ type: 'tool_use', tool: 'shell', params: { command: 'npm test' }, timestamp: '2026-06-05T13:00:02.000Z' }),
        JSON.stringify({ type: 'tool_result', result: 'tests passed', status: 'success', timestamp: '2026-06-05T13:00:03.000Z' }),
        JSON.stringify({ type: 'result', result: 'Success', status: 'success', timestamp: '2026-06-05T13:00:04.000Z' })
    ]);

    assert.deepStrictEqual(parsed.events, [
        { type: 'thought', content: 'Task completed.', timestamp: '2026-06-05T13:00:01.000Z' },
        { type: 'tool_use', toolName: 'shell', input: { command: 'npm test' }, timestamp: '2026-06-05T13:00:02.000Z' },
        { type: 'tool_result', result: 'tests passed', isError: false, timestamp: '2026-06-05T13:00:03.000Z' }
    ]);
    assert.strictEqual(parsed.tokenUsage, null);
});

test('parseRedisOutput emits Vibe live events from a partial JSON transcript array', () => {
    const output = `[
  {
    "role": "system",
    "content": "System prompt should not be shown"
  },
  {
    "role": "assistant",
    "content": "",
    "reasoning_content": "I will inspect the file.",
    "tool_calls": [
      {
        "id": "tool-1",
        "function": {
          "name": "read_file",
          "arguments": "{\\"path\\":\\"vibe_test.py\\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "tool-1",
    "content": "content: print(\\"Hello from Vibe\\")"
  },
  {
    "role": "assistant",
    "content": "Updated the greeting."
  },
  {
    "role": "assistant",
    "content": "still streaming"`;

    const parsed = parseRedisOutput(output.split('\n').filter(line => line.trim()));

    assert.deepStrictEqual(parsed.events.map(event => event.type), ['thought', 'tool_use', 'tool_result', 'thought']);
    assert.strictEqual(parsed.events[0].content, 'I will inspect the file.');
    assert.strictEqual(parsed.events[1].toolName, 'read_file');
    assert.deepStrictEqual(parsed.events[1].input, { path: 'vibe_test.py' });
    assert.strictEqual(parsed.events[2].toolUseId, 'tool-1');
    assert.strictEqual(parsed.events[2].result, 'content: print("Hello from Vibe")');
    assert.strictEqual(parsed.events[3].content, 'Updated the greeting.');
    assert.ok(!JSON.stringify(parsed.events).includes('System prompt should not be shown'));
});

test('parseRedisOutput emits Vibe live events from session JSONL', () => {
    const output = [
        '{"role":"user","content":"Fix the greeting"}',
        '{"role":"assistant","reasoning_content":"I will inspect the current file.","tool_calls":[{"id":"tool-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"vibe_test.py\\"}"}}]}',
        '{"role":"tool","tool_call_id":"tool-1","content":"content: print(\\"Hello from Vibe\\")"}',
        '{"role":"assistant","content":"Changed the greeting and verified it."}'
    ];

    const parsed = parseRedisOutput(output);

    assert.deepStrictEqual(parsed.events.map(event => event.type), ['thought', 'tool_use', 'tool_result', 'thought']);
    assert.strictEqual(parsed.events[0].content, 'I will inspect the current file.');
    assert.strictEqual(parsed.events[1].toolName, 'read_file');
    assert.deepStrictEqual(parsed.events[1].input, { path: 'vibe_test.py' });
    assert.strictEqual(parsed.events[2].result, 'content: print("Hello from Vibe")');
    assert.strictEqual(parsed.events[3].content, 'Changed the greeting and verified it.');
});

test('parseRedisOutput ignores Vibe startup progress when no session messages exist yet', () => {
    const parsed = parseRedisOutput([
        'Skipping firewall setup (would require --privileged Docker flag)',
        'Vibe config directory mounted',
        'Executing command: vibe --output json -p',
        'Switching to node user...'
    ]);

    assert.deepStrictEqual(parsed.events, []);
});

test('parseRedisOutput prefers Vibe session JSONL over startup progress when both are present', () => {
    const parsed = parseRedisOutput([
        'Vibe config directory mounted',
        'Executing command: vibe --output json -p <redacted>',
        'Switching to node user...',
        '{"role":"assistant","reasoning_content":"The comment asks for a less formal greeting."}',
        '{"role":"assistant","content":"Updated the greeting and verified the script output."}'
    ]);

    assert.deepStrictEqual(parsed.events.map(event => event.content), [
        'The comment asks for a less formal greeting.',
        'Updated the greeting and verified the script output.'
    ]);
});

test('parseRedisOutput ignores generic Vibe completion event before session messages', () => {
    const parsed = parseRedisOutput([
        '{"role":"assistant","content":"Task completed."}',
        '{"role":"assistant","reasoning_content":"I can see there are PHP files already."}',
        '{"role":"assistant","reasoning_content":"Now I understand the current state."}'
    ]);

    assert.deepStrictEqual(parsed.events.map(event => event.content), [
        'I can see there are PHP files already.',
        'Now I understand the current state.'
    ]);
});

test('parseRedisOutput anchors untimestamped Vibe events to execution start', () => {
    const parsed = parseRedisOutput([
        '{"role":"assistant","reasoning_content":"First thought."}',
        '{"role":"assistant","reasoning_content":"Second thought."}'
    ], { executionStartTimestamp: '2026-06-03T20:56:52.000Z' });

    assert.deepStrictEqual(parsed.events.map(event => event.timestamp), [
        '2026-06-03T20:56:52.000Z',
        '2026-06-03T20:56:53.000Z'
    ]);
});

test('parseRedisOutput deduplicates replayed Vibe session transcript events', () => {
    const sessionLines = [
        '{"role":"assistant","reasoning_content":"I need to understand the current state."}',
        '{"role":"assistant","reasoning_content":"Let me verify the change was applied correctly."}',
        '{"role":"assistant","content":"The change has been successfully applied."}'
    ];

    const parsed = parseRedisOutput([...sessionLines, ...sessionLines], {
        executionStartTimestamp: '2026-06-03T20:56:52.000Z'
    });

    assert.deepStrictEqual(parsed.events.map(event => event.content), [
        'I need to understand the current state.',
        'Let me verify the change was applied correctly.',
        'The change has been successfully applied.'
    ]);
});
