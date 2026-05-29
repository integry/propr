import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { VibeAgent } from '../src/agents/impl/VibeAgent.js';
import { db } from '../src/db/connection.js';
import type { AgentConfig } from '../src/agents/types.js';

type VibeAgentPrivate = {
    buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        promptPath: string;
        issueNumber: number;
        mode: 'analysis';
    }): string[];
};

const originalEnv = {
    HOST_VIBE_PROMPT_CACHE_DIR: process.env.HOST_VIBE_PROMPT_CACHE_DIR,
    VIBE_PROMPT_CACHE_DIR: process.env.VIBE_PROMPT_CACHE_DIR,
    VIBE_PROMPT_CACHE_HOST_MOUNTED: process.env.VIBE_PROMPT_CACHE_HOST_MOUNTED
};

afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

after(async () => {
    await db.destroy();
});

function createAgent(): VibeAgentPrivate {
    const config: AgentConfig = {
        id: 'vibe-test',
        type: 'vibe',
        alias: 'vibe-test',
        enabled: true,
        dockerImage: 'propr/agent-vibe:latest',
        configPath: '/tmp/missing-vibe-config',
        supportedModels: ['mistral-medium-3.5']
    };
    return new VibeAgent(config) as unknown as VibeAgentPrivate;
}

function getPromptMount(args: string[]): string {
    const mountIndex = args.findIndex((arg, index) => arg === '-v' && args[index + 1]?.endsWith(':/tmp/propr-vibe-prompt.md:ro'));
    assert.notEqual(mountIndex, -1);
    return args[mountIndex + 1];
}

test('Vibe prompt mounts use the container path unless host cache translation is launcher-marked', () => {
    const containerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-container-'));
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-host-'));
    const promptPath = path.join(containerDir, 'prompt.md');
    fs.writeFileSync(promptPath, 'hello');
    process.env.VIBE_PROMPT_CACHE_DIR = containerDir;
    process.env.HOST_VIBE_PROMPT_CACHE_DIR = hostDir;
    delete process.env.VIBE_PROMPT_CACHE_HOST_MOUNTED;

    const args = createAgent().buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        promptPath,
        issueNumber: 0,
        mode: 'analysis'
    });

    assert.equal(getPromptMount(args), `${promptPath}:/tmp/propr-vibe-prompt.md:ro`);
});

test('Vibe prompt mounts translate to host cache paths for launcher-mounted caches', () => {
    const containerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-container-'));
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-host-'));
    const promptPath = path.join(containerDir, 'nested', 'prompt.md');
    fs.mkdirSync(path.dirname(promptPath));
    fs.writeFileSync(promptPath, 'hello');
    process.env.VIBE_PROMPT_CACHE_DIR = containerDir;
    process.env.HOST_VIBE_PROMPT_CACHE_DIR = hostDir;
    process.env.VIBE_PROMPT_CACHE_HOST_MOUNTED = '1';

    const args = createAgent().buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        promptPath,
        issueNumber: 0,
        mode: 'analysis'
    });

    assert.equal(getPromptMount(args), `${path.join(hostDir, 'nested', 'prompt.md')}:/tmp/propr-vibe-prompt.md:ro`);
});
