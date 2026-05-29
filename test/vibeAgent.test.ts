import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VibeAgent, parseVibeOutput } from '../packages/core/src/agents/impl/VibeAgent.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

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

    test('parses line-delimited final and error events', () => {
        const output = [
            JSON.stringify({ type: 'delta', delta: { content: 'partial' } }),
            JSON.stringify({ type: 'final', response: 'Final response' }),
            JSON.stringify({ type: 'error', error: { message: 'Rate limit exceeded' } })
        ].join('\n');

        const parsed = parseVibeOutput(output);

        assert.strictEqual(parsed.summary, 'Final response');
        assert.strictEqual(parsed.error, 'Rate limit exceeded');
    });

    test('prefers known final events over trailing metadata text', () => {
        const output = [
            JSON.stringify({ type: 'final', response: 'Final response' }),
            JSON.stringify({ type: 'log', text: 'Wrote session metadata' })
        ].join('\n');

        assert.strictEqual(parseVibeOutput(output).summary, 'Final response');
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

    test('marks JSON text output incomplete when no final event is present', () => {
        const output = [
            JSON.stringify({ type: 'message', text: 'Successful streamed response' }),
            JSON.stringify({ type: 'error', error: 'Stale diagnostic from retry' })
        ].join('\n');

        const parsed = parseVibeOutput(output);
        assert.strictEqual(parsed.summary, 'Successful streamed response');
        assert.strictEqual(parsed.error, undefined);
        assert.strictEqual(parsed.incomplete, true);
    });
});

