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
            supportedModels: ['opencode-big-pickle'],
            defaultModel: 'opencode-big-pickle',
            cliVersionType: 'default'
        }];

        assert.strictEqual(validateAgentsConfig(agents), null);
    });

    test('accepts registered agent runtimes and normalizes the name', async () => {
        const { normalizeAgentsConfig, validateAgentsConfig } = await import('../packages/api/routes/configAgentValidation.js');
        const agent = (runtime: unknown): AgentConfig => ({
            id: 'claude-1', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest',
            configPath: '/home/user/.claude', supportedModels: ['claude-opus-5-5'], cliVersionType: 'default', runtime: runtime as string,
        });
        const [normalized] = normalizeAgentsConfig([agent(' Sprites ')]);
        assert.strictEqual(normalized.runtime, 'sprites');
        assert.strictEqual(validateAgentsConfig([normalized]), null);
        assert.strictEqual(validateAgentsConfig([agent('docker')]), null);
        assert.strictEqual(validateAgentsConfig([agent(undefined)]), null);
        assert.match(validateAgentsConfig([agent('podman')]) ?? '', /invalid runtime 'podman'.*docker, sprites/);
        assert.match(validateAgentsConfig([agent(42)]) ?? '', /invalid runtime '42'/);
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
