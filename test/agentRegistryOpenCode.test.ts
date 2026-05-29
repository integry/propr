import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

process.env.NODE_ENV = 'test';
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agent-registry-'));
process.env.DATA_DIR = testDataDir;

const opencodeConfig: AgentConfig = {
    id: 'opencode-1',
    type: 'opencode',
    alias: 'opencode',
    enabled: true,
    dockerImage: 'propr/agent-opencode:latest',
    configPath: '~/.config/opencode',
    supportedModels: ['opencode-go/kimi-k2.6'],
    defaultModel: 'opencode-go/kimi-k2.6'
};

let AgentRegistry: typeof import('../packages/core/src/agents/AgentRegistry.js').AgentRegistry;
let OpenCodeAgent: typeof import('../packages/core/src/agents/impl/OpenCodeAgent.js').OpenCodeAgent;
let ClaudeAgent: typeof import('../packages/core/src/agents/impl/ClaudeAgent.js').ClaudeAgent;
let runMigrations: typeof import('../packages/core/src/db/connection.js').runMigrations;
let closeConnection: typeof import('../packages/core/src/db/connection.js').closeConnection;
let saveAgents: typeof import('../packages/core/src/config/configManager.js').saveAgents;
let saveSettings: typeof import('../packages/core/src/config/configManager.js').saveSettings;

before(async () => {
    ({ AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js'));
    ({ OpenCodeAgent } = await import('../packages/core/src/agents/impl/OpenCodeAgent.js'));
    ({ ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js'));
    ({ runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js'));
    ({ saveAgents, saveSettings } = await import('../packages/core/src/config/configManager.js'));
    await runMigrations();
});

beforeEach(async () => {
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    await saveAgents([opencodeConfig]);
    await saveSettings({ default_agent_alias: null });
});

after(async () => {
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    await closeConnection();
    fs.rmSync(testDataDir, { recursive: true, force: true });
});

function skipImageChecks(registry: InstanceType<typeof AgentRegistry>): void {
    (registry as unknown as { ensureAgentImage: () => Promise<boolean> }).ensureAgentImage = async () => true;
}

function stubDefaultClaudeRegistration(registry: InstanceType<typeof AgentRegistry>): void {
    (registry as unknown as { registerDefaultAgent: () => Promise<void> }).registerDefaultAgent = async function registerDefaultAgent(this: {
        agents: Map<string, unknown>;
        agentsByAlias: Map<string, unknown>;
    }) {
        const defaultConfig: AgentConfig = {
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            enabled: true,
            dockerImage: 'propr/agent-claude:latest',
            configPath: '~/.claude',
            supportedModels: ['claude-sonnet-4-6'],
            defaultModel: undefined
        };
        const agent = new ClaudeAgent(defaultConfig);
        this.agents.set(defaultConfig.id, agent);
        this.agentsByAlias.set(defaultConfig.alias, agent);
    };
}

test('AgentRegistry registers enabled OpenCode configs by alias', async () => {
    const registry = AgentRegistry.getInstance();
    skipImageChecks(registry);

    await registry.refresh();

    const agent = registry.getAgentByAlias('opencode');
    assert.ok(agent instanceof OpenCodeAgent);
    assert.strictEqual(agent.config.type, 'opencode');
    assert.strictEqual(agent.config.alias, 'opencode');
});

test('AgentRegistry keeps default Claude fallback when no agents are configured', async () => {
    await saveAgents([]);
    const registry = AgentRegistry.getInstance();
    skipImageChecks(registry);
    stubDefaultClaudeRegistration(registry);

    await registry.refresh();

    const defaultAgent = registry.getDefaultAgent();
    assert.ok(defaultAgent);
    assert.strictEqual(defaultAgent.config.type, 'claude');
    assert.strictEqual(defaultAgent.config.alias, 'default');
});
