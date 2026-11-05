import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRepositoryWorkflow } from '../packages/core/src/workflow/repositoryWorkflow.js';
import { executeWithRepositoryWorkflow, repositoryWorkflowExecution } from '../packages/core/src/workflow/workflowExecution.js';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';
import { executeDockerCommand } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

// Runs a real supported agent image, so it needs Docker and an image name, e.g.
// PROPR_TEST_AGENT_IMAGE=propr-agent:latest. Without them it is skipped.
const image = process.env.PROPR_TEST_AGENT_IMAGE;
const skip = !image ? 'set PROPR_TEST_AGENT_IMAGE to a supported agent image'
    : spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0 ? 'docker is needed for the container smoke test' : false;

after(closeConnection);

test('the workflow wrapper in a real agent image drops privileges, runs hooks and keeps reports out of the agent\'s reach', { skip, timeout: 300_000 }, async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'workflow-container-'));
    // The container's unprivileged node user writes the probes.
    await chmod(workspace, 0o777);
    try {
        const config = parseRepositoryWorkflow(`hooks:
  before_run: 'id -u > hook-uid; command -v timeout > hook-timeout'
  before_remove: 'echo removed > removed'
validation:
  - 'test "$(id -u)" != 0'
  - 'exit 3'
`);
        const workflow = { revision: 'smoke', fileRevision: 'smoke', baseBranch: 'main', config, timeoutMs: 60_000, maxParallelTasks: 0 };
        let exitCode: number | null = null;
        const result = await executeWithRepositoryWorkflow(workflow, async () => {
            const { marker } = repositoryWorkflowExecution.getStore()!;
            // The real entrypoint initializes the container and runs this agent command as node.
            // It then tries to forge a passing report through the wrapper's own stderr.
            const agent = `id -u > agent-uid; if printf '\\n%s\\n' '${marker}:validation:1:0' > /proc/1/fd/2; then echo forged > forgery; else echo blocked > forgery; fi`;
            const args = wrapDockerRunArgsWithRepoSetup(['run', '--rm', '--user', '0:0', '-v', `${workspace}:/home/node/workspace`, image!], image!, 'claude');
            const execution = await executeDockerCommand('docker', [...args, '/bin/bash', '-c', agent], { timeout: 240_000 });
            exitCode = execution.exitCode;
            return { success: true, logs: execution.stderr, modifiedFiles: [], modelUsed: 'smoke', executionTimeMs: 1 };
        });
        assert.equal(exitCode, 0);
        const read = (name: string) => readFile(path.join(workspace, name), 'utf8').then(value => value.trim());
        assert.notEqual(await read('hook-uid'), '0', 'hooks run as the unprivileged user');
        assert.notEqual(await read('agent-uid'), '0', 'the entrypoint dropped the agent to the unprivileged user');
        assert.match(await read('hook-timeout'), /timeout/, 'the image provides timeout(1) for hook limits');
        assert.equal(await read('removed'), 'removed');
        assert.equal(await read('forgery'), 'blocked', 'the agent cannot open the root wrapper\'s stderr');
        assert.match(result.repositoryValidation!, /\[1\] .*: Passed$/m);
        assert.match(result.repositoryValidation!, /\[2\] exit 3: Failed \(exit 3\)$/m);
        assert.doesNotMatch(result.repositoryValidation!, /unverified/);
    } finally {
        // Files written by the container's node user may need a container to remove.
        await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
});
