import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupervisedDockerExecution } from '../../claude/docker/dockerExecutor.js';
import type { GoalSupervisedOpenClaim } from './goalSessionOpen.js';

const execFileAsync = promisify(execFile);
interface PendingOpenIdentity {
    goalId: string;
    sessionId: string;
    attemptId: string;
    deterministicOpenKey?: string;
}

function identity(claim: Readonly<GoalSupervisedOpenClaim>): PendingOpenIdentity {
    return {
        goalId: claim.operationFence.goalId, sessionId: claim.operationFence.sessionId,
        attemptId: claim.attemptId, deterministicOpenKey: claim.deterministicOpenKey,
    };
}

function key(value: PendingOpenIdentity): string {
    return `${value.goalId}\0${value.sessionId}\0${value.attemptId}`;
}

export class PendingOpenOwnership {
    private readonly executions = new Map<string, SupervisedDockerExecution>();

    constructor(private readonly dockerPath = '/usr/bin/docker') {}

    register(claim: Readonly<GoalSupervisedOpenClaim>, execution: SupervisedDockerExecution): void {
        this.executions.set(key(identity(claim)), execution);
    }

    transfer(claim: Readonly<GoalSupervisedOpenClaim>): void { this.executions.delete(key(identity(claim))); }

    async cancel(claim: Readonly<GoalSupervisedOpenClaim>): Promise<void> {
        await this.cancelIdentity(identity(claim));
    }

    async cancelIdentity(value: PendingOpenIdentity): Promise<void> {
        const execution = this.executions.get(key(value));
        if (execution) {
            this.executions.delete(key(value));
            await execution.cancel(new Error('Pending eager-open ownership was cancelled'));
            return;
        }
        await this.cancelByDurableLabels(value);
    }

    private async cancelByDurableLabels(value: PendingOpenIdentity): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            try {
                const { stdout } = await execFileAsync(this.dockerPath, [
                    'ps', '-aq', '--filter', `label=propr.goal.id=${value.goalId}`,
                    '--filter', `label=propr.goal.session=${value.sessionId}`,
                    '--filter', 'label=propr.goal.scope=open',
                    '--filter', `label=propr.goal.attempt=${value.attemptId}`,
                    ...(value.deterministicOpenKey
                        ? ['--filter', `label=propr.goal.open-key=${value.deterministicOpenKey}`] : []),
                ], { timeout: 2_000, maxBuffer: 64 * 1024 });
                const containers = stdout.split('\n').map(item => item.trim()).filter(Boolean);
                for (const container of containers) {
                    await execFileAsync(this.dockerPath, ['rm', '-f', container], { timeout: 4_000, maxBuffer: 64 * 1024 });
                }
                if (containers.length > 0 || attempt === 11) return;
                await wait(50);
            } catch (error) {
                lastError = error;
                await wait(50);
            }
        }
        throw new Error('Pending eager-open container cleanup failed safely', { cause: lastError });
    }
}

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
