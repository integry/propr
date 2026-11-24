import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';

// Container names carry a random nonce; pin it so old and new argv compare exactly.
await mock.module('../packages/core/src/agents/impl/utils/containerExecutionId.js', {
    namedExports: {
        createContainerExecutionId: (taskId?: string) => `${taskId ? taskId.slice(-8) : 'untasked'}-0a1b2c3d`,
    },
});

const legacyClaude = await import('./fixtures/legacyAgentDockerArgs/dockerArgsBuilder.ts');
const legacyCodex = await import('./fixtures/legacyAgentDockerArgs/codexDockerArgsBuilder.ts');
const legacyOpenCode = await import('./fixtures/legacyAgentDockerArgs/openCodeUtils.ts');
const legacyClaudeService = await import('./fixtures/legacyAgentDockerArgs/claudeHelpers.ts');
const { legacyAntigravityDockerArgs, legacyVibeDockerArgs } = await import('./fixtures/legacyAgentDockerArgs/agentLaunchArgs.ts');

const { buildDockerArgs, buildClaudeRunSpec } = await import('../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts');
const { buildCodexDockerArgs, buildCodexAppServerDockerArgs, buildCodexRunSpec } = await import('../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts');
const { buildOpenCodeDockerArgs, buildOpenCodeRunSpec } = await import('../packages/core/src/agents/impl/openCodeUtils.ts');
const { buildDockerArgs: buildClaudeServiceDockerArgs } = await import('../packages/core/src/claude/claudeHelpers.ts');
const { AntigravityAgent } = await import('../packages/core/src/agents/impl/AntigravityAgent.ts');
const { VibeAgent } = await import('../packages/core/src/agents/impl/VibeAgent.ts');
const { renderDockerRunArgs } = await import('../packages/core/src/agents/runtime/dockerRunArgs.ts');
const { agentRunEnvironment, agentRunMounts } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
// The agent classes open the shared SQLite connection on import; close it or the
// file never exits and the suite runner kills it at its 180s timeout.
const { closeConnection } = await import('../packages/core/src/db/connection.ts');

import type { AgentConfig, AgentToolPolicy } from '../packages/core/src/agents/types.ts';
import type { AgentRunSpec } from '../packages/core/src/agents/runtime/types.ts';

let root: string;
const savedEnvironment = { ...process.env };
const config = (type: AgentConfig['type'], overrides: Partial<AgentConfig> = {}): AgentConfig => ({
    id: `${type}-id`, type, alias: `${type}-golden`, enabled: true, dockerImage: `propr/${type}:golden`,
    configPath: join(root, `${type}-config`),
    supportedModels: [type === 'antigravity' ? 'antigravity-gemini-3.8-flash' : 'golden-model'],
    envVars: { OPERATOR_FLAG: 'on', GH_TOKEN: 'must-not-leak', MULTI: 'a=b=c', MISTRAL_API_KEY: 'mistral-key' },
    ...overrides,
});

const policy: AgentToolPolicy = {
    allowWeb: false,
    mcpServers: [{ name: 'propr', url: 'http://api:4000/api/mcp', bearerTokenEnv: 'PROPR_MCP_TOKEN', bearerToken: 'secret-token' }],
    dockerNetwork: 'propr_default',
};

const base = { worktreePath: '/tmp/golden-worktree', githubToken: 'gh-token', issueNumber: 42, taskId: 'repo-42-claude-model-abcdef12' };

before(() => {
    root = mkdtempSync(join(tmpdir(), 'propr-golden-argv-'));
    for (const type of ['claude', 'codex', 'opencode', 'antigravity', 'vibe']) mkdirSync(join(root, `${type}-config`));
    // A seed path with a comma exercises `--mount` field quoting.
    const claudeJson = join(root, 'claude,seed.json');
    writeFileSync(claudeJson, '{}');
    process.env.CLAUDE_JSON_PATH = claudeJson;
    process.env.AGENT_CONTAINER_CPU_LIMIT = '2';
    process.env.AGENT_CONTAINER_MEMORY_LIMIT = '4g';
});

after(async () => {
    process.env = savedEnvironment;
    rmSync(root, { recursive: true, force: true });
    await closeConnection();
});

function assertStructured(spec: AgentRunSpec): void {
    for (const variable of spec.env) assert.ok(!variable.name.includes('='), `env name ${variable.name} carries a value`);
    const workspace = agentRunMounts(spec, 'workspace');
    assert.equal(workspace.length, 1);
    assert.deepEqual(
        workspace[0].type === 'bind' && [workspace[0].source, workspace[0].target, workspace[0].readOnly],
        [spec.workspace.hostPath, spec.workspace.containerPath, spec.workspace.readOnly],
    );
    // The spec alone renders the argv: rendering is pure and repeatable.
    assert.deepEqual(renderDockerRunArgs(spec), renderDockerRunArgs(structuredClone(spec)));
}

