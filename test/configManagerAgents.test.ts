import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.js';
import { AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.js';

process.env.NODE_ENV = 'test';

let migrateAgentConfig: typeof import('../packages/core/src/config/configManagerAgents.js').migrateAgentConfig;
let closeConnection: typeof import('../packages/core/src/db/connection.js').closeConnection;

before(async () => {
    ({ migrateAgentConfig } = await import('../packages/core/src/config/configManagerAgents.js'));
    ({ closeConnection } = await import('../packages/core/src/db/connection.js'));
});

after(async () => {
    await closeConnection();
});

function createAgent(overrides: Partial<AgentConfig>): AgentConfig {
    return {
        id: 'agent-1',
        type: 'claude',
        alias: 'agent',
        enabled: true,
        dockerImage: 'propr/agent:latest',
        configPath: '/tmp/agent',
        supportedModels: [],
        ...overrides
    };
}

describe('agent config migration', () => {
    test('adds Claude CLI defaults when CLI version fields are missing', () => {
        const agent = createAgent({
            type: 'claude',
            dockerImage: 'claude-code-processor:latest',
            supportedModels: ['claude-haiku-4-5-20251001']
        });

        const migrated = migrateAgentConfig(agent);

        assert.strictEqual(migrated, true);
        assert.strictEqual(agent.cliVersionType, 'default');
        assert.strictEqual(agent.cliVersionResolved, AGENT_DEFAULT_VERSIONS.claude);
        assert.strictEqual(agent.dockerImage, 'propr/agent:latest');
        assert.ok(agent.supportedModels.includes('claude-opus-4-6'));
        assert.ok(agent.supportedModels.includes('claude-sonnet-4-6'));
    });

    test('normalizes legacy agent images while updating Codex defaults', () => {
        const gemini = createAgent({
            id: 'gemini-1',
            type: 'gemini',
            dockerImage: 'propr-gemini:latest',
            supportedModels: ['gemini-2.5-pro']
        });
        const codex = createAgent({
            id: 'codex-1',
            type: 'codex',
            dockerImage: 'codex-code-processor:latest',
            supportedModels: ['gpt-5.4']
        });

        assert.strictEqual(migrateAgentConfig(gemini), true);
        assert.strictEqual(migrateAgentConfig(codex), true);
        assert.strictEqual(gemini.dockerImage, 'propr-gemini:latest');
        assert.strictEqual(codex.dockerImage, 'propr/agent:latest');
        assert.ok(codex.supportedModels.includes('gpt-5.6-sol'));
        assert.ok(codex.supportedModels.includes('gpt-5.6-terra'));
        assert.ok(codex.supportedModels.includes('gpt-5.6-luna'));
        assert.ok(codex.supportedModels.includes('gpt-5.5'));
        assert.strictEqual(codex.defaultModel, 'gpt-5.6-sol');
    });

    test('normalizes custom images during default CLI migration', () => {
        const agent = createAgent({
            type: 'codex',
            dockerImage: 'local/codex-custom:latest',
            supportedModels: ['gpt-5.5'],
            defaultModel: 'gpt-5.5'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.strictEqual(agent.cliVersionType, 'default');
        assert.strictEqual(agent.dockerImage, 'propr/agent:latest');
        assert.strictEqual(agent.defaultModel, 'gpt-5.6-sol');
        assert.strictEqual(agent.cliVersionResolved, AGENT_DEFAULT_VERSIONS.codex);
    });

    test('updates Codex agents defaulting to GPT-5.5 and stale default CLI versions', () => {
        const agent = createAgent({
            type: 'codex',
            supportedModels: ['gpt-5.5'],
            defaultModel: 'gpt-5.5',
            cliVersionType: 'default',
            cliVersionResolved: '0.143.0'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.ok(agent.supportedModels.includes('gpt-5.6-sol'));
        assert.ok(agent.supportedModels.includes('gpt-5.6-terra'));
        assert.ok(agent.supportedModels.includes('gpt-5.6-luna'));
        assert.strictEqual(agent.defaultModel, 'gpt-5.6-sol');
        assert.strictEqual(agent.cliVersionResolved, AGENT_DEFAULT_VERSIONS.codex);
    });

    test('fills in a missing Docker image instead of crashing', () => {
        const agent = createAgent({
            type: 'claude',
            dockerImage: undefined as unknown as string,
            supportedModels: ['claude-sonnet-4-6'],
            defaultModel: 'claude-sonnet-4-6'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.strictEqual(agent.dockerImage, 'propr/agent:latest');
    });

    test('does not renormalize managed bundle image tags', () => {
        const agent = createAgent({
            type: 'opencode',
            dockerImage: 'propr/agent:bundle-abc123-def456',
            supportedModels: ['opencode-minimax-m3-free'],
            defaultModel: 'opencode-minimax-m3-free',
            cliVersionType: 'default',
            cliVersionResolved: AGENT_DEFAULT_VERSIONS.opencode
        });

        assert.strictEqual(migrateAgentConfig(agent), false);
        assert.strictEqual(agent.dockerImage, 'propr/agent:bundle-abc123-def456');
    });

    test('advances stale default CLI versions for every agent type', () => {
        const agent = createAgent({
            type: 'opencode',
            supportedModels: ['opencode-minimax-m3-free'],
            defaultModel: 'opencode-minimax-m3-free',
            cliVersionType: 'default',
            cliVersion: 'latest',
            cliVersionResolved: '1.17.10'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.strictEqual(agent.cliVersionResolved, AGENT_DEFAULT_VERSIONS.opencode);
        assert.strictEqual(agent.cliVersion, undefined);
    });

    test('migrates legacy Antigravity config paths to Gemini credentials', () => {
        const agent = createAgent({
            type: 'antigravity',
            dockerImage: 'propr/agent:latest',
            configPath: '~/.antigravity',
            supportedModels: ['gemini-3-pro']
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.strictEqual(agent.configPath, '~/.gemini');
    });
});
