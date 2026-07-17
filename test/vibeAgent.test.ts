import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VibeAgent, getMistralApiKeyFromSettings, parseVibeConversationLog, parseVibeOutput, readLatestVibeSessionTokenUsage } from '../packages/core/src/agents/impl/VibeAgent.js';
import { executeDockerCommand } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { getForwardedVibeEnvVars, isSuccessfulVibeResult, splitVibeCliArgs } from '../packages/core/src/agents/impl/utils/vibeAgentHelpers.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

const envKeys = ['MISTRAL_API_KEY', 'VIBE_CLI_ARGS', 'VIBE_CONFIG_PATH'] as const;

function withRestoredEnv(run: () => void): void {
    const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    try {
        run();
    } finally {
        for (const key of envKeys) {
            const value = previous[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function createAgent(overrides: Partial<AgentConfig> = {}): VibeAgent {
    return new VibeAgent({
        id: 'vibe-test',
        type: 'vibe',
        alias: 'vibe-test',
        enabled: true,
        dockerImage: 'propr/agent:bundle-test',
        configPath: '/tmp/missing-vibe-config',
        supportedModels: ['mistral-medium-3.5'],
        defaultModel: 'mistral-medium-3.5',
        ...overrides
    } satisfies AgentConfig);
}

function buildArgs(agent: VibeAgent, params: {
    worktreePath?: string;
    githubToken?: string;
    modelName?: string;
    issueNumber?: number;
    taskId?: string;
    executionType?: string;
    maxTurns?: number;
    mode?: 'execute' | 'analysis';
    mistralApiKey?: string;
    envFilePath?: string;
    runtimeHomePath?: string;
} = {}): string[] {
    return (agent as unknown as {
        buildDockerArgs(params: {
            worktreePath: string;
            githubToken: string;
            modelName?: string;
            mistralApiKey?: string;
            issueNumber: number;
            taskId?: string;
            executionType?: string;
            maxTurns?: number;
            mode?: 'execute' | 'analysis';
            envFilePath?: string;
            runtimeHomePath?: string;
        }): string[];
    }).buildDockerArgs({
        worktreePath: params.worktreePath || '/tmp/vibe-worktree',
        githubToken: params.githubToken || 'github-token',
        modelName: params.modelName || 'mistral-medium-3.5',
        mistralApiKey: params.mistralApiKey,
        issueNumber: params.issueNumber ?? 1477,
        taskId: params.taskId || 'task-1234567890',
        executionType: params.executionType,
        maxTurns: params.maxTurns,
        mode: params.mode,
        envFilePath: params.envFilePath,
        runtimeHomePath: params.runtimeHomePath
    });
}

describe('parseVibeOutput', () => {
    test('returns plain output as the summary when output is not JSON', () => {
        assert.deepStrictEqual(parseVibeOutput('Plain analysis result\n'), {
            summary: 'Plain analysis result'
        });
    });

    test('parses nested message content and metadata from JSON output', () => {
        const parsed = parseVibeOutput(JSON.stringify({
            type: 'final',
            session_id: 'session-123',
            model: 'mistral-medium-3.5',
            message: {
                content: [{ text: 'Nested final summary' }]
            },
            usage: {
                input_tokens: 10,
                output_tokens: 20
            }
        }));

        assert.strictEqual(parsed.sessionId, 'session-123');
        assert.strictEqual(parsed.model, 'mistral-medium-3.5');
        assert.strictEqual(parsed.summary, 'Nested final summary');
        assert.deepStrictEqual(parsed.tokenUsage, { input_tokens: 10, output_tokens: 20 });
    });

    test('extracts text from common Vibe content object shapes', () => {
        const parsed = parseVibeOutput(JSON.stringify({
            type: 'final',
            content: [
                { text: 'First line' },
                { message: { content: [{ text: '\nSecond line' }] } }
            ]
        }));

        assert.strictEqual(parsed.summary, 'First line\nSecond line');
    });

    test('separates adjacent structured array text parts', () => {
        const parsed = parseVibeOutput(JSON.stringify({
            type: 'final',
            content: [
                { text: 'First block' },
                { text: 'Second block' }
            ]
        }));

        assert.strictEqual(parsed.summary, 'First block\nSecond block');
    });

    test('does not promote nested metadata objects to output events', () => {
        const parsed = parseVibeOutput(JSON.stringify({
            type: 'final',
            session_id: 'session-top',
            model: 'mistral-medium-3.5',
            message: {
                content: [{ text: 'Actual final summary' }]
            },
            metadata: {
                session_id: 'session-nested',
                model: 'metadata-model',
                text: 'metadata text'
            }
        }));

        assert.strictEqual(parsed.sessionId, 'session-top');
        assert.strictEqual(parsed.model, 'mistral-medium-3.5');
        assert.strictEqual(parsed.summary, 'Actual final summary');
    });

    test('prefers known final events over trailing metadata text', () => {
        const output = [
            JSON.stringify({ type: 'final', response: 'Final response' }),
            JSON.stringify({ type: 'log', text: 'Wrote session metadata' })
        ].join('\n');

        assert.strictEqual(parseVibeOutput(output).summary, 'Final response');
    });

    test('treats assistant transcript arrays as complete Vibe output', () => {
        const parsed = parseVibeOutput(JSON.stringify([
            { role: 'system', content: 'System prompt should not be selected' },
            { role: 'user', content: 'Do the task' },
            { role: 'assistant', content: 'Implemented the requested change.' }
        ]));

        assert.strictEqual(parsed.summary, 'Implemented the requested change.');
        assert.strictEqual(parsed.incomplete, false);
        assert.strictEqual(isSuccessfulVibeResult(0, parsed), true);
    });

    test('converts Vibe transcript arrays into structured conversation log entries', () => {
        const conversationLog = parseVibeConversationLog(JSON.stringify([
            { role: 'system', content: 'System prompt should not be logged' },
            { role: 'user', content: 'speed it up', message_id: 'user-1' },
            {
                role: 'assistant',
                content: '',
                reasoning_content: 'I need to inspect the file.',
                message_id: 'assistant-1',
                tool_calls: [{
                    id: 'tool-1',
                    function: {
                        name: 'read_file',
                        arguments: '{"path":"vibe_test.py"}'
                    }
                }]
            },
            {
                role: 'tool',
                name: 'read_file',
                tool_call_id: 'tool-1',
                content: 'path: /home/node/workspace/vibe_test.py\ncontent: print("Hello from Vibe")'
            },
            {
                role: 'assistant',
                content: 'Updated vibe_test.py.',
                message_id: 'assistant-2'
            }
        ]));

        assert.strictEqual(conversationLog.length, 4);
        assert.strictEqual(conversationLog[0].type, 'user');
        assert.deepStrictEqual(conversationLog[1].message.content, [
            { type: 'text', text: 'I need to inspect the file.' },
            { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'vibe_test.py' } }
        ]);
        assert.deepStrictEqual(conversationLog[2].message.content, [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'path: /home/node/workspace/vibe_test.py\ncontent: print("Hello from Vibe")',
            is_error: false
        }]);
        assert.deepStrictEqual(conversationLog[3].message.content, [{ type: 'text', text: 'Updated vibe_test.py.' }]);
        assert.ok(!JSON.stringify(conversationLog).includes('System prompt should not be logged'));
    });

    test('captures explicit error events', () => {
        const output = [
            JSON.stringify({ type: 'final', response: 'Final response' }),
            JSON.stringify({ type: 'error', error: { message: 'Rate limit exceeded' } })
        ].join('\n');

        const parsed = parseVibeOutput(output);
        assert.strictEqual(parsed.summary, 'Final response');
        assert.strictEqual(parsed.error, 'Rate limit exceeded');
    });

    test('ignores transient errors followed by a final response', () => {
        const output = [
            JSON.stringify({ type: 'error', error: 'Transient retryable error' }),
            JSON.stringify({ type: 'final', response: 'Recovered response' })
        ].join('\n');

        const parsed = parseVibeOutput(output);
        assert.strictEqual(parsed.summary, 'Recovered response');
        assert.strictEqual(parsed.error, undefined);
    });

    test('marks JSON text output incomplete when no final event is present and treats it as failure', () => {
        const output = [
            JSON.stringify({ type: 'message', text: 'Successful streamed response' }),
            JSON.stringify({ type: 'error', error: 'Stale diagnostic from retry' })
        ].join('\n');

        const parsed = parseVibeOutput(output);
        assert.strictEqual(parsed.summary, 'Successful streamed response');
        assert.strictEqual(parsed.error, undefined);
        assert.strictEqual(parsed.incomplete, true);
        assert.strictEqual(isSuccessfulVibeResult(0, parsed), false);
    });
});

describe('readLatestVibeSessionTokenUsage', () => {
    test('reads token totals from Vibe session meta stats', () => {
        const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-meta-test-'));
        try {
            const sessionDir = path.join(runtimeHome, 'logs', 'session', 'session_20260603_131445_ae284605');
            fs.mkdirSync(sessionDir, { recursive: true });
            fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
                stats: {
                    session_prompt_tokens: 7462,
                    session_completion_tokens: 4,
                    session_total_llm_tokens: 7466,
                    session_cost: 0.0007474
                }
            }));

            assert.deepStrictEqual(readLatestVibeSessionTokenUsage(runtimeHome), {
                input_tokens: 7462,
                output_tokens: 4
            });
        } finally {
            fs.rmSync(runtimeHome, { recursive: true, force: true });
        }
    });
});

