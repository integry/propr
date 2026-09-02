import { GoalSessionContractError } from './errors.js';

/** Canonical grammar for every opaque goal-session identifier. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Credential formats that remain syntactically valid opaque identifiers. */
export const SECRET_ID_PREFIX = /^(?:Bearer|gh[oprsu]_|github_pat_|sk-|AKIA)/i;

export function isSafeIdentifier(value: unknown): value is string {
    return typeof value === 'string' && SAFE_ID.test(value) && !SECRET_ID_PREFIX.test(value);
}

export function assertSafeCallerTurnIdentity(request: {
    turnId: unknown;
    executionId: unknown;
    attemptId?: unknown;
}): void {
    if (!isSafeIdentifier(request.turnId) || !isSafeIdentifier(request.executionId)
        || request.attemptId !== undefined && !isSafeIdentifier(request.attemptId)) {
        throw new GoalSessionContractError(
            'turnId, executionId, and attemptId must be safe opaque identifiers', 'INVALID_TURN',
        );
    }
}

export function assertSafeCallerSteeringIdentity(request: {
    turnId: unknown;
    executionId?: unknown;
    attemptId?: unknown;
}): void {
    if (!isSafeIdentifier(request.turnId)
        || request.executionId !== undefined && !isSafeIdentifier(request.executionId)
        || request.attemptId !== undefined && !isSafeIdentifier(request.attemptId)) {
        throw new GoalSessionContractError('Steering identity is unsafe', 'INVALID_TURN');
    }
}
