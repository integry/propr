import { test } from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';

after(async () => {
    const { db } = await import('@propr/core');
    await db.destroy();
});

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
        { type: 'thought', content: 'I will inspect the repo.', timestamp: '2026-06-05T13:00:01.000Z' },
        { type: 'tool_use', toolName: 'read_file', input: { path: 'package.json' }, id: 'tool-1', timestamp: '2026-06-05T13:00:03.000Z' },
        { type: 'thought', content: 'Done.', timestamp: '2026-06-05T13:00:05.000Z' }
    ]);
    assert.deepStrictEqual(parsed.tokenUsage, {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    });
});

test('parseRedisOutput emits later Antigravity tool calls once per stable ID', () => {
    const firstCall = { type: 'tool_use', tool_name: 'read_file', tool_id: 'tool-1', parameters: { path: 'one.ts' }, timestamp: '2026-06-05T13:00:02.000Z' };
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'init', model: 'antigravity-gemini-3-pro-preview' }),
        JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'Checking files. ', timestamp: '2026-06-05T13:00:01.000Z' }),
        JSON.stringify(firstCall),
        JSON.stringify(firstCall),
        JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'Next file.', timestamp: '2026-06-05T13:00:03.000Z' }),
        JSON.stringify({ type: 'tool_use', tool_name: 'read_file', tool_id: 'tool-2', parameters: { path: 'two.ts' }, timestamp: '2026-06-05T13:00:04.000Z' }),
    ]);

    assert.deepStrictEqual(parsed.events.map(event => event.type), [
        'thought', 'tool_use', 'thought', 'tool_use',
    ]);
    assert.deepStrictEqual(parsed.events.filter(event => event.type === 'tool_use').map(event => event.id), [
        'tool-1', 'tool-2',
    ]);
});

test('parseRedisOutput suppresses Antigravity tool_result output', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'tool_result', tool_id: 'tool-2', status: 'error', output: 'command failed', timestamp: '2026-06-05T13:00:04.000Z' })
    ]);

    assert.deepStrictEqual(parsed.events, []);
});

test('parseRedisOutput renders only Antigravity planner transcript items', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-06-09T10:37:04Z', content: 'I will inspect the repo.' }),
        JSON.stringify({ step_index: 3, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: '2026-06-09T10:37:05Z', content: 'Created At: 2026-06-09T10:37:05Z\npackage contents' }),
        JSON.stringify({ step_index: 4, source: 'MODEL', type: 'CODE_ACTION', status: 'DONE', created_at: '2026-06-09T10:37:06Z', content: '[diff_block_start]\n+change' })
    ]);

    assert.deepStrictEqual(parsed.events, [
        { type: 'thought', content: 'I will inspect the repo.', timestamp: '2026-06-09T10:37:04Z' }
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

test('parseRedisOutput counts Codex usage once when turn and result records coexist', () => {
    const usage = { input_tokens: 120, output_tokens: 30, cached_input_tokens: 40 };
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'turn.completed', usage }),
        JSON.stringify({ type: 'result', status: 'success', usage }),
    ]);

    assert.deepStrictEqual(parsed.tokenUsage, {
        input_tokens: 120,
        output_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 40,
    });
});

test('parseRedisOutput projects native Codex App Server plan, activity and token usage', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ method: 'turn/plan/updated', params: { plan: [
            { step: 'Inspect transport', status: 'completed' },
            { step: 'Run tests', status: 'inProgress' },
        ] } }),
        JSON.stringify({ method: 'item/completed', params: { item: {
            id: 'cmd-1', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'passed', status: 'completed',
        } } }),
        JSON.stringify({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: {
            inputTokens: 200, outputTokens: 50, cachedInputTokens: 80,
        } } } }),
        JSON.stringify({ method: 'thread/goal/updated', params: { goal: {
            objective: 'Ship native goals', status: 'active', tokenBudget: 1000, tokensUsed: 330, timeUsedSeconds: 42,
        } } }),
    ]);

    assert.deepStrictEqual(parsed.todos, [
        { id: 'plan-0', content: 'Inspect transport', status: 'completed' },
        { id: 'plan-1', content: 'Run tests', status: 'in_progress' },
    ]);
    assert.equal(parsed.currentTask, 'Run tests');
    assert.equal(parsed.events.some(event => event.type === 'tool_use'), true);
    assert.deepStrictEqual(parsed.tokenUsage, {
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 80,
    });
    assert.deepStrictEqual(parsed.nativeGoal, {
        objective: 'Ship native goals', status: 'active', tokenBudget: 1000, tokensUsed: 330, timeUsedSeconds: 42,
    });
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
    assert.equal(parsed.events[0].internalReasoning, true);
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

