import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.js';
import { toAntigravityCliModelId } from '../packages/core/src/agents/impl/antigravityModelIds.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

process.env.NODE_ENV = 'test';

after(async () => {
    await closeConnection();
});

function createAgent(configPath: string): AntigravityAgent {
    const config: AgentConfig = {
        id: 'antigravity-test',
        type: 'antigravity',
        alias: 'antigravity',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath,
        supportedModels: ['antigravity-gemini-3.5-flash-high'],
        defaultModel: 'antigravity-gemini-3.5-flash-high'
    };
    return new AntigravityAgent(config);
}

describe('AntigravityAgent Docker args', () => {
    test('mounts sibling .gemini auth directory when legacy .antigravity config is configured', () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-home-'));
        const legacyPath = path.join(tempHome, '.antigravity');
        const geminiPath = path.join(tempHome, '.gemini');
        fs.mkdirSync(legacyPath, { recursive: true });
        fs.mkdirSync(geminiPath, { recursive: true });

        try {
            const agent = createAgent(legacyPath);
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName?: string;
                    issueNumber: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/worktree',
                githubToken: '',
                modelName: 'antigravity-gemini-3.5-flash-high',
                issueNumber: 42
            });

            assert.ok(args.includes(`${geminiPath}:/home/node/.gemini:rw`));
            assert.ok(!args.includes(`${legacyPath}:/home/node/.gemini:rw`));
        } finally {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });

    test('reads the prompt from stdin via `--print -` and passes the CLI display-name model', () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-model-'));
        fs.mkdirSync(path.join(tempHome, '.gemini'), { recursive: true });

        try {
            const agent = createAgent(path.join(tempHome, '.gemini'));
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    modelName?: string;
                    issueNumber: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/worktree',
                githubToken: '',
                modelName: 'antigravity-gpt-oss-120b-medium',
                issueNumber: 0
            });

            // Prompt is delivered via stdin (`--print -`), never as an argv element
            // (large repo-context prompts would exceed MAX_ARG_STRLEN -> E2BIG).
            const shellCmd = args.find(a => a.includes('agy'));
            assert.ok(shellCmd && shellCmd.includes('--print - '), 'shell command must use `--print -` to read stdin');

            // Model must be the CLI display name, never the namespaced id.
            const modelIdx = args.indexOf('--model');
            assert.ok(modelIdx >= 0, '--model flag should be present');
            assert.strictEqual(args[modelIdx + 1], 'GPT-OSS 120B (Medium)');
            assert.ok(!args.includes('antigravity-gpt-oss-120b-medium'), 'prefixed id must not be passed to the CLI');
        } finally {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });
});

describe('toAntigravityCliModelId', () => {
    test('maps ProPR ids to the CLI display names accepted by --model', () => {
        assert.strictEqual(toAntigravityCliModelId('antigravity-gemini-3.5-flash-high'), 'Gemini 3.5 Flash (High)');
        assert.strictEqual(toAntigravityCliModelId('antigravity-gemini-3.1-pro-high'), 'Gemini 3.1 Pro (High)');
        assert.strictEqual(toAntigravityCliModelId('antigravity-claude-sonnet-4.6-thinking'), 'Claude Sonnet 4.6 (Thinking)');
        assert.strictEqual(toAntigravityCliModelId('antigravity-claude-opus-4.6-thinking'), 'Claude Opus 4.6 (Thinking)');
        assert.strictEqual(toAntigravityCliModelId('antigravity-gpt-oss-120b-medium'), 'GPT-OSS 120B (Medium)');
    });

    test('strips an optional antigravity: route prefix before mapping', () => {
        assert.strictEqual(toAntigravityCliModelId('antigravity:antigravity-gemini-3.1-pro-low'), 'Gemini 3.1 Pro (Low)');
        assert.strictEqual(toAntigravityCliModelId('antigravity:antigravity-claude-sonnet-4.6-thinking'), 'Claude Sonnet 4.6 (Thinking)');
    });

    test('leaves an already-native model name unchanged', () => {
        assert.strictEqual(toAntigravityCliModelId('gemini-3.5-flash-high'), 'gemini-3.5-flash-high');
    });
});

describe('AntigravityAgent token estimation', () => {
    type Estimate = { input_tokens?: number; output_tokens?: number } | undefined;
    interface TokenAgent {
        resolveTokenUsage(
            reported: { input_tokens?: number; output_tokens?: number },
            prompt: string,
            summary: string | undefined,
            conversationLog: unknown[]
        ): Estimate;
    }
    const agent = createAgent('/tmp/nonexistent') as unknown as TokenAgent;

    test('reported counts always win', () => {
        const usage = agent.resolveTokenUsage({ input_tokens: 1000, output_tokens: 200 }, 'p', 's', []);
        assert.deepStrictEqual(usage, { input_tokens: 1000, output_tokens: 200 });
    });

    test('estimates from the full transcript (file views/searches as input, planner/code as output)', () => {
        const events = [
            { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'x'.repeat(400) },   // input
            { source: 'MODEL', type: 'VIEW_FILE', content: 'y'.repeat(8000) },           // input (bulk)
            { source: 'MODEL', type: 'GREP_SEARCH', content: 'z'.repeat(4000) },         // input
            { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'a'.repeat(800) },     // output
            { source: 'MODEL', type: 'CODE_ACTION', content: 'b'.repeat(1200) },         // output
        ];
        const usage = agent.resolveTokenUsage({}, 'prompt', 'summary', events)!;
        assert.ok(usage, 'should produce an estimate');
        // Input dominates (file view + grep ~12.4K chars) and far exceeds the old
        // prompt-only estimate; output reflects planner + code (~2K chars).
        assert.ok(usage.input_tokens! > 2000, `input should reflect file context, got ${usage.input_tokens}`);
        assert.ok(usage.output_tokens! > 300, `output should reflect planner+code, got ${usage.output_tokens}`);
        assert.ok(usage.input_tokens! > usage.output_tokens!, 'agentic runs are input-heavy');
    });

    test('falls back to prompt + summary when no transcript content (plain-text output)', () => {
        const usage = agent.resolveTokenUsage({}, 'p'.repeat(4000), 's'.repeat(800), [])!;
        assert.ok(usage.input_tokens! > usage.output_tokens!, 'prompt is input, summary is output');
        assert.ok(usage.output_tokens! > 0);
    });
});
