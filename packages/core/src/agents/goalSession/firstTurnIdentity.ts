import { createHash } from 'node:crypto';
import type {
    GoalProviderCapabilities,
    GoalSessionIdentity,
    GoalSessionInitializationIntent,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { nowIso } from './support.js';

type FirstTurnCrashPolicy = Extract<GoalProviderCapabilities, { nativeSessionId: 'first_turn' }>['firstTurnIdCrashPolicy'];

export function deterministicOpenKey(identity: GoalSessionIdentity & { provider: string }): string {
    return createHash('sha256').update(`${identity.provider}\0${identity.goalId}\0${identity.sessionId}`).digest('hex');
}

export function createFirstTurnInitializationIntent(
    identity: GoalSessionIdentity & { provider: string },
    attemptId: string,
): GoalSessionInitializationIntent {
    return {
        attemptId,
        deterministicOpenKey: deterministicOpenKey(identity),
        recordedAt: nowIso(),
    };
}

export function firstTurnIdentityFailure(policy: FirstTurnCrashPolicy): GoalSessionContractError {
    return new GoalSessionContractError(
        `The first provider invocation ended before binding its native session ID (${policy})`,
        'FIRST_TURN_ID_NOT_BOUND',
    );
}
