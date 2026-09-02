import { appendFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
    executeSupervisedDockerCommand,
    type SupervisedDockerExecution,
    type SupervisedDockerOutput,
} from '../../claude/docker/dockerExecutor.js';
import type {
    GoalExecutionIdentity,
    GoalProviderFirstEffectPort,
    GoalSessionEventSink,
    GoalSessionFence,
} from './contract.js';
import type { GoalSupervisedOpenClaim } from './goalSessionOpen.js';
import { PendingOpenOwnership } from './pendingOpenOwnership.js';
import { cleanTerminalGoalSession } from './terminalContainerCleanup.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { startedProviderEffect } from './providerEffectProtocol.js';
import { assertSafeCallerTurnIdentity } from './safeIdentifier.js';
import { sanitizeGoalSessionEvent } from './securityBoundary.js';
import { isSensitiveHostSourcePath } from './worktreeIdentity.js';
import {
    buildGoalContainerLayout, buildGoalOpenContainerLayout, DEFAULT_GOAL_CONTAINER_RETENTION,
    validateAbsolutePath, validateBindMountPath,
    type GoalContainerIsolationPolicy, type GoalContainerLayout, type GoalContainerRetentionPolicy,
    type GoalCredentialMount, type StartGoalContainerRequest, type StartGoalOpenContainerRequest,
} from './goalContainerLayout.js';
export {
    buildGoalContainerLayout, buildGoalOpenContainerLayout, DEFAULT_GOAL_CONTAINER_RETENTION,
} from './goalContainerLayout.js';
export type {
    GoalContainerIsolationPolicy, GoalContainerLayout, GoalContainerOutputObserver,
    GoalContainerRetentionPolicy, GoalCredentialMount, StartGoalContainerRequest, StartGoalOpenContainerRequest,
} from './goalContainerLayout.js';

export interface GoalContainerSupervisorOptions {
    isolation?: GoalContainerIsolationPolicy;
    providerFirstEffects?: GoalProviderFirstEffectPort;
}

function resolveSupervisorOptions(
    value: GoalContainerSupervisorOptions | GoalContainerIsolationPolicy,
): GoalContainerSupervisorOptions {
    return 'environmentKeys' in value && 'worktreePaths' in value && 'providerHomeTargets' in value
        ? { isolation: value } : value;
}

/** Container paths a provider home may never shadow. */
const RESERVED_CONTAINER_PATHS = new Set(['/', '/workspace', '/etc', '/root', '/home', '/usr', '/bin', '/var', '/tmp', '/proc', '/sys', '/dev']);
/** Provider homes must live under one of these provider-owned roots. */
const PROVIDER_HOME_ROOTS = ['/home/', '/root/', '/opt/'];
const CREDENTIAL_TARGET_DENY_TREES = ['/proc', '/sys', '/dev'];
const MAX_GOAL_LOG_BYTES = 8 * 1024 * 1024;

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

const SENSITIVE_SOURCE_SEGMENT = /(?:^|\/)(?:\.ssh|\.aws|\.docker|\.config|id_rsa|id_ed25519)(?:\/|$)/i;
const CONTAINER_SOCKET_PATHS = new Set(['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock']);
const CREDENTIAL_SOURCE_DENY_TREES = ['/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/bin', '/sbin', '/usr', '/var/lib/docker', '/var/lib/containers'];

