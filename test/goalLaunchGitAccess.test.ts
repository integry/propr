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
import type { ClaudeNativeGoalLaunch } from '../packages/core/src/agents/impl/claudeNativeGoal.js';
import type { AntigravityNativeGoalLaunch } from '../packages/core/src/agents/impl/antigravityNativeGoal.js';
let goalArgs: string[][] = [];
let failRelaunch = false;
await mock.module('../packages/core/src/agents/impl/claudeNativeGoal.js', { namedExports: {
    claudeSessionTranscriptExists: async () => true,
    claudeSessionTranscriptPath: () => path.join(root, "transcript"),
    executeClaudeNativeGoal: async (_options: AgentTaskOptions, launch: ClaudeNativeGoalLaunch) => {
        goalArgs.push(await launch.buildDockerArgs());
        return { success: false };
    },
} });
await mock.module('../packages/core/src/agents/impl/antigravityNativeGoal.js', { namedExports: {
    executeAntigravityNativeGoal: async (_options: AgentTaskOptions, launch: AntigravityNativeGoalLaunch) => {
        goalArgs.push(await launch.buildDockerArgs({ launch: true }));
        failMint = failRelaunch;
        goalArgs.push(await launch.buildDockerArgs({ launch: false, conversationId: 'resume-id' }));
        return { success: false };
    },
} });
const helpers = await import('../packages/core/src/claude/claudeHelpers.js');
await mock.module('../packages/core/src/claude/claudeHelpers.js', { namedExports: { ...helpers,
    setWorktreeOwnership: async () => {}, verifyWorktreeStructure: () => '', verifyWorktreePostExecution: () => {},
} });
const configManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', { namedExports: { ...configManager,
    loadModelReasoningLevel: async () => '',
} });
const { ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js');
const { AntigravityAgent } = await import('../packages/core/src/agents/impl/AntigravityAgent.js');
const { CodexAgent } = await import('../packages/core/src/agents/impl/CodexAgent.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const config = (type: AgentConfig['type']): AgentConfig => {
    const model = type === 'antigravity' ? 'antigravity-gemini-3.8-flash' : 'test-model';
    return {
        id: type, type, alias: type, enabled: true, dockerImage: 'test-agent', configPath: root,
        supportedModels: [model], defaultModel: model,
    };
};
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
beforeEach(() => { mints = 0; failMint = false; failRelaunch = false; spawned = []; goalArgs = []; beforeMint = async () => {}; });
after(async () => { await closeConnection(); await fs.rm(root, { recursive: true, force: true }); });

function assertFreshLaunches(args: string[][]) {
    assert.equal(args.length, 2);
    args.forEach((launch, index) => {
        assert.ok(launch.includes(`GH_TOKEN=fresh-token-${index + 1}`));
        assert.ok(launch.includes(`${root}/scope-${index + 1}:/context:ro`));
        assert.doesNotMatch(launch.join('\n'), /stale-worker-token/);
    });
    assert.equal(mints, 2, 'Mint once per container, never at executeTask entry');
}

test('Claude initial goal and resumed attempt mint separately at launch', async () => {
    const agent = new ClaudeAgent(config('claude'));
    await agent.executeTask(options);
    await agent.executeTask({ ...options, resumeSessionId: 'resume-id' });
    assertFreshLaunches(goalArgs);
});

test('Antigravity relaunch refreshes credentials and mounts inside the callback', async () => {
    await new AntigravityAgent(config('antigravity')).executeTask(options);
    assertFreshLaunches(goalArgs);
    assert.ok(goalArgs[1].includes('resume-id'));
});

test('Antigravity failed refresh does not reuse the previous invocation credentials', async () => {
    failRelaunch = true;
    const result = await new AntigravityAgent(config('antigravity')).executeTask(options);
    assert.equal(result.success, false);
    assert.match(result.error!, /Scope unavailable/);
    assert.equal(goalArgs.length, 1);
});

test('Codex app-server initial and resumed container attempts prepare fresh access', async () => {
    const agent = new CodexAgent(config('codex'));
    await assert.rejects(agent.executeTask(options), /Captured spawn/);
    await assert.rejects(agent.executeTask({ ...options, resumeSessionId: 'resume-id' }), /Captured spawn/);
    assertFreshLaunches(spawned);
    failMint = true;
    await assert.rejects(agent.executeTask(options), /Scope unavailable/);
    assert.equal(spawned.length, 2);
});