describe('Vibe CLI args', () => {
    test('splits shell-like VIBE_CLI_ARGS without invoking a shell', () => {
        assert.deepStrictEqual(
            splitVibeCliArgs('vibe --flag "two words" --empty "" escaped\\ value'),
            ['vibe', '--flag', 'two words', '--empty', '', 'escaped value']
        );
        assert.throws(() => splitVibeCliArgs('vibe "unterminated'), /unmatched quote/);
    });

    test('does not forward VIBE_CLI_ARGS into the container environment', () => {
        const forwarded = getForwardedVibeEnvVars({
            VIBE_CLI_ARGS: 'vibe --output json',
            MISTRAL_API_KEY: 'mistral-key',
            EXTRA_VIBE_ENV: 'extra-value'
        });

        assert.deepStrictEqual(forwarded, {
            dockerArgs: ['-e', 'EXTRA_VIBE_ENV=extra-value'],
            skipped: []
        });
    });

    test('reports which VIBE_CLI_ARGS source is invalid', () => {
        withRestoredEnv(() => {
            process.env.VIBE_CLI_ARGS = 'vibe "unterminated';
            process.env.MISTRAL_API_KEY = 'test-key';
            assert.throws(
                () => buildArgs(createAgent()),
                /Invalid process\.env\.VIBE_CLI_ARGS: unmatched quote/
            );
        });
    });
});

