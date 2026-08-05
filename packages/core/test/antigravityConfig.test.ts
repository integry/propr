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
import { filterAntigravityAnalysisEvents, parseAntigravityJsonl } from '../src/agents/impl/utils/antigravityOutputParser.js';
import type { AntigravityOutputEvent } from '../src/agents/impl/utils/antigravityOutputParser.js';
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
        dockerImage: 'propr/agent:latest',
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
    assert.equal(AGENT_DEFAULTS.antigravity.dockerImage, 'propr/agent:latest');
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
        const imageIndex = args.indexOf('propr/agent:latest');
        const entrypointIndex = args.indexOf('/home/node/antigravity-entrypoint.sh');

        assert.ok(imageIndex > -1);
        assert.ok(entrypointIndex > imageIndex);
        assert.equal(args[entrypointIndex + 1], '/bin/bash');
        assert.equal(args[entrypointIndex + 2], '-lc');
        assert.match(args[entrypointIndex + 3], /--dangerously-skip-permissions/);
        assert.match(args[entrypointIndex + 3], /cat > "\$prompt_file"/);
        assert.match(args[entrypointIndex + 3], /--add-dir "\$prompt_dir" --print "Read the complete user request from \$prompt_file/);
        assert.doesNotMatch(args[entrypointIndex + 3], /--print -/);
        assert.equal(args[entrypointIndex + 4], 'propr-antigravity');
        assert.ok(!args.includes('--output-format'));
        assert.ok(!args.includes('--yolo'));
        assert.ok(!args.includes('--skip-trust'));
        assert.ok(args.includes('--model'));
        assert.equal(args[args.indexOf('--model') + 1], 'Gemini 3.1 Pro (High)');
    });
});

test('Antigravity output parser falls back to plain print output', () => {
    const parsed = parseAntigravityJsonl('antigravity-ok\n');

    assert.equal(parsed.summary, 'antigravity-ok');
    assert.deepEqual(parsed.conversationLog, []);
});

test('Antigravity output parser preserves plain responses that are valid JSON values', () => {
    const numeric = parseAntigravityJsonl('2\n');
    const object = parseAntigravityJsonl('{"answer":2}\n');
    const commonType = parseAntigravityJsonl('{"type":"result","value":2}\n');
    const sourceAndType = parseAntigravityJsonl('{"source":"data","type":"answer"}\n');

    assert.equal(numeric.summary, '2');
    assert.equal(object.summary, '{"answer":2}');
    assert.equal(commonType.summary, '{"type":"result","value":2}');
    assert.equal(sourceAndType.summary, '{"source":"data","type":"answer"}');
    assert.deepEqual(numeric.conversationLog, []);
    assert.deepEqual(object.conversationLog, []);
    assert.deepEqual(commonType.conversationLog, []);
    assert.deepEqual(sourceAndType.conversationLog, []);
});

test('Antigravity output parser reads real transcript JSONL events', () => {
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

    const parsed = parseAntigravityJsonl(transcript);

    assert.equal(parsed.summary, 'transcript-ok');
    assert.equal(parsed.conversationLog.length, 2);
});

test('Antigravity output parser accepts camelCase result token stats', () => {
    const parsed = parseAntigravityJsonl(JSON.stringify({
        type: 'result',
        status: 'success',
        stats: { inputTokens: 12, outputTokens: 4 },
        timestamp: '2026-06-06T09:40:25Z'
    }));

    assert.deepEqual(parsed.tokenUsage, { input_tokens: 12, output_tokens: 4 });
});

test('Antigravity display log keeps planner analysis and drops tool output', () => {
    const transcript: AntigravityOutputEvent[] = [
        {
            step_index: 2,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '2026-06-09T10:37:04Z',
            content: 'I will inspect the stylesheet.'
        },
        {
            step_index: 3,
            source: 'MODEL',
            type: 'VIEW_FILE',
            status: 'DONE',
            created_at: '2026-06-09T10:37:04Z',
            content: 'Created At: 2026-06-09T10:37:04Z\n750: .quick-table{'
        },
        {
            step_index: 8,
            source: 'MODEL',
            type: 'CODE_ACTION',
            status: 'DONE',
            created_at: '2026-06-09T10:37:10Z',
            content: '[diff_block_start]\n+  margin-bottom:22px;'
        }
    ];

    const filtered = filterAntigravityAnalysisEvents(transcript);

    assert.equal(filtered.length, 1);
    assert.deepEqual(filtered[0], transcript[0]);
});

test('Antigravity session recovery reads and removes the exported transient transcript', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'propr-antigravity-transcript-'));
    const previousTranscriptRoot = process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT;
    process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT = tempDir;

    try {
        const sessionId = '758451e9-8997-4c87-b246-c99436a3629d';
        const transcriptPath = path.join(tempDir, 'transcript.jsonl');
        await fs.promises.writeFile(
            transcriptPath,
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
            readTransientSessionOutput(transcriptPath: string, sessionId: string): Promise<{ sessionId?: string; summary?: string; conversationLog: unknown[]; tokenUsage?: { input_tokens?: number; output_tokens?: number } }>;
        }).readTransientSessionOutput(transcriptPath, sessionId);

        assert.equal(recovered.sessionId, sessionId);
        assert.equal(recovered.summary, 'persisted-session-ok');
        assert.equal(recovered.conversationLog.length, 1);
        assert.equal(fs.existsSync(transcriptPath), false);
    } finally {
        if (previousTranscriptRoot === undefined) delete process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT;
        else process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT = previousTranscriptRoot;
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
});

test('Antigravity config path uses ANTIGRAVITY_CONFIG_PATH env override', () => {
    withAntigravityEnv({ ANTIGRAVITY_CONFIG_PATH: '/tmp/antigravity-config' }, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '/tmp/stored-config' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes('/tmp/antigravity-config:/home/node/.gemini-source:rw'));
    });
});

test('Antigravity config path uses stored config when no env override is set', () => {
    withAntigravityEnv({}, () => {
        const agent = new AntigravityAgent(createAntigravityConfig({ configPath: '~/.gemini-test' }));
        const args = buildDockerArgs(agent);

        assert.ok(args.includes(`${os.homedir()}/.gemini-test:/home/node/.gemini-source:rw`));
    });
});

test('Antigravity labels resolve to Antigravity models', async (t) => {
    const registry = AgentRegistry.getInstance() as unknown as {
        initialized: boolean;
        agents: Map<string, Agent>;
        agentsByAlias: Map<string, Agent>;
        defaultAgentAlias: string | null;
        ensureInitialized(): Promise<void>;
    };
    const config = createAntigravityConfig();
    const fakeAgent = { config } as Agent;

    t.mock.method(registry, 'ensureInitialized', async () => undefined);
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
