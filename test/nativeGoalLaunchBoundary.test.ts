import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, AgentTaskOptions, GoalExecutionControl } from '../packages/core/src/agents/types.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-goal-access-'));
let mints = 0;
let failMint = false;
let beforeMint: () => Promise<void> = async () => {};
await mock.module('../packages/core/src/agents/agentGitAccess.js', {
    namedExports: {
        prepareAgentGitAccess: async (options: AgentTaskOptions) => {
            await beforeMint();
            if (failMint) throw new Error('Scope unavailable');
            mints++;
            return { ...options, githubToken: `fresh-token-${mints}`, gitMountArgs: ['-v', `${root}/scope-${mints}:/context:ro`] };
        },
        prepareAnalysisGitAccess: () => { throw new Error('Unexpected analysis'); },
        buildAgentGitCredentialArgs: () => [], buildAgentGitMountArgs: () => [],
        agentOwnsGit: () => false,
    },
});
const childProcess = await import('node:child_process');
let spawned: string[][] = [];
await mock.module('node:child_process', { namedExports: { ...childProcess,
    spawn: (_command: string, args: string[]) => {
        spawned.push(args);
        throw new Error('Captured spawn');
    },
} });

let beforeNetwork: () => Promise<void> = async () => {};
let beforeTaskNetwork: () => Promise<void> = async () => {};
let authenticationVersion = 'initial';
let diagnosticCaptures: Array<{ args: string[]; authentication: string }> = [];
let nativeCapacityRefusal = false;
let networkAdmissions = 0;
let dockerAdmissions = 0;
const diagnostics = await import('../packages/core/src/diagnostics/managedLogRuntime.js');
await mock.module('../packages/core/src/diagnostics/managedLogRuntime.js', { namedExports: {
    ...diagnostics,
    assertNativeLogAdmission: (agent: unknown) => {
        if (agent && nativeCapacityRefusal) throw new Error('Protected native capacity; operator action required');
    },
    prepareProviderCapture: (_agent: unknown, args: string[]) => {
        diagnosticCaptures.push({ args, authentication: authenticationVersion });
        return null;
    },
} });
await mock.module('../packages/core/src/claude/docker/dockerNetworkPolicy.js', { namedExports: {
    startWithNetworkPolicy: async (_command: string, args: string[], _options: unknown, start: (args: string[]) => Promise<unknown>) => {
        await beforeTaskNetwork();
        return start(args);
    },
    spawnWithNetworkPolicy: async (args: string[], spawn: (args: string[]) => unknown) => {
        networkAdmissions++;
        await beforeNetwork();
        return spawn([...args, '-e', 'INJECTED_TOKEN=final-run-canary']);
    },
} });
await mock.module('../packages/core/src/agents/agentRunAdmission.js', { namedExports: {
    prepareAdmittedAgent: async () => { dockerAdmissions++; throw new Error('Unexpected Docker admission'); },
    agentAdmissionKeys: (instance: string) => [`${instance}:holders`, `${instance}:config`, `${instance}:waiting`],
    resolveAgentRunAdmission: () => null,
} });

const claudeNative = await import('../packages/core/src/agents/impl/claudeNativeGoal.js');
const antigravityNative = await import('../packages/core/src/agents/impl/antigravityNativeGoal.js');
const { executeCodexAppServerGoal } = await import('../packages/core/src/agents/impl/codexAppServer.js');
const { executeDockerCommand } = await import('../packages/core/src/claude/docker/dockerExecutor.js');
const { runWithExecutionAbortSignal } = await import('../packages/core/src/claude/docker/dockerExecutionOwnership.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const config = (type: AgentConfig['type']): AgentConfig => ({
    id: type, type, alias: type, enabled: true, dockerImage: 'test-agent', configPath: root,
    supportedModels: ['test-model'], defaultModel: 'test-model',
});
const control = {
    load: async () => ({ desiredState: 'running', pendingInputs: [], pendingCheckpoints: [], pendingStop: null }),
    setActiveTurn: async () => {}, appendOutput: async () => {},
    markInputDelivered: mock.fn(),
} as unknown as GoalExecutionControl;
const options: AgentTaskOptions = {
    worktreePath: root, issueRef: { repoOwner: 'owner', repoName: 'task', number: 1 },
    githubToken: 'stale-worker-token', prompt: 'Goal', executionMode: 'goal',
    environment: { PROPR_GOAL_LAUNCH_STRATEGY: 'direct' }, nativeGoalObjective: 'Ship it', goalControl: control, initialControlInputId: 'input-1', initialControlInputMessage: 'Pending input',
};
beforeEach(() => { mints = 0; failMint = false; spawned = []; beforeMint = async () => {}; beforeNetwork = async () => {}; beforeTaskNetwork = async () => {}; authenticationVersion = 'initial'; diagnosticCaptures = []; nativeCapacityRefusal = false; networkAdmissions = 0; dockerAdmissions = 0; });
after(async () => { await closeConnection(); await fs.rm(root, { recursive: true, force: true }); });

