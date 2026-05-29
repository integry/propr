import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.js';

process.env.NODE_ENV = 'test';

let closeConnection: typeof import('../packages/core/src/db/connection.js').closeConnection;

before(async () => {
    ({ closeConnection } = await import('@propr/core'));
});

after(async () => {
    await closeConnection();
});

describe('agent config validation', () => {
    test('accepts OpenCode agent configs', async () => {
        const { validateAgentsConfig } = await import('../packages/api/routes/configAgentValidation.js');
        const agents: AgentConfig[] = [{
            id: 'opencode-1',
            type: 'opencode',
            alias: 'opencode',
            enabled: true,
            dockerImage: 'propr/agent-opencode:latest',
            configPath: '~/.config/opencode',
            supportedModels: ['opencode-go/kimi-k2.6'],
            defaultModel: 'opencode-go/kimi-k2.6',
            cliVersionType: 'default'
        }];

        assert.strictEqual(validateAgentsConfig(agents), null);
    });
});
