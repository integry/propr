import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import { OpenCodeAgent } from '../packages/core/src/agents/impl/OpenCodeAgent.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

after(async () => {
    await closeConnection();
});

function createAgent(): OpenCodeAgent {
    const config: AgentConfig = {
        id: 'opencode-test',
        type: 'opencode',
        alias: 'open/code test',
        enabled: true,
        dockerImage: 'propr-opencode:latest',
        configPath: '/tmp/opencode-config',
        supportedModels: ['opencode-go/kimi-k2.6'],
        defaultModel: 'opencode-go/kimi-k2.6'
    };
    return new OpenCodeAgent(config);
}

function parseOutput(agent: OpenCodeAgent, output: string): { summary?: string; modelUsed?: string; sessionId?: string; error?: string } {
    return (agent as unknown as {
        parseOpenCodeJsonl(value: string): { summary?: string; modelUsed?: string; sessionId?: string; error?: string };
    }).parseOpenCodeJsonl(output);
}

function buildDockerArgs(agent: OpenCodeAgent, modelName: string): string[] {
    return (agent as unknown as {
        buildDockerArgs(params: { worktreePath: string; githubToken: string; modelName: string; issueNumber: number; taskId: string }): string[];
    }).buildDockerArgs({
        worktreePath: '/tmp/worktree',
        githubToken: 'token',
        modelName,
        issueNumber: 42,
        taskId: 'task-12345678'
    });
}

describe('OpenCodeAgent JSONL parsing', () => {
    test('collects text from original text part events', () => {
        const parsed = parseOutput(createAgent(), [
            JSON.stringify({ type: 'text', sessionID: 'session-a', model: 'opencode-go/kimi-k2.6', part: { type: 'text', text: 'hello ' } }),
            JSON.stringify({ type: 'text', part: { type: 'text', text: 'world' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'hello world');
        assert.strictEqual(parsed.sessionId, 'session-a');
        assert.strictEqual(parsed.modelUsed, 'opencode-go/kimi-k2.6');
    });

    test('collects text from assistant message and delta shapes', () => {
        const parsed = parseOutput(createAgent(), [
            JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'opencode-go/kimi-k2.6', content: 'first ' } }),
            JSON.stringify({ type: 'delta', delta: 'second' }),
            JSON.stringify({ type: 'message', message: { role: 'user', content: 'ignored' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'first second');
        assert.strictEqual(parsed.modelUsed, 'opencode-go/kimi-k2.6');
    });

    test('does not duplicate text when message and event-level content match', () => {
        const parsed = parseOutput(createAgent(), [
            JSON.stringify({ type: 'message', content: 'duplicate', message: { role: 'assistant', content: 'duplicate' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'duplicate');
    });

    test('recognizes mixed-case error event types and error payloads', () => {
        const parsed = parseOutput(createAgent(), [
            JSON.stringify({ type: 'Message', message: { role: 'assistant', model: 'initial/model', content: 'partial' } }),
            JSON.stringify({ type: 'ERROR', model: 'final/model', error: { data: { message: 'rate limited' } } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'partial');
        assert.strictEqual(parsed.error, 'rate limited');
        assert.strictEqual(parsed.modelUsed, 'final/model');
    });

    test('uses non-json stdout as fallback text', () => {
        const parsed = parseOutput(createAgent(), 'plain response\n');

        assert.strictEqual(parsed.summary, 'plain response');
    });

    test('handles empty output', () => {
        const parsed = parseOutput(createAgent(), '');

        assert.strictEqual(parsed.summary, undefined);
        assert.strictEqual(parsed.modelUsed, undefined);
        assert.strictEqual(parsed.sessionId, undefined);
        assert.strictEqual(parsed.error, undefined);
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
});
