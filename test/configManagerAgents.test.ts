import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.js';

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
        dockerImage: 'propr/agent-claude:latest',
        configPath: '/tmp/agent',
        supportedModels: [],
        ...overrides
    };
}

describe('agent config migration', () => {
    test('migrates legacy Claude default images when CLI version fields are missing', () => {
        const agent = createAgent({
            type: 'claude',
            dockerImage: 'claude-code-processor:latest',
            supportedModels: ['claude-haiku-4-5-20251001']
        });

        const migrated = migrateAgentConfig(agent);

        assert.strictEqual(migrated, true);
        assert.strictEqual(agent.cliVersionType, 'default');
        assert.strictEqual(agent.cliVersionResolved, '2.1.85');
        assert.strictEqual(agent.dockerImage, 'propr/agent-claude:latest');
        assert.ok(agent.supportedModels.includes('claude-opus-4-6'));
        assert.ok(agent.supportedModels.includes('claude-sonnet-4-6'));
    });

    test('migrates legacy Gemini and Codex image names to registry-qualified defaults', () => {
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
        assert.strictEqual(gemini.dockerImage, 'propr/agent-gemini:latest');
        assert.strictEqual(codex.dockerImage, 'propr/agent-codex:latest');
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
});
