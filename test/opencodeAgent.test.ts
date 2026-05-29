import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { OpenCodeAgent } from '../packages/core/src/agents/impl/OpenCodeAgent.js';
import { buildOpenCodeDockerArgs, buildOpenCodePrompt, isOpenCodeJsonlEvent, parseOpenCodeJsonl } from '../packages/core/src/agents/impl/openCodeUtils.js';
import { normalizeOpenCodeTimestamp } from '../packages/core/src/agents/impl/openCodeTimestamp.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentConfig, TokenUsage } from '../packages/core/src/agents/types.js';

after(async () => {
    await closeConnection();
});

function createAgent(): OpenCodeAgent {
    const config: AgentConfig = {
        id: 'opencode-test',
        type: 'opencode',
        alias: 'open/code test',
        enabled: true,
        dockerImage: 'propr/agent-opencode:latest',
        configPath: '/tmp/opencode-config',
        supportedModels: ['opencode-go/kimi-k2.6'],
        defaultModel: 'opencode-go/kimi-k2.6'
    };
    return new OpenCodeAgent(config);
}

function parseOutput(output: string): { summary?: string; modelUsed?: string; sessionId?: string; error?: string; tokenUsage?: TokenUsage } {
    return parseOpenCodeJsonl(output);
}

function buildDockerArgs(agent: OpenCodeAgent, modelName: string): string[] {
    return buildOpenCodeDockerArgs({
        config: agent.config,
        worktreePath: '/tmp/worktree',
        githubToken: 'token',
        modelName,
        issueNumber: 42,
        taskId: 'task-12345678',
        ensureConfigPath: () => undefined
    });
}

describe('OpenCodeAgent JSONL parsing', () => {
    test('collects text from original text part events', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'text', sessionID: 'session-a', model: 'opencode-go/kimi-k2.6', part: { type: 'text', text: 'hello ' } }),
            JSON.stringify({ type: 'text', part: { type: 'text', text: 'world' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'hello world');
        assert.strictEqual(parsed.sessionId, 'session-a');
        assert.strictEqual(parsed.modelUsed, 'opencode-go/kimi-k2.6');
    });

    test('prefers assistant message text over unrelated delta shapes', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'opencode-go/kimi-k2.6', content: 'first ' } }),
            JSON.stringify({ type: 'delta', delta: 'second' }),
            JSON.stringify({ type: 'message', message: { role: 'user', content: 'ignored' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'first');
        assert.strictEqual(parsed.modelUsed, 'opencode-go/kimi-k2.6');
    });

    test('does not duplicate text when message and event-level content match', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', content: 'duplicate', message: { role: 'assistant', content: 'duplicate' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'duplicate');
    });

    test('recognizes mixed-case error event types and error payloads', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'Message', message: { role: 'assistant', model: 'initial/model', content: 'partial' } }),
            JSON.stringify({ type: 'ERROR', model: 'final/model', error: { data: { message: 'rate limited' } } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'partial');
        assert.strictEqual(parsed.error, 'rate limited');
        assert.strictEqual(parsed.modelUsed, 'initial/model');
    });

    test('prefers the final assistant message over duplicate streaming deltas', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'delta', delta: 'hello ' }),
            JSON.stringify({ type: 'delta', delta: 'world' }),
            JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'opencode-go/kimi-k2.6', content: 'hello world' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'hello world');
        assert.strictEqual(parsed.modelUsed, 'opencode-go/kimi-k2.6');
    });

    test('preserves repeated stream text from separate events', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'delta', delta: 'retry ' }),
            JSON.stringify({ type: 'delta', delta: 'retry ' }),
            JSON.stringify({ type: 'delta', delta: 'done' })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'retry retry done');
    });

    test('deduplicates duplicate text fields only within one event container', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'text', text: 'once ', content: 'once ' }),
            JSON.stringify({ type: 'text', text: 'again' })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'once again');
    });

    test('uses non-json stdout as fallback text', () => {
        const parsed = parseOutput('plain response\n');

        assert.strictEqual(parsed.summary, 'plain response');
    });

    test('handles empty output', () => {
        const parsed = parseOutput('');

        assert.strictEqual(parsed.summary, undefined);
        assert.strictEqual(parsed.modelUsed, undefined);
        assert.strictEqual(parsed.sessionId, undefined);
        assert.strictEqual(parsed.error, undefined);
    });

    test('normalizes token usage from common output shapes', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'result', usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 10 }, stats: { inputTokens: 90, outputTokens: 30, cacheCreationInputTokens: 5 } })
        ].join('\n'));

        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 100,
            output_tokens: 30,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 10
        });
    });

    test('aggregates per-message token usage', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', sessionID: 'session-a', message: { role: 'assistant', content: 'first', usage: { input_tokens: 10, output_tokens: 2 } } }),
            JSON.stringify({ type: 'message', sessionID: 'session-a', message: { role: 'assistant', content: 'second', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 4 } } })
        ].join('\n'));

        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 17,
            output_tokens: 5,
            cache_read_input_tokens: 4
        });
    });

    test('does not overcount cumulative top-level usage snapshots', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'result', sessionID: 'session-a', usage: { input_tokens: 10, output_tokens: 2 } }),
            JSON.stringify({ type: 'result', sessionID: 'session-a', usage: { input_tokens: 18, output_tokens: 5, cache_read_input_tokens: 4 } })
        ].join('\n'));

        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 18,
            output_tokens: 5,
            cache_read_input_tokens: 4
        });
    });

    test('does not double count final top-level usage after nested usage', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', sessionID: 'session-a', message: { role: 'assistant', content: 'first', usage: { input_tokens: 10, output_tokens: 2 } } }),
            JSON.stringify({ type: 'message', sessionID: 'session-a', message: { role: 'assistant', content: 'second', usage: { input_tokens: 8, output_tokens: 3 } } }),
            JSON.stringify({ type: 'result', sessionID: 'session-a', usage: { input_tokens: 18, output_tokens: 5 } })
        ].join('\n'));

        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 18,
            output_tokens: 5
        });
    });

    test('keeps generic stream envelopes out of OpenCode detection', () => {
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', sessionId: 'generic-session', message: { content: 'hello' } }), false);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', session_id: 'generic-session', message: { content: 'hello' } }), false);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', message: { parts: [] } }), false);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', sessionId: 'session-a', message: { role: 'assistant', content: 'hello' } }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'text', text: 'OpenCode text' }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'result', usage: { input_tokens: 10 } }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'result', stats: { input_tokens: 10 } }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'tool_use', stats: { input_tokens: 10 } }), false);
    });

    test('normalizes numeric OpenCode timestamps in seconds and milliseconds', () => {
        assert.strictEqual(normalizeOpenCodeTimestamp(1714867200, 'fallback'), '2024-05-05T00:00:00.000Z');
        assert.strictEqual(normalizeOpenCodeTimestamp(1714867200000, 'fallback'), '2024-05-05T00:00:00.000Z');
        assert.strictEqual(normalizeOpenCodeTimestamp(Number.NaN, 'fallback'), 'fallback');
    });
});

