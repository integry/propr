import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
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
        configPath: '~/.gemini',
        supportedModels: ['antigravity-gemini-3.5-flash-medium', 'antigravity-claude-opus-4.6-thinking'],
        defaultModel: 'antigravity-gemini-3.5-flash-medium',
        ...overrides
    };
}

const antigravityEnvKeys = ['ANTIGRAVITY_CONFIG_PATH'] as const;

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
    taskId?: string;
} = {}): string[] {
    return (agent as unknown as {
        buildDockerArgs(params: {
            worktreePath: string;
            githubToken: string;
            modelName?: string;
            issueNumber: number;
            taskId?: string;
        }): string[];
    }).buildDockerArgs({
        worktreePath: params.worktreePath || '/tmp/workspace',
        githubToken: params.githubToken || 'token',
        modelName: params.modelName,
        issueNumber: params.issueNumber ?? 123,
        taskId: params.taskId
    });
}

test('Antigravity is the canonical selectable agent type', () => {
    assert.ok(AGENT_TYPES.includes('antigravity'));
    assert.equal(AGENT_TYPES.includes('gemini' as never), false);
    assert.equal(AGENT_DEFAULTS.antigravity.defaultAlias, 'antigravity');
    assert.equal(AGENT_DEFAULTS.antigravity.configPath, '~/.gemini');
    assert.equal(AGENT_DEFAULTS.antigravity.dockerImage, 'propr/agent-antigravity:latest');
    assert.equal(AGENT_MODELS.antigravity, ANTIGRAVITY_MODELS);
});

test('Antigravity metadata includes non-Google model families', () => {
    const opusModel = MODEL_INFO_MAP['antigravity-claude-opus-4.6-thinking'];
    assert.equal(opusModel.name, 'Antigravity Claude Opus 4.6 Thinking');
    assert.equal(opusModel.openRouterId, 'anthropic/claude-opus-4.6');
    assert.equal(getModelHardLimit('antigravity-claude-opus-4.6-thinking'), 980000);
});

test('AgentRegistry creates AntigravityAgent for antigravity configs', () => {
    const registry = AgentRegistry.getInstance();
    const agent = registry.createAgentFromConfig(createAntigravityConfig());
    assert.ok(agent instanceof AntigravityAgent);
});

test('Antigravity execution invokes agy with print-mode CLI flags', () => {
    withAntigravityEnv({}, () => {
        const agent = new AntigravityAgent(createAntigravityConfig());
        const args = buildDockerArgs(agent, { modelName: 'antigravity:antigravity-gemini-3.1-pro-high' });
        const imageIndex = args.indexOf('propr/agent-antigravity:latest');
        const entrypointIndex = args.indexOf('/home/node/antigravity-entrypoint.sh');

        assert.ok(imageIndex > -1);
        assert.ok(entrypointIndex > imageIndex);
        assert.equal(args[entrypointIndex + 1], '/bin/bash');
        assert.equal(args[entrypointIndex + 2], '-lc');
        assert.match(args[entrypointIndex + 3], /--dangerously-skip-permissions/);
        assert.match(args[entrypointIndex + 3], /--print "\$prompt"/);
        assert.equal(args[entrypointIndex + 4], 'propr-antigravity');
        assert.ok(!args.includes('--output-format'));
        assert.ok(!args.includes('--yolo'));
        assert.ok(!args.includes('--skip-trust'));
        assert.ok(args.includes('--model'));
        assert.equal(args[args.indexOf('--model') + 1], 'Gemini 3.1 Pro (High)');
    });
});

test('Antigravity output parser falls back to plain print output', () => {
    const agent = new AntigravityAgent(createAntigravityConfig());
    const parsed = (agent as unknown as {
        parseAntigravityJsonl(output: string): { summary?: string; conversationLog: unknown[] };
    }).parseAntigravityJsonl('antigravity-ok\n');

    assert.equal(parsed.summary, 'antigravity-ok');
    assert.deepEqual(parsed.conversationLog, []);
});

