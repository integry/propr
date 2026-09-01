import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SupervisedDockerOutput } from '../../claude/docker/dockerExecutor.js';
import type {
    GoalExecutionIdentity, GoalSessionFence, GoalSessionIdentity,
} from './contract.js';

export interface GoalContainerLayout {
    executionId: string;
    containerName: string;
    sessionRoot: string;
    providerHome: string;
    logPath: string;
}

/** A read-only credential source kept separate from writable provider state. */
export interface GoalCredentialMount {
    source: string;
    target: string;
    provider?: 'claude' | 'codex' | 'antigravity';
}

/** Adapter-facing view of exact in-memory protocol chunks (never persistence). */
export interface GoalContainerOutputObserver {
    next(output: Readonly<SupervisedDockerOutput>): void | 'unsubscribe' | Promise<void | 'unsubscribe'>;
    complete?(): void | Promise<void>;
    error?(error: Error): void | Promise<void>;
}

export interface StartGoalContainerRequest extends GoalSessionFence, GoalExecutionIdentity {
    image: string;
    command: string[];
    worktreePath: string;
    worktreeFingerprint: string;
    providerHomeTarget: string;
    environment?: Record<string, string>;
    credentialMounts?: ReadonlyArray<GoalCredentialMount>;
    outputObserver?: GoalContainerOutputObserver;
    signal?: AbortSignal;
    timeout?: number;
    taskId?: string;
}

/** Eager provider process construction is control-scoped and never invents a turn. */
export interface StartGoalOpenContainerRequest extends GoalSessionIdentity, GoalExecutionIdentity {
    controllerEpoch: number;
    deterministicOpenKey: string;
    image: string;
    command: string[];
    worktreePath: string;
    worktreeFingerprint: string;
    providerHomeTarget: string;
    environment?: Record<string, string>;
    credentialMounts?: ReadonlyArray<GoalCredentialMount>;
    outputObserver?: GoalContainerOutputObserver;
    signal?: AbortSignal;
    timeout?: number;
    taskId?: string;
}

export interface GoalContainerRetentionPolicy {
    succeededMs: number;
    cancelledMs: number;
    failedMs: number;
}

/** Host resources explicitly approved for this supervisor instance. */
export interface GoalContainerIsolationPolicy {
    environmentKeys: ReadonlyArray<string>;
    worktreePaths: ReadonlyArray<string>;
    providerHomeTargets: ReadonlyArray<string>;
    credentialMounts?: ReadonlyArray<GoalCredentialMount>;
}

export const DEFAULT_GOAL_CONTAINER_RETENTION: GoalContainerRetentionPolicy = {
    succeededMs: 24 * 60 * 60 * 1000,
    cancelledMs: 24 * 60 * 60 * 1000,
    failedMs: 7 * 24 * 60 * 60 * 1000,
};

export const GOAL_SCOPE_PATTERN = /^[a-f0-9]{24}$/;

function opaquePart(value: string, length = 16): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function goalScopeFor(request: GoalSessionIdentity): string {
    return opaquePart(`${request.goalId}\0${request.sessionId}`, 24);
}

export function validateAbsolutePath(value: string, name: string): void {
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

/** Rejects characters that Docker would parse as additional mount options. */
export function validateBindMountPath(value: string, name: string): void {
    validateAbsolutePath(value, name);
    if (/[,=\n\r\0]/.test(value)) {
        throw new Error(`${name} may not contain a comma, '=', or control character that could inject Docker --mount options`);
    }
}

export function buildGoalContainerLayout(
    baseDirectory: string,
    request: GoalSessionFence & GoalExecutionIdentity,
): GoalContainerLayout {
    return buildScopedGoalContainerLayout(baseDirectory, request, request.turnId);
}

export function buildGoalOpenContainerLayout(
    baseDirectory: string,
    request: StartGoalOpenContainerRequest,
): GoalContainerLayout {
    return buildScopedGoalContainerLayout(baseDirectory, request, `open:${request.deterministicOpenKey}`);
}

function buildScopedGoalContainerLayout(
    baseDirectory: string,
    request: GoalSessionIdentity & GoalExecutionIdentity & { controllerEpoch: number },
    operationIdentity: string,
): GoalContainerLayout {
    validateBindMountPath(baseDirectory, 'Goal container base directory');
    const goalScope = goalScopeFor(request);
    const executionId = [
        goalScope,
        `e${request.controllerEpoch}`,
        opaquePart(operationIdentity, 10),
        opaquePart(request.attemptId, 10),
    ].join('-');
    const sessionRoot = path.join(baseDirectory, 'goals', goalScope);
    const logDir = path.join(sessionRoot, 'logs');
    const logPath = path.join(logDir, `${executionId}.jsonl`);
    if (path.dirname(logPath) !== logDir) throw new Error('Derived goal log path escaped the goal log directory');
    return {
        executionId,
        containerName: `propr-goal-${executionId}`,
        sessionRoot,
        providerHome: path.join(sessionRoot, 'provider-home'),
        logPath,
    };
}
