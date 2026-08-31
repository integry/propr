import type {
    GoalContainerInspection,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionState,
} from './contract.js';
import { fingerprintGoalWorktree } from './worktreeIdentity.js';

export function verifyRecoveredContainer(
    state: GoalSessionState,
    inspection: GoalContainerInspection,
    worktreeFingerprint: string,
): string | null {
    if (inspection.status === 'missing') return null;
    if (inspection.status === 'daemon_unavailable') {
        return `Container identity could not be inspected: ${inspection.reason ?? 'Docker unavailable'}`;
    }
    const turn = state.activeTurn;
    if (!turn) return 'A recovered container exists without an authoritative active turn';
    const observed = inspection.recoveryIdentity;
    if (!observed) return 'Recovered container is missing authoritative recovery metadata';
    const expected = {
        goalId: state.goalId,
        sessionId: state.sessionId,
        executionEpoch: turn.executionEpoch,
        turnId: turn.turnId,
        attemptId: turn.attemptId,
        worktreeFingerprint,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
        if (observed[key] !== expected[key]) {
            return `Recovered container ${key} mismatch: expected ${expected[key]}, found ${observed[key]}`;
        }
    }
    return null;
}

/** Verifies authoritative checkout identity while allowing legitimate HEAD advancement. */
export function verifyReconciliationTarget(
    expected: GoalRepositoryIdentity,
    inspection: GoalRepositoryInspection,
): string | null {
    if (!inspection.exists) {
        return `Worktree ${expected.worktreePath} is unavailable: ${inspection.reason ?? 'not found'}`;
    }
    if (!inspection.observedBranch) {
        return `Worktree ${expected.worktreePath} branch could not be observed: ${inspection.reason ?? 'branch unavailable'}`;
    }
    const expectedFingerprint = fingerprintGoalWorktree(expected);
    if (!inspection.observedWorktreeFingerprint) {
        return `Worktree ${expected.worktreePath} fingerprint could not be observed: ${inspection.reason ?? 'metadata unavailable'}`;
    }
    if (inspection.observedWorktreeFingerprint !== expectedFingerprint) {
        return `Worktree fingerprint mismatch: expected ${expectedFingerprint}, found ${inspection.observedWorktreeFingerprint}`;
    }
    if (inspection.observedBranch !== expected.branch) {
        return `Worktree branch mismatch: expected ${expected.branch}, found ${inspection.observedBranch}`;
    }
    return null;
}
