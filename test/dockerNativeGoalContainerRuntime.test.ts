import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
    DockerNativeGoalContainerRuntime,
    type NativeGoalCommandExecutor,
} from '../packages/core/src/agents/goals/DockerNativeGoalContainerRuntime.js';
import type { NativeGoalContainerSpec } from '../packages/core/src/agents/goals/nativeGoalTypes.js';

test('Docker goal runtime reuses only a matching live container and replaces a killed one', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-goal-container-'));
    try {
        const worktreePath = path.join(directory, 'worktree');
        const statePath = path.join(directory, 'state');
        await fs.mkdir(worktreePath);
        const calls: string[][] = [];
        let inspection: Record<string, unknown> | null = null;
        let run = 0;
        const execute: NativeGoalCommandExecutor = async (_command, args) => {
            calls.push(args);
            if (args[0] === 'inspect') {
                if (!inspection) throw new Error('No such container');
                return { stdout: JSON.stringify([inspection]), stderr: '' };
            }
            if (args[0] === 'rm') {
                inspection = null;
                return { stdout: args[1], stderr: '' };
            }
            run += 1;
            const labels: Record<string, string> = {};
            for (let index = 0; index < args.length; index += 1) {
                if (args[index] !== '--label') continue;
                const [key, value] = args[index + 1].split('=', 2);
                labels[key] = value;
            }
            inspection = { Id: `container-${run}`, State: { Running: true }, Config: { Labels: labels } };
            return { stdout: `container-${run}\n`, stderr: '' };
        };
        const runtime = new DockerNativeGoalContainerRuntime(execute, async worktree => {
            assert.equal(worktree.branch, 'goal-branch');
        });
        const spec: NativeGoalContainerSpec = {
            goalId: 'goal-2007', provider: 'codex', image: 'propr/agent:test',
            worktree: {
                hostPath: worktreePath, containerPath: '/home/node/workspace',
                repository: 'integry/propr', branch: 'goal-branch',
            },
            writableMounts: [{
                name: 'provider-state', hostPath: statePath, containerPath: '/home/node/.codex',
            }],
        };

        const first = await runtime.ensure(spec);
        const reused = await runtime.ensure(spec, first);
        assert.equal(reused.id, first.id);
        assert.equal(reused.replaced, false);
        assert.equal(run, 1);
        assert.ok(calls.find(args => args[0] === 'run')?.includes(`propr.goal.id=${spec.goalId}`));
        assert.ok(calls.find(args => args[0] === 'run')?.includes(`${statePath}:/home/node/.codex:rw`));

        (inspection!.State as { Running: boolean }).Running = false;
        const replaced = await runtime.ensure(spec, first);
        assert.equal(replaced.id, 'container-2');
        assert.equal(replaced.replaced, true);
        assert.equal(run, 2);
        assert.ok(calls.some(args => args[0] === 'rm'));
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
