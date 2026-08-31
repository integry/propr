import type {
    GoalRepositoryIdentity,
    GoalSessionState,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { normalizeGoalRepositoryIdentity } from './worktreeIdentity.js';

export function validateTurnRequestIdentity(request: { turnId: string; executionId: string }): void {
    if (!request.turnId.trim() || !request.executionId.trim()) {
        throw new GoalSessionContractError('turnId and executionId must be non-empty', 'INVALID_TURN');
    }
}

export function credentialFreeRepositoryRequest<T extends { repository: GoalRepositoryIdentity }>(request: T): T {
    const repository = normalizeGoalRepositoryIdentity(request.repository);
    if (!repository) {
        throw new GoalSessionContractError(
            'Repository identity is not a trustworthy Git repository name or remote',
            'INVALID_REPOSITORY',
        );
    }
    return { ...request, repository };
}

export function normalizeRecoveryRepositories(
    state: GoalSessionState,
    requested: GoalRepositoryIdentity,
): { requested: GoalRepositoryIdentity; durable: GoalRepositoryIdentity } | undefined {
    const normalizedRequested = normalizeGoalRepositoryIdentity(requested);
    const normalizedDurable = normalizeGoalRepositoryIdentity(state.activeTurn?.repository ?? requested);
    return normalizedRequested && normalizedDurable
        ? { requested: normalizedRequested, durable: normalizedDurable }
        : undefined;
}
