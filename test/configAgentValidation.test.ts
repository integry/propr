import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import {
    MANAGED_AGENT_CREDENTIALS_PREFIX,
    getManagedAgentConfigPath
} from '@propr/shared';
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
            dockerImage: 'propr/agent:latest',
            configPath: '~/.config/opencode',
            supportedModels: ['opencode-deepseek-v4-flash-free'],
            defaultModel: 'opencode-deepseek-v4-flash-free',
            cliVersionType: 'default'
        }];

        assert.strictEqual(validateAgentsConfig(agents), null);
    });

    test('accepts only the generated per-agent managed credential path', async () => {
        const { validateAgentsConfig } = await import('../packages/api/routes/configAgentValidation.js');
        const managedAgent: AgentConfig = {
            id: 'codex-1',
            type: 'codex',
            alias: 'codex',
            enabled: true,
            dockerImage: 'propr/agent:latest',
            configPath: getManagedAgentConfigPath('codex-1', 'codex'),
            supportedModels: ['gpt-5.6-sol'],
            defaultModel: 'gpt-5.6-sol',
            cliVersionType: 'default'
        };

        assert.strictEqual(validateAgentsConfig([managedAgent]), null);
        assert.match(
            validateAgentsConfig([{
                ...managedAgent,
                configPath: `${MANAGED_AGENT_CREDENTIALS_PREFIX}/another-agent/.codex`
            }]) ?? '',
            /invalid ProPR-managed credential path/
        );
        assert.match(
            validateAgentsConfig([{
                ...managedAgent,
                configPath: MANAGED_AGENT_CREDENTIALS_PREFIX
            }]) ?? '',
            /invalid ProPR-managed credential path/
        );
    });
});
