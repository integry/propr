import { createHash } from 'node:crypto';
import type { GoalSessionState } from './contract.js';
import { GoalSessionContractError } from './errors.js';

export function mintFreshAttemptId(previousAttemptId: string, mint: () => string): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = mint();
        if (candidate && candidate !== previousAttemptId) return candidate;
    }
    throw new GoalSessionContractError('Could not mint a fresh recovery attempt identity', 'RECOVERY_ATTEMPT_REUSED');
}

/** Stable, non-secret identity for a control operation claimed at one state version. */
export function controlOperationId(kind: string, state: GoalSessionState): string {
    const scope = createHash('sha256')
        .update(`${state.goalId}\0${state.sessionId}`)
        .digest('hex')
        .slice(0, 24);
    return `${kind}-${scope}-e${state.controllerEpoch}-v${state.version}`;
}