const VIBE3_STREAMING_FIXTURE = new URL('./fixtures/vibe/vibe-3.1.5-streaming-tool-task.jsonl', import.meta.url);

test('parseRedisOutput projects real Vibe 3.1.5 streaming effects as tool_use/tool_result pairs', async () => {
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(VIBE3_STREAMING_FIXTURE, 'utf8').split('\n').filter(Boolean);
    const parsed = parseRedisOutput(lines);

    assert.deepStrictEqual(parsed.events.map(event => event.type), [
        'tool_use', 'tool_result',
        'tool_use', 'tool_result',
        'tool_use', 'tool_result',
        'tool_use', 'tool_result',
        'tool_use', 'tool_result',
        'thought'
    ]);
    const toolUses = parsed.events.filter(event => event.type === 'tool_use');
    assert.deepStrictEqual(toolUses.map(event => [event.toolName, event.id]), [
        ['file_system.read_file', '7QQfJf2UN'],
        ['file_system.read_file', 'rmr2zlANF'],
        ['file_system.edit', '5ioehZlAB'],
        ['file_system.edit', 'hu7GCZXlS'],
        ['file_system.bash', 'dNds9G1Z8']
    ]);
    assert.deepStrictEqual(toolUses[0].input, { filePath: 'math.js', offset: null, limit: 2000 });
    assert.strictEqual(toolUses[2].input?.filePath, 'math.js');
    assert.match(String(toolUses[2].input?.newString), /function subtract\(a, b\)/);
    assert.deepStrictEqual(toolUses[4].input, { command: 'cd /home/node/workspace && node --test' });
    assert.strictEqual(toolUses[0].timestamp, new Date(1795777802057).toISOString());

    const toolResults = parsed.events.filter(event => event.type === 'tool_result');
    assert.deepStrictEqual(toolResults.map(event => event.toolUseId), toolUses.map(event => event.id));
    assert.deepStrictEqual(toolResults.map(event => event.isError), [false, false, false, false, false]);
    assert.strictEqual(toolResults[0].result, '<trimmed>');
    assert.match(String(toolResults[4].result), /^TAP version 13\n# Subtest: add\nok 1 - add/);

    const answer = parsed.events.at(-1);
    assert.match(String(answer?.content), /^Done\. Added `subtract\(a, b\)` to `math\.js`/);
    assert.strictEqual(answer?.internalReasoning, undefined);
    assert.strictEqual(answer?.timestamp, new Date(1795777811190).toISOString());
    assert.ok(!parsed.events.some(event => String(event.content).startsWith('Add subtract')), 'user prompt is not a thought');
});

test('parseRedisOutput flags failed Vibe 3 effects and keeps assistant reasoning', () => {
    const base = { sessionId: 's', turnId: 'turn-1', generationStatus: 'completed', createdAt: 1795777800000 };
    const parsed = parseRedisOutput([
        JSON.stringify({ ...base, id: 'r', type: 'reasoning', text: 'Check the file first.' }),
        JSON.stringify({ ...base, id: 'e1', type: 'effect', toolCallId: 'call-1',
            detail: { toolName: 'file_system.read_file', input: { filePath: 'missing.js' } },
            state: { status: 'failed', outputText: '', error: { message: 'File not found: missing.js' } } }),
        JSON.stringify({ ...base, id: 'e2', type: 'effect', toolCallId: 'call-2',
            detail: { toolName: 'file_system.bash', input: { command: 'rm -rf /' } },
            state: { status: 'rejected', outputText: '', decision: 'deny' } }),
        JSON.stringify({ ...base, id: 'e3', type: 'effect', toolCallId: 'call-3', generationStatus: 'running',
            detail: { toolName: 'file_system.edit', input: { filePath: 'partial' } }, state: { status: 'running' } }),
        JSON.stringify({ ...base, id: 'a', type: 'message', role: 'assistant', reasoning_content: 'The file is missing.',
            content: [{ type: 'reasoning', text: 'I should report it.' }, { type: 'text', text: 'missing.js does not exist.' }] }),
        JSON.stringify({ ...base, id: 'd', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Draft' }],
            outcome: { type: 'discarded' } })
    ]);

    assert.deepStrictEqual(parsed.events.map(event => [event.type, event.toolName ?? event.toolUseId ?? event.content, event.isError ?? event.internalReasoning]), [
        ['thought', 'Check the file first.', true],
        ['tool_use', 'file_system.read_file', undefined],
        ['tool_result', 'call-1', true],
        ['tool_use', 'file_system.bash', undefined],
        ['tool_result', 'call-2', true],
        ['thought', 'The file is missing.\nI should report it.', true],
        ['thought', 'missing.js does not exist.', undefined]
    ]);
    assert.strictEqual(parsed.events[2].result, 'File not found: missing.js');
    assert.strictEqual(parsed.events[4].result, 'rejected');
});

test('parseRedisOutput reads Vibe 3 entries from a --output json history array', () => {
    const base = { sessionId: 's', turnId: 'turn-1', generationStatus: 'completed' };
    const parsed = parseRedisOutput([JSON.stringify([
        { ...base, id: 'u', type: 'message', role: 'user', content: [{ type: 'text', text: 'Read it' }] },
        { ...base, id: 'e', type: 'effect', toolCallId: 'call', detail: { toolName: 'file_system.read_file', input: { filePath: 'a.js' } },
            state: { status: 'completed', outputText: 'contents' } },
        { ...base, id: 'a', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Read a.js.' }] }
    ], null, 2)]);

    assert.deepStrictEqual(parsed.events.map(event => event.type), ['tool_use', 'tool_result', 'thought']);
    assert.strictEqual(parsed.events[1].result, 'contents');
});

test('parseRedisOutput keeps Vibe 2 role-based records unchanged', () => {
    const parsed = parseRedisOutput([
        '{"role":"system","content":"System prompt"}',
        '{"role":"user","content":"Fix the greeting"}',
        '{"role":"assistant","reasoning_content":"I will inspect the current file.","tool_calls":[{"id":"tool-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"vibe_test.py\\"}"}}]}',
        '{"role":"tool","tool_call_id":"tool-1","content":"<tool_error>missing</tool_error>"}',
        '{"role":"assistant","content":"Changed the greeting and verified it."}'
    ], { executionStartTimestamp: '2026-06-03T20:56:52.000Z' });

    assert.deepStrictEqual(parsed.events, [
        { type: 'thought', content: 'I will inspect the current file.', internalReasoning: true, timestamp: '2026-06-03T20:56:54.000Z' },
        { type: 'tool_use', toolName: 'read_file', input: { path: 'vibe_test.py' }, id: 'tool-1', timestamp: '2026-06-03T20:56:54.000Z' },
        { type: 'tool_result', toolUseId: 'tool-1', result: '<tool_error>missing</tool_error>', isError: true, timestamp: '2026-06-03T20:56:55.000Z' },
        { type: 'thought', content: 'Changed the greeting and verified it.', timestamp: '2026-06-03T20:56:56.000Z' }
    ]);
});

const PI_FIXTURE = new URL('./fixtures/pi/pi-1.6.1-json-tool-task.jsonl', import.meta.url);

test('parseRedisOutput projects the Pi 1.6.1 JSON fixture as tool pairs, final text and summed usage', async () => {
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(PI_FIXTURE, 'utf8').split('\n').filter(Boolean);
    const parsed = parseRedisOutput(lines);

    const toolUses = parsed.events.filter(event => event.type === 'tool_use');
    const toolResults = parsed.events.filter(event => event.type === 'tool_result');
    assert.deepStrictEqual(toolUses.map(event => [event.toolName, event.id]), [
        ['read', 'HEFIeQfFW'],
        ['read', '7Rc4Yw8fp'],
        ['bash', '4vK53wBZb'],
        ['edit', '6UNoPXH4u'],
    ]);
    assert.deepStrictEqual(toolUses[2].input, { command: 'cat missing.txt', timeout: 5 });
    // One result per call, though Pi repeats them in toolResult messages and turn_end.
    assert.deepStrictEqual(toolResults.map(event => [event.toolUseId, event.isError]), [
        ['4vK53wBZb', true],
        ['6UNoPXH4u', false],
        ['HEFIeQfFW', false],
    ]);
    for (const result of toolResults) {
        const use = parsed.events.findIndex(event => event.type === 'tool_use' && event.id === result.toolUseId);
        assert.ok(use >= 0 && use < parsed.events.indexOf(result), `tool_use precedes result ${result.toolUseId}`);
    }
    assert.match(String(toolResults[0].result), /^cat: missing\.txt: No such file or directory/);
    assert.match(String(toolResults[2].result), /^function add\(a, b\)/);

    const answer = parsed.events.at(-1);
    assert.strictEqual(answer?.type, 'thought');
    assert.strictEqual(answer?.content, 'Done. Added subtract(a, b) to math.js, exported it, and added a test; node --test passes.');
    assert.strictEqual(answer?.timestamp, new Date(1795790316556).toISOString());
    assert.ok(!parsed.events.some(event => String(event.content).startsWith('Read math.js')), 'user prompt is not a thought');
    assert.deepStrictEqual(parsed.tokenUsage, {
        input_tokens: 1583 + 2202,
        output_tokens: 65 + 164,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    });
});

test('Pi message_update deltas are buffered per contentIndex until text_end, thinking_end or message_end', async () => {
    const { createRedisOutputProjection } = await import('../packages/api/services/redisOutputParser.ts');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
    const update = (assistantMessageEvent: Record<string, unknown>) => JSON.stringify({ type: 'message_update', usage, assistantMessageEvent });
    const projection = createRedisOutputProjection();
    const feed = (line: string, key: string) => projection.feed(line, key).events.map(({ event }) => event);

    feed(JSON.stringify({ type: 'session', version: 3, id: 's-1', timestamp: '2026-11-27T14:00:00.000Z', cwd: '/w' }), '0');
    feed(JSON.stringify({ type: 'message_start', message: { role: 'assistant', content: [], stopReason: 'pending', timestamp: 1795790400000 } }), '1');
    assert.deepStrictEqual(feed(update({ type: 'thinking_start', contentIndex: 0 }), '2'), []);
    assert.deepStrictEqual(feed(update({ type: 'thinking_delta', contentIndex: 0, delta: 'Look at ' }), '3'), []);
    feed(update({ type: 'thinking_delta', contentIndex: 0, delta: 'math.js' }), '4');
    assert.strictEqual(projection.pendingEvent()?.event.content, 'Look at math.js');
    assert.strictEqual(projection.pendingEvent()?.event.internalReasoning, true);
    assert.strictEqual(projection.pendingEvent()?.key, 'pi:block:1795790400000:0', 'a block streams under its message key');

    const thought = feed(update({ type: 'thinking_end', contentIndex: 0, content: 'Look at math.js first.' }), '5');
    assert.deepStrictEqual(thought.map(event => [event.content, event.internalReasoning]), [['Look at math.js first.', true]]);
    assert.strictEqual(projection.pendingEvent(), null);

    feed(update({ type: 'text_start', contentIndex: 1 }), '6');
    feed(update({ type: 'text_delta', contentIndex: 1, delta: 'Reading ' }), '7');
    feed(update({ type: 'text_delta', contentIndex: 1, delta: 'it now' }), '8');
    assert.strictEqual(projection.pendingEvent()?.event.content, 'Reading it now');
    assert.strictEqual(projection.pendingEvent()?.event.internalReasoning, undefined);
    feed(update({ type: 'toolcall_start', contentIndex: 2, id: 'call-1', toolName: 'read' }), '9');
    // No text_end: the final message is authoritative for the streamed block.
    const end = feed(JSON.stringify({ type: 'message_end', message: {
        role: 'assistant',
        content: [
            { type: 'thinking', thinking: 'Look at math.js first.' },
            { type: 'text', text: 'Reading it now.' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'math.js' } },
        ],
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155 },
        stopReason: 'toolUse',
        // Pi stamps the assistant message once, when it starts streaming.
        timestamp: 1795790400000,
    } }), '10');
    assert.deepStrictEqual(end.map(event => [event.type, event.content ?? event.toolName]), [
        ['thought', 'Reading it now.'],
        ['tool_use', 'read'],
    ]);
    assert.strictEqual(projection.pendingEvent(), null);

    assert.deepStrictEqual(feed(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'math.js' } }), '11'), []);
    feed(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'bash', args: { command: 'false' } }), '12');
    feed(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'bash', result: { content: [{ type: 'text', text: 'exit 1' }] }, isError: true }), '13');
    feed(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { content: [{ type: 'text', text: 'module.exports = {}' }] }, isError: false }), '14');
    feed(JSON.stringify({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'module.exports = {}' }], isError: false, timestamp: 1795790402000 } }), '15');
    feed(JSON.stringify({ type: 'agent_settled', aborted: false }), '16');

    const result = projection.result();
    assert.deepStrictEqual(result.events.map(event => [event.type, event.id ?? event.toolUseId ?? event.content, event.isError]), [
        ['thought', 'Look at math.js first.', undefined],
        ['thought', 'Reading it now.', undefined],
        ['tool_use', 'call-1', undefined],
        ['tool_use', 'call-2', undefined],
        ['tool_result', 'call-2', true],
        ['tool_result', 'call-1', false],
    ]);
    assert.deepStrictEqual(result.events[3].input, { command: 'false' });
    assert.strictEqual(result.events[1].timestamp, new Date(1795790400000).toISOString(), 'streamed block keeps its message timestamp');
    assert.deepStrictEqual(result.tokenUsage, { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 30 });
});