describe('VibeAgent Docker args', () => {
    test('mounts prompt and config, sets model env, and skips repo setup for analysis', (t) => {
        const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-config-test-'));
        fs.writeFileSync(path.join(configPath, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
        t.after(() => {
            fs.rmSync(configPath, { recursive: true, force: true });
        });
        const agent = new VibeAgent({
            id: 'vibe-test',
            type: 'vibe',
            alias: 'vibe-test',
            enabled: true,
            dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
            configPath,
            supportedModels: ['mistral-medium-3.5'],
            defaultModel: 'mistral-medium-3.5'
        } satisfies AgentConfig);
        const args = (agent as unknown as {
            buildDockerArgs(params: {
                worktreePath: string;
                githubToken: string;
                modelName: string;
                promptPath: string;
                issueNumber: number;
                taskId: string;
                executionType: string;
                maxTurns: number;
                mode: 'analysis';
            }): string[];
        }).buildDockerArgs({
            worktreePath: '/tmp/vibe-worktree',
            githubToken: 'github-token',
            modelName: 'openrouter:mistral-medium-3.5',
            promptPath: '/tmp/propr-vibe-prompts/vibe-task/prompt.md',
            issueNumber: 0,
            taskId: 'task-1234567890',
            executionType: 'context-analysis',
            maxTurns: 5,
            mode: 'analysis'
        });

        assert.ok(args.includes('propr/agent-vibe:2.12.1-abcdef'));
        assert.ok(args.includes('VIBE_ACTIVE_MODEL=mistral-medium-3.5'));
        assert.ok(args.includes('VIBE_READ_ONLY_CONFIG=1'));
        assert.ok(args.includes('XDG_CACHE_HOME=/tmp/propr-vibe-cache'));
        assert.ok(args.includes('UV_CACHE_DIR=/tmp/propr-uv-cache'));
        assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:ro'));
        assert.ok(args.includes('--read-only'));
        assert.ok(args.includes('/tmp:rw,nosuid,size=512m'));
        assert.ok(args.includes('/home/node/.cache:rw,nosuid,size=256m'));
        assert.ok(!args.includes('--user'));
        assert.ok(!args.includes('0:0'));
        assert.ok(!args.includes('/tmp/git-processor:/tmp/git-processor:rw'));
        assert.ok(!args.includes('--cap-add'));
        assert.ok(!args.includes('PROPR_AGENT_TYPE=vibe'));
        assert.ok(!args.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));
        assert.ok(args.includes(`${configPath}:/home/node/.vibe:ro`));
        assert.ok(args.includes('/tmp/propr-vibe-prompts/vibe-task/prompt.md:/tmp/propr-vibe-prompt.md:ro'));

        const imageIndex = args.indexOf('propr/agent-vibe:2.12.1-abcdef');
        assert.deepStrictEqual(args.slice(imageIndex + 1, imageIndex + 4), ['vibe', '--prompt', 'Read the full task prompt from @/tmp/propr-vibe-prompt.md and follow it exactly.']);
        assert.deepStrictEqual(args.slice(-4), ['--max-turns', '5', '--output', 'json']);
    });

    test('uses host prompt cache path for sibling Docker bind mounts', () => {
        const previousPromptDir = process.env.VIBE_PROMPT_CACHE_DIR;
        const previousHostPromptDir = process.env.HOST_VIBE_PROMPT_CACHE_DIR;
        process.env.VIBE_PROMPT_CACHE_DIR = '/container/vibe-prompts';
        process.env.HOST_VIBE_PROMPT_CACHE_DIR = '/host/vibe-prompts';
        try {
            const agent = new VibeAgent({
                id: 'vibe-test',
                type: 'vibe',
                alias: 'vibe-test',
                enabled: true,
                dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
                configPath: '/tmp/vibe-config',
                supportedModels: ['mistral-medium-3.5'],
                defaultModel: 'mistral-medium-3.5'
            } satisfies AgentConfig);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName: string;
                    promptPath: string;
                    issueNumber: number;
                    taskId: string;
                    maxTurns: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/vibe-worktree',
                githubToken: 'github-token',
                modelName: 'mistral-medium-3.5',
                promptPath: '/container/vibe-prompts/vibe-task/prompt.md',
                issueNumber: 1477,
                taskId: 'task-1234567890',
                maxTurns: 12
            });

            assert.ok(args.includes('/host/vibe-prompts/vibe-task/prompt.md:/tmp/propr-vibe-prompt.md:ro'));
            assert.ok(!args.includes('/container/vibe-prompts/vibe-task/prompt.md:/tmp/propr-vibe-prompt.md:ro'));
        } finally {
            if (previousPromptDir === undefined) {
                delete process.env.VIBE_PROMPT_CACHE_DIR;
            } else {
                process.env.VIBE_PROMPT_CACHE_DIR = previousPromptDir;
            }
            if (previousHostPromptDir === undefined) {
                delete process.env.HOST_VIBE_PROMPT_CACHE_DIR;
            } else {
                process.env.HOST_VIBE_PROMPT_CACHE_DIR = previousHostPromptDir;
            }
        }
    });

    test('does not mount an empty config path when using Mistral API key fallback', () => {
        const emptyConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-vibe-config-'));
        const previousApiKey = process.env.MISTRAL_API_KEY;
        process.env.MISTRAL_API_KEY = 'mistral-api-key';
        try {
            const agent = new VibeAgent({
                id: 'vibe-test',
                type: 'vibe',
                alias: 'vibe-test',
                enabled: true,
                dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
                configPath: emptyConfigPath,
                supportedModels: ['mistral-medium-3.5'],
                defaultModel: 'mistral-medium-3.5'
            } satisfies AgentConfig);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName: string;
                    promptPath: string;
                    issueNumber: number;
                    taskId: string;
                    maxTurns: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/vibe-worktree',
                githubToken: 'github-token',
                modelName: 'mistral-medium-3.5',
                promptPath: '/tmp/propr-vibe-prompts/vibe-task/prompt.md',
                issueNumber: 1477,
                taskId: 'task-1234567890',
                maxTurns: 12
            });

            assert.ok(args.includes('MISTRAL_API_KEY=mistral-api-key'));
            assert.ok(!args.includes(`${emptyConfigPath}:/home/node/.vibe:ro`));
        } finally {
            if (previousApiKey === undefined) {
                delete process.env.MISTRAL_API_KEY;
            } else {
                process.env.MISTRAL_API_KEY = previousApiKey;
            }
            fs.rmSync(emptyConfigPath, { recursive: true, force: true });
        }
    });

    test('passes configured Mistral API key through the explicit credential path', () => {
        const emptyConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-vibe-config-'));
        try {
            const agent = new VibeAgent({
                id: 'vibe-test',
                type: 'vibe',
                alias: 'vibe-test',
                enabled: true,
                dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
                configPath: emptyConfigPath,
                supportedModels: ['mistral-medium-3.5'],
                defaultModel: 'mistral-medium-3.5',
                envVars: {
                    MISTRAL_API_KEY: 'configured-mistral-api-key',
                    EXTRA_VIBE_ENV: 'extra-value'
                }
            } satisfies AgentConfig);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName: string;
                    promptPath: string;
                    issueNumber: number;
                    taskId: string;
                    maxTurns: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/vibe-worktree',
                githubToken: 'github-token',
                modelName: 'mistral-medium-3.5',
                promptPath: '/tmp/propr-vibe-prompts/vibe-task/prompt.md',
                issueNumber: 1477,
                taskId: 'task-1234567890',
                maxTurns: 12
            });

            assert.ok(args.includes('MISTRAL_API_KEY=configured-mistral-api-key'));
            assert.ok(args.includes('EXTRA_VIBE_ENV=extra-value'));
            assert.strictEqual(args.filter(arg => arg.startsWith('MISTRAL_API_KEY=')).length, 1);
            assert.ok(!args.includes(`${emptyConfigPath}:/home/node/.vibe:ro`));
        } finally {
            fs.rmSync(emptyConfigPath, { recursive: true, force: true });
        }
    });

    test('trims configured Mistral API key and ignores whitespace-only values', () => {
        const emptyConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-vibe-config-'));
        try {
            const agent = new VibeAgent({
                id: 'vibe-test',
                type: 'vibe',
                alias: 'vibe-test',
                enabled: true,
                dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
                configPath: emptyConfigPath,
                supportedModels: ['mistral-medium-3.5'],
                defaultModel: 'mistral-medium-3.5',
                envVars: {
                    MISTRAL_API_KEY: '   ',
                    EXTRA_VIBE_ENV: 'extra-value'
                }
            } satisfies AgentConfig);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName: string;
                    promptPath: string;
                    issueNumber: number;
                    taskId: string;
                    maxTurns: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/vibe-worktree',
                githubToken: 'github-token',
                modelName: 'mistral-medium-3.5',
                promptPath: '/tmp/propr-vibe-prompts/vibe-task/prompt.md',
                issueNumber: 1477,
                taskId: 'task-1234567890',
                maxTurns: 12
            });

            assert.strictEqual(args.filter(arg => arg.startsWith('MISTRAL_API_KEY=')).length, 0);
            assert.ok(args.includes(`${emptyConfigPath}:/home/node/.vibe:ro`));
        } finally {
            fs.rmSync(emptyConfigPath, { recursive: true, force: true });
        }
    });

    test('uses writable workspace and auto-approve agent for execution mode', () => {
        const agent = new VibeAgent({
            id: 'vibe-test',
            type: 'vibe',
            alias: 'vibe-test',
            enabled: true,
            dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
            configPath: '/tmp/vibe-config',
            supportedModels: ['mistral-medium-3.5'],
            defaultModel: 'mistral-medium-3.5'
        } satisfies AgentConfig);
        const args = (agent as unknown as {
            buildDockerArgs(params: {
                worktreePath: string;
                githubToken: string;
                modelName: string;
                promptPath: string;
                issueNumber: number;
                taskId: string;
                maxTurns: number;
            }): string[];
        }).buildDockerArgs({
            worktreePath: '/tmp/vibe-worktree',
            githubToken: 'github-token',
            modelName: 'mistral-medium-3.5',
            promptPath: '/tmp/propr-vibe-prompts/vibe-task/prompt.md',
            issueNumber: 1477,
            taskId: 'task-1234567890',
            maxTurns: 12
        });

        assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:rw'));
        assert.ok(args.includes('GH_TOKEN=github-token'));
        assert.ok(args.includes('GITHUB_TOKEN=github-token'));
        assert.ok(args.includes('PROPR_WORKSPACE=/home/node/workspace'));
        assert.ok(args.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));
        assert.ok(!args.includes('--user'));
        assert.ok(!args.includes('0:0'));
        const imageIndex = args.indexOf('propr/agent-vibe:2.12.1-abcdef');
        assert.deepStrictEqual(args.slice(imageIndex + 4, imageIndex + 7), ['vibe', '--prompt', 'Read the full task prompt from @/tmp/propr-vibe-prompt.md and follow it exactly.']);
        assert.ok(!args.includes('--read-only'));
        assert.ok(!args.includes('VIBE_READ_ONLY_CONFIG=1'));
        assert.deepStrictEqual(args.slice(-7), ['--max-turns', '12', '--output', 'json', '--trust', '--agent', 'auto-approve']);
    });

    test('cleans up private prompt directory when execution throws', async () => {
        const promptParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agent-test-'));
        const previousPromptDir = process.env.VIBE_PROMPT_CACHE_DIR;
        process.env.VIBE_PROMPT_CACHE_DIR = promptParent;
        try {
            const agent = new VibeAgent({
                id: 'vibe-test',
                type: 'vibe',
                alias: 'vibe-test',
                enabled: true,
                dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
                configPath: '/tmp/vibe-config',
                supportedModels: ['mistral-medium-3.5'],
                defaultModel: 'mistral-medium-3.5'
            } satisfies AgentConfig);
            const privateApi = agent as unknown as {
                writePromptFile(prompt: string, taskId?: string): string;
                runWithPromptCleanup<T>(promptPath: string, run: () => Promise<T>): Promise<T>;
            };
            const promptPath = privateApi.writePromptFile('sensitive prompt', 'task-123');
            const promptDir = path.dirname(promptPath);
            assert.strictEqual((fs.statSync(promptParent).mode & 0o777), 0o755);
            assert.strictEqual((fs.statSync(promptDir).mode & 0o777), 0o755);
            assert.strictEqual((fs.statSync(promptPath).mode & 0o777), 0o444);

            await assert.rejects(
                () => privateApi.runWithPromptCleanup(promptPath, async () => {
                    throw new Error('execution failed');
                }),
                /execution failed/
            );
            assert.strictEqual(fs.existsSync(promptDir), false);
        } finally {
            if (previousPromptDir === undefined) {
                delete process.env.VIBE_PROMPT_CACHE_DIR;
            } else {
                process.env.VIBE_PROMPT_CACHE_DIR = previousPromptDir;
            }
            fs.rmSync(promptParent, { recursive: true, force: true });
        }
    });

    test('does not remove arbitrary vibe-prefixed directories outside the prompt cache', () => {
        const managedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-managed-parent-'));
        const externalParent = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-external-parent-'));
        const previousPromptDir = process.env.VIBE_PROMPT_CACHE_DIR;
        process.env.VIBE_PROMPT_CACHE_DIR = managedParent;
        try {
            const externalDir = path.join(externalParent, 'vibe-external');
            fs.mkdirSync(externalDir);
            const externalPrompt = path.join(externalDir, 'prompt.md');
            fs.writeFileSync(externalPrompt, 'external prompt');
            const agent = new VibeAgent({
                id: 'vibe-test',
                type: 'vibe',
                alias: 'vibe-test',
                enabled: true,
                dockerImage: 'propr/agent-vibe:2.12.1-abcdef',
                configPath: '/tmp/vibe-config',
                supportedModels: ['mistral-medium-3.5'],
                defaultModel: 'mistral-medium-3.5'
            } satisfies AgentConfig);
            const privateApi = agent as unknown as {
                cleanupPromptFile(promptPath: string): void;
            };

            privateApi.cleanupPromptFile(externalPrompt);

            assert.strictEqual(fs.existsSync(externalDir), true);
            assert.strictEqual(fs.existsSync(externalPrompt), false);
        } finally {
            if (previousPromptDir === undefined) {
                delete process.env.VIBE_PROMPT_CACHE_DIR;
            } else {
                process.env.VIBE_PROMPT_CACHE_DIR = previousPromptDir;
            }
            fs.rmSync(managedParent, { recursive: true, force: true });
            fs.rmSync(externalParent, { recursive: true, force: true });
        }
    });
});
