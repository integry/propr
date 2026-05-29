import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VibeAgent, parseVibeOutput } from '../packages/core/src/agents/impl/VibeAgent.js';
import { splitVibeCliArgs } from '../packages/core/src/agents/impl/utils/vibeAgentHelpers.js';
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
        dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
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
} = {}): string[] {
    return (agent as unknown as {
        buildDockerArgs(params: {
            worktreePath: string;
            githubToken: string;
            modelName?: string;
            issueNumber: number;
            taskId?: string;
            executionType?: string;
            maxTurns?: number;
            mode?: 'execute' | 'analysis';
        }): string[];
    }).buildDockerArgs({
        worktreePath: params.worktreePath || '/tmp/vibe-worktree',
        githubToken: params.githubToken || 'github-token',
        modelName: params.modelName || 'mistral-medium-3.5',
        issueNumber: params.issueNumber ?? 1477,
        taskId: params.taskId || 'task-1234567890',
        executionType: params.executionType,
        maxTurns: params.maxTurns,
        mode: params.mode
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

    test('prefers known final events over trailing metadata text', () => {
        const output = [
            JSON.stringify({ type: 'final', response: 'Final response' }),
            JSON.stringify({ type: 'log', text: 'Wrote session metadata' })
        ].join('\n');

        assert.strictEqual(parseVibeOutput(output).summary, 'Final response');
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
});

describe('Vibe CLI args', () => {
    test('splits shell-like VIBE_CLI_ARGS without invoking a shell', () => {
        assert.deepStrictEqual(
            splitVibeCliArgs('vibe --flag "two words" --empty "" escaped\\ value'),
            ['vibe', '--flag', 'two words', '--empty', '', 'escaped value']
        );
        assert.throws(() => splitVibeCliArgs('vibe "unterminated'), /unmatched quote/);
    });
});

describe('VibeAgent Docker args', () => {
    test('uses stdin-oriented default command and read-only sandbox for analysis', () => {
        const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-config-test-'));
        fs.writeFileSync(path.join(configPath, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
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
            assert.ok(!args.includes('PROPR_AGENT_TYPE=vibe'));

            const imageIndex = args.indexOf('propr/agent-vibe:2.12.1-abcdef');
            assert.deepStrictEqual(args.slice(imageIndex + 1), ['vibe']);
        } finally {
            fs.rmSync(configPath, { recursive: true, force: true });
        }
    });

    test('wraps implementation runs for repo setup and honors VIBE_CLI_ARGS', () => {
        withRestoredEnv(() => {
            process.env.VIBE_CLI_ARGS = 'vibe --headless --plain "two words"';
            const args = buildArgs(createAgent(), { maxTurns: 12 });

            assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:rw'));
            assert.ok(args.includes('GH_TOKEN=github-token'));
            assert.ok(args.includes('GITHUB_TOKEN=github-token'));
            assert.ok(args.includes('PROPR_AGENT_TYPE=vibe'));
            assert.ok(args.includes('PROPR_WORKSPACE=/home/node/workspace'));
            assert.ok(args.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));
            assert.ok(args.includes('VIBE_MAX_TURNS=12'));
            assert.ok(!args.some(arg => arg.includes('propr-vibe-prompt.md')));

            const imageIndex = args.indexOf('propr/agent-vibe:2.12.1-abcdef');
            assert.deepStrictEqual(args.slice(imageIndex + 4), ['vibe', '--headless', '--plain', 'two words']);
        });
    });

    test('expands tilde config paths before checking Docker mountability', () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
        const configPath = path.join(homeDir, '.vibe');
        fs.mkdirSync(configPath);
        fs.writeFileSync(path.join(configPath, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
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

    test('propagates Mistral API key through the explicit credential path', () => {
        const emptyConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-vibe-config-'));
        try {
            const args = buildArgs(createAgent({
                configPath: emptyConfigPath,
                envVars: {
                    MISTRAL_API_KEY: ' configured-mistral-api-key ',
                    EXTRA_VIBE_ENV: 'extra-value',
                    'BAD-ENV': 'skipped',
                    MULTILINE_ENV: 'skip\nme'
                }
            }));

            assert.ok(args.includes('MISTRAL_API_KEY=configured-mistral-api-key'));
            assert.ok(args.includes('EXTRA_VIBE_ENV=extra-value'));
            assert.ok(!args.includes('BAD-ENV=skipped'));
            assert.ok(!args.includes('MULTILINE_ENV=skip\nme'));
            assert.strictEqual(args.filter(arg => arg.startsWith('MISTRAL_API_KEY=')).length, 1);
            assert.ok(!args.includes(`${emptyConfigPath}:/home/node/.vibe:ro`));
        } finally {
            fs.rmSync(emptyConfigPath, { recursive: true, force: true });
        }
    });
});
