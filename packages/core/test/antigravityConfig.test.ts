import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import os from 'node:os';
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

const antigravityEnvKeys = ['ANTIGRAVITY_CONFIG_PATH', 'GEMINI_CONFIG_PATH'] as const;

function withAntigravityEnv(env: Partial<Record<typeof antigravityEnvKeys[number], string>>, fn: () => void): void {
    const previous = new Map<typeof antigravityEnvKeys[number], string | undefined>();
    for (const key of antigravityEnvKeys) {
        previous.set(key, process.env[key]);
        delete process.env[key];
    }
    for (const [key, value] of Object.entries(env)) {
        process.env[key as typeof antigravityEnvKeys[number]] = value;
    }

    try {
        fn();
    } finally {
        for (const key of antigravityEnvKeys) {
            const value = previous.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function buildDockerArgs(agent: AntigravityAgent, params: {
    worktreePath?: string;
    githubToken?: string;
    modelName?: string;
    issueNumber?: number;
    outputFormat?: 'stream-json' | 'text';
    taskId?: string;
} = {}): string[] {
    return (agent as unknown as {
        buildDockerArgs(params: {
            worktreePath: string;
            githubToken: string;
            modelName?: string;
            issueNumber: number;
            outputFormat?: 'stream-json' | 'text';
            taskId?: string;
        }): string[];
    }).buildDockerArgs({
        worktreePath: params.worktreePath || '/tmp/workspace',
        githubToken: params.githubToken || 'token',
        modelName: params.modelName,
        issueNumber: params.issueNumber ?? 123,
        outputFormat: params.outputFormat,
        taskId: params.taskId
    });
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

test('Antigravity execution invokes agy with stream JSON output', () => {
    withAntigravityEnv({}, () => {
        const agent = new AntigravityAgent(createAntigravityConfig());
        const args = buildDockerArgs(agent, { modelName: 'antigravity:antigravity-gemini-3-pro-preview' });
        const imageIndex = args.indexOf('propr/agent-antigravity:latest');
        const entrypointIndex = args.indexOf('/home/node/antigravity-entrypoint.sh');

        assert.ok(imageIndex > -1);
        assert.ok(entrypointIndex > imageIndex);
        assert.equal(args[entrypointIndex + 1], 'agy');
        assert.ok(args.includes('--output-format'));
        assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
        assert.ok(args.includes('-m'));
        assert.equal(args[args.indexOf('-m') + 1], 'gemini-3-pro-preview');
    });
});

test('Antigravity config path prefers ANTIGRAVITY_CONFIG_PATH over legacy GEMINI_CONFIG_PATH', () => {
    withAntigravityEnv({
        ANTIGRAVITY_CONFIG_PATH: '/tmp/antigravity-config',
        GEMINI_CONFIG_PATH: '/tmp/gemini-config'
    }, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '/tmp/stored-config' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes('/tmp/antigravity-config:/home/node/.antigravity:rw'));
        assert.equal(args.includes('/tmp/gemini-config:/home/node/.antigravity:rw'), false);
    });
});

test('Antigravity config path falls back to legacy GEMINI_CONFIG_PATH temporarily', () => {
    withAntigravityEnv({ GEMINI_CONFIG_PATH: '/tmp/gemini-config' }, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '/tmp/stored-config' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes('/tmp/gemini-config:/home/node/.antigravity:rw'));
    });
});

test('Antigravity config path uses stored config when no env override is set', () => {
    withAntigravityEnv({}, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '~/.antigravity-test' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes(`${os.homedir()}/.antigravity-test:/home/node/.antigravity:rw`));
    });
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
