import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { AGENT_DEFAULTS, getManagedAgentConfigPath } from '@propr/shared';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.js';
import { AGENT_DEFAULT_VERSIONS } from '../packages/core/src/agents/version/types.js';

process.env.NODE_ENV = 'test';

let migrateAgentConfig: typeof import('../packages/core/src/config/configManagerAgents.js').migrateAgentConfig;
let resolveConfigPath: typeof import('../packages/core/src/config/configManagerAgents.js').resolveConfigPath;
let resolveCodexConfigPath: typeof import('../packages/core/src/config/configManagerAgents.js').resolveCodexConfigPath;
let closeConnection: typeof import('../packages/core/src/db/connection.js').closeConnection;

before(async () => {
    ({ migrateAgentConfig, resolveCodexConfigPath, resolveConfigPath } = await import('../packages/core/src/config/configManagerAgents.js'));
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
    test('uses the mounted Codex host mapping instead of the backend HOME for the portable default', () => {
        const environment = {
            HOME: '/root',
            PROPR_CONTAINERIZED: '1',
            CODEX_CONFIG_PATH: '/home/desktop-user/.codex'
        };
        assert.strictEqual(resolveConfigPath('~/.codex', environment), '/home/desktop-user/.codex');
        assert.strictEqual(resolveCodexConfigPath('~/.codex', environment), '/home/desktop-user/.codex');
    });

    test('uses HOST_CODEX_DIR when the normalized backend mapping is not present', () => {
        assert.strictEqual(
            resolveCodexConfigPath('~/.codex', {
                HOME: '/root',
                PROPR_CONTAINERIZED: '1',
                HOST_CODEX_DIR: '/home/desktop-user/.codex'
            }),
            '/home/desktop-user/.codex'
        );
    });

    test('preserves an explicit custom Codex config path despite a provider-wide mapping', () => {
        assert.strictEqual(
            resolveCodexConfigPath('/srv/custom-codex', {
                HOME: '/root',
                PROPR_CONTAINERIZED: '1',
                CODEX_CONFIG_PATH: '/home/desktop-user/.codex'
            }),
            '/srv/custom-codex'
        );
    });

    test('rejects an ambiguous custom tilde path instead of using the backend account', () => {
        assert.throws(
            () => resolveCodexConfigPath('~/.codex-other', {
                HOME: '/root',
                PROPR_CONTAINERIZED: '1',
                CODEX_CONFIG_PATH: '/home/desktop-user/.codex'
            }),
            /Custom Codex credential paths must be absolute/
        );
    });

    test('preserves a managed Codex path despite a provider-wide mapping', () => {
        assert.strictEqual(
            resolveCodexConfigPath(getManagedAgentConfigPath('codex-1', 'codex'), {
                HOME: '/root',
                PROPR_CONTAINERIZED: '1',
                CODEX_CONFIG_PATH: '/home/desktop-user/.codex',
                PROPR_MANAGED_CREDENTIALS_DIR: '/srv/propr-managed'
            }),
            '/srv/propr-managed/codex-1/.codex'
        );
    });

    test('fails clearly when a containerized portable Codex config has no host mapping', () => {
        assert.throws(
            () => resolveCodexConfigPath('~/.codex', { HOME: '/root', PROPR_CONTAINERIZED: '1' }),
            /has no host mapping.*HOST_CODEX_DIR/
        );
    });

    test('detects a Docker container without requiring PROPR_CONTAINERIZED', (t) => {
        const keys = ['HOME', 'PROPR_CONTAINERIZED', 'CODEX_CONFIG_PATH', 'HOST_CODEX_DIR'] as const;
        const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        t.mock.method(fs, 'existsSync', value => value === '/.dockerenv');
        try {
            process.env.HOME = '/root';
            delete process.env.PROPR_CONTAINERIZED;
            delete process.env.CODEX_CONFIG_PATH;
            delete process.env.HOST_CODEX_DIR;

            assert.throws(
                () => resolveCodexConfigPath('~/.codex'),
                /has no host mapping.*HOST_CODEX_DIR/
            );
        } finally {
            for (const key of keys) {
                const value = previous[key];
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test('resolves portable managed credentials through the deployment root', () => {
        const previous = process.env.PROPR_MANAGED_CREDENTIALS_DIR;
        try {
            process.env.PROPR_MANAGED_CREDENTIALS_DIR = '/srv/propr-managed';
            assert.strictEqual(
                resolveConfigPath(getManagedAgentConfigPath('codex-1', 'codex')),
                '/srv/propr-managed/codex-1/.codex'
            );
        } finally {
            if (previous === undefined) delete process.env.PROPR_MANAGED_CREDENTIALS_DIR;
            else process.env.PROPR_MANAGED_CREDENTIALS_DIR = previous;
        }
    });

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
        assert.ok(agent.supportedModels.includes('claude-opus-5-5'));
        assert.ok(agent.supportedModels.includes('claude-opus-5'));
        assert.ok(agent.supportedModels.includes('claude-sonnet-5'));
        assert.ok(agent.supportedModels.includes('claude-fable-5-1'));
        assert.ok(agent.supportedModels.includes('claude-opus-4-6'));
        assert.ok(agent.supportedModels.includes('claude-sonnet-4-6'));
    });

    test('moves Claude agents defaulting to Opus 5 onto Opus 5.5', () => {
        const agent = createAgent({
            type: 'claude',
            supportedModels: ['claude-opus-5', 'claude-sonnet-5'],
            defaultModel: 'claude-opus-5'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.ok(agent.supportedModels.includes('claude-opus-5-5'));
        assert.strictEqual(agent.defaultModel, 'claude-opus-5-5');
    });

    test('keeps a deliberate non-Opus Claude default model', () => {
        const agent = createAgent({
            type: 'claude',
            supportedModels: ['claude-fable-5-1', 'claude-opus-5'],
            defaultModel: 'claude-fable-5-1'
        });

        migrateAgentConfig(agent);

        assert.ok(agent.supportedModels.includes('claude-opus-5-5'));
        assert.strictEqual(agent.defaultModel, 'claude-fable-5-1');
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
        assert.ok(codex.supportedModels.includes('gpt-6-astra'));
        assert.strictEqual(codex.defaultModel, 'gpt-6-astra');
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
        assert.strictEqual(agent.defaultModel, 'gpt-6-astra');
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
        assert.ok(agent.supportedModels.includes('gpt-6-astra'));
        assert.strictEqual(agent.defaultModel, 'gpt-6-astra');
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
            supportedModels: [...AGENT_DEFAULTS.opencode.defaultModels],
            defaultModel: AGENT_DEFAULTS.opencode.defaultModels[0],
            cliVersionType: 'default',
            cliVersionResolved: AGENT_DEFAULT_VERSIONS.opencode
        });

        assert.strictEqual(migrateAgentConfig(agent), false);
        assert.strictEqual(agent.dockerImage, 'propr/agent:bundle-abc123-def456');
    });

    test('advances stale default CLI versions for every agent type', () => {
        const agent = createAgent({
            type: 'opencode',
            supportedModels: ['opencode-deepseek-v4-flash-free'],
            defaultModel: 'opencode-deepseek-v4-flash-free',
            cliVersionType: 'default',
            cliVersion: 'latest',
            cliVersionResolved: '1.17.10'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.strictEqual(agent.cliVersionResolved, AGENT_DEFAULT_VERSIONS.opencode);
        assert.strictEqual(agent.cliVersion, undefined);
    });

    test('replaces retired OpenCode defaults while preserving authenticated provider models', () => {
        const agent = createAgent({
            type: 'opencode',
            supportedModels: ['opencode-minimax-m3-free', 'opencode-openai/gpt-5.5'],
            defaultModel: 'opencode-minimax-m3-free',
            cliVersionType: 'default',
            cliVersionResolved: AGENT_DEFAULT_VERSIONS.opencode
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.ok(!agent.supportedModels.includes('opencode-minimax-m3-free'));
        assert.ok(agent.supportedModels.includes('opencode-big-pickle'));
        assert.ok(agent.supportedModels.includes('opencode-ling-3.0-flash-fin-free'));
        assert.ok(agent.supportedModels.includes('opencode-muse-spark-1.3-contributor-free'));
        assert.ok(!agent.supportedModels.includes('opencode-deepseek-v4-flash-free'));
        assert.ok(agent.supportedModels.includes('opencode-openai/gpt-5.5'));
        assert.strictEqual(agent.defaultModel, 'opencode-big-pickle');
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

    test('adds Gemini 3.8 tiers without changing an existing Antigravity default', () => {
        const existingDefault = 'antigravity-gemini-3.6-flash-medium';
        const agent = createAgent({
            type: 'antigravity',
            supportedModels: [existingDefault],
            defaultModel: existingDefault,
            cliVersionType: 'default',
            cliVersionResolved: '1.1.11'
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.ok(agent.supportedModels.includes('antigravity-gemini-3.8-flash-high'));
        assert.ok(agent.supportedModels.includes('antigravity-gemini-3.8-flash-medium'));
        assert.ok(agent.supportedModels.includes('antigravity-gemini-3.8-flash-low'));
        assert.strictEqual(agent.defaultModel, existingDefault);
        assert.strictEqual(agent.cliVersionResolved, AGENT_DEFAULT_VERSIONS.antigravity);
    });

    test('removes retired Vibe models and repairs a stale default', () => {
        const agent = createAgent({
            type: 'vibe',
            supportedModels: ['devstral-small'],
            defaultModel: 'devstral-small',
            cliVersionType: 'default',
            cliVersionResolved: AGENT_DEFAULT_VERSIONS.vibe
        });

        assert.strictEqual(migrateAgentConfig(agent), true);
        assert.deepStrictEqual(agent.supportedModels, ['mistral-medium-3.5']);
        assert.strictEqual(agent.defaultModel, 'mistral-medium-3.5');
    });
});
