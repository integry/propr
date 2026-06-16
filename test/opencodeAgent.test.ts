import { after, afterEach, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeAgent } from '../packages/core/src/agents/impl/OpenCodeAgent.js';
import { buildOpenCodeDockerArgs, buildOpenCodePrompt, isOpenCodeJsonlEvent, normalizeOpenCodeCliModelName, parseOpenCodeJsonl, parseOpenCodeStreamOutput, shouldForwardEnvVar, toOpenCodeExternalModelId, toProprOpenCodeExternalModelId, toProprOpenCodeModelId, toOpenCodeGoOpenRouterId } from '../packages/core/src/agents/impl/openCodeUtils.js';
import { normalizeOpenCodeTimestamp } from '../packages/core/src/agents/impl/openCodeTimestamp.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentConfig, TokenUsage } from '../packages/core/src/agents/types.js';

after(async () => {
    await closeConnection();
});

afterEach(() => {
    delete process.env.HOST_OPENCODE_DATA_DIR;
});

function createAgent(): OpenCodeAgent {
    const config: AgentConfig = {
        id: 'opencode-test',
        type: 'opencode',
        alias: 'open/code test',
        enabled: true,
        dockerImage: 'propr/agent-opencode:latest',
        configPath: '/tmp/opencode-config',
        supportedModels: ['opencode-minimax-m3-free'],
        defaultModel: 'opencode-minimax-m3-free'
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
    test('exposes parseOpenCodeStreamOutput as the stream parser alias', () => {
        const output = JSON.stringify({ type: 'text', text: 'hello from opencode' });

        assert.deepStrictEqual(parseOpenCodeStreamOutput(output), parseOpenCodeJsonl(output));
    });

    test('collects text from original text part events', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'text', sessionID: 'session-a', model: 'opencode/minimax-m3-free', part: { type: 'text', text: 'hello ' } }),
            JSON.stringify({ type: 'text', part: { type: 'text', text: 'world' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'hello world');
        assert.strictEqual(parsed.sessionId, 'session-a');
        assert.strictEqual(parsed.modelUsed, 'opencode-minimax-m3-free');
    });

    test('prefers assistant message text over unrelated delta shapes', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'opencode/minimax-m3-free', content: 'first ' } }),
            JSON.stringify({ type: 'delta', delta: 'second' }),
            JSON.stringify({ type: 'message', message: { role: 'user', content: 'ignored' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'first');
        assert.strictEqual(parsed.modelUsed, 'opencode-minimax-m3-free');
    });

    test('does not duplicate text when message and event-level content match', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', content: 'duplicate', message: { role: 'assistant', content: 'duplicate' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'duplicate');
    });

    test('does not treat user-owned top-level parts as assistant text', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', sessionID: 'session-a', part: { type: 'text', text: 'hidden' }, message: { role: 'user', content: 'user text' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, undefined);
    });

    test('recognizes mixed-case error event types and error payloads', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'Message', message: { role: 'assistant', model: 'initial/model', content: 'partial' } }),
            JSON.stringify({ type: 'ERROR', model: 'final/model', error: { data: { message: 'rate limited' } } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'partial');
        assert.strictEqual(parsed.error, 'rate limited');
        assert.strictEqual(parsed.modelUsed, 'opencode-initial/model');
    });

    test('parses OpenCode provider/server error streams', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'error', timestamp: 1780743353227, sessionID: 'ses_1636ccd92ffeqefe412qL8ll1f', error: { name: 'UnknownError', data: { message: '' } } }),
            JSON.stringify({ type: 'error', timestamp: 1780743353241, sessionID: 'ses_1636ccd92ffeqefe412qL8ll1f', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_12358dd0' } } })
        ].join('\n'));

        assert.strictEqual(parsed.sessionId, 'ses_1636ccd92ffeqefe412qL8ll1f');
        assert.strictEqual(parsed.error, 'Unexpected server error. Check server logs for details.');
    });

    test('prefers the final assistant message over duplicate streaming deltas', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'delta', delta: 'hello ' }),
            JSON.stringify({ type: 'delta', delta: 'world' }),
            JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'opencode/minimax-m3-free', content: 'hello world' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'hello world');
        assert.strictEqual(parsed.modelUsed, 'opencode-minimax-m3-free');
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

    test('collects assistant text from response containers', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', sessionID: 'session-a', response: { text: 'response text' } })
        ].join('\n'));

        assert.strictEqual(parsed.summary, 'response text');
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

    test('normalizes token usage from numeric strings', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'result', sessionID: 'session-a', usage: { input_tokens: '100', output_tokens: '25', cache_creation_input_tokens: '5', cache_read_input_tokens: '10' } })
        ].join('\n'));

        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 100,
            output_tokens: 25,
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

    test('sums increasing per-event top-level usage outside result snapshots', () => {
        const parsed = parseOutput([
            JSON.stringify({ type: 'message', sessionID: 'session-a', usage: { input_tokens: 10, output_tokens: 2 } }),
            JSON.stringify({ type: 'message', sessionID: 'session-a', usage: { input_tokens: 18, output_tokens: 5, cache_read_input_tokens: 4 } })
        ].join('\n'));

        assert.deepStrictEqual(parsed.tokenUsage, {
            input_tokens: 28,
            output_tokens: 7,
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
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', sessionID: 'session-a' }), false);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', sessionId: 'session-a', message: { role: 'assistant', content: 'hello' } }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'text', text: 'OpenCode text' }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'result', usage: { input_tokens: 10 } }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'result', stats: { input_tokens: 10 } }), false);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'result', sessionID: 'session-a', stats: { input_tokens: 10 } }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'tool_use', stats: { input_tokens: 10 } }), false);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'tool_use', sessionID: 'session-a', tool_name: 'Shell' }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'tool_use', session_id: 'session-a', tool_name: 'Shell' }), true);
        assert.strictEqual(isOpenCodeJsonlEvent({ type: 'message', sessionID: 'session-a', response: { text: 'hello' } }), true);
    });

    test('normalizes numeric OpenCode timestamps in seconds and milliseconds', () => {
        assert.strictEqual(normalizeOpenCodeTimestamp(1714867200, 'fallback'), '2024-05-05T00:00:00.000Z');
        assert.strictEqual(normalizeOpenCodeTimestamp(1714867200000, 'fallback'), '2024-05-05T00:00:00.000Z');
        assert.strictEqual(normalizeOpenCodeTimestamp(Number.NaN, 'fallback'), 'fallback');
        assert.strictEqual(normalizeOpenCodeTimestamp('not-a-date', 'fallback'), 'fallback');
    });
});

