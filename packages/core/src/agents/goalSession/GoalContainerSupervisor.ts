import { createHash } from 'node:crypto';
import { appendFile, mkdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
    executeSupervisedDockerCommand,
    type SupervisedDockerExecution,
    type SupervisedDockerOutput,
} from '../../claude/docker/dockerExecutor.js';
import type {
    GoalExecutionIdentity,
    GoalSessionEventSink,
    GoalSessionFence,
    GoalSessionIdentity,
} from './contract.js';
import { StaleGoalSessionFenceError } from './errors.js';
import { isSensitiveWorktreePath } from './worktreeIdentity.js';

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
    /** Durable fingerprint of the exact worktree recorded on the active turn. */
    worktreeFingerprint: string;
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
const CREDENTIAL_TARGET_DENY_TREES = ['/proc', '/sys', '/dev'];
const MAX_GOAL_LOG_BYTES = 8 * 1024 * 1024;

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

/**
 * Terminal homes and their bounded diagnostic logs are retained briefly, then
 * removed. Failed sessions receive a longer window. Worktrees and authoritative
 * events owned by the injected persistence ports are never deleted here.
 */
export const DEFAULT_GOAL_CONTAINER_RETENTION: GoalContainerRetentionPolicy = {
    succeededMs: 24 * 60 * 60 * 1000,
    cancelledMs: 24 * 60 * 60 * 1000,
    failedMs: 7 * 24 * 60 * 60 * 1000,
};

/** An opaque, derived goal scope: 24 hex characters from buildGoalContainerLayout. */
const GOAL_SCOPE_PATTERN = /^[a-f0-9]{24}$/;

function opaquePart(value: string, length = 16): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function goalScopeFor(request: GoalSessionIdentity): string {
    return opaquePart(`${request.goalId}\0${request.sessionId}`, 24);
}

