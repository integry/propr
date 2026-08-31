import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
    GoalContainerInspection,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionIdentity,
    GoalSessionRecoveryPort,
} from './contract.js';
import { fingerprintGoalWorktree } from './worktreeIdentity.js';

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
            const { stdout: labelOutput } = await execFileAsync(this.dockerPath, [
                'inspect', '--format', '{{json .Config.Labels}}', containerId,
            ], { timeout: 10_000 });
            const labels = JSON.parse(labelOutput) as Record<string, string>;
            const executionEpoch = Number(labels['propr.goal.controller-epoch']);
            const hasIdentity = labels['propr.goal.id'] && labels['propr.goal.session']
                && labels['propr.goal.turn'] && labels['propr.goal.attempt']
                && labels['propr.goal.worktree-fingerprint']
                && Number.isSafeInteger(executionEpoch) && executionEpoch >= 0;
            return {
                status,
                containerId,
                containerName,
                recoveryIdentity: hasIdentity ? {
                    goalId: labels['propr.goal.id'],
                    sessionId: labels['propr.goal.session'],
                    executionEpoch,
                    turnId: labels['propr.goal.turn'],
                    attemptId: labels['propr.goal.attempt'],
                    worktreeFingerprint: labels['propr.goal.worktree-fingerprint'],
                } : undefined,
                reason: hasIdentity
                    ? `Docker reports container state ${rawState || 'unknown'}`
                    : 'Recovered container is missing one or more authoritative identity labels',
            };
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
            const lexicalPath = path.resolve(repository.worktreePath);
            const resolvedWorktreePath = await realpath(repository.worktreePath);
            if (resolvedWorktreePath !== lexicalPath) {
                return {
                    ...repository,
                    exists: true,
                    resolvedWorktreePath,
                    reason: 'Worktree path resolves through a symlink or alias',
                };
            }
            const [{ stdout: head }, { stdout: status }, { stdout: branch }, { stdout: remote }, { stdout: root }] = await Promise.all([
                execFileAsync(this.gitPath, ['rev-parse', 'HEAD'], { cwd: repository.worktreePath, timeout: 10_000 }),
                execFileAsync(this.gitPath, ['status', '--porcelain'], { cwd: repository.worktreePath, timeout: 10_000 }),
                execFileAsync(this.gitPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repository.worktreePath, timeout: 10_000 }),
                execFileAsync(this.gitPath, ['config', '--get', 'remote.origin.url'], { cwd: repository.worktreePath, timeout: 10_000 }),
                execFileAsync(this.gitPath, ['rev-parse', '--show-toplevel'], { cwd: repository.worktreePath, timeout: 10_000 }),
            ]);
            const observedRepository = remote.trim();
            const observedBranch = branch.trim();
            if (path.resolve(root.trim()) !== resolvedWorktreePath) {
                return {
                    ...repository,
                    exists: true,
                    resolvedWorktreePath,
                    reason: 'Worktree path is not the observed Git repository root',
                };
            }
            return {
                ...repository,
                exists: true,
                dirty: Boolean(status.trim()),
                observedRepository,
                observedHeadSha: head.trim(),
                observedBranch,
                observedWorktreeFingerprint: fingerprintGoalWorktree({
                    repository: observedRepository,
                    worktreePath: resolvedWorktreePath,
                    branch: observedBranch,
                }),
                resolvedWorktreePath,
            };
        } catch (error) {
            return { ...repository, exists: true, reason: `External worktree state could not be inspected: ${errorText(error)}` };
        }
    }
}
