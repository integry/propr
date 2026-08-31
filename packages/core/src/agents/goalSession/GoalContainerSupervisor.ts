import { createHash } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import {
    executeSupervisedDockerCommand,
    type SupervisedDockerExecution,
} from '../../claude/docker/dockerExecutor.js';
import type {
    GoalExecutionIdentity,
    GoalSessionEventSink,
    GoalSessionFence,
} from './contract.js';
import { StaleGoalSessionFenceError } from './GoalSessionSupervisor.js';

export interface GoalContainerLayout {
    executionId: string;
    containerName: string;
    sessionRoot: string;
    providerHome: string;
    logPath: string;
}

export interface StartGoalContainerRequest extends GoalSessionFence, GoalExecutionIdentity {
    image: string;
    command: string[];
    worktreePath: string;
    /** Provider-specific home location, for example /home/node/.codex. */
    providerHomeTarget: string;
    environment?: Record<string, string>;
    signal?: AbortSignal;
    timeout?: number;
    taskId?: string;
}

export interface GoalContainerRetentionPolicy {
    succeededMs: number;
    cancelledMs: number;
    failedMs: number;
}

/**
 * Terminal homes are retained briefly for diagnostics, then removed. Failed
 * sessions receive a longer window. Worktrees and event logs are owned by their
 * injected persistence ports and are never deleted by this supervisor.
 */
export const DEFAULT_GOAL_CONTAINER_RETENTION: GoalContainerRetentionPolicy = {
    succeededMs: 24 * 60 * 60 * 1000,
    cancelledMs: 24 * 60 * 60 * 1000,
    failedMs: 7 * 24 * 60 * 60 * 1000,
};

function opaquePart(value: string, length = 16): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function validateAbsolutePath(value: string, name: string): void {
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

export function buildGoalContainerLayout(baseDirectory: string, request: GoalSessionFence & GoalExecutionIdentity): GoalContainerLayout {
    validateAbsolutePath(baseDirectory, 'Goal container base directory');
    const goalScope = opaquePart(`${request.goalId}\0${request.sessionId}`, 24);
    const executionId = [
        goalScope,
        `e${request.controllerEpoch}`,
        opaquePart(request.turnId, 10),
        opaquePart(request.attemptId, 10),
    ].join('-');
    const sessionRoot = path.join(baseDirectory, 'goals', goalScope);
    return {
        executionId,
        containerName: `propr-goal-${executionId}`,
        sessionRoot,
        providerHome: path.join(sessionRoot, 'provider-home'),
        logPath: path.join(sessionRoot, 'logs', `${request.executionId}-${request.attemptId}.jsonl`),
    };
}

function validateEnvironment(environment: Record<string, string>): void {
    for (const name of Object.keys(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid container environment name: ${name}`);
    }
}

/**
 * Owns goal-scoped container resources and converts duplex byte output into
 * normalized, atomically fenced durable events. Provider adapters retain
 * responsibility for interpreting structured protocol lines.
 */
export class GoalContainerSupervisor {
    constructor(
        private readonly baseDirectory: string,
        private readonly events: GoalSessionEventSink,
        private readonly retention: GoalContainerRetentionPolicy = DEFAULT_GOAL_CONTAINER_RETENTION,
    ) {
        validateAbsolutePath(baseDirectory, 'Goal container base directory');
    }

    async start(request: StartGoalContainerRequest): Promise<{ layout: GoalContainerLayout; execution: SupervisedDockerExecution }> {
        validateAbsolutePath(request.worktreePath, 'Goal worktree path');
        validateAbsolutePath(request.providerHomeTarget, 'Provider home target');
        if (!request.image.trim()) throw new Error('Goal container image must be non-empty');
        const environment = request.environment ?? {};
        validateEnvironment(environment);
        const layout = buildGoalContainerLayout(this.baseDirectory, request);
        await Promise.all([
            mkdir(layout.providerHome, { recursive: true, mode: 0o700 }),
            mkdir(path.dirname(layout.logPath), { recursive: true, mode: 0o700 }),
        ]);

        const dockerArgs = [
            'run', '--rm', '--name', layout.containerName,
            '--mount', `type=bind,src=${layout.providerHome},dst=${request.providerHomeTarget}`,
            '--mount', `type=bind,src=${request.worktreePath},dst=/workspace`,
            '--workdir', '/workspace',
            ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
            request.image,
            ...request.command,
        ];
        const execution = executeSupervisedDockerCommand(dockerArgs, {
            ...request,
            durableOutput: async output => {
                const result = await this.events.append(request, request, {
                    type: 'output',
                    channel: output.channel,
                    data: output.data,
                });
                if (!result.accepted) {
                    throw new StaleGoalSessionFenceError(`Container output rejected by durable sink: ${result.reason}`);
                }
            },
        });
        return { layout, execution };
    }

    retentionDeadline(
        terminalAt: Date,
        outcome: 'succeeded' | 'cancelled' | 'failed',
    ): Date {
        const duration = outcome === 'succeeded'
            ? this.retention.succeededMs
            : outcome === 'cancelled'
                ? this.retention.cancelledMs
                : this.retention.failedMs;
        return new Date(terminalAt.getTime() + duration);
    }

    /** Removes only a previously derived, goal-scoped session directory after its retention deadline. */
    async cleanTerminalSession(
        layout: GoalContainerLayout,
        terminalAt: Date,
        outcome: 'succeeded' | 'cancelled' | 'failed',
        currentTime = new Date(),
    ): Promise<boolean> {
        if (currentTime < this.retentionDeadline(terminalAt, outcome)) return false;
        const base = await realpath(this.baseDirectory);
        const expectedParent = path.join(base, 'goals') + path.sep;
        const resolvedRoot = path.resolve(layout.sessionRoot);
        if (!resolvedRoot.startsWith(expectedParent) || path.dirname(resolvedRoot) !== path.join(base, 'goals')) {
            throw new Error('Refusing to clean a path outside the goal container resource directory');
        }
        await rm(resolvedRoot, { recursive: true, force: true });
        return true;
    }
}
