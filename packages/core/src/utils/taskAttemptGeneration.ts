import { createHash } from 'node:crypto';

/** Raised when a task mutation is attempted by an execution that no longer owns the task generation. */
export class SupersededTaskAttemptError extends Error {
    constructor(taskId: string) {
        super(`PR processing attempt was superseded for taskId: ${taskId}`);
        this.name = 'SupersededTaskAttemptError';
    }
}

/** Explicit authority for control-plane mutations such as a user cancellation. */
export const ADMINISTRATIVE_TASK_ATTEMPT_OVERRIDE = Symbol('administrative-task-attempt-override');
export type TaskAttemptMutationAuthority = string | typeof ADMINISTRATIVE_TASK_ATTEMPT_OVERRIDE;

export function assertTaskAttemptOwnership(
    taskId: string,
    actualToken: string | undefined,
    expectedToken: TaskAttemptMutationAuthority | undefined,
): void {
    if (expectedToken === ADMINISTRATIVE_TASK_ATTEMPT_OVERRIDE) return;
    if ((actualToken !== undefined && expectedToken === undefined)
        || (expectedToken !== undefined && actualToken !== expectedToken)) {
        throw new SupersededTaskAttemptError(taskId);
    }
}

/** One-way identifier used to fence durable task metadata without storing the lease token. */
export function hashTaskAttemptToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
