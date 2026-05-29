import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { VibeAgent } from '../src/agents/impl/VibeAgent.js';
import { splitVibeCliArgs } from '../src/agents/impl/utils/vibeAgentHelpers.js';
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

after(async () => {
    if (originalVibeCliArgs === undefined) {
        delete process.env.VIBE_CLI_ARGS;
    } else {
        process.env.VIBE_CLI_ARGS = originalVibeCliArgs;
    }
    await db.destroy();
});

function createAgent(envVars?: Record<string, string>): VibeAgentPrivate {
    const config: AgentConfig = {
        id: 'vibe-test',
        type: 'vibe',
        alias: 'vibe-test',
        enabled: true,
        dockerImage: 'propr/agent-vibe:latest',
        configPath: '/tmp/missing-vibe-config',
        supportedModels: ['mistral-medium-3.5'],
        envVars
    };
    return new VibeAgent(config) as unknown as VibeAgentPrivate;
}

test('Vibe Docker args use stdin-oriented default CLI invocation', () => {
    delete process.env.VIBE_CLI_ARGS;
    const args = createAgent().buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        issueNumber: 0,
        mode: 'analysis'
    });

    const imageIndex = args.indexOf('propr/agent-vibe:latest');
    assert.deepEqual(args.slice(imageIndex + 1), ['vibe']);
    assert.equal(args.some(arg => arg.includes('propr-vibe-prompt.md')), false);
});

test('Vibe Docker args honor VIBE_CLI_ARGS override', () => {
    process.env.VIBE_CLI_ARGS = 'vibe --headless "two words"';
    const args = createAgent().buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        issueNumber: 0,
        mode: 'analysis'
    });

    const imageIndex = args.indexOf('propr/agent-vibe:latest');
    assert.deepEqual(args.slice(imageIndex + 1), ['vibe', '--headless', 'two words']);
});

test('Vibe Docker args can read CLI override from agent env vars', () => {
    delete process.env.VIBE_CLI_ARGS;
    const args = createAgent({ VIBE_CLI_ARGS: 'vibe --plain' }).buildDockerArgs({
        worktreePath: process.cwd(),
        githubToken: 'token',
        issueNumber: 0,
        mode: 'analysis'
    });

    const imageIndex = args.indexOf('propr/agent-vibe:latest');
    assert.deepEqual(args.slice(imageIndex + 1), ['vibe', '--plain']);
});

test('Vibe CLI arg splitter handles quotes and escaped spaces', () => {
    assert.deepEqual(
        splitVibeCliArgs('vibe --flag "two words" escaped\\ value'),
        ['vibe', '--flag', 'two words', 'escaped value']
    );
    assert.throws(() => splitVibeCliArgs("vibe 'unterminated"), /unmatched quote/);
});
