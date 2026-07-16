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
        assert.strictEqual(agent.dockerImage, 'claude-code-processor:latest');
        assert.ok(agent.supportedModels.includes('claude-opus-4-6'));
        assert.ok(agent.supportedModels.includes('claude-sonnet-4-6'));
    });

    test('preserves existing images while updating Codex defaults', () => {
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
        assert.strictEqual(codex.dockerImage, 'codex-code-processor:latest');
        assert.ok(codex.supportedModels.includes('gpt-5.5'));
        assert.strictEqual(codex.defaultModel, 'gpt-5.5');
    });

    test('does not overwrite custom images during default CLI migration', () => {
        const agent = createAgent({
            type: 'codex',
            dockerImage: 'local/codex-custom:latest',
            supportedModels: ['gpt-5.5'],
            defaultModel: 'gpt-5.5'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.strictEqual(agent.cliVersionType, 'default');
        assert.strictEqual(agent.dockerImage, 'local/codex-custom:latest');
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
