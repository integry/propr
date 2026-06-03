import { test } from 'node:test';
import assert from 'node:assert';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';

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

test('parseRedisOutput emits Vibe progress when no session messages exist yet', () => {
    const parsed = parseRedisOutput([
        'Skipping firewall setup (would require --privileged Docker flag)',
        'Vibe config directory mounted',
        'Executing command: vibe --output json -p',
        'Switching to node user...'
    ]);

    assert.deepStrictEqual(parsed.events.map(event => event.content), [
        'Vibe config directory mounted',
        'Executing command: vibe --output json -p',
        'Switching to node user...'
    ]);
});
