import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
    GoalContainerInspection,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionIdentity,
    GoalSessionRecoveryPort,
} from './contract.js';

const execFileAsync = promisify(execFile);

function errorText(error: unknown): string {
    if (error && typeof error === 'object') {
        const stderr = 'stderr' in error ? String(error.stderr).trim() : '';
        if (stderr) return stderr;
    }
    return error instanceof Error ? error.message : String(error);
}

/** Read-only Docker/worktree inspection used during daemon or worker restart reconciliation. */
export class DockerGoalSessionRecovery implements GoalSessionRecoveryPort {
    constructor(
        private readonly dockerPath = '/usr/bin/docker',
        private readonly gitPath = '/usr/bin/git',
    ) {}

    async inspectContainer(identity: GoalSessionIdentity): Promise<GoalContainerInspection> {
        try {
            const { stdout } = await execFileAsync(this.dockerPath, [
                'ps', '-a',
                '--filter', `label=propr.goal.id=${identity.goalId}`,
                '--filter', `label=propr.goal.session=${identity.sessionId}`,
                '--format', '{{.ID}}\t{{.Names}}\t{{.State}}',
            ], { timeout: 10_000 });
            const records = stdout.trim().split('\n').filter(Boolean);
            if (records.length === 0) return { status: 'missing', reason: 'No container has the persisted goal/session labels' };
            if (records.length > 1) {
                return { status: 'daemon_unavailable', reason: 'Multiple containers claim the same goal session; manual cleanup is required' };
            }
            const [containerId, containerName, rawState] = records[0].split('\t');
            const status = rawState === 'running' || rawState === 'restarting' ? 'running' : 'exited';
            return { status, containerId, containerName, reason: `Docker reports container state ${rawState || 'unknown'}` };
        } catch (error) {
            return { status: 'daemon_unavailable', reason: `Docker inspection failed: ${errorText(error)}` };
        }
    }

    async inspectRepository(repository: GoalRepositoryIdentity): Promise<GoalRepositoryInspection> {
        try {
            await access(repository.worktreePath);
        } catch (error) {
            return { ...repository, exists: false, reason: `Worktree is unavailable: ${errorText(error)}` };
        }
        try {
            const [{ stdout: head }, { stdout: status }, { stdout: branch }] = await Promise.all([
                execFileAsync(this.gitPath, ['rev-parse', 'HEAD'], { cwd: repository.worktreePath, timeout: 10_000 }),
                execFileAsync(this.gitPath, ['status', '--porcelain'], { cwd: repository.worktreePath, timeout: 10_000 }),
                execFileAsync(this.gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repository.worktreePath, timeout: 10_000 }),
            ]);
            return {
                ...repository,
                exists: true,
                dirty: Boolean(status.trim()),
                observedHeadSha: head.trim(),
                observedBranch: branch.trim(),
            };
        } catch (error) {
            return { ...repository, exists: true, reason: `External worktree state could not be inspected: ${errorText(error)}` };
        }
    }
}
