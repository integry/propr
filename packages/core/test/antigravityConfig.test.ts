import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AGENT_TYPES } from '@propr/shared';
import {
    AGENT_DEFAULTS,
    AGENT_MODELS,
    MODEL_INFO_MAP,
    ANTIGRAVITY_MODELS
} from '../src/config/modelDefinitions.js';
import { getModelHardLimit } from '../src/config/modelLimits.js';
import { resolveLlmLabel, resolveModelAlias } from '../src/config/modelAliases.js';
import { AgentRegistry } from '../src/agents/AgentRegistry.js';
import { AntigravityAgent } from '../src/agents/impl/AntigravityAgent.js';
import type { Agent, AgentConfig } from '../src/agents/types.js';
import { db } from '../src/db/connection.js';

after(async () => {
    await db.destroy();
});

function createAntigravityConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        id: 'antigravity-test',
        type: 'antigravity',
        alias: 'antigravity',
        enabled: true,
        dockerImage: 'propr/agent-antigravity:latest',
        configPath: '~/.antigravity',
        supportedModels: ['antigravity-gemini-3-pro-preview', 'antigravity-opus-4-8'],
        defaultModel: 'antigravity-gemini-3-pro-preview',
        ...overrides
    };
}

test('Antigravity is the canonical selectable agent type', () => {
    assert.ok(AGENT_TYPES.includes('antigravity'));
    assert.equal(AGENT_TYPES.includes('gemini' as never), false);
    assert.equal(AGENT_DEFAULTS.antigravity.defaultAlias, 'antigravity');
    assert.equal(AGENT_DEFAULTS.antigravity.configPath, '~/.antigravity');
    assert.equal(AGENT_DEFAULTS.antigravity.dockerImage, 'propr/agent-antigravity:latest');
    assert.equal(AGENT_MODELS.antigravity, ANTIGRAVITY_MODELS);
});

test('Antigravity metadata includes non-Google model families', () => {
    const opusModel = MODEL_INFO_MAP['antigravity-opus-4-8'];
    assert.equal(opusModel.name, 'Antigravity Opus 4.8');
    assert.equal(opusModel.openRouterId, 'anthropic/claude-opus-4.8');
    assert.equal(getModelHardLimit('antigravity-opus-4-8'), 980000);
});

test('AgentRegistry creates AntigravityAgent for antigravity configs', () => {
    const registry = AgentRegistry.getInstance();
    const agent = registry.createAgentFromConfig(createAntigravityConfig());
    assert.ok(agent instanceof AntigravityAgent);
});

test('Antigravity labels resolve to Antigravity models', async () => {
    const registry = AgentRegistry.getInstance() as unknown as {
        initialized: boolean;
        agents: Map<string, Agent>;
        agentsByAlias: Map<string, Agent>;
        defaultAgentAlias: string | null;
    };
    const config = createAntigravityConfig();
    const fakeAgent = { config } as Agent;

    registry.initialized = true;
    registry.defaultAgentAlias = config.alias;
    registry.agents = new Map([[config.id, fakeAgent]]);
    registry.agentsByAlias = new Map([[config.alias, fakeAgent]]);

    const resolution = await resolveLlmLabel('antigravity-pro-preview');
    assert.deepEqual(resolution, {
        agentAlias: 'antigravity',
        model: 'antigravity-gemini-3-pro-preview'
    });

    assert.equal(resolveModelAlias('antigravity-pro-preview'), 'antigravity-gemini-3-pro-preview');

    const prefixedResolution = await resolveLlmLabel('llm-antigravity-pro-preview'.replace(/^llm-/, ''));
    assert.deepEqual(prefixedResolution, {
        agentAlias: 'antigravity',
        model: 'antigravity-gemini-3-pro-preview'
    });

    const scopedResolution = await resolveLlmLabel('antigravity:antigravity-gemini-3-pro-preview');
    assert.deepEqual(scopedResolution, {
        agentAlias: 'antigravity',
        model: 'antigravity-gemini-3-pro-preview'
    });
});
