/** Typed errors shared by the goal-session runtime. */

export class GoalSessionContractError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'GoalSessionContractError';
    }
}

export class StaleGoalSessionFenceError extends GoalSessionContractError {
    constructor(message = 'The goal session controller fence is stale') {
        super(message, 'STALE_FENCE');
        this.name = 'StaleGoalSessionFenceError';
    }
}

export class UnsupportedGoalSessionTransitionError extends GoalSessionContractError {
    constructor(message: string, code: 'UNSUPPORTED_MODEL_TRANSITION' | 'UNSUPPORTED_PROVIDER_TRANSITION') {
        super(message, code);
        this.name = 'UnsupportedGoalSessionTransitionError';
    }
}

const PROVIDER_OPEN_IN_DOUBT_ERRORS = new WeakSet<GoalSessionContractError>();

/** Internal Codex transport signal; adapter-supplied lookalikes are untrusted. */
export function providerOpenInDoubtError(): GoalSessionContractError {
    const error = new GoalSessionContractError(
        'Codex thread creation is in doubt; exact identifiers were not persisted', 'PROVIDER_OPEN_IN_DOUBT',
    );
    PROVIDER_OPEN_IN_DOUBT_ERRORS.add(error);
    return error;
}

export function isProviderOpenInDoubtError(value: unknown): value is GoalSessionContractError {
    return value instanceof GoalSessionContractError && PROVIDER_OPEN_IN_DOUBT_ERRORS.has(value);
}
