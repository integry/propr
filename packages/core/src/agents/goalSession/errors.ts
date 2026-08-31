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