function validateAbsolutePath(value: string, name: string): void {
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

/**
 * Validates a host path that is interpolated into a Docker `--mount` CSV value.
 * A comma, `=`, or control character would be parsed by Docker as an additional
 * mount field/option, so such paths are rejected outright.
 */
function validateBindMountPath(value: string, name: string): void {
    validateAbsolutePath(value, name);
    if (/[,=\n\r\0]/.test(value)) {
        throw new Error(`${name} may not contain a comma, '=', or control character that could inject Docker --mount options`);
    }
}

export function buildGoalContainerLayout(baseDirectory: string, request: GoalSessionFence & GoalExecutionIdentity): GoalContainerLayout {
    validateBindMountPath(baseDirectory, 'Goal container base directory');
    const goalScope = goalScopeFor(request);
    const executionId = [
        goalScope,
        `e${request.controllerEpoch}`,
        opaquePart(request.turnId, 10),
        opaquePart(request.attemptId, 10),
    ].join('-');
    const sessionRoot = path.join(baseDirectory, 'goals', goalScope);
    const logDir = path.join(sessionRoot, 'logs');
    // The log file name is built only from the opaque, derived executionId, so
    // caller-controlled turn/attempt identifiers can never inject a separator or
    // `..` that would escape the goal's log directory.
    const logPath = path.join(logDir, `${executionId}.jsonl`);
    if (path.dirname(logPath) !== logDir) {
        throw new Error('Derived goal log path escaped the goal log directory');
    }
    return {
        executionId,
        containerName: `propr-goal-${executionId}`,
        sessionRoot,
        providerHome: path.join(sessionRoot, 'provider-home'),
        logPath,
    };
}

const BLOCKED_ENVIRONMENT_KEYS = /^(?:DOCKER(?:_|$)|LD_PRELOAD$|LD_LIBRARY_PATH$|SSH(?:_|$)|HOME$|NODE_OPTIONS$|GIT_ASKPASS$|GIT_SSH(?:_|$)|AWS_(?:CONFIG|SHARED_CREDENTIALS)_FILE$|GOOGLE_APPLICATION_CREDENTIALS$)/;

function validateEnvironment(environment: Record<string, string>, allowedKeys: ReadonlySet<string>): void {
    for (const name of Object.keys(environment)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid container environment name: ${name}`);
        if (BLOCKED_ENVIRONMENT_KEYS.test(name.toUpperCase())) {
            throw new Error(`Container environment key ${name} is host-controlled or sensitive and may not be forwarded`);
        }
        if (!allowedKeys.has(name)) throw new Error(`Container environment key ${name} is not explicitly allow-listed`);
    }
}

/** Rejects a provider home that would shadow /workspace, /, or another sensitive mount. */
function validateProviderHomeTarget(target: string, allowedTargets: ReadonlySet<string>): void {
    validateBindMountPath(target, 'Provider home target');
    const normalized = path.posix.normalize(target).replace(/\/+$/, '') || '/';
    if (target !== normalized) throw new Error('Provider home target must be canonical and may not contain traversal aliases');
    if (RESERVED_CONTAINER_PATHS.has(normalized)) {
        throw new Error(`Provider home target may not shadow the reserved container path ${normalized}`);
    }
    if (normalized === '/workspace' || normalized.startsWith('/workspace/')) {
        throw new Error('Provider home target may not be placed inside the workspace mount');
    }
    if (!PROVIDER_HOME_ROOTS.some(root => normalized.startsWith(root))) {
        throw new Error(`Provider home target must be under a provider-owned root (${PROVIDER_HOME_ROOTS.join(', ')})`);
    }
    if (!allowedTargets.has(normalized)) throw new Error(`Provider home target ${normalized} is not explicitly allow-listed`);
}

const SENSITIVE_SOURCE_SEGMENT = /(?:^|\/)(?:\.ssh|\.aws|\.docker|\.config|credentials?|id_rsa|id_ed25519)(?:\/|$)/i;
const CONTAINER_SOCKET_PATHS = new Set(['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock']);
const BROAD_HOST_PATHS = new Set(['/', '/root', '/home', '/etc', '/var/run/docker.sock']);

async function resolveApprovedSource(source: string, allowedSources: ReadonlySet<string>, name: string): Promise<string> {
    validateBindMountPath(source, name);
    const lexical = path.resolve(source);
    if (source !== lexical) throw new Error(`${name} must be canonical and may not contain traversal aliases`);
    if (name === 'Goal worktree path' && isSensitiveWorktreePath(lexical)) {
        throw new Error(`${name} may not be a sensitive host root or descendant`);
    }
    const resolved = await realpath(lexical).catch(() => null);
    if (!resolved || resolved !== lexical) throw new Error(`${name} must exist and may not use a symlink alias`);
    if (name === 'Goal worktree path' && isSensitiveWorktreePath(resolved)) {
        throw new Error(`${name} may not resolve to a sensitive host root or descendant`);
    }
    if (!allowedSources.has(resolved)) throw new Error(`${name} is not explicitly allow-listed`);
    return resolved;
}

async function canonicalCredentialSource(source: string): Promise<string> {
    validateBindMountPath(source, 'Credential mount source');
    const lexical = path.resolve(source);
    if (source !== lexical) throw new Error('Credential mount source must be canonical and may not contain traversal aliases');
    const resolved = await realpath(lexical).catch(() => null);
    if (!resolved || resolved !== lexical) throw new Error('Credential mount source must exist and may not use a symlink alias');
    if (BROAD_HOST_PATHS.has(resolved) || SENSITIVE_SOURCE_SEGMENT.test(resolved)) {
        throw new Error('Credential mount source is a broad or sensitive host path');
    }
    if (!(await stat(resolved)).isFile()) throw new Error('Credential mount source must be an explicitly approved file');
    return resolved;
}

function canonicalCredentialTarget(target: string): string {
    validateBindMountPath(target, 'Credential mount target');
    const normalized = path.posix.normalize(target).replace(/\/+$/, '');
    if (target !== normalized) throw new Error('Credential mount target must be canonical and may not contain traversal aliases');
    if (RESERVED_CONTAINER_PATHS.has(normalized) || CONTAINER_SOCKET_PATHS.has(normalized)
        || CREDENTIAL_TARGET_DENY_TREES.some(root => normalized.startsWith(`${root}/`))
        || normalized.startsWith('/etc/') || SENSITIVE_SOURCE_SEGMENT.test(normalized)) {
        throw new Error('Credential mount target is a broad or sensitive container path');
    }
    return normalized;
}

function utf8Prefix(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value) <= maxBytes) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
        else high = middle - 1;
    }
    return value.slice(0, low);
}

function createGoalLogSink(logPath: string): (output: SupervisedDockerOutput) => Promise<void> {
    let usedBytes: number | undefined;
    return async output => {
        usedBytes ??= await stat(logPath).then(value => value.size).catch(() => 0);
        const remaining = MAX_GOAL_LOG_BYTES - usedBytes;
        if (remaining <= 0) return;
        const outputData = output.data;
        // This is a second, independent allowlist at the persistence boundary.
        // Never serialize the delivered object wholesale: callers and adapters
        // can supply structurally valid objects with secret-bearing excess keys.
        const base = {
            goalId: output.goalId,
            sessionId: output.sessionId,
            controllerEpoch: output.controllerEpoch,
            turnId: output.turnId,
            executionId: output.executionId,
            attemptId: output.attemptId,
            worktreeFingerprint: output.worktreeFingerprint,
            sequence: output.sequence,
            recordedAt: output.recordedAt,
            channel: output.channel,
        };
        const overhead = Buffer.byteLength(`${JSON.stringify({ ...base, data: '', truncated: true })}\n`);
        const data = utf8Prefix(outputData, Math.max(0, remaining - overhead));
        const line = `${JSON.stringify({ ...base, data, truncated: data !== outputData })}\n`;
        const lineBytes = Buffer.byteLength(line);
        if (lineBytes > remaining) return;
        await appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
        usedBytes += lineBytes;
    };
}

async function validateCredentialMounts(
    mounts: ReadonlyArray<GoalCredentialMount>,
    providerHomeTarget: string,
    allowedMounts: ReadonlySet<string>,
): Promise<void> {
    const home = path.posix.normalize(providerHomeTarget).replace(/\/+$/, '');
    for (const mount of mounts) {
        const source = await canonicalCredentialSource(mount.source);
        const target = canonicalCredentialTarget(mount.target);
        if (!allowedMounts.has(`${source}\0${target}`)) {
            throw new Error('Credential mount source and target pair is not explicitly allow-listed');
        }
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
        private readonly isolation: GoalContainerIsolationPolicy = {
            environmentKeys: [], worktreePaths: [], providerHomeTargets: [], credentialMounts: [],
        },
    ) {
        validateAbsolutePath(baseDirectory, 'Goal container base directory');
    }

    async start(request: StartGoalContainerRequest): Promise<{ layout: GoalContainerLayout; execution: SupervisedDockerExecution }> {
        const worktreePath = await resolveApprovedSource(
            request.worktreePath,
            new Set(this.isolation.worktreePaths.map(value => path.resolve(value))),
            'Goal worktree path',
        );
        if (!(await stat(worktreePath)).isDirectory()) throw new Error('Goal worktree path must be a directory');
        validateProviderHomeTarget(
            request.providerHomeTarget,
            new Set(this.isolation.providerHomeTargets.map(value => path.posix.normalize(value).replace(/\/+$/, ''))),
        );
        if (!request.image.trim()) throw new Error('Goal container image must be non-empty');
        if (!request.worktreeFingerprint.trim()) throw new Error('Goal worktree fingerprint must be non-empty');
        const environment = request.environment ?? {};
        validateEnvironment(environment, new Set(this.isolation.environmentKeys));
        const credentialMounts = request.credentialMounts ?? [];
        await validateCredentialMounts(
            credentialMounts,
            request.providerHomeTarget,
            new Set((this.isolation.credentialMounts ?? []).map(mount =>
                `${path.resolve(mount.source)}\0${path.posix.normalize(mount.target).replace(/\/+$/, '')}`)),
        );
        const layout = buildGoalContainerLayout(this.baseDirectory, request);
        await Promise.all([
            mkdir(layout.providerHome, { recursive: true, mode: 0o700 }),
            mkdir(path.dirname(layout.logPath), { recursive: true, mode: 0o700 }),
        ]);
        const appendGoalLog = createGoalLogSink(layout.logPath);
        // Explicit public DTOs: the start request also carries commands,
        // environment values, mounts, host paths, task IDs, and arbitrary excess
        // properties. None of those may cross the durable event boundary.
        const eventFence: GoalSessionFence = {
            goalId: request.goalId,
            sessionId: request.sessionId,
            controllerEpoch: request.controllerEpoch,
            turnId: request.turnId,
        };
        const eventExecution: GoalExecutionIdentity = {
            executionId: request.executionId,
            attemptId: request.attemptId,
        };

        const dockerArgs = [
            'run', '--rm', '--name', layout.containerName,
            '--mount', `type=bind,src=${layout.providerHome},dst=${request.providerHomeTarget}`,
            '--mount', `type=bind,src=${worktreePath},dst=/workspace`,
            ...credentialMounts.flatMap(mount => ['--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`]),
            '--workdir', '/workspace',
            // Names only: values are forwarded through the docker client's own
            // environment so secrets never appear in argv/process listings.
            ...Object.keys(environment).flatMap(name => ['--env', name]),
            request.image,
            ...request.command,
        ];
        const execution = executeSupervisedDockerCommand(dockerArgs, {
            goalId: request.goalId,
            sessionId: request.sessionId,
            controllerEpoch: request.controllerEpoch,
            turnId: request.turnId,
            executionId: request.executionId,
            attemptId: request.attemptId,
            worktreeFingerprint: request.worktreeFingerprint,
            taskId: request.taskId,
            signal: request.signal,
            timeout: request.timeout,
            env: environment,
            durableOutput: async output => {
                const result = await this.events.append(eventFence, eventExecution, {
                    type: 'output',
                    channel: output.channel,
                    data: output.data,
                });
                if (!result.accepted) {
                    throw new StaleGoalSessionFenceError(`Container output rejected by durable sink: ${result.reason}`);
                }
                await appendGoalLog(output);
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
     * retention deadline. The target must be a real directory whose lexical path
     * is exactly its symlink-resolved path: any symlink is rejected, including an
     * in-tree one pointing at a sibling goal's real directory, so cleanup can
     * never delete another goal's resources through a redirected session root.
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

        // Derived-layout ownership: the lexical target must be an immediate child
        // of the real goals directory whose name is an opaque, derived goal scope,
        // exactly as buildGoalContainerLayout produces it.
        const lexicalRoot = path.resolve(layout.sessionRoot);
        if (path.dirname(lexicalRoot) !== realGoals || !GOAL_SCOPE_PATTERN.test(path.basename(lexicalRoot))) {
            throw new Error('Refusing to clean a path outside the goal container resource directory');
        }
        let resolvedRoot: string;
        try {
            resolvedRoot = await realpath(lexicalRoot);
        } catch {
            return false; // Already removed.
        }
        // Lexical/resolved identity: a session root that is (or traverses) a
        // symlink resolves to a different real path than its derived location.
        // Rejecting the mismatch spares both external and in-tree sibling targets.
        if (resolvedRoot !== lexicalRoot) {
            throw new Error('Refusing to clean a symlinked goal session directory');
        }
        await rm(resolvedRoot, { recursive: true, force: true });
        return true;
    }
}
