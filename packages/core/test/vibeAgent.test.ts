import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VibeAgent } from '../src/agents/impl/VibeAgent.js';
import { splitVibeCliArgs, writeVibePromptFile } from '../src/agents/impl/utils/vibeAgentHelpers.js';
import { db } from '../src/db/connection.js';
import type { AgentConfig } from '../src/agents/types.js';

type VibeAgentPrivate = {
    buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        issueNumber: number;
        mode?: 'execute' | 'analysis';
    }): string[];
};

const originalVibeCliArgs = process.env.VIBE_CLI_ARGS;
const originalMistralApiKey = process.env.MISTRAL_API_KEY;
const originalVibePromptCacheDir = process.env.VIBE_PROMPT_CACHE_DIR;

after(async () => {
    if (originalVibeCliArgs === undefined) {
        delete process.env.VIBE_CLI_ARGS;
    } else {
        process.env.VIBE_CLI_ARGS = originalVibeCliArgs;
    }
    if (originalMistralApiKey === undefined) {
        delete process.env.MISTRAL_API_KEY;
    } else {
        process.env.MISTRAL_API_KEY = originalMistralApiKey;
    }
    if (originalVibePromptCacheDir === undefined) {
        delete process.env.VIBE_PROMPT_CACHE_DIR;
    } else {
        process.env.VIBE_PROMPT_CACHE_DIR = originalVibePromptCacheDir;
    }
    await db.destroy();
});

function createAgent(envVars?: Record<string, string>, configPath = '/tmp/missing-vibe-config'): VibeAgentPrivate {
    const config: AgentConfig = {
        id: 'vibe-test',
        type: 'vibe',
        alias: 'vibe-test',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath,
        supportedModels: ['mistral-medium-3.5'],
        envVars
    };
    return new VibeAgent(config) as unknown as VibeAgentPrivate;
}

test('Vibe Docker args use supported default CLI invocation', () => {
    delete process.env.VIBE_CLI_ARGS;
    process.env.MISTRAL_API_KEY = 'test-key';
    const args = createAgent().buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        issueNumber: 0,
        mode: 'analysis'
    });

    const imageIndex = args.indexOf('propr/agent:latest');
    assert.deepEqual(args.slice(imageIndex + 1), ['--output', 'json']);
    assert.equal(args.some(arg => arg.includes('propr-vibe-prompt.md')), false);

    const networkIndex = args.indexOf('--network');
    assert.ok(networkIndex !== -1);
    assert.equal(args[networkIndex + 1], 'bridge');
});

test('Vibe Docker args honor VIBE_CLI_ARGS override', () => {
    process.env.VIBE_CLI_ARGS = 'vibe --output json "two words"';
    process.env.MISTRAL_API_KEY = 'test-key';
    const args = createAgent().buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        issueNumber: 0,
        mode: 'analysis'
    });

    const imageIndex = args.indexOf('propr/agent:latest');
    assert.deepEqual(args.slice(imageIndex + 1), ['vibe', '--output', 'json', 'two words']);
});

test('Vibe Docker args can read CLI override from agent env vars', () => {
    delete process.env.VIBE_CLI_ARGS;
    process.env.MISTRAL_API_KEY = 'test-key';
    const args = createAgent({ VIBE_CLI_ARGS: 'vibe --plain --output json' }).buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        issueNumber: 0,
        mode: 'analysis'
    });

    const imageIndex = args.indexOf('propr/agent:latest');
    assert.deepEqual(args.slice(imageIndex + 1), ['vibe', '--plain', '--output', 'json']);
});

test('Vibe CLI arg splitter handles quotes and escaped spaces', () => {
    assert.deepEqual(
        splitVibeCliArgs('vibe --flag "two words" escaped\\ value'),
        ['vibe', '--flag', 'two words', 'escaped value']
    );
    assert.throws(() => splitVibeCliArgs("vibe 'unterminated"), /unmatched quote/);
});

test('Vibe Docker args accept mounted Vibe config env file credentials', () => {
    delete process.env.MISTRAL_API_KEY;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-config-'));
    try {
        fs.writeFileSync(path.join(configDir, 'config.toml'), 'active_model = "mistral-medium-3.5"\n');
        fs.writeFileSync(path.join(configDir, '.env'), 'MISTRAL_API_KEY=test-key\n', { mode: 0o600 });

        const args = createAgent(undefined, configDir).buildDockerArgs({
            worktreePath: process.cwd(),
            githubToken: 'token',
            issueNumber: 191
        });

        assert.ok(args.includes(`${configDir}:/home/node/.vibe:ro`));
    } finally {
        fs.rmSync(configDir, { recursive: true, force: true });
    }
});

test('Vibe prompt files are readable by spawned agent container user', () => {
    const promptCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-prompts-'));
    process.env.VIBE_PROMPT_CACHE_DIR = promptCacheDir;
    try {
        const promptPath = writeVibePromptFile('test prompt');
        const promptDir = path.dirname(promptPath);
        assert.equal(fs.statSync(promptDir).mode & 0o777, 0o755);
        assert.equal(fs.statSync(promptPath).mode & 0o777, 0o644);
    } finally {
        fs.rmSync(promptCacheDir, { recursive: true, force: true });
        delete process.env.VIBE_PROMPT_CACHE_DIR;
    }
});