test('parseRedisOutput keeps Pi output away from the Vibe transcript scan and other agents away from Pi', async () => {
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'All done.' }], usage: { input: 3, output: 1 }, stopReason: 'stop', timestamp: 1795790500000 };
    const parsed = parseRedisOutput([
        JSON.stringify({ type: 'session', version: 3, id: 's-2', timestamp: '2026-11-27T14:00:00.000Z', cwd: '/w' }),
        JSON.stringify({ type: 'message_end', message: { role: 'user', content: 'Do it', timestamp: 1795790499000 } }),
        // The first `[` of the stream: a whole-transcript scan would read these messages as Vibe records.
        JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: 'Do it' }, { role: 'tool', tool_call_id: 'x', content: 'zzz' }], willRetry: true }),
        JSON.stringify({ type: 'message_end', message: assistant }),
    ]);
    assert.deepStrictEqual(parsed.events.map(event => [event.type, event.content]), [['thought', 'All done.']]);
    assert.deepStrictEqual(parsed.tokenUsage, { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

    const { isPiRecord } = await import('../packages/api/services/redisOutputParserPi.ts');
    for (const other of [
        { type: 'message', role: 'assistant', content: 'hi', delta: true },
        { type: 'turn.started' },
        { type: 'tool_use', tool_name: 'read', tool_id: 't' },
        { type: 'effect', turnId: 't', generationStatus: 'completed', toolCallId: 'c' },
        { type: 'assistant', message: { role: 'assistant', content: [] } },
        { type: 'session', sessionID: 'ses_1' },
        { type: 'message_end' },
        { type: 'tool_execution_end' },
    ]) {
        assert.strictEqual(isPiRecord(other), false, JSON.stringify(other));
    }
});

