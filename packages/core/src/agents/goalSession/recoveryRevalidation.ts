import type { GoalSessionControlFence, GoalSessionState } from './contract.js';
import { StaleGoalSessionFenceError } from './errors.js';
import { sameRecoverySubject, stoppedReconciliationResult } from './recoveryOperationProtocol.js';

export class RecoveryGuardResult<T> extends Error {
    constructor(readonly result: T) { super('Recovery stopped while revalidating provider inspection'); }
}

export async function revalidateRecoveryInspection<T>(options: {
    expected: GoalSessionState;
    fence: GoalSessionControlFence;
    load: () => Promise<GoalSessionState>;
    guard: (state: GoalSessionState) => Promise<T | null>;
}): Promise<GoalSessionState> {
    const current = await options.load();
    const guarded = await options.guard(current);
    if (guarded) throw new RecoveryGuardResult(guarded);
    const revalidated = await options.load();
    const stopped = stoppedReconciliationResult(revalidated);
    if (stopped) {
        if (revalidated.status === 'cancelling') {
            throw new RecoveryGuardResult((await options.guard(revalidated))!);
        }
        throw new RecoveryGuardResult(stopped as T);
    }
    if (!sameRecoverySubject(options.expected, revalidated)) {
        throw new StaleGoalSessionFenceError('Recovery subject changed during durable inspection');
    }
    return revalidated;
}
