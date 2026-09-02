import type {
    GoalRepositoryIdentity,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { normalizeCanonicalGoalRepositoryIdentity } from './worktreeIdentity.js';
import { assertSafeCallerTurnIdentity } from './safeIdentifier.js';

export function validateTurnRequestIdentity(
    request: { turnId: string; executionId: string; attemptId?: string },
): void {
    assertSafeCallerTurnIdentity(request);
}

export async function credentialFreeRepositoryIdentity(repositoryInput: GoalRepositoryIdentity): Promise<GoalRepositoryIdentity> {
    const repository = await normalizeCanonicalGoalRepositoryIdentity(repositoryInput);
    if (!repository) {
        throw new GoalSessionContractError(
            'Repository identity is not a trustworthy Git repository name or remote',
            'INVALID_REPOSITORY',
        );
    }
    return repository;
}

export async function normalizeRecoveryRepositories(
    state: GoalSessionState,
    requested: GoalRepositoryIdentity,
): Promise<{ requested: GoalRepositoryIdentity; durable: GoalRepositoryIdentity } | undefined> {
    const normalizedRequested = await normalizeCanonicalGoalRepositoryIdentity(requested);
    const normalizedDurable = await normalizeCanonicalGoalRepositoryIdentity(state.activeTurn?.repository ?? requested);
    return normalizedRequested && normalizedDurable
        ? { requested: normalizedRequested, durable: normalizedDurable }
        : undefined;
}
