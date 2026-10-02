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

const claudeNative = await import('../packages/core/src/agents/impl/claudeNativeGoal.js');
const antigravityNative = await import('../packages/core/src/agents/impl/antigravityNativeGoal.js');
const { executeCodexAppServerGoal } = await import('../packages/core/src/agents/impl/codexAppServer.js');
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
beforeEach(() => { mints = 0; failMint = false; spawned = []; beforeMint = async () => {}; });
after(async () => { await closeConnection(); await fs.rm(root, { recursive: true, force: true }); });


for (const provider of ['claude', 'antigravity', 'codex'] as const) {
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