test('task capacity refusal happens before Docker creation and preserves provider output', async () => {
    nativeCapacityRefusal = true;
    const canary = path.join(root, 'task-output.txt');
    await fs.writeFile(canary, 'UNPUBLISHED-WORK-CANARY');
    await assert.rejects(executeDockerCommand('docker', ['run', 'image'], {
        diagnostics: { provider: 'codex', agent: 'codex' },
    }), /Protected native capacity/);
    assert.equal(dockerAdmissions, 0);
    assert.equal(spawned.length, 0);
    assert.equal(await fs.readFile(canary, 'utf8'), 'UNPUBLISHED-WORK-CANARY');
});

for (const provider of ['claude', 'antigravity', 'codex'] as const) {
    test(`${provider} native capacity refusal preserves queued input and prevents Docker admission`, async () => {
        nativeCapacityRefusal = true;
        const diagnostics = { provider, agent: provider };
        if (provider === 'claude') {
            await assert.rejects(claudeNative.executeClaudeNativeGoal(options, {
                diagnostics, buildDockerArgs: async () => ['run', 'image'], sessionId: 'resume-session',
                transcriptPath: path.join(root, 'resume-transcript'), model: 'test-model', timeoutMs: 1000,
            }), /Protected native capacity/);
        } else if (provider === 'antigravity') {
            const result = await antigravityNative.executeAntigravityNativeGoal(options, {
                diagnostics, buildDockerArgs: async () => ['run', 'image'], model: 'test-model', timeoutMs: 1000,
            });
            assert.match(result.error!, /Protected native capacity/);
        } else {
            await assert.rejects(executeCodexAppServerGoal(config('codex'), options, 1000), /Protected native capacity/);
        }
        assert.equal(networkAdmissions, 0);
        assert.equal(spawned.length, 0);
        assert.equal((control.markInputDelivered as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    });
    test(`${provider} cancellation during async preparation prevents spawn and input delivery`, async () => {
        const abort = new AbortController();
        const prepare = async () => { abort.abort(new Error('Cancelled while minting')); return ['run', 'image']; };
        await runWithExecutionAbortSignal(abort.signal, async () => {
            if (provider === 'claude') {
                let persisted = false;
                await assert.rejects(claudeNative.executeClaudeNativeGoal({ ...options, onSessionId: async () => { persisted = true; } }, {
                    buildDockerArgs: async () => { assert.equal(persisted, true); return prepare(); },
                    sessionId: 'session', transcriptPath: path.join(root, 'transcript'), model: 'test-model', timeoutMs: 1000,
                }), /Cancelled while minting/);
            } else if (provider === 'antigravity') {
                const result = await antigravityNative.executeAntigravityNativeGoal(options, { buildDockerArgs: prepare, model: 'test-model', timeoutMs: 1000 });
                assert.match(result.error!, /Cancelled while minting/);
            } else {
                beforeMint = async () => { await prepare(); };
                await assert.rejects(executeCodexAppServerGoal(config('codex'), options, 1000), /Cancelled while minting/);
            }
        });
        assert.equal(spawned.length, 0);
        assert.equal((control.markInputDelivered as ReturnType<typeof mock.fn>).mock.callCount(), 0);
    });
}

test('Antigravity timeout during preparation prevents spawn and preserves queued input', async () => {
    const result = await antigravityNative.executeAntigravityNativeGoal(options, {
        buildDockerArgs: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return ['run', 'image']; },
        model: 'test-model', timeoutMs: 1,
    });
    assert.match(result.error!, /execution timeout/);
    assert.equal(spawned.length, 0);
    assert.equal((control.markInputDelivered as ReturnType<typeof mock.fn>).mock.callCount(), 0);
});

for (const provider of ['claude', 'antigravity', 'codex'] as const) {
    test(`${provider} establishes diagnostic context after awaited network preparation with final arguments`, async () => {
        beforeNetwork = async () => { await Promise.resolve(); authenticationVersion = 'rotated'; };
        const diagnosticAgent = { provider, agent: provider, authenticationRoot: root };
        if (provider === 'claude') {
            await assert.rejects(claudeNative.executeClaudeNativeGoal(options, {
                diagnostics: diagnosticAgent, buildDockerArgs: async () => ['run', 'image'],
                sessionId: 'session', transcriptPath: path.join(root, 'transcript'), model: 'test-model', timeoutMs: 1000,
            }), /Captured spawn/);
        } else if (provider === 'antigravity') {
            const result = await antigravityNative.executeAntigravityNativeGoal(options, {
                diagnostics: diagnosticAgent, buildDockerArgs: async () => ['run', 'image'], model: 'test-model', timeoutMs: 1000,
            });
            assert.match(result.error!, /Captured spawn/);
        } else {
            await assert.rejects(executeCodexAppServerGoal(config('codex'), options, 1000), /Captured spawn/);
        }
        assert.equal(diagnosticCaptures.length, 1);
        assert.equal(diagnosticCaptures[0].authentication, 'rotated');
        assert.ok(diagnosticCaptures[0].args.includes('INJECTED_TOKEN=final-run-canary'));
        assert.deepEqual(diagnosticCaptures[0].args, spawned[0]);
    });
}

const { registerAgentRuntime, AGENT_RUNTIME_ENV } = await import('../packages/core/src/agents/runtime/registry.js');
const { DockerRuntime } = await import('../packages/core/src/agents/runtime/dockerRuntime.js');
const { ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js');
const { CodexAgent } = await import('../packages/core/src/agents/impl/CodexAgent.js');
registerAgentRuntime('goal-remote', () => new DockerRuntime());

for (const [selection, select, expected] of [
    ['a registered non-Docker runtime', { runtime: 'goal-remote' }, /support only the "docker" agent runtime; "goal-remote" is selected/],
    ['an unknown PROPR_AGENT_RUNTIME', { env: 'podman' }, /Unknown agent runtime "podman"/],
    ['the Sprites runtime', { env: 'sprites' }, /support only the "docker" agent runtime; "sprites" is selected/],
] as const) {
    for (const provider of ['claude', 'antigravity', 'codex'] as const) {
        test(`${provider} native goal refuses ${selection} before preparing a Docker launch`, async () => {
            const previous = process.env[AGENT_RUNTIME_ENV];
            if ('env' in select) process.env[AGENT_RUNTIME_ENV] = select.env;
            const runtime = 'runtime' in select ? select.runtime : undefined;
            let built = 0;
            try {
                if (provider === 'claude') {
                    const agent = new ClaudeAgent({ ...config('claude'), runtime }) as unknown as { executeNativeGoal(o: AgentTaskOptions, m: string): Promise<{ success: boolean; error?: string }> };
                    const result = await agent.executeNativeGoal(options, 'test-model');
                    assert.equal(result.success, false);
                    assert.match(result.error!, expected);
                } else if (provider === 'antigravity') {
                    const result = await antigravityNative.executeAntigravityNativeGoal(options, {
                        agentAlias: 'antigravity', runtime, buildDockerArgs: async () => { built++; return ['run', 'image']; }, model: 'test-model', timeoutMs: 1000,
                    });
                    assert.match(result.error!, expected);
                } else {
                    await assert.rejects(executeCodexAppServerGoal({ ...config('codex'), runtime }, options, 1000), expected);
                    const agent = new CodexAgent({ ...config('codex'), runtime }) as unknown as { executeNativeGoal(o: AgentTaskOptions): Promise<unknown> };
                    await assert.rejects(agent.executeNativeGoal(options), expected);
                }
            } finally {
                if (previous === undefined) delete process.env[AGENT_RUNTIME_ENV];
                else process.env[AGENT_RUNTIME_ENV] = previous;
            }
            assert.equal(built, 0);
            assert.equal(mints, 0, 'no git access is minted for a refused runtime');
            assert.equal(networkAdmissions, 0);
            assert.equal(spawned.length, 0);
        });
    }
}

test('run handle stop during pending network preparation keeps the executor from spawning the agent', async () => {
    const { DockerRuntime: Runtime, AgentRunStoppedError } = await import('../packages/core/src/agents/runtime/dockerRuntime.js');
    const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.js');
    let releaseNetwork!: () => void;
    let preparing!: () => void;
    const preparationStarted = new Promise<void>(resolve => { preparing = resolve; });
    beforeTaskNetwork = () => { preparing(); return new Promise<void>(resolve => { releaseNetwork = resolve; }); };
    const runSpec = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'test-agent', name: 'claude-issue-1-stop', stdin: true,
        network: agentRunNetwork('bridge'), workspace: { hostPath: root, containerPath: '/home/node/workspace', readOnly: false },
    }).command('claude', '-p', '-').build();
    const handle = new Runtime().start(runSpec, { timeout: 5000, costCapExempt: true });
    const outcome = handle.wait().then(() => 'resolved', error => error);
    await preparationStarted;
    let stopped = false;
    const stopping = handle.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'stop does not report success while the launch can still start');
    releaseNetwork();
    await stopping;
    assert.ok(await outcome instanceof AgentRunStoppedError);
    assert.equal(spawned.length, 0, 'neither the agent nor a docker stop was spawned');
});