describe('VibeAgent Docker args', () => {
    test('resolves Mistral API key from ProPR settings when explicit env is absent', () => {
        assert.strictEqual(getMistralApiKeyFromSettings({ mistral_api_key: ' settings-mistral-key ' }), 'settings-mistral-key');
        assert.strictEqual(getMistralApiKeyFromSettings({ vibe_mistral_api_key: 'vibe-settings-key' }), 'vibe-settings-key');
        assert.strictEqual(getMistralApiKeyFromSettings({ mistral_api_key: '   ' }), undefined);
    });

    test('uses stdin-oriented structured default command and read-only sandbox for analysis', () => {
        const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-config-test-'));
        fs.writeFileSync(path.join(configPath, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
        fs.writeFileSync(path.join(configPath, '.env'), 'MISTRAL_API_KEY=test-key\n', { mode: 0o600 });
        try {
            const args = buildArgs(createAgent({ configPath }), {
                issueNumber: 0,
                executionType: 'context-analysis',
                maxTurns: 5,
                mode: 'analysis'
            });

            assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:ro'));
            assert.ok(args.includes(`${configPath}:/home/node/.vibe:ro`));
            assert.ok(args.includes('--read-only'));
            assert.ok(args.includes('VIBE_READ_ONLY_CONFIG=1'));
            assert.ok(args.includes('VIBE_ACTIVE_MODEL=mistral-medium-3.5'));
            assert.ok(args.includes('VIBE_MAX_TURNS=5'));
            assert.ok(!args.some(arg => arg.includes('propr-vibe-prompt.md')));
            assert.ok(args.includes('PROPR_AGENT_TYPE=vibe'));

            const imageIndex = args.indexOf('propr/agent:bundle-test');
            assert.deepStrictEqual(args.slice(imageIndex + 1), ['--output', 'json']);
        } finally {
            fs.rmSync(configPath, { recursive: true, force: true });
        }
    });

    test('analysis mode uses bridge network for outbound Mistral API access', () => {
        withRestoredEnv(() => {
            process.env.MISTRAL_API_KEY = 'test-key';
            const args = buildArgs(createAgent(), {
                issueNumber: 0,
                maxTurns: 5,
                mode: 'analysis'
            });

            const networkIndex = args.indexOf('--network');
            assert.ok(networkIndex !== -1, 'expected --network flag in docker args');
            assert.strictEqual(args[networkIndex + 1], 'bridge');
        });
    });

    test('hasUsableConfigDir requires config.toml or credentials.json', () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-empty-'));
        const cacheOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cache-'));
        fs.writeFileSync(path.join(cacheOnlyDir, 'history.json'), '[]');
        const validDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-valid-'));
        fs.writeFileSync(path.join(validDir, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
        try {
            process.env.MISTRAL_API_KEY = 'test-key';

            const emptyArgs = buildArgs(createAgent({ configPath: emptyDir }));
            assert.ok(!emptyArgs.some(a => a.includes(`${emptyDir}:`)), 'empty dir should not be mounted');

            const cacheArgs = buildArgs(createAgent({ configPath: cacheOnlyDir }));
            assert.ok(!cacheArgs.some(a => a.includes(`${cacheOnlyDir}:`)), 'dir with only cache files should not be mounted');

            const validArgs = buildArgs(createAgent({ configPath: validDir }));
            assert.ok(validArgs.some(a => a.includes(`${validDir}:/home/node/.vibe:ro`)), 'dir with config.toml should be mounted');
        } finally {
            delete process.env.MISTRAL_API_KEY;
            fs.rmSync(emptyDir, { recursive: true, force: true });
            fs.rmSync(cacheOnlyDir, { recursive: true, force: true });
            fs.rmSync(validDir, { recursive: true, force: true });
        }
    });

    test('wraps implementation runs for repo setup and honors VIBE_CLI_ARGS', () => {
        withRestoredEnv(() => {
            process.env.VIBE_CLI_ARGS = 'vibe --plain --output json "two words"';
            process.env.MISTRAL_API_KEY = 'test-key';
            const args = buildArgs(createAgent(), { maxTurns: 12, envFilePath: '/tmp/propr-vibe-agent.env' });

            assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:rw'));
            const envFileIndex = args.indexOf('--env-file');
            assert.notStrictEqual(envFileIndex, -1);
            assert.strictEqual(args[envFileIndex + 1], '/tmp/propr-vibe-agent.env');
            assert.ok(args.includes('PROPR_AGENT_TYPE=vibe'));
            assert.ok(args.includes('PROPR_WORKSPACE=/home/node/workspace'));
            assert.ok(args.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));
            assert.ok(args.includes('VIBE_MAX_TURNS=12'));
            assert.ok(!args.some(arg => arg.includes('propr-vibe-prompt.md')));

            const imageIndex = args.indexOf('propr/agent:bundle-test');
            assert.deepStrictEqual(args.slice(imageIndex + 4), ['vibe', '--plain', '--output', 'json', 'two words']);
        });
    });

    test('mounts Vibe runtime home through the shared prompt cache host path', () => {
        withRestoredEnv(() => {
            process.env.MISTRAL_API_KEY = 'test-key';
            process.env.VIBE_PROMPT_CACHE_HOST_MOUNTED = '1';
            process.env.VIBE_PROMPT_CACHE_DIR = '/tmp/propr-vibe-prompts';
            process.env.HOST_VIBE_PROMPT_CACHE_DIR = '/host/propr-vibe-prompts';

            const args = buildArgs(createAgent(), {
                runtimeHomePath: '/tmp/propr-vibe-prompts/propr-vibe-runtime/task-home'
            });

            assert.ok(args.includes('/host/propr-vibe-prompts/propr-vibe-runtime/task-home:/tmp/propr-vibe-home:rw'));
            assert.ok(args.includes('VIBE_RUNTIME_HOME=/tmp/propr-vibe-home'));
            assert.ok(args.includes('HOME=/tmp/propr-vibe-home'));
        });
    });

    test('expands tilde config paths before checking Docker mountability', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
        const configPath = path.join(homeDir, '.vibe');
        fs.mkdirSync(configPath);
        fs.writeFileSync(path.join(configPath, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
        fs.writeFileSync(path.join(configPath, '.env'), 'MISTRAL_API_KEY=test-key\n', { mode: 0o600 });
        const previousHome = process.env.HOME;
        try {
            process.env.HOME = homeDir;
            const args = buildArgs(createAgent({ configPath: '~/.vibe' }), {
                issueNumber: 0,
                maxTurns: 5,
                mode: 'analysis'
            });

            assert.ok(args.includes(`${configPath}:/home/node/.vibe:ro`));
        } finally {
            if (previousHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = previousHome;
            }
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    test('entrypoint forces Vibe runtime home after dropping privileges', () => {
        const script = fs.readFileSync(path.resolve('scripts/vibe-entrypoint.sh'), 'utf8');
        const readOnlyIndex = script.indexOf('VIBE_READ_ONLY_CONFIG" = "1"');
        const suExecIndex = script.indexOf('command -v su-exec');
        const sudoIndex = script.indexOf('command -v sudo', suExecIndex);

        assert.match(script, /export HOME="\$RUNTIME_VIBE_HOME"/);
        assert.match(script, /env HOME="\$RUNTIME_VIBE_HOME" VIBE_HOME="\$RUNTIME_VIBE_HOME"/);
        assert.ok(readOnlyIndex !== -1, 'entrypoint should handle read-only analysis mode before user switching');
        assert.ok(readOnlyIndex < suExecIndex, 'read-only analysis mode should not call su-exec');
        assert.ok(suExecIndex !== -1, 'entrypoint should support su-exec for restricted containers');
        assert.ok(sudoIndex > suExecIndex, 'entrypoint should prefer su-exec before sudo');
        assert.match(script, /normalize_vibe_config_paths/);
        assert.match(script, /ensure_runtime_dirs/);
        assert.match(script, /chown -R node:node "\$RUNTIME_VIBE_HOME"/);
        assert.match(script, /bypass_tool_permissions = true/);
        assert.doesNotMatch(script, /sudo -E -u node -H/);
    });

    test('Vibe image provides a su-exec-compatible helper for no-new-privileges user switching', () => {
        const dockerfile = fs.readFileSync(path.resolve('Dockerfile.agent'), 'utf8');

        assert.match(dockerfile, /apt-get install -y[\s\S]*--no-install-recommends[\s\S]*\bgosu\b/);
        assert.match(dockerfile, /ln -sf "\$\(command -v gosu\)" \/usr\/local\/bin\/su-exec/);
        assert.match(dockerfile, /if \[ ! -e \/usr\/local\/bin\/vibe-acp \]; then ln -s \/usr\/local\/bin\/vibe \/usr\/local\/bin\/vibe-acp; fi/);
    });

    test('propagates Mistral API key through the explicit credential path', () => {
        const emptyConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-vibe-config-'));
        try {
            const args = buildArgs(createAgent({
                configPath: emptyConfigPath,
                envVars: {
                    MISTRAL_API_KEY: ' configured-mistral-api-key ',
                    VIBE_CLI_ARGS: 'vibe --output json',
                    EXTRA_VIBE_ENV: 'extra-value',
                    'BAD-ENV': 'skipped',
                    MULTILINE_ENV: 'skip\nme'
                }
            }), { mistralApiKey: 'configured-mistral-api-key', envFilePath: '/tmp/propr-vibe-agent.env' });

            const envFileIndex = args.indexOf('--env-file');
            assert.notStrictEqual(envFileIndex, -1);
            assert.strictEqual(args[envFileIndex + 1], '/tmp/propr-vibe-agent.env');
            assert.ok(!args.includes('MISTRAL_API_KEY=configured-mistral-api-key'));
            assert.ok(args.includes('EXTRA_VIBE_ENV=extra-value'));
            assert.ok(!args.includes('VIBE_CLI_ARGS=vibe --output json'));
            assert.ok(!args.includes('BAD-ENV=skipped'));
            assert.ok(!args.includes('MULTILINE_ENV=skip\nme'));
            assert.ok(!args.includes(`${emptyConfigPath}:/home/node/.vibe:ro`));
        } finally {
            delete process.env.MISTRAL_API_KEY;
            fs.rmSync(emptyConfigPath, { recursive: true, force: true });
        }
    });

    test('uses structured output in the default execution command', () => {
        withRestoredEnv(() => {
            process.env.MISTRAL_API_KEY = 'test-key';
            const args = buildArgs(createAgent(), { maxTurns: 12 });

            const imageIndex = args.indexOf('propr/agent:bundle-test');
            assert.deepStrictEqual(
                args.slice(imageIndex + 4),
                ['--output', 'json']
            );
        });
    });
});

describe('Docker command stdin delivery', () => {
    test('passes prompt data through stdin', async () => {
        const result = await executeDockerCommand(process.execPath, [
            '-e',
            'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(input));'
        ], {
            stdinData: 'prompt from stdin',
            timeout: 5000
        });

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'prompt from stdin');
    });
});
