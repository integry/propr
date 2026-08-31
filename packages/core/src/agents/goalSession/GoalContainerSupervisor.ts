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
import { StaleGoalSessionFenceError } from './errors.js';

export interface GoalContainerLayout {
    executionId: string;
    containerName: string;
    sessionRoot: string;
    providerHome: string;
    logPath: string;
}

/**
 * A read-only credential source mounted into the container, kept separate from
 * the writable provider home so secrets never share a directory with mutable
 * goal state.
 */
export interface GoalCredentialMount {
    /** Absolute host path holding the credential material. */
    source: string;
    /** Absolute, provider-owned container path; mounted read-only. */
    target: string;
}

export interface StartGoalContainerRequest extends GoalSessionFence, GoalExecutionIdentity {
    image: string;
    command: string[];
    worktreePath: string;
    /** Provider-specific home location, for example /home/node/.codex. Must be provider-owned. */
    providerHomeTarget: string;
    /**
     * Allow-listed environment. Names are passed to Docker as `--env NAME` while
     * the values are injected into the docker client's environment, so secret
     * values never appear in argv or a process listing.
     */
    environment?: Record<string, string>;
    /** Read-only credential mounts, kept separate from the writable provider home. */
    credentialMounts?: ReadonlyArray<GoalCredentialMount>;
    signal?: AbortSignal;
    timeout?: number;
    taskId?: string;
}

/** Container paths a provider home may never shadow. */
const RESERVED_CONTAINER_PATHS = new Set(['/', '/workspace', '/etc', '/root', '/home', '/usr', '/bin', '/var', '/tmp', '/proc', '/sys', '/dev']);
/** Provider homes must live under one of these provider-owned roots. */
const PROVIDER_HOME_ROOTS = ['/home/', '/root/', '/opt/'];

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

/** Rejects a provider home that would shadow /workspace, /, or another sensitive mount. */
function validateProviderHomeTarget(target: string): void {
    validateAbsolutePath(target, 'Provider home target');
    const normalized = path.posix.normalize(target).replace(/\/+$/, '') || '/';
    if (RESERVED_CONTAINER_PATHS.has(normalized)) {
        throw new Error(`Provider home target may not shadow the reserved container path ${normalized}`);
    }
    if (normalized === '/workspace' || normalized.startsWith('/workspace/')) {
        throw new Error('Provider home target may not be placed inside the workspace mount');
    }
    if (!PROVIDER_HOME_ROOTS.some(root => normalized.startsWith(root))) {
        throw new Error(`Provider home target must be under a provider-owned root (${PROVIDER_HOME_ROOTS.join(', ')})`);
    }
}

function validateCredentialMounts(mounts: ReadonlyArray<GoalCredentialMount>, providerHomeTarget: string): void {
    const home = path.posix.normalize(providerHomeTarget).replace(/\/+$/, '');
    for (const mount of mounts) {
        validateAbsolutePath(mount.source, 'Credential mount source');
        validateAbsolutePath(mount.target, 'Credential mount target');
        const target = path.posix.normalize(mount.target).replace(/\/+$/, '');
        if (target === home || target.startsWith(`${home}/`)) {
            throw new Error('Credentials must be mounted separately from the writable provider home');
        }
        if (target === '/workspace' || target.startsWith('/workspace/')) {
            throw new Error('Credentials may not be mounted inside the writable workspace');
        }
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
        validateProviderHomeTarget(request.providerHomeTarget);
        if (!request.image.trim()) throw new Error('Goal container image must be non-empty');
        const environment = request.environment ?? {};
        validateEnvironment(environment);
        const credentialMounts = request.credentialMounts ?? [];
        validateCredentialMounts(credentialMounts, request.providerHomeTarget);
        const layout = buildGoalContainerLayout(this.baseDirectory, request);
        await Promise.all([
            mkdir(layout.providerHome, { recursive: true, mode: 0o700 }),
            mkdir(path.dirname(layout.logPath), { recursive: true, mode: 0o700 }),
        ]);

        const dockerArgs = [
            'run', '--rm', '--name', layout.containerName,
            '--mount', `type=bind,src=${layout.providerHome},dst=${request.providerHomeTarget}`,
            '--mount', `type=bind,src=${request.worktreePath},dst=/workspace`,
            ...credentialMounts.flatMap(mount => ['--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`]),
            '--workdir', '/workspace',
            // Names only: values are forwarded through the docker client's own
            // environment so secrets never appear in argv/process listings.
            ...Object.keys(environment).flatMap(name => ['--env', name]),
            request.image,
            ...request.command,
        ];
        const execution = executeSupervisedDockerCommand(dockerArgs, {
            ...request,
            env: environment,
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

    /**
     * Removes only a previously derived, goal-scoped session directory after its
     * retention deadline. The path is resolved through realpath so a symlinked
     * session root (or any symlinked ancestor) that points outside the goal
     * resource directory is rejected rather than followed.
     */
    async cleanTerminalSession(
        layout: GoalContainerLayout,
        terminalAt: Date,
        outcome: 'succeeded' | 'cancelled' | 'failed',
        currentTime = new Date(),
    ): Promise<boolean> {
        if (currentTime < this.retentionDeadline(terminalAt, outcome)) return false;
        const realGoals = await realpath(path.join(await realpath(this.baseDirectory), 'goals')).catch(() => null);
        if (!realGoals) return false;

        // The lexical target must already be inside the goals directory before we
        // touch the filesystem, and its real (symlink-resolved) location must land
        // in exactly the same goals directory.
        const lexicalRoot = path.resolve(layout.sessionRoot);
        if (path.dirname(lexicalRoot) !== path.join(await realpath(this.baseDirectory), 'goals')) {
            throw new Error('Refusing to clean a path outside the goal container resource directory');
        }
        let resolvedRoot: string;
        try {
            resolvedRoot = await realpath(lexicalRoot);
        } catch {
            return false; // Already removed.
        }
        if (path.dirname(resolvedRoot) !== realGoals || resolvedRoot === realGoals) {
            throw new Error('Refusing to clean a symlinked path that escapes the goal container resource directory');
        }
        await rm(resolvedRoot, { recursive: true, force: true });
        return true;
    }
}
