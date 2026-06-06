import { after, describe, test } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

const { parseOpenCodeJsonl } = await import('../packages/core/src/agents/impl/openCodeUtils.js');
const { parseOpenCodeOutputToConversationResult } = await import('../packages/api/routes/liveDetailsOpenCodeParser.ts');
const { parseStoredOutputContent } = await import('../packages/api/routes/liveDetailsRoutes.ts');
const { parseRedisOutput } = await import('../packages/api/services/redisOutputParser.ts');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { closeConnection: closeDistConnection } = await import('@propr/core');

after(async () => {
    await closeConnection();
    await closeDistConnection();
});

const opencodeToolLine = JSON.stringify({
    type: 'tool_use',
    timestamp: 1767036061199,
    sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
    part: {
        id: 'prt_tool',
        sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
        messageID: 'msg_1',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: {
            status: 'completed',
            input: { command: 'echo hello', description: 'Print hello' },
            output: 'hello\n',
            metadata: { output: 'hello\n', exit: 0 },
        },
    },
});

const opencodeStepFinishLine = JSON.stringify({
    type: 'step_finish',
    timestamp: 1767036064273,
    sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
    part: {
        id: 'prt_finish',
        type: 'step-finish',
        reason: 'stop',
        tokens: {
            input: 671,
            output: 8,
            cache: { read: 21415, write: 3 },
        },
    },
});

describe('OpenCode live details parsing', () => {
    test('parses actual OpenCode tool state and step token payloads from stored output', () => {
        const result = parseOpenCodeOutputToConversationResult([
            JSON.stringify({
                type: 'text',
                timestamp: 1767036064268,
                sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
                part: { type: 'text', text: 'OpenCode answer' },
            }),
            opencodeToolLine,
            opencodeStepFinishLine,
        ].join('\n'));

        assert.deepStrictEqual(result?.events, [
            { type: 'thought', content: 'OpenCode answer', timestamp: '2025-12-29T19:21:04.268Z' },
            {
                type: 'tool_use',
                toolName: 'bash',
                input: { command: 'echo hello', description: 'Print hello' },
                id: 'call_1',
                timestamp: '2025-12-29T19:21:01.199Z',
            },
            {
                type: 'tool_result',
                toolUseId: 'call_1',
                result: 'hello\n',
                isError: false,
                timestamp: '2025-12-29T19:21:01.199Z',
            },
        ]);
        assert.deepStrictEqual(result?.tokenUsage, {
            input_tokens: 671,
            output_tokens: 8,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 21415,
        });
    });

    test('parses OpenCode tool failures as error tool results', () => {
        const result = parseOpenCodeOutputToConversationResult(JSON.stringify({
            type: 'tool_use',
            timestamp: 1767036061199,
            sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
            part: {
                type: 'tool',
                callID: 'call_2',
                tool: 'bash',
                state: {
                    status: 'error',
                    input: { command: 'exit 1' },
                    error: { message: 'command failed' },
                    metadata: { exit: 1 },
                },
            },
        }));

        assert.deepStrictEqual(result?.events, [
            {
                type: 'tool_use',
                toolName: 'bash',
                input: { command: 'exit 1' },
                id: 'call_2',
                timestamp: '2025-12-29T19:21:01.199Z',
            },
            {
                type: 'tool_result',
                toolUseId: 'call_2',
                result: 'command failed',
                isError: true,
                timestamp: '2025-12-29T19:21:01.199Z',
            },
        ]);
    });

    test('emits confirmed assistant envelopes as message events', () => {
        const result = parseOpenCodeOutputToConversationResult(JSON.stringify({
            type: 'message',
            timestamp: '2026-05-05T00:00:00.000Z',
            message: { role: 'assistant', content: 'Final answer' },
        }));

        assert.deepStrictEqual(result?.events, [
            { type: 'message', content: 'Final answer', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('filters generic OpenCode tool events without a tool name or id', () => {
        const result = parseOpenCodeOutputToConversationResult(JSON.stringify({
            type: 'tool',
            timestamp: '2026-05-05T00:00:00.000Z',
            state: { status: 'pending' },
        }));

        assert.strictEqual(result, null);
    });

    test('recognizes actual OpenCode output in stored output detection', () => {
        const parsed = parseStoredOutputContent([opencodeToolLine, opencodeStepFinishLine].join('\n'));

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.tokenUsage, {
            input_tokens: 671,
            output_tokens: 8,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 21415,
        });
    });

    test('recognizes OpenCode assistant parts without session identifiers', () => {
        const parsed = parseStoredOutputContent(JSON.stringify({
            type: 'message',
            message: { role: 'assistant', parts: [{ type: 'text', text: 'OpenCode assistant parts' }] },
            timestamp: '2026-05-05T00:00:00.000Z',
        }));

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'message', content: 'OpenCode assistant parts', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('parses actual OpenCode tool and token events from Redis output', () => {
        const result = parseRedisOutput([opencodeToolLine, opencodeStepFinishLine]);

        assert.deepStrictEqual(result.events, [
            {
                type: 'tool_use',
                toolName: 'bash',
                input: { command: 'echo hello', description: 'Print hello' },
                id: 'call_1',
                timestamp: '2025-12-29T19:21:01.199Z',
            },
            {
                type: 'tool_result',
                toolUseId: 'call_1',
                result: 'hello\n',
                isError: false,
                timestamp: '2025-12-29T19:21:01.199Z',
            },
        ]);
        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 671,
            output_tokens: 8,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 21415,
        });
    });

    test('deduplicates Redis OpenCode tool updates and keeps sessionless tool events', () => {
        const sessionlessToolLine = JSON.stringify({
            type: 'tool',
            timestamp: 1767036061199,
            callID: 'call_sessionless',
            tool: 'bash',
            state: {
                status: 'completed',
                input: { command: 'pwd' },
                output: '/repo\n',
                metadata: { output: '/repo\n', exit: 0 },
            },
        });
        const result = parseRedisOutput([opencodeToolLine, opencodeToolLine, sessionlessToolLine]);

        assert.deepStrictEqual(result.events, [
            {
                type: 'tool_use',
                toolName: 'bash',
                input: { command: 'echo hello', description: 'Print hello' },
                id: 'call_1',
                timestamp: '2025-12-29T19:21:01.199Z',
            },
            {
                type: 'tool_result',
                toolUseId: 'call_1',
                result: 'hello\n',
                isError: false,
                timestamp: '2025-12-29T19:21:01.199Z',
            },
            {
                type: 'tool_use',
                toolName: 'bash',
                input: { command: 'pwd' },
                id: 'call_sessionless',
                timestamp: '2025-12-29T19:21:01.199Z',
            },
            {
                type: 'tool_result',
                toolUseId: 'call_sessionless',
                result: '/repo\n',
                isError: false,
                timestamp: '2025-12-29T19:21:01.199Z',
            },
        ]);
    });

    test('keeps OpenCode nested response usage even without text content', () => {
        const result = parseRedisOutput([
            JSON.stringify({
                type: 'message',
                sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
                response: { usage: { cache_read_input_tokens: 3 } },
            }),
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3,
        });
    });

    test('core OpenCode parser reads reasoning and step-finish token payloads', () => {
        const parsed = parseOpenCodeJsonl([
            JSON.stringify({
                type: 'reasoning',
                sessionID: 'ses_494719016ffe85dkDMj0FPRbHK',
                part: { type: 'reasoning', text: 'checking files' },
            }),
            opencodeStepFinishLine,
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'checking files');
        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 671,
            output_tokens: 8,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 21415,
        });
    });
});
