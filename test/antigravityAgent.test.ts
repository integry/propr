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
        dockerImage: 'propr/agent-antigravity:latest',
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

    test('passes the prompt as the first positional arg, before --model, with the CLI display-name model', () => {
        const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-antigravity-model-'));
        fs.mkdirSync(path.join(tempHome, '.gemini'), { recursive: true });

        try {
            const agent = createAgent(path.join(tempHome, '.gemini'));
            const args = (agent as unknown as {
                buildDockerArgs(params: {
                    worktreePath: string;
                    githubToken: string;
                    prompt?: string;
                    modelName?: string;
                    issueNumber: number;
                }): string[];
            }).buildDockerArgs({
                worktreePath: '/tmp/worktree',
                githubToken: '',
                prompt: 'Summarize this repo',
                modelName: 'antigravity-gpt-oss-120b-medium',
                issueNumber: 0
            });

            // Model must be the CLI display name, never the namespaced id.
            const modelIdx = args.indexOf('--model');
            assert.ok(modelIdx >= 0, '--model flag should be present');
            assert.strictEqual(args[modelIdx + 1], 'GPT-OSS 120B (Medium)');
            assert.ok(!args.includes('antigravity-gpt-oss-120b-medium'), 'prefixed id must not be passed to the CLI');

            // The prompt must be the positional arg immediately after the `$0`
            // placeholder ('propr-antigravity') so `agy --print "$@"` receives it
            // as the value of --print, and it must come BEFORE --model.
            const argvStart = args.indexOf('propr-antigravity');
            assert.ok(argvStart >= 0, 'propr-antigravity $0 placeholder should be present');
            assert.strictEqual(args[argvStart + 1], 'Summarize this repo', 'prompt must be the first positional arg');
            const promptIdx = args.indexOf('Summarize this repo');
            assert.ok(promptIdx >= 0 && promptIdx < modelIdx, 'prompt must precede --model');
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
