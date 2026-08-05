import { createHash } from 'node:crypto';

/** Raised when a task mutation is attempted by an execution that no longer owns the task generation. */
export class SupersededTaskAttemptError extends Error {
    constructor(taskId: string) {
        super(`PR processing attempt was superseded for taskId: ${taskId}`);
        this.name = 'SupersededTaskAttemptError';
    }
}

export function assertTaskAttemptOwnership(
    taskId: string,
    actualToken: string | undefined,
    expectedToken: string | undefined,
): void {
    if (expectedToken !== undefined && actualToken !== expectedToken) {
        throw new SupersededTaskAttemptError(taskId);
    }
}

/** One-way identifier used to fence durable task metadata without storing the lease token. */
export function hashTaskAttemptToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