describe('golden argv: AgentRunSpec rendering matches the pre-runtime argv builders', () => {
    const claudeCases: Array<[string, number, Record<string, unknown>]> = [
        ['task', 30, {}],
        ['task with model, prompt, tools, effort and environment', 50, {
            modelName: 'claude:claude-sonnet-4-5', systemPrompt: 'Be brief.', tools: 'Read,Edit', reasoningLevel: 'high',
            environment: { RUN_VAR: '1', GITHUB_TOKEN: 'must-not-leak' },
        }],
        ['task with MCP tool policy on a Compose network', 30, { toolPolicy: policy }],
        ['task with prepared git mounts', 30, { gitMountArgs: ['-v', '/tmp/git-processor/clones/a:/tmp/git-processor/clones/a:ro'] }],
        ['read-only analysis', 10, { issueNumber: 0, readOnlyWorkspace: true, tools: 'Read', executionType: 'context-analysis' }],
        ['repository inspection', 10, { issueNumber: 0, readOnlyWorkspace: true, repositoryInspection: true }],
        ['fresh goal session', 30, { executionMode: 'goal', sessionId: 'session-1', modelName: 'claude-opus-4-6' }],
        ['resumed orchestrated goal with operator questions', 30, {
            executionMode: 'goal', resumeSessionId: 'session-1', environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' },
            operatorQuestions: { exchangeDir: '/tmp/claude-logs/propr-operator/1', maxWaitMs: 60_000 },
        }],
    ];
    for (const [name, maxTurns, params] of claudeCases) {
        test(`Claude: ${name}`, () => {
            const input = { ...base, ...params } as Parameters<typeof buildDockerArgs>[2];
            const spec = buildClaudeRunSpec(config('claude'), maxTurns, input);
            assertStructured(spec);
            assert.deepEqual(buildDockerArgs(config('claude'), maxTurns, input), legacyClaude.buildDockerArgs(config('claude'), maxTurns, input));
        });
    }

    const codexCases: Array<[string, Record<string, unknown>]> = [
        ['task', {}],
        ['task with model, effort and policy', { modelName: 'codex:gpt-5.5', reasoningLevel: 'high', toolPolicy: policy, environment: { RUN_VAR: '1' } }],
        ['exclusive MCP profile', { toolPolicy: { ...policy, exclusiveMcp: true } }],
        ['repository inspection', { issueNumber: 0, readOnlyWorkspace: true, repositoryInspection: true }],
        ['goal resume', { executionMode: 'goal', resumeSessionId: 'thread-1', environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' } }],
    ];
    for (const [name, params] of codexCases) {
        test(`Codex: ${name}`, () => {
            const input = { ...base, ...params } as Parameters<typeof buildCodexDockerArgs>[1];
            assertStructured(buildCodexRunSpec(config('codex'), input));
            assert.deepEqual(buildCodexDockerArgs(config('codex'), input), legacyCodex.buildCodexDockerArgs(config('codex'), input));
            assert.deepEqual(buildCodexAppServerDockerArgs(config('codex'), input), legacyCodex.buildCodexAppServerDockerArgs(config('codex'), input));
        });
    }

    const openCodeCases: Array<[string, Record<string, unknown>]> = [
        ['task with model', { modelName: 'opencode-big-pickle' }],
        ['read-only analysis with data path', { issueNumber: 0, readOnlyWorkspace: true, dataPath: '/tmp/opencode-data' }],
        ['repository inspection', { issueNumber: 0, readOnlyWorkspace: true, repositoryInspection: true }],
    ];
    for (const [name, params] of openCodeCases) {
        test(`OpenCode: ${name}`, () => {
            const input = { ...base, ...params, config: config('opencode'), ensureConfigPath: () => {} } as Parameters<typeof buildOpenCodeDockerArgs>[0];
            assertStructured(buildOpenCodeRunSpec(input));
            assert.deepEqual(buildOpenCodeDockerArgs(input), legacyOpenCode.buildOpenCodeDockerArgs(input));
        });
    }

    test('OpenCode: host data directory override', () => {
        process.env.HOST_OPENCODE_DATA_DIR = '/srv/opencode-data';
        try {
            const input = { ...base, config: config('opencode'), ensureConfigPath: () => {} } as Parameters<typeof buildOpenCodeDockerArgs>[0];
            assert.deepEqual(buildOpenCodeDockerArgs(input), legacyOpenCode.buildOpenCodeDockerArgs(input));
        } finally {
            delete process.env.HOST_OPENCODE_DATA_DIR;
        }
    });

    const antigravityCases: Array<[string, Record<string, unknown>]> = [
        ['task with model and transcript', { modelName: 'antigravity-gemini-3.8-flash', transcriptPath: '/tmp/agy-transcript.json', environment: { RUN_VAR: '1' } }],
        ['inspection analysis', { issueNumber: 0, readOnlyWorkspace: true, repositoryInspection: true, printTimeoutMs: 90_000 }],
        ['native goal launch', { executionMode: 'goal', nativeGoalLaunch: true, modelName: 'antigravity-gemini-3.8-flash' }],
        ['goal resume', { executionMode: 'goal', resumeConversationId: 'conversation-1', environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'orchestrate' } }],
    ];
    for (const [name, params] of antigravityCases) {
        test(`Antigravity: ${name}`, () => {
            const agent = new AntigravityAgent(config('antigravity')) as unknown as {
                buildDockerArgs(input: unknown): string[];
                buildRunSpec(input: unknown): AgentRunSpec;
            };
            const input = { ...base, ...params };
            assertStructured(agent.buildRunSpec(input));
            assert.deepEqual(agent.buildDockerArgs(input), legacyAntigravityDockerArgs(agent, input));
        });
    }

    const vibeCases: Array<[string, Record<string, unknown>]> = [
        ['execute with prompt file, env file and runtime home', {
            modelName: 'vibe:devstral-2', promptFilePath: '/tmp/vibe-prompt.txt', envFilePath: '/tmp/vibe.env', runtimeHomePath: '/tmp/vibe-home',
        }],
        ['analysis', { issueNumber: 0, mode: 'analysis', maxTurns: 5 }],
        ['repository inspection analysis', { issueNumber: 0, mode: 'analysis', repositoryInspection: true, modelName: 'zai-glm-5-3' }],
    ];
    for (const [name, params] of vibeCases) {
        test(`Vibe: ${name}`, () => {
            const agent = new VibeAgent(config('vibe')) as unknown as {
                buildDockerArgs(input: unknown): string[];
                buildRunSpec(input: unknown): AgentRunSpec;
            };
            const input = { ...base, mistralApiKey: 'mistral-key', ...params };
            assertStructured(agent.buildRunSpec(input));
            assert.deepEqual(agent.buildDockerArgs(input), legacyVibeDockerArgs(agent, input));
        });
    }

    test('legacy Claude service', () => {
        const input = {
            ...base, prompt: 'prompt', modelName: 'claude-sonnet-4-5', systemPrompt: 'system', tools: 'Read',
            CLAUDE_DOCKER_IMAGE: 'propr/claude:golden', CLAUDE_CONFIG_PATH: '/srv/claude', CLAUDE_MAX_TURNS: 25, agentAlias: 'claude',
        };
        assert.deepEqual(buildClaudeServiceDockerArgs(input), legacyClaudeService.buildDockerArgs(input));
    });
});

describe('AgentRunSpec is runtime-neutral', () => {
    test('exposes environment, credential mounts, resources, network and MCP grant without argv', () => {
        const spec = buildClaudeRunSpec(config('claude'), 30, { ...base, toolPolicy: policy });
        const environment = agentRunEnvironment(spec);
        assert.equal(environment.GH_TOKEN, 'gh-token');
        assert.equal(environment.MULTI, 'a=b=c');
        assert.equal('PROPR_MCP_TOKEN' in environment && environment.PROPR_MCP_TOKEN, undefined, 'policy tokens are passed by name only');
        assert.equal(environment.GITHUB_TOKEN, undefined);
        assert.equal(environment.PROPR_AGENT_TYPE, 'claude');
        assert.deepEqual(spec.resources, { init: true, memory: '4g', memorySwap: '4g', cpus: '2', pidsLimit: '512' });
        assert.deepEqual(spec.network, { mode: 'named', name: 'propr_default' });
        assert.deepEqual(spec.mcpGrant, { servers: ['propr'], network: 'propr_default', transport: 'private-network' });
        assert.ok(agentRunMounts(spec, 'credential').some(mount => mount.type === 'bind' && mount.target === '/home/node/.claude'));
        assert.equal(spec.profile.image, 'propr/claude:golden');
        assert.equal(spec.repoSetup?.providerEntrypoint, '/home/node/claude-entrypoint.sh');
    });
});