test('Antigravity output parser reads real transcript JSONL events', () => {
    const agent = new AntigravityAgent(createAntigravityConfig());
    const transcript = [
        JSON.stringify({
            step_index: 0,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            status: 'DONE',
            created_at: '2026-06-06T09:40:25Z',
            content: '<USER_REQUEST>\nReply with exactly: transcript-ok\n</USER_REQUEST>'
        }),
        JSON.stringify({
            step_index: 2,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '2026-06-06T09:40:25Z',
            content: 'transcript-ok'
        })
    ].join('\n');

    const parsed = (agent as unknown as {
        parseAntigravityJsonl(output: string): { summary?: string; conversationLog: unknown[] };
    }).parseAntigravityJsonl(transcript);

    assert.equal(parsed.summary, 'transcript-ok');
    assert.equal(parsed.conversationLog.length, 2);
});

test('Antigravity session recovery reads last conversation cache and transcript', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'antigravity-config-'));
    const previousConfigPath = process.env.ANTIGRAVITY_CONFIG_PATH;
    process.env.ANTIGRAVITY_CONFIG_PATH = tempDir;

    try {
        const sessionId = '758451e9-8997-4c87-b246-c99436a3629d';
        await fs.promises.mkdir(path.join(tempDir, 'antigravity-cli', 'cache'), { recursive: true });
        await fs.promises.mkdir(path.join(tempDir, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs'), { recursive: true });
        await fs.promises.writeFile(
            path.join(tempDir, 'antigravity-cli', 'cache', 'last_conversations.json'),
            JSON.stringify({ '/home/node/workspace': sessionId }),
            'utf8'
        );
        await fs.promises.writeFile(
            path.join(tempDir, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
            JSON.stringify({
                step_index: 2,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-06-06T09:40:25Z',
                content: 'persisted-session-ok'
            }) + '\n',
            'utf8'
        );

        const agent = new AntigravityAgent(createAntigravityConfig());
        const recovered = await (agent as unknown as {
            readPersistedSessionOutput(worktreePath: string): Promise<{ sessionId?: string; summary?: string; conversationLog: unknown[] }>;
        }).readPersistedSessionOutput('/tmp/worktree');

        assert.equal(recovered.sessionId, sessionId);
        assert.equal(recovered.summary, 'persisted-session-ok');
        assert.equal(recovered.conversationLog.length, 1);
    } finally {
        if (previousConfigPath === undefined) delete process.env.ANTIGRAVITY_CONFIG_PATH;
        else process.env.ANTIGRAVITY_CONFIG_PATH = previousConfigPath;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

test('Antigravity config path uses ANTIGRAVITY_CONFIG_PATH env override', () => {
    withAntigravityEnv({ ANTIGRAVITY_CONFIG_PATH: '/tmp/antigravity-config' }, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '/tmp/stored-config' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes('/tmp/antigravity-config:/home/node/.gemini:rw'));
    });
});

test('Antigravity config path uses stored config when no env override is set', () => {
    withAntigravityEnv({}, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '~/.gemini-test' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes(`${os.homedir()}/.gemini-test:/home/node/.gemini:rw`));
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

    const resolution = await resolveLlmLabel('antigravity-flash-medium');
    assert.deepEqual(resolution, {
        agentAlias: 'antigravity',
        model: 'antigravity-gemini-3.5-flash-medium'
    });

    assert.equal(resolveModelAlias('antigravity-flash-medium'), 'antigravity-gemini-3.5-flash-medium');

    const prefixedResolution = await resolveLlmLabel('llm-antigravity-flash-medium'.replace(/^llm-/, ''));
    assert.deepEqual(prefixedResolution, {
        agentAlias: 'antigravity',
        model: 'antigravity-gemini-3.5-flash-medium'
    });

    const scopedResolution = await resolveLlmLabel('antigravity:antigravity-gemini-3.5-flash-medium');
    assert.deepEqual(scopedResolution, {
        agentAlias: 'antigravity',
        model: 'antigravity-gemini-3.5-flash-medium'
    });
});
