import type {
    GoalContainerInspection,
    GoalRepositoryIdentity,
    GoalRepositoryInspection,
    GoalSessionState,
} from './contract.js';
import { fingerprintGoalWorktree, normalizeGitRepositoryIdentity } from './worktreeIdentity.js';
import path from 'node:path';
import { isSafeIdentifier } from './safeIdentifier.js';

const SHA = /^[a-f\d]{4,64}$/i;
const FINGERPRINT = /^[a-f\d]{64}$/i;
const SAFE_BRANCH = /^(?![./])(?!.*(?:\.\.|@\{|\\|\s|[~^:?*]|\[))(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

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
        observedBranch: !invalidRemote && SAFE_BRANCH.test(inspection.observedBranch ?? '')
            ? inspection.observedBranch : undefined,
        observedWorktreeFingerprint: invalidRemote
            ? undefined
            : FINGERPRINT.test(inspection.observedWorktreeFingerprint ?? '')
                ? inspection.observedWorktreeFingerprint
                : undefined,
        resolvedWorktreePath: inspection.resolvedWorktreePath === path.resolve(expected.worktreePath)
            ? inspection.resolvedWorktreePath : undefined,
        reason: invalidRemote ? 'Git remote does not contain a trustworthy repository identity'
            : inspection.reason ? 'Repository inspection did not establish an authoritative checkout' : undefined,
    };
}

/** Explicit allowlist for the untrusted recovery-port container result. */
export function sanitizeContainerInspection(inspection: GoalContainerInspection): GoalContainerInspection {
    const status = ['running', 'exited', 'missing', 'daemon_unavailable'].includes(inspection.status)
        ? inspection.status : 'daemon_unavailable';
    const identity = inspection.recoveryIdentity;
    const recoveryIdentity = identity
        && isSafeIdentifier(identity.goalId) && isSafeIdentifier(identity.sessionId)
        && isSafeIdentifier(identity.turnId) && isSafeIdentifier(identity.attemptId)
        && Number.isSafeInteger(identity.executionEpoch) && identity.executionEpoch >= 0
        && FINGERPRINT.test(identity.worktreeFingerprint)
        ? {
            goalId: identity.goalId, sessionId: identity.sessionId,
            executionEpoch: identity.executionEpoch, turnId: identity.turnId,
            attemptId: identity.attemptId, worktreeFingerprint: identity.worktreeFingerprint,
        } : undefined;
    return {
        status,
        containerId: isSafeIdentifier(inspection.containerId) ? inspection.containerId : undefined,
        containerName: isSafeIdentifier(inspection.containerName) ? inspection.containerName : undefined,
        recoveryIdentity,
        reason: inspection.reason ? 'Container inspection did not establish an authoritative runtime' : undefined,
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
            return `Recovered container ${key} does not match authoritative identity`;
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
        return 'Authoritative goal worktree is unavailable';
    }
    if (!inspection.observedBranch) {
        return 'Authoritative worktree branch could not be observed';
    }
    const expectedFingerprint = fingerprintGoalWorktree(expected);
    if (!inspection.observedWorktreeFingerprint) {
        return 'Authoritative worktree fingerprint could not be observed';
    }
    if (inspection.observedWorktreeFingerprint !== expectedFingerprint) {
        return 'Worktree fingerprint mismatch against authoritative identity';
    }
    if (inspection.observedBranch !== expected.branch) {
        return 'Worktree branch mismatch against authoritative identity';
    }
    return null;
}