describe('OpenCodeAgent prompt building', () => {
    test('includes system instructions, safety rules, and retry context', () => {
        const prompt = buildOpenCodePrompt({
            customPrompt: 'Implement the change.',
            issueRef: { repoOwner: 'integry', repoName: 'propr', number: 1482 },
            systemPrompt: 'Use the local conventions.',
            isRetry: true,
            retryReason: 'tests failed'
        });

        assert.match(prompt, /SYSTEM INSTRUCTIONS:\nUse the local conventions\./);
        assert.match(prompt, /CRITICAL GIT SAFETY RULES/);
        assert.match(prompt, /RETRY CONTEXT/);
    });
});

describe('OpenCodeAgent Docker args', () => {
    test('only strips the opencode route prefix from model names', () => {
        const agent = createAgent();
        const routedArgs = buildDockerArgs(agent, 'opencode:provider:model');
        const qualifiedArgs = buildDockerArgs(agent, 'provider:model');

        assert.strictEqual(routedArgs[routedArgs.indexOf('--model') + 1], 'provider:model');
        assert.strictEqual(qualifiedArgs[qualifiedArgs.indexOf('--model') + 1], 'provider:model');
        assert.ok(routedArgs.includes('--name'));
        assert.match(routedArgs[routedArgs.indexOf('--name') + 1], /^open-code-test-issue-42-12345678$/);
        assert.ok(routedArgs.includes('--dangerously-skip-permissions'));
    });

    test('can mount a temporary config path for read-only analysis', () => {
        const args = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 0,
            readOnlyWorkspace: true,
            allowDangerousPermissions: false,
            configPath: '/tmp/opencode-analysis-config-test',
            ensureConfigPath: () => undefined
        });

        assert.ok(args.includes('-v'));
        assert.ok(args.includes('/tmp/worktree:/home/node/workspace:ro'));
        assert.ok(args.includes('/tmp/opencode-analysis-config-test:/home/node/.config/opencode:ro'));
        assert.ok(!args.includes('--dangerously-skip-permissions'));
    });
});