describe('toOpenCodeGoOpenRouterId', () => {
    test('derives OpenRouter slug for opencode-go models by provider prefix', () => {
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/deepseek-v4-pro'), 'deepseek/deepseek-v4-pro');
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/mimo-v2.5-pro'), 'xiaomi/mimo-v2.5-pro');
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/minimax-m3'), 'minimax/minimax-m3');
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/glm-5.1'), 'z-ai/glm-5.1');
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/kimi-k2.6'), 'moonshotai/kimi-k2.6');
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/qwen3.7-max'), 'qwen/qwen3.7-max');
    });

    test('strips an optional opencode: route prefix', () => {
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode:opencode-go/deepseek-v4-flash'), 'deepseek/deepseek-v4-flash');
    });

    test('returns null for non-opencode-go ids and unknown providers', () => {
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-minimax-m3-free'), null);
        assert.strictEqual(toOpenCodeGoOpenRouterId('claude-opus-4-8'), null);
        assert.strictEqual(toOpenCodeGoOpenRouterId('opencode-go/unknownprovider-1'), null);
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
    test('normalizes model names for the OpenCode CLI', () => {
        const agent = createAgent();
        const routedArgs = buildDockerArgs(agent, 'opencode:provider:model');
        const openAiArgs = buildDockerArgs(agent, 'openai/gpt-5.5');
        const goArgs = buildDockerArgs(agent, 'opencode-go/qwen3.7-max');
        const freeArgs = buildDockerArgs(agent, 'opencode-minimax-m3-free');

        assert.strictEqual(routedArgs[routedArgs.indexOf('--model') + 1], 'provider:model');
        assert.strictEqual(openAiArgs[openAiArgs.indexOf('--model') + 1], 'openai/gpt-5.5');
        assert.strictEqual(goArgs[goArgs.indexOf('--model') + 1], 'opencode-go/qwen3.7-max');
        assert.strictEqual(freeArgs[freeArgs.indexOf('--model') + 1], 'opencode/minimax-m3-free');
        assert.strictEqual(normalizeOpenCodeCliModelName('opencode-openai/gpt-5.5'), 'openai/gpt-5.5');
        assert.strictEqual(normalizeOpenCodeCliModelName('opencode:openai/gpt-5.5'), 'openai/gpt-5.5');
        assert.strictEqual(toProprOpenCodeModelId('openai/gpt-5.5'), 'opencode-openai/gpt-5.5');
        assert.strictEqual(toProprOpenCodeModelId('opencode/minimax-m3-free'), 'opencode-minimax-m3-free');
        assert.strictEqual(toProprOpenCodeModelId('opencode-go/qwen3.7-max'), 'opencode-go/qwen3.7-max');
        assert.strictEqual(toProprOpenCodeExternalModelId('opencode-openai/gpt-5.5'), 'opencode-openai/gpt-5.5');
        assert.strictEqual(toOpenCodeExternalModelId('opencode-openai/gpt-5.5'), 'openai/gpt-5.5');
        assert.strictEqual(toOpenCodeExternalModelId('opencode-minimax-m3-free'), 'opencode/minimax-m3-free');
        assert.ok(routedArgs.includes('--name'));
        assert.match(routedArgs[routedArgs.indexOf('--name') + 1], /^open-code-test-issue-42-opencode-provider-model-12345678$/);
        assert.match(openAiArgs[openAiArgs.indexOf('--name') + 1], /openai-gpt-5.5-12345678$/);
        assert.match(goArgs[goArgs.indexOf('--name') + 1], /opencode-go-qwen3.7-max-12345678$/);
        assert.ok(routedArgs.includes('--dangerously-skip-permissions'));
    });

    test('uses opencode-run wrapper and JSON output mode', () => {
        const args = buildDockerArgs(createAgent(), 'opencode-minimax-m3-free');
        const imageIndex = args.indexOf('propr/agent-opencode:latest');

        assert.ok(imageIndex > -1);
        assert.ok(args.includes('opencode-run'));
        assert.strictEqual(args[args.indexOf('--format') + 1], 'json');
    });

    test('honours a read-only workspace mount while keeping OpenCode config writable', () => {
        const args = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 0,
            readOnlyWorkspace: true,
            configPath: '/tmp/opencode-analysis-config-test',
            ensureConfigPath: () => undefined
        });

        assert.ok(args.includes('-v'));
        assert.ok(args.includes('/tmp/worktree:/home/node/workspace:ro'));
        assert.ok(args.includes('/tmp/opencode-analysis-config-test:/home/node/.config/opencode:rw'));
    });

    test('analysis uses the same opencode-run wrapper path as task execution', () => {
        const analysisArgs = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 0,
            modelName: 'opencode-openai/gpt-5.5',
            configPath: '/tmp/opencode-analysis-config-test',
            ensureConfigPath: () => undefined
        });

        // No bespoke "direct" shell mode any more — one wrapper for everything.
        assert.ok(!analysisArgs.includes('/bin/sh'));
        assert.ok(analysisArgs.includes('opencode-run'));
        assert.ok(analysisArgs.includes('--dangerously-skip-permissions'));
        assert.ok(analysisArgs.includes('/tmp/worktree:/home/node/workspace:ro'));
        assert.strictEqual(analysisArgs[analysisArgs.indexOf('--format') + 1], 'json');
        assert.strictEqual(analysisArgs[analysisArgs.indexOf('--title') + 1], 'ProPR analysis');
        assert.strictEqual(analysisArgs[analysisArgs.indexOf('--model') + 1], 'openai/gpt-5.5');
    });

    test('can mount real OpenCode data alongside an analysis config snapshot', () => {
        const args = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 0,
            readOnlyWorkspace: false,
            configPath: '/tmp/opencode-analysis-config-test',
            dataPath: '/tmp/opencode-real-data-test',
            ensureConfigPath: () => undefined
        });

        assert.ok(args.includes('/tmp/opencode-analysis-config-test:/home/node/.config/opencode:rw'));
        assert.ok(args.includes('/tmp/opencode-real-data-test:/home/node/.local/share/opencode:rw'));
    });

    test('infers default OpenCode auth data mount from the saved XDG config path', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'));
        const configPath = path.join(home, '.config/opencode');
        const dataPath = path.join(home, '.local/share/opencode');
        fs.mkdirSync(dataPath, { recursive: true });
        const agent = createAgent();
        agent.config.configPath = configPath;

        const args = buildDockerArgs(agent, 'opencode-minimax-m3-free');

        assert.ok(args.includes(`${dataPath}:/home/node/.local/share/opencode:rw`));
        assert.strictEqual(args[args.lastIndexOf('-e') + 1], 'XDG_DATA_HOME=/home/node/.local/share');
        fs.rmSync(home, { recursive: true, force: true });
    });

    test('uses HOST_OPENCODE_DATA_DIR as a writable analysis state mount', () => {
        process.env.HOST_OPENCODE_DATA_DIR = '/host/opencode-data';
        const args = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 0,
            readOnlyWorkspace: true,
            configPath: '/tmp/opencode-analysis-config-test',
            ensureConfigPath: () => undefined
        });

        assert.ok(args.includes('/host/opencode-data:/home/node/.local/share/opencode:rw'));
    });

    test('opencode-run keeps prompt attachment separate from the final message', () => {
        const script = fs.readFileSync(path.join(process.cwd(), 'scripts/opencode-run.sh'), 'utf8');

        assert.match(script, /opencode run "\$@" --file "\$prompt_file" -- "The attached file is the trusted user prompt for this non-interactive CLI run\. Follow the instructions in that file exactly\."/);
    });

    test('always skips permissions for isolated non-interactive runs, like the other agents', () => {
        const taskArgs = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 42,
            ensureConfigPath: () => undefined
        });
        const analysisArgs = buildOpenCodeDockerArgs({
            config: createAgent().config,
            worktreePath: '/tmp/worktree',
            githubToken: 'token',
            issueNumber: 0,
            ensureConfigPath: () => undefined
        });

        assert.ok(taskArgs.includes('--dangerously-skip-permissions'));
        assert.ok(analysisArgs.includes('--dangerously-skip-permissions'));
    });

    test('filters unsafe and GitHub credential env vars before forwarding to the container', () => {
        const config = createAgent().config;
        config.envVars = {
            SAFE_VAR: 'keep-me',
            GH_TOKEN: 'leaked-secret',
            GITHUB_API_URL: 'https://github.enterprise.example',
            GITHUB_PAT: 'leaked-secret',
            OPENCODE_CONFIG_DIR: '/tmp/override',
            'bad-name': 'nope',
            MULTILINE: 'line1\nline2'
        };
        const args = buildOpenCodeDockerArgs({
            config,
            worktreePath: '/tmp/worktree',
            githubToken: 'scoped-token',
            issueNumber: 42,
            ensureConfigPath: () => undefined
        });
        const envValues = args.filter((_, i) => args[i - 1] === '-e');

        // The user-configured safe var is forwarded.
        assert.ok(envValues.includes('SAFE_VAR=keep-me'));
        assert.ok(envValues.includes('GITHUB_API_URL=https://github.enterprise.example'));
        // The scoped token is still injected (token removal is deferred), but the
        // user-supplied GH_TOKEN value is never forwarded.
        assert.ok(envValues.includes('GH_TOKEN=scoped-token'));
        assert.ok(!envValues.includes('GH_TOKEN=leaked-secret'));
        // Credential-like GitHub vars, reserved wrapper vars, invalid names, and
        // multiline values are dropped entirely.
        assert.ok(!envValues.some(v => v.startsWith('GITHUB_PAT=')));
        assert.ok(!envValues.includes('OPENCODE_CONFIG_DIR=/tmp/override'));
        assert.ok(!envValues.some(v => v.startsWith('bad-name=')));
        assert.ok(!envValues.some(v => v.startsWith('MULTILINE=')));
    });

    test('shouldForwardEnvVar enforces name, credential, and value rules', () => {
        assert.ok(shouldForwardEnvVar('OPENROUTER_API_KEY', 'sk-123'));
        assert.ok(shouldForwardEnvVar('GITHUB_API_URL', 'https://github.enterprise.example'));
        assert.ok(!shouldForwardEnvVar('GH_TOKEN', 'x'));
        assert.ok(!shouldForwardEnvVar('GITHUB_TOKEN', 'x'));
        assert.ok(!shouldForwardEnvVar('GITHUB_PAT', 'x'));
        assert.ok(!shouldForwardEnvVar('GITHUB_APP_PRIVATE_KEY', 'x'));
        assert.ok(!shouldForwardEnvVar('XDG_DATA_HOME', '/tmp/data'));
        assert.ok(!shouldForwardEnvVar('1INVALID', 'x'));
        assert.ok(!shouldForwardEnvVar('has space', 'x'));
        assert.ok(!shouldForwardEnvVar('OK', 'line1\nline2'));
        assert.ok(!shouldForwardEnvVar('OK', 'has\0nul'));
    });

    test('enforces a configurable prompt size cap in opencode-run.sh', () => {
        const script = fs.readFileSync(path.join(process.cwd(), 'scripts/opencode-run.sh'), 'utf8');

        assert.match(script, /OPENCODE_PROMPT_MAX_BYTES:-20971520/);
        assert.match(script, /expected an integer byte limit/);
        assert.match(script, /exceeding OPENCODE_PROMPT_MAX_BYTES/);
    });

    test('prevents duplicate opencode- prefix on round-trip conversions', () => {
        assert.strictEqual(toProprOpenCodeModelId('opencode-openai/gpt-5.5'), 'opencode-openai/gpt-5.5');
        assert.strictEqual(toProprOpenCodeModelId('opencode-minimax-m3-free'), 'opencode-minimax-m3-free');
        assert.strictEqual(toProprOpenCodeModelId('opencode:opencode-openai/gpt-5.5'), 'opencode-openai/gpt-5.5');
        assert.strictEqual(toProprOpenCodeExternalModelId('opencode-openai/gpt-5.5'), 'opencode-openai/gpt-5.5');
        assert.strictEqual(toProprOpenCodeExternalModelId('opencode-minimax-m3-free'), 'opencode-minimax-m3-free');

        // Repeated normalization should be idempotent
        const once = toProprOpenCodeModelId('openai/gpt-5.5');
        const twice = toProprOpenCodeModelId(once);
        const thrice = toProprOpenCodeModelId(twice);
        assert.strictEqual(once, 'opencode-openai/gpt-5.5');
        assert.strictEqual(twice, 'opencode-openai/gpt-5.5');
        assert.strictEqual(thrice, 'opencode-openai/gpt-5.5');
    });
});
