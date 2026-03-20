import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseCodexStreamOutput } from '../packages/core/src/codex/codexHelpers.js';

describe('parseCodexStreamOutput', () => {
    describe('basic functionality', () => {
        test('handles empty stdout', () => {
            const result = parseCodexStreamOutput('');

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.logs, '');
            assert.strictEqual(result.result, undefined);
            assert.strictEqual(result.error, undefined);
            assert.deepStrictEqual(result.conversationLog, []);
            assert.strictEqual(result.tokenUsage, undefined);
        });

        test('handles whitespace-only stdout', () => {
            const result = parseCodexStreamOutput('   \n  \n   ');

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.logs, '');
            assert.deepStrictEqual(result.conversationLog, []);
        });
    });

    describe('agent_message parsing', () => {
        test('parses agent_message item.completed event', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'agent_message',
                    text: 'I have completed the task successfully.'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.result, 'I have completed the task successfully.');
            assert.ok(result.logs.includes('[Assistant] I have completed the task successfully.'));
            assert.strictEqual(result.conversationLog.length, 1);
        });

        test('parses agent_message with empty text', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'agent_message',
                    text: ''
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.result, '');
            assert.ok(result.logs.includes('[Assistant]'));
        });

        test('parses agent_message with undefined text', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'agent_message'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.result, undefined);
            assert.ok(result.logs.includes('[Assistant]'));
        });

        test('aggregates multiple agent_message events (last one wins)', () => {
            const events = [
                { type: 'item.completed', item: { type: 'agent_message', text: 'First message' } },
                { type: 'item.completed', item: { type: 'agent_message', text: 'Second message' } }
            ];
            const stdout = events.map(e => JSON.stringify(e)).join('\n');

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.result, 'Second message');
            assert.ok(result.logs.includes('[Assistant] First message'));
            assert.ok(result.logs.includes('[Assistant] Second message'));
        });
    });

    describe('command_execution parsing', () => {
        test('parses command_execution item.completed event', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'command_execution',
                    command: 'npm test',
                    aggregated_output: 'All tests passed',
                    exit_code: 0
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(result.logs.includes('[Command] npm test'));
            assert.ok(result.logs.includes('[Output] All tests passed'));
        });

        test('parses command_execution without output', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'command_execution',
                    command: 'mkdir test-dir'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[Command] mkdir test-dir'));
            assert.ok(!result.logs.includes('[Output]'));
        });

        test('parses item.started for command_execution', () => {
            const event = {
                type: 'item.started',
                item: {
                    type: 'command_execution',
                    command: 'git status'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[Running] git status'));
        });
    });

    describe('reasoning parsing', () => {
        test('parses reasoning item.completed event', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'reasoning',
                    text: 'I need to analyze the codebase first.'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[Reasoning] I need to analyze the codebase first.'));
        });
    });

    describe('file_change parsing', () => {
        test('parses file_change item.completed event', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'file_change',
                    changes: [
                        { path: 'src/index.ts', kind: 'modified' },
                        { path: 'src/utils.ts', kind: 'created' }
                    ]
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[File Changes]'));
            assert.ok(result.logs.includes('modified: src/index.ts'));
            assert.ok(result.logs.includes('created: src/utils.ts'));
        });

        test('handles file_change without changes array', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'file_change'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(!result.logs.includes('[File Changes]'));
        });
    });

    describe('todo_list parsing', () => {
        test('parses todo_list item.completed event', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'todo_list',
                    items: [
                        { text: 'Review code', completed: true },
                        { text: 'Write tests', completed: false }
                    ]
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[Todo List]'));
            assert.ok(result.logs.includes('[x] Review code'));
            assert.ok(result.logs.includes('[ ] Write tests'));
        });

        test('parses todo_list item.updated event', () => {
            const event = {
                type: 'item.updated',
                item: {
                    type: 'todo_list',
                    items: [
                        { text: 'Task 1', completed: true },
                        { text: 'Task 2', completed: true }
                    ]
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[Todo Update]'));
            assert.ok(result.logs.includes('[x] Task 1'));
            assert.ok(result.logs.includes('[x] Task 2'));
        });
    });

    describe('error event handling', () => {
        test('parses error event', () => {
            const event = {
                type: 'error',
                message: 'API rate limit exceeded'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, 'API rate limit exceeded');
            assert.ok(result.logs.includes('[Error] API rate limit exceeded'));
        });

        test('parses result event with error status', () => {
            const event = {
                type: 'result',
                status: 'error',
                message: 'Execution failed'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, 'Execution failed');
        });

        test('parses result event with success status', () => {
            const event = {
                type: 'result',
                result: 'Task completed successfully',
                status: 'success'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.result, 'Task completed successfully');
            assert.strictEqual(result.error, undefined);
        });

        test('handles error event without message', () => {
            const event = {
                type: 'error'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, undefined);
        });
    });

    describe('token usage aggregation', () => {
        test('aggregates token usage from turn.completed events', () => {
            const events = [
                { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
                { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 75 } }
            ];
            const stdout = events.map(e => JSON.stringify(e)).join('\n');

            const result = parseCodexStreamOutput(stdout);

            assert.deepStrictEqual(result.tokenUsage, {
                input_tokens: 300,
                output_tokens: 125
            });
        });

        test('includes cached_input_tokens in total', () => {
            const event = {
                type: 'turn.completed',
                usage: {
                    input_tokens: 100,
                    cached_input_tokens: 50,
                    output_tokens: 25
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.deepStrictEqual(result.tokenUsage, {
                input_tokens: 150,
                output_tokens: 25
            });
        });

        test('handles turn.completed without usage', () => {
            const event = {
                type: 'turn.completed'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.tokenUsage, undefined);
        });

        test('returns undefined tokenUsage when no tokens used', () => {
            const event = {
                type: 'message',
                role: 'user',
                content: 'Hello'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.tokenUsage, undefined);
        });
    });

    describe('session and conversation ID extraction', () => {
        test('extracts session_id from event', () => {
            const event = {
                type: 'message',
                session_id: 'sess_123abc',
                role: 'assistant',
                content: 'Hello'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.sessionId, 'sess_123abc');
        });

        test('extracts conversation_id from event', () => {
            const event = {
                type: 'message',
                conversation_id: 'conv_456def',
                role: 'assistant',
                content: 'Hello'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.conversationId, 'conv_456def');
        });

        test('extracts thread_id as sessionId from thread.started event', () => {
            const event = {
                type: 'thread.started',
                thread_id: 'thread_789xyz'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.sessionId, 'thread_789xyz');
        });

        test('uses thread_id as sessionId fallback when session_id is absent', () => {
            const event = {
                type: 'message',
                thread_id: 'thread_fallback',
                role: 'assistant',
                content: 'Test'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.sessionId, 'thread_fallback');
        });

        test('prefers session_id over thread_id', () => {
            const events = [
                { type: 'message', thread_id: 'thread_first', role: 'user', content: 'Hello' },
                { type: 'message', session_id: 'sess_preferred', role: 'assistant', content: 'Hi' }
            ];
            const stdout = events.map(e => JSON.stringify(e)).join('\n');

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.sessionId, 'sess_preferred');
        });

        test('extracts model from event', () => {
            const event = {
                type: 'message',
                model: 'codex-2025-01',
                role: 'assistant',
                content: 'Hello'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.model, 'codex-2025-01');
        });
    });

    describe('non-JSON line handling', () => {
        test('handles non-JSON lines gracefully', () => {
            const stdout = 'This is plain text output\nAnother line';

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(result.logs.includes('This is plain text output'));
            assert.ok(result.logs.includes('Another line'));
            assert.deepStrictEqual(result.conversationLog, []);
        });

        test('handles mixed JSON and non-JSON lines', () => {
            const lines = [
                'Starting execution...',
                JSON.stringify({ type: 'message', role: 'user', content: 'Hello' }),
                'Processing...',
                JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } })
            ];
            const stdout = lines.join('\n');

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(result.logs.includes('Starting execution...'));
            assert.ok(result.logs.includes('[user] Hello'));
            assert.ok(result.logs.includes('Processing...'));
            assert.ok(result.logs.includes('[Assistant] Done'));
            assert.strictEqual(result.conversationLog.length, 2);
        });

        test('handles malformed JSON gracefully', () => {
            const stdout = '{"type": "message", "content": invalid}';

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(result.logs.includes('{"type": "message", "content": invalid}'));
            assert.deepStrictEqual(result.conversationLog, []);
        });
    });

    describe('unknown event types', () => {
        test('handles unknown event types', () => {
            const event = {
                type: 'future.event.type',
                data: 'some data'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(result.logs.includes('[future.event.type]'));
            assert.strictEqual(result.conversationLog.length, 1);
        });

        test('handles event without type', () => {
            const event = {
                data: 'some data without type'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.ok(result.logs.includes('[unknown]'));
        });
    });

    describe('message and tool_use events', () => {
        test('parses message event with role', () => {
            const event = {
                type: 'message',
                role: 'user',
                content: 'Please help me fix this bug'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[user] Please help me fix this bug'));
        });

        test('parses message event without role', () => {
            const event = {
                type: 'message',
                content: 'Anonymous message'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[unknown] Anonymous message'));
        });

        test('parses tool_use event', () => {
            const event = {
                type: 'tool_use',
                tool: 'read_file',
                params: { path: '/src/index.ts' }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[Tool] read_file'));
            assert.ok(result.logs.includes('params:'));
            assert.ok(result.logs.includes('/src/index.ts'));
        });
    });

    describe('turn events', () => {
        test('parses turn.started event', () => {
            const event = {
                type: 'turn.started'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[turn.started]'));
        });

        test('parses turn.completed event', () => {
            const event = {
                type: 'turn.completed'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('[turn.completed]'));
        });
    });

    describe('complete stream scenarios', () => {
        test('parses a complete Codex execution stream', () => {
            const events = [
                { type: 'thread.started', thread_id: 'thread_abc123' },
                { type: 'turn.started' },
                { type: 'message', role: 'user', content: 'Fix the bug in auth.ts' },
                { type: 'item.started', item: { type: 'command_execution', command: 'cat src/auth.ts' } },
                { type: 'item.completed', item: { type: 'command_execution', command: 'cat src/auth.ts', aggregated_output: 'file contents...' } },
                { type: 'item.completed', item: { type: 'reasoning', text: 'I see the bug in line 42' } },
                { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'src/auth.ts', kind: 'modified' }] } },
                { type: 'item.completed', item: { type: 'agent_message', text: 'I fixed the authentication bug.' } },
                { type: 'turn.completed', usage: { input_tokens: 500, output_tokens: 200 } },
                { type: 'result', result: 'Success', status: 'success' }
            ];
            const stdout = events.map(e => JSON.stringify(e)).join('\n');

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.sessionId, 'thread_abc123');
            assert.strictEqual(result.result, 'Success');
            assert.deepStrictEqual(result.tokenUsage, { input_tokens: 500, output_tokens: 200 });
            assert.strictEqual(result.conversationLog.length, 10);
            assert.ok(result.logs.includes('[user] Fix the bug in auth.ts'));
            assert.ok(result.logs.includes('[Running] cat src/auth.ts'));
            assert.ok(result.logs.includes('[Reasoning] I see the bug in line 42'));
            assert.ok(result.logs.includes('[File Changes]'));
            assert.ok(result.logs.includes('[Assistant] I fixed the authentication bug.'));
        });

        test('parses a failed Codex execution stream', () => {
            const events = [
                { type: 'thread.started', thread_id: 'thread_failed' },
                { type: 'turn.started' },
                { type: 'message', role: 'user', content: 'Run npm test' },
                { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } },
                { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', aggregated_output: 'FAIL: 5 tests failed', exit_code: 1 } },
                { type: 'error', message: 'Tests failed with exit code 1' },
                { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }
            ];
            const stdout = events.map(e => JSON.stringify(e)).join('\n');

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, 'Tests failed with exit code 1');
            assert.ok(result.logs.includes('[Error] Tests failed with exit code 1'));
            assert.ok(result.logs.includes('FAIL: 5 tests failed'));
        });
    });

    describe('edge cases', () => {
        test('handles item.completed without item', () => {
            const event = {
                type: 'item.completed'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.success, true);
        });

        test('handles special characters in content', () => {
            const event = {
                type: 'message',
                role: 'assistant',
                content: 'Special chars: "quotes", \\backslash, \nnewline, \ttab'
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.ok(result.logs.includes('Special chars:'));
            assert.ok(result.logs.includes('"quotes"'));
        });

        test('handles unicode in content', () => {
            const event = {
                type: 'item.completed',
                item: {
                    type: 'agent_message',
                    text: 'Émoji: 🎉 and unicode: 你好'
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.result, 'Émoji: 🎉 and unicode: 你好');
        });

        test('handles very long output', () => {
            const longText = 'A'.repeat(10000);
            const event = {
                type: 'item.completed',
                item: {
                    type: 'agent_message',
                    text: longText
                }
            };
            const stdout = JSON.stringify(event);

            const result = parseCodexStreamOutput(stdout);

            assert.strictEqual(result.result, longText);
            assert.strictEqual(result.result?.length, 10000);
        });
    });
});
