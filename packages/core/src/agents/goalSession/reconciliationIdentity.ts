import type {
    GoalContainerInspection,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionState,
} from './contract.js';
import { fingerprintGoalWorktree, normalizeGitRepositoryIdentity } from './worktreeIdentity.js';

const SHA = /^[a-f\d]{4,64}$/i;
const FINGERPRINT = /^[a-f\d]{64}$/i;

/** Removes untrusted recovery-port fields before provider or audit boundaries. */
export function sanitizeRepositoryInspection(
    expected: GoalRepositoryIdentity,
    inspection: GoalRepositoryInspection,
): GoalRepositoryInspection {
    const observedRepository = inspection.observedRepository === undefined
        ? undefined
        : normalizeGitRepositoryIdentity(inspection.observedRepository);
    const invalidRemote = inspection.observedRepository !== undefined && !observedRepository;
    return {
        ...expected,
        exists: inspection.exists === true,
        dirty: inspection.dirty === true,
        observedRepository,
        observedHeadSha: SHA.test(inspection.observedHeadSha ?? '') ? inspection.observedHeadSha : undefined,
        observedBranch: invalidRemote ? undefined : inspection.observedBranch,
        observedWorktreeFingerprint: invalidRemote
            ? undefined
            : FINGERPRINT.test(inspection.observedWorktreeFingerprint ?? '')
                ? inspection.observedWorktreeFingerprint
                : undefined,
        resolvedWorktreePath: inspection.resolvedWorktreePath,
        reason: invalidRemote ? 'Git remote does not contain a trustworthy repository identity' : undefined,
    };
}

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
