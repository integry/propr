import { after, afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';

// Native-host fixture: `~/.claude` expands against HOME rather than a launcher host mapping.
const previousContainerized = process.env.PROPR_CONTAINERIZED;
process.env.PROPR_CONTAINERIZED = '0';
process.env.PROPR_DEMO_MODE = 'true';

const { db } = await import('../packages/core/src/db/connection.ts');
const { buildDockerArgs } = await import('../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts');

after(async () => {
    if (previousContainerized === undefined) delete process.env.PROPR_CONTAINERIZED;
    else process.env.PROPR_CONTAINERIZED = previousContainerized;
    await db.destroy();
});

afterEach(() => mock.timers.reset());

const claudeConfig: AgentConfig = {
    id: 'claude',
    type: 'claude',
    alias: 'claude',
    enabled: true,
    dockerImage: 'propr/agent:latest',
    configPath: '~/.claude',
    supportedModels: ['claude-sonnet-4-5-20250929', 'claude-sonnet-5-5'],
    defaultModel: 'claude-sonnet-4-5-20250929',
};

function launchedModel(modelName: string, now: string): string {
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: new Date(now) });
    const args = buildDockerArgs(claudeConfig, 1000, { worktreePath: '/tmp/worktree', githubToken: '', modelName, issueNumber: 42 });
    return args[args.indexOf('--model') + 1];
}

test('a saved Sonnet 4.5 selection launches as selected until Anthropic retires it', () => {
    assert.equal(launchedModel('claude:claude-sonnet-4-5-20250929', '2026-11-29T23:59:59Z'), 'claude-sonnet-4-5-20250929');
});

test('a saved Sonnet 4.5 selection launches on Sonnet 5.5 from its 2026-11-30 retirement', () => {
    assert.equal(launchedModel('claude:claude-sonnet-4-5-20250929', '2026-11-30T00:00:00Z'), 'claude-sonnet-5-5');
    assert.equal(launchedModel('claude-sonnet-4-5', '2027-01-01T00:00:00Z'), 'claude-sonnet-5-5');
});

test('active Claude models are never rerouted', () => {
    for (const model of ['claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'claude-fable-5-2']) {
        assert.equal(launchedModel(`claude:${model}`, '2030-01-01T00:00:00Z'), model);
    }
});
