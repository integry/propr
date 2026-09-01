import type { GoalModelChangeIntent, GoalSessionState } from './contract.js';

const MODEL_APPLICATION_LEASE_MS = 30_000;

export function claimModelApplicationIntent(
    intent: GoalModelChangeIntent,
    state: GoalSessionState,
): GoalModelChangeIntent {
    return {
        ...intent,
        phase: intent.phase === 'committed' ? 'committed' : 'provider_in_doubt',
        applicationToken: `${intent.modelChangeId}:e${state.controllerEpoch}:v${state.version}`,
        applicationControllerEpoch: state.controllerEpoch,
        leaseExpiresAt: new Date(Date.now() + MODEL_APPLICATION_LEASE_MS).toISOString(),
    };
}
