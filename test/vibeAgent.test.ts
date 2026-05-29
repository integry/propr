import { after, describe, test } from 'node:test';
import assert from 'node:assert';
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
});

describe('VibeAgent Docker args', () => {
    test('mounts prompt and config, sets model env, and enables repo setup wrapper', () => {
        const agent = new VibeAgent({
            id: 'vibe-test',
            type: 'vibe',
            alias: 'vibe-test',
            enabled: true,
            dockerImage: 'propr-vibe:2.12.1-abcdef',
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
                executionType: string;
                maxTurns: number;
                mode: 'analysis';
            }): string[];
        }).buildDockerArgs({
            worktreePath: '/tmp/vibe-worktree',
            githubToken: 'github-token',
            modelName: 'openrouter:mistral-medium-3.5',
            promptPath: '/tmp/git-processor/propr-cache/vibe-prompts/prompt.md',
            issueNumber: 0,
            taskId: 'task-1234567890',
            executionType: 'context-analysis',
            maxTurns: 5,
            mode: 'analysis'
        });

        assert.ok(args.includes('propr-vibe:2.12.1-abcdef'));
        assert.ok(args.includes('PROPR_AGENT_TYPE=vibe'));
        assert.ok(args.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));
        assert.ok(args.includes('VIBE_ACTIVE_MODEL=mistral-medium-3.5'));
        assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:ro'));
        assert.ok(args.includes('/tmp/git-processor:/tmp/git-processor:rw'));
        assert.ok(args.includes('/tmp/vibe-config:/home/node/.vibe:ro'));
        assert.ok(args.includes('/tmp/git-processor/propr-cache/vibe-prompts/prompt.md:/tmp/propr-vibe-prompt.md:ro'));

        const imageIndex = args.indexOf('propr-vibe:2.12.1-abcdef');
        assert.strictEqual(args[imageIndex + 3], '/home/node/vibe-entrypoint.sh');
        assert.deepStrictEqual(args.slice(-6), ['--max-turns', '5', '--output', 'json', '--agent', 'plan']);
    });

    test('uses writable workspace and auto-approve agent for execution mode', () => {
        const agent = new VibeAgent({
            id: 'vibe-test',
            type: 'vibe',
            alias: 'vibe-test',
            enabled: true,
            dockerImage: 'propr-vibe:2.12.1-abcdef',
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
            promptPath: '/tmp/git-processor/propr-cache/vibe-prompts/prompt.md',
            issueNumber: 1477,
            taskId: 'task-1234567890',
            maxTurns: 12
        });

        assert.ok(args.includes('/tmp/vibe-worktree:/home/node/workspace:rw'));
        assert.ok(args.includes('GH_TOKEN=github-token'));
        assert.ok(args.includes('GITHUB_TOKEN=github-token'));
        assert.ok(args.includes('PROPR_WORKSPACE=/home/node/workspace'));
        assert.ok(args.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));
        assert.deepStrictEqual(args.slice(-7), ['--max-turns', '12', '--output', 'json', '--trust', '--agent', 'auto-approve']);
    });
});