test('stored Pi output is detected and parsed for the live-details routes', async () => {
    const { readFileSync } = await import('node:fs');
    const { detectStoredOutputFormat } = await import('../packages/api/routes/liveDetailsStoredOutputFormat.ts');
    const { parsePiOutputToConversationResult } = await import('../packages/api/routes/liveDetailsOutputParsers.ts');
    const output = readFileSync(PI_FIXTURE, 'utf8');
    assert.strictEqual(detectStoredOutputFormat(output), 'pi');
    // Container banners before the stream and CRLF framing do not change the result.
    const parsed = parsePiOutputToConversationResult(`starting pi\n${output.replace(/\n/g, '\r\n')}`);
    assert.strictEqual(parsed?.events.filter(event => event.type === 'tool_result').length, 3);
    assert.strictEqual(parsed?.events.at(-1)?.content, 'Done. Added subtract(a, b) to math.js, exported it, and added a test; node --test passes.');
    assert.strictEqual(parsed?.tokenUsage?.input_tokens, 3785);
});

test('parseRedisOutput projects agy stream-json envelopes into thoughts, step tools and usage', () => {
    const step = (index: number, state: string, stepType: string, extra: Record<string, unknown> = {}) => JSON.stringify({
        event: 'step_update', step_update: { conversation_id: 'agy-task', step_index: index, state, step_type: stepType, ...extra },
    });
    const parsed = parseRedisOutput([
        'Using disposable Antigravity runtime state',
        JSON.stringify({ event: 'init', conversation_id: 'agy-task', init: { model: 'gemini-3.8-flash-medium', cwd: '/home/node/workspace', tools: [] } }),
        step(1, 'RUNNING', 'AGENT_RESPONSE', { text_delta: 'I will inspect ' }),
        step(1, 'DONE', 'AGENT_RESPONSE', { text_delta: 'the repository.', usage: { input_tokens: 900, output_tokens: 12 } }),
        step(2, 'ACTIVE', 'tool', { tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test' } } }),
        step(2, 'DONE', 'tool', { tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test' }, output: 'Command exited with code 0.' }, usage: { input_tokens: 1000, output_tokens: 8 } }),
        step(3, 'ACTIVE', 'tool', { tool_name: 'list_dir' }),
        step(3, 'ERROR', 'tool', { tool_name: 'list_dir' }),
        step(4, 'DONE', 'AGENT_RESPONSE', { text_delta: 'Done. Added subtract.' }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'agy-task', status: 'SUCCESS', response: 'Done. Added subtract.\n\nAll tests pass.', usage: { input_tokens: 4100, output_tokens: 120, cache_read_tokens: 3000 } } }),
    ]);

    assert.deepStrictEqual(parsed.events.map(event => ({ type: event.type, content: event.content, toolName: event.toolName, isError: event.isError })), [
        { type: 'thought', content: 'I will inspect the repository.', toolName: undefined, isError: undefined },
        { type: 'tool_use', content: undefined, toolName: 'run_command', isError: undefined },
        { type: 'tool_result', content: undefined, toolName: undefined, isError: false },
        { type: 'tool_use', content: undefined, toolName: 'list_dir', isError: undefined },
        { type: 'tool_result', content: undefined, toolName: undefined, isError: true },
        { type: 'thought', content: 'Done. Added subtract.', toolName: undefined, isError: undefined },
        // The terminal response extends the final narration, so it is a distinct answer and is kept.
        { type: 'thought', content: 'Done. Added subtract.\n\nAll tests pass.', toolName: undefined, isError: undefined },
    ]);
    assert.deepStrictEqual(parsed.events[1].input, { CommandLine: 'npm test' });
    assert.equal(parsed.events[2].toolUseId, parsed.events[1].id);
    assert.deepStrictEqual(parsed.tokenUsage, { input_tokens: 4100, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 });
});

test('parseRedisOutput buffers live agy narration and does not repeat a terminal response that equals it', () => {
    const lines = [
        JSON.stringify({ event: 'init', conversation_id: 'agy-goal', init: { model: 'gemini-3.8-flash-medium' } }),
        JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-goal', step_index: 1, state: 'RUNNING', step_type: 'agent_response', text_delta: 'Adding ', usage: { input_tokens: 40, output_tokens: 1 } } }),
        JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-goal', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'subtract.', usage: { input_tokens: 40, output_tokens: 2 } } }),
    ];
    const live = parseRedisOutput(lines);
    assert.deepStrictEqual(live.events.map(event => event.content), ['Adding subtract.']);
    assert.equal(live.tokenUsage?.input_tokens, 40);

    const finished = parseRedisOutput([...lines,
        JSON.stringify({ event: 'result', result: { conversation_id: 'agy-goal', status: 'SUCCESS', response: 'Adding subtract.', usage: { input_tokens: 45, output_tokens: 2 } } })]);
    assert.deepStrictEqual(finished.events.map(event => event.content), ['Adding subtract.']);
    assert.equal(finished.tokenUsage?.input_tokens, 45);
});

test('parseRedisOutput names real agy 1.5 tool steps and keeps user input out of tool activity', () => {
    const fixture = fs.readFileSync(new URL('./fixtures/antigravity/agy-1.5-stream-tools.jsonl', import.meta.url), 'utf8');
    const parsed = parseRedisOutput(fixture.trim().split('\n'));
    const tools = parsed.events.filter(event => event.type === 'tool_use');
    assert.deepStrictEqual(tools.map(event => [event.toolName, event.input]), [
        ['run_command', { CommandLine: 'ls -la' }],
        ['write_file', { Path: '/home/node/workspace/notes.txt' }],
        ['run_command', { CommandLine: 'cat missing.txt' }],
    ]);
    assert.ok(!parsed.events.some(event => event.toolName === 'user_input' || event.toolName === 'tool'));
    const results = parsed.events.filter(event => event.type === 'tool_result');
    assert.deepStrictEqual(results.map(event => event.toolUseId), tools.map(event => event.id));
    assert.match(String(results[0].result), /math\.test\.js/);
    assert.match(String(results[2].result), /cat: missing\.txt: No such file or directory/);
    // `cat missing.txt` exited with code 1: an error, although the step state is DONE.
    assert.deepStrictEqual(results.map(event => event.isError), [false, false, true]);
    const thoughts = parsed.events.filter(event => event.type === 'thought');
    assert.equal(thoughts.length, 1);
    assert.match(String(thoughts[0].content), /^1\. \*\*Listed workspace files\*\*[\s\S]*return code 1/);
    assert.deepStrictEqual(parsed.tokenUsage, { input_tokens: 14026, output_tokens: 1099, cache_creation_input_tokens: 0, cache_read_input_tokens: 14152 });
});

test('parseRedisOutput keeps a final agy answer supplied only by the result after intermediate narration', () => {
    const step = (index: number, state: string, stepType: string, extra: Record<string, unknown> = {}) => JSON.stringify({
        event: 'step_update', step_update: { conversation_id: 'agy-final', step_index: index, state, step_type: stepType, ...extra },
    });
    const parsed = parseRedisOutput([
        JSON.stringify({ event: 'init', conversation_id: 'agy-final', init: { model: 'gemini-3.8-flash-medium' } }),
        step(1, 'DONE', 'agent_response', { text_delta: 'I will inspect the repository.' }),
        step(2, 'ACTIVE', 'tool', { tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'npm test' } } }),
        step(2, 'DONE', 'tool', { tool_name: 'run_command', tool_info: { output: 'Command exited with code 0.' } }),
        // The answering step carries usage but no text_delta.
        step(3, 'DONE', 'agent_response', { usage: { input_tokens: 30, output_tokens: 5 } }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'agy-final', status: 'SUCCESS', response: 'Added subtract; npm test passes.' } }),
    ]);
    assert.deepStrictEqual(parsed.events.filter(event => event.type === 'thought').map(event => event.content), [
        'I will inspect the repository.',
        'Added subtract; npm test passes.',
    ]);
});

