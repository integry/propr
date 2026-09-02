import type { SupervisedDockerExecution } from '../../claude/docker/dockerExecutor.js';
import type { GoalSupervisedOpenClaim } from './goalSessionOpen.js';

interface PendingOpenIdentity { goalId: string; sessionId: string; attemptId: string }

function identity(claim: Readonly<GoalSupervisedOpenClaim>): PendingOpenIdentity {
    return { goalId: claim.operationFence.goalId, sessionId: claim.operationFence.sessionId, attemptId: claim.attemptId };
}

function key(value: PendingOpenIdentity): string {
    return `${value.goalId}\0${value.sessionId}\0${value.attemptId}`;
}

export class PendingOpenOwnership {
    private readonly executions = new Map<string, SupervisedDockerExecution>();

    register(claim: Readonly<GoalSupervisedOpenClaim>, execution: SupervisedDockerExecution): void {
        this.executions.set(key(identity(claim)), execution);
    }

    transfer(claim: Readonly<GoalSupervisedOpenClaim>): void { this.executions.delete(key(identity(claim))); }

    async cancel(claim: Readonly<GoalSupervisedOpenClaim>): Promise<void> {
        await this.cancelIdentity(identity(claim));
    }

    async cancelIdentity(value: PendingOpenIdentity): Promise<void> {
        const execution = this.executions.get(key(value));
        if (!execution) return;
        this.executions.delete(key(value));
        await execution.cancel(new Error('Pending eager-open ownership was cancelled'));
    }
}