async function resolveApprovedSource(source: string, allowedSources: ReadonlySet<string>, name: string): Promise<string> {
    validateBindMountPath(source, name);
    const lexical = path.resolve(source);
    if (source !== lexical) throw new Error(`${name} must be canonical and may not contain traversal aliases`);
    if (name === 'Goal worktree path' && isSensitiveHostSourcePath(lexical)) {
        throw new Error(`${name} may not be a sensitive host root or descendant`);
    }
    const resolved = await realpath(lexical).catch(() => null);
    if (!resolved || resolved !== lexical) throw new Error(`${name} must exist and may not use a symlink alias`);
    if (name === 'Goal worktree path' && isSensitiveHostSourcePath(resolved)) {
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
    if (CONTAINER_SOCKET_PATHS.has(lexical) || CONTAINER_SOCKET_PATHS.has(resolved)
        || SENSITIVE_SOURCE_SEGMENT.test(resolved)
        || CREDENTIAL_SOURCE_DENY_TREES.some(root => resolved === root || resolved.startsWith(`${root}/`))) {
        throw new Error('Credential mount source is a broad or sensitive host path');
    }
    if (!(await stat(resolved)).isFile()) throw new Error('Credential mount source is a broad or sensitive path, not a regular file');
    return resolved;
}

function canonicalCredentialTarget(target: string): string {
    validateBindMountPath(target, 'Credential mount target');
    const normalized = path.posix.normalize(target).replace(/\/+$/, '');
    if (target !== normalized) throw new Error('Credential mount target must be canonical and may not contain traversal aliases');
    if (RESERVED_CONTAINER_PATHS.has(normalized) || CONTAINER_SOCKET_PATHS.has(normalized)
        || CREDENTIAL_TARGET_DENY_TREES.some(root => normalized.startsWith(`${root}/`))
        || normalized.startsWith('/etc/')) {
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
        const provider = mount.provider ?? credentialProviderForTarget(target) ?? credentialProviderForHome(home);
        if (!provider || !isProviderCredentialTarget(provider, target)) {
            throw new Error('Credential mount target is not owned by Claude, Codex, or Antigravity');
        }
        if (!allowedMounts.has(`${provider}\0${source}\0${target}`)
            && !allowedMounts.has(`${source}\0${target}`)) {
            throw new Error('Credential mount source and target pair is not explicitly allow-listed');
        }
        if (target === home) throw new Error('A credential file may not replace the writable provider home directory');
        if (target === '/workspace' || target.startsWith('/workspace/')) {
            throw new Error('Credentials may not be mounted inside the writable workspace');
        }
    }
}

function credentialProviderForTarget(target: string): GoalCredentialMount['provider'] {
    if (target === '/home/node/.claude.json' || target.startsWith('/home/node/.claude/')) return 'claude';
    if (target.startsWith('/home/node/.codex/')) return 'codex';
    if (target.startsWith('/home/node/.gemini/')) return 'antigravity';
    return undefined;
}

function credentialProviderForHome(home: string): GoalCredentialMount['provider'] {
    if (home === '/home/node/.claude') return 'claude';
    if (home === '/home/node/.codex') return 'codex';
    if (home === '/home/node/.gemini') return 'antigravity';
    return undefined;
}

function isProviderCredentialTarget(provider: NonNullable<GoalCredentialMount['provider']>, target: string): boolean {
    return credentialProviderForTarget(target) === provider || target === '/home/node/.creds';
}

function assertContainerOperationFence(
    request: StartGoalContainerRequest | StartGoalOpenContainerRequest,
    fence: import('./contract.js').GoalProviderOperationFence,
    scope: 'turn' | 'open',
): void {
    const turnId = scope === 'turn' ? (request as StartGoalContainerRequest).turnId : undefined;
    if (fence.goalId !== request.goalId || fence.sessionId !== request.sessionId
        || fence.controllerEpoch !== request.controllerEpoch
        || fence.executionId !== request.executionId || fence.attemptId !== request.attemptId
        || fence.turnId !== turnId || fence.kind !== scope) {
        throw new GoalSessionContractError(
            'Container operation fence does not match its durable execution claim', 'STALE_FENCE',
        );
    }
}

/**
 * Owns goal-scoped container resources and converts duplex byte output into
 * normalized, atomically fenced durable events. Provider adapters retain
 * responsibility for interpreting structured protocol lines.
 */
export class GoalContainerSupervisor {
    private readonly isolation: GoalContainerIsolationPolicy;
    private readonly providerFirstEffects?: GoalProviderFirstEffectPort;
    private readonly pendingOpen = new PendingOpenOwnership();

    constructor(
        private readonly baseDirectory: string,
        private readonly events: GoalSessionEventSink,
        private readonly retention: GoalContainerRetentionPolicy = DEFAULT_GOAL_CONTAINER_RETENTION,
        options: GoalContainerSupervisorOptions | GoalContainerIsolationPolicy = {},
    ) {
        const resolved = resolveSupervisorOptions(options);
        this.isolation = resolved.isolation ?? {
            environmentKeys: [], worktreePaths: [], providerHomeTargets: [], credentialMounts: [],
        };
        this.providerFirstEffects = resolved.providerFirstEffects;
        validateAbsolutePath(baseDirectory, 'Goal container base directory');
    }

    async start(request: StartGoalContainerRequest): Promise<{ layout: GoalContainerLayout; execution: SupervisedDockerExecution }> {
        return this.startScoped(request, 'turn');
    }

    async startOpen(request: StartGoalOpenContainerRequest): Promise<{ layout: GoalContainerLayout; execution: SupervisedDockerExecution }> {
        return this.startScoped(request, 'open');
    }

    /** Idempotently releases a process still owned by its exact eager-open attempt. */
    async cancelPendingOpen(claim: Readonly<GoalSupervisedOpenClaim>): Promise<void> { await this.pendingOpen.cancel(claim); }

    async cancelPendingOpenAttempt(identity: { goalId: string; sessionId: string; attemptId: string }): Promise<void> {
        await this.pendingOpen.cancelIdentity(identity); }

    /** Transfers cleanup ownership to the now-persisted provider session. */
    transferPendingOpen(claim: Readonly<GoalSupervisedOpenClaim>): void {
        this.pendingOpen.transfer(claim);
    }

    private async startScoped(
        request: StartGoalContainerRequest | StartGoalOpenContainerRequest,
        scope: 'turn' | 'open',
    ): Promise<{ layout: GoalContainerLayout; execution: SupervisedDockerExecution }> {
        assertSafeCallerTurnIdentity({
            turnId: scope === 'turn' ? (request as StartGoalContainerRequest).turnId : 'open',
            executionId: request.executionId,
            attemptId: request.attemptId,
        });
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
                `${mount.provider ?? credentialProviderForTarget(path.posix.normalize(mount.target).replace(/\/+$/, '')) ?? credentialProviderForHome(path.posix.normalize(request.providerHomeTarget).replace(/\/+$/, '')) ?? ''}\0${path.resolve(mount.source)}\0${path.posix.normalize(mount.target).replace(/\/+$/, '')}`)),
        );
        const layout = scope === 'turn'
            ? buildGoalContainerLayout(this.baseDirectory, request as StartGoalContainerRequest)
            : buildGoalOpenContainerLayout(this.baseDirectory, request as StartGoalOpenContainerRequest);
        await Promise.all([
            mkdir(layout.providerHome, { recursive: true, mode: 0o700 }),
            mkdir(path.dirname(layout.logPath), { recursive: true, mode: 0o700 }),
        ]);
        const appendGoalLog = createGoalLogSink(layout.logPath);
        let observerSubscribed = request.outputObserver !== undefined;
        // Explicit public DTOs: the start request also carries commands,
        // environment values, mounts, host paths, task IDs, and arbitrary excess
        // properties. None of those may cross the durable event boundary.
        const eventFence = {
            goalId: request.goalId,
            sessionId: request.sessionId,
            controllerEpoch: request.controllerEpoch,
            ...(scope === 'turn' ? { turnId: (request as StartGoalContainerRequest).turnId } : {}),
        };
        const eventExecution: GoalExecutionIdentity = {
            executionId: request.executionId,
            attemptId: request.attemptId,
        };
        const operationFence = request.operationFence;
        assertContainerOperationFence(request, operationFence, scope);
        if (!this.providerFirstEffects) throw new GoalSessionContractError(
            'Container start requires the authoritative provider first-effect gate', 'FIRST_EFFECT_GATE_MISSING',
        );

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
        const execution = await this.providerFirstEffects.start<SupervisedDockerExecution>(
            operationFence, 'container_spawn', () => {
                const started = executeSupervisedDockerCommand(dockerArgs, {
            goalId: request.goalId,
            sessionId: request.sessionId,
            controllerEpoch: request.controllerEpoch,
            turnId: scope === 'turn' ? (request as StartGoalContainerRequest).turnId : undefined,
            scope,
            openKey: scope === 'open'
                ? (request as StartGoalOpenContainerRequest).deterministicOpenKey : undefined,
            executionId: request.executionId,
            attemptId: request.attemptId,
            worktreeFingerprint: request.worktreeFingerprint,
            taskId: request.taskId,
            operationGeneration: operationFence.generation,
            operationKind: operationFence.kind,
            operationId: operationFence.operationId,
            operationLeaseExpiresAt: operationFence.leaseExpiresAt,
            signal: request.signal,
            timeout: request.timeout,
            env: environment,
            durableOutput: async output => {
                const safeOutput = sanitizeGoalSessionEvent({
                    type: 'output',
                    channel: output.channel,
                    data: output.data,
                });
                if (safeOutput.type !== 'output') throw new Error('Output sanitizer returned an invalid event');
                const result = scope === 'turn'
                    ? await this.events.append(eventFence as GoalSessionFence, eventExecution, safeOutput)
                    : await this.events.appendControl(eventFence, eventExecution, safeOutput);
                if (!result.accepted) {
                    throw new StaleGoalSessionFenceError(`Container output rejected by durable sink: ${result.reason}`);
                }
                await appendGoalLog({ ...output, channel: safeOutput.channel, data: safeOutput.data });
                if (observerSubscribed && request.outputObserver) {
                    let disposition: void | 'unsubscribe';
                    try {
                        disposition = await request.outputObserver.next(Object.freeze({
                            goalId: output.goalId, sessionId: output.sessionId,
                            controllerEpoch: output.controllerEpoch, turnId: output.turnId,
                            executionId: output.executionId, attemptId: output.attemptId,
                            worktreeFingerprint: output.worktreeFingerprint, sequence: output.sequence,
                            operationGeneration: output.operationGeneration,
                            operationKind: output.operationKind, operationId: output.operationId,
                            operationLeaseExpiresAt: output.operationLeaseExpiresAt,
                            recordedAt: output.recordedAt, channel: output.channel, data: output.data,
                        }));
                    } catch {
                        throw new GoalSessionContractError(
                            'Provider output consumer failed safely', 'PROVIDER_OPERATION_FAILED',
                        );
                    }
                    if (disposition === 'unsubscribe') observerSubscribed = false;
                }
            },
                });
                if (scope === 'open') {
                    this.pendingOpen.register({
                        executionId: request.executionId, attemptId: request.attemptId,
                        deterministicOpenKey: (request as StartGoalOpenContainerRequest).deterministicOpenKey,
                        operationGeneration: operationFence.generation, operationFence,
                    }, started);
                }
                return startedProviderEffect(Promise.resolve(started), () =>
                    started.cancel(new Error('Authoritative Docker-start transaction failed')));
            },
        );
        // Completion notifications are observed and rebuilt; they never create
        // an unhandled rejection or expose a subprocess exception to an adapter.
        void execution.completion.then(async () => {
            if (observerSubscribed) await request.outputObserver?.complete?.();
        }, async () => {
            if (observerSubscribed) await request.outputObserver?.error?.(
                new GoalSessionContractError('Supervised provider output failed safely', 'PROVIDER_OPERATION_FAILED'),
            );
        }).catch(() => undefined);
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
        return cleanTerminalGoalSession({
            baseDirectory: this.baseDirectory, retention: this.retention, layout, terminalAt, outcome, currentTime,
        });
    }
}