test('parseRedisOutput does not repeat a terminal agy response that equals the final narration after tools', () => {
    const step = (index: number, state: string, stepType: string, extra: Record<string, unknown> = {}) => JSON.stringify({
        event: 'step_update', step_update: { conversation_id: 'agy-dup', step_index: index, state, step_type: stepType, ...extra },
    });
    const parsed = parseRedisOutput([
        JSON.stringify({ event: 'init', conversation_id: 'agy-dup', init: { model: 'gemini-3.8-flash-medium' } }),
        step(1, 'DONE', 'agent_response', { text_delta: 'I will inspect the repository.' }),
        step(2, 'DONE', 'tool', { tool_name: 'run_command' }),
        step(3, 'DONE', 'agent_response', { text_delta: 'Added subtract.' }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'agy-dup', status: 'SUCCESS', response: '  Added subtract.\n' } }),
    ]);
    assert.deepStrictEqual(parsed.events.filter(event => event.type === 'thought').map(event => event.content), [
        'I will inspect the repository.',
        'Added subtract.',
    ]);
});

test('parseRedisOutput shows the terminal agy response when no narration streamed', () => {
    const parsed = parseRedisOutput([
        JSON.stringify({ event: 'init', conversation_id: 'agy-quiet', init: { model: 'gemini-3.8-flash-medium' } }),
        JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-quiet', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 10, output_tokens: 2 } } }),
        JSON.stringify({ event: 'result', result: { conversation_id: 'agy-quiet', status: 'SUCCESS', response: 'All done.' } }),
    ]);
    assert.deepStrictEqual(parsed.events.map(event => [event.type, event.content]), [['thought', 'All done.']]);
});
