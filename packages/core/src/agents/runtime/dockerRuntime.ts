import type { Readable } from 'node:stream';
import { executeDockerCommand, type DockerCommandOptions, type ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { DOCKER_RESTRICTED_NETWORK_ENFORCEMENT, executeDockerRunWithSpecNetwork } from './dockerNetwork.js';
import { renderDockerRunArgs } from './dockerRunArgs.js';
import { readDockerContainerFile } from './dockerContainerFiles.js';
import { DockerComputeUsageSampler } from './dockerComputeUsage.js';
import type { AgentRunHandle, AgentRunInspection, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

import { AgentRunStoppedError, LazyOutputStreams } from './agentRunOutput.js';

export { renderDockerRunArgs } from './dockerRunArgs.js';
export { AGENT_RUN_OUTPUT_BUFFER_LIMIT_BYTES, AgentRunStoppedError, agentRunOutputDroppedNotice } from './agentRunOutput.js';

/** Launch options shared by every runtime: deadlines, stdin, streaming, callbacks, admission identity. */
export type AgentRunOptions = Omit<DockerCommandOptions, 'agentRun'>;

const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 15_000;
/** How long a run may take to exit after a successful `docker stop` before its launch is cancelled outright. */
const STOPPED_RUN_SETTLE_MS = 5_000;
/** A kept clone-mode container nobody released or retained is removed after this long. */
export const UNRELEASED_RUN_REMOVAL_MS = 10 * 60_000;
const REMOVE_TIMEOUT_MS = 30_000;

export const DOCKER_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = Object.freeze({
    supportsBindMounts: true,
    supportsRestrictedNetwork: true,
    restrictedNetworkEnforcement: DOCKER_RESTRICTED_NETWORK_ENFORCEMENT,
    supportsMcpPrivateNetwork: true,
    supportsMcpReachableUrl: true,
    // Runs use `--rm -i` with the worker holding stdin; a restarted worker cannot reattach.
    reattach: false,
    // Clone mode suits a Docker host that cannot see the worker's paths (remote DOCKER_HOST).
    workspaceTransports: Object.freeze(['bind', 'clone'] as const),
});

class DockerRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly result: Promise<ExecutionResult>;
    /** Reaches the executor's launch preparation (network, admission) and its final pre-spawn check. */
    private readonly cancellation = new AbortController();
    /**
     * The handle's own snapshot of the caller's `extraEnvVars`, taken once at
     * `start()`: the Docker client environment beyond `process.env` (both the
     * direct spawn and admission's client merge it over `process.env`). The
     * launch and every `stop`/`inspect` are given copies of this one snapshot,
     * never the caller's object, so all of them address the same daemon
     * (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, ...) even if the caller
     * reuses that object while the launch is still being prepared.
     */
    private readonly dockerEnvironment: Readonly<Record<string, string>> | undefined;
    private spawned = false;
    private settled = false;
    /** Clone-mode runs are not `--rm`: the container stays until {@link release} so result files can be read. */
    private readonly kept: boolean;
    private released?: Promise<void>;
    private releaseTimer?: NodeJS.Timeout;
    /** Set by {@link retain}: the container stays until an explicit {@link release}. */
    private retained = false;
    /** Samples the container's cgroup from spawn until the run settles. */
    private usageSampler?: DockerComputeUsageSampler;

    constructor(readonly spec: AgentRunSpec, options: AgentRunOptions) {
        this.dockerEnvironment = options.extraEnvVars && Object.keys(options.extraEnvVars).length > 0
            ? Object.freeze({ ...options.extraEnvVars })
            : undefined;
        const args = renderDockerRunArgs(spec);
        const signal = options.signal ? AbortSignal.any([options.signal, this.cancellation.signal]) : this.cancellation.signal;
        const { restriction } = spec.network;
        // The spec's restriction is installed as the launch's policy scope, so the executor's
        // network boundary confines the container whatever policy (if any) is ambient. A spec that
        // demands confinement is not exempted from it by a caller's exemption reason.
        const launchOptions: AgentRunOptions = { ...options, ...(restriction && { networkPolicyExempt: undefined }) };
        // The launch's Docker client gets the handle's snapshot, as stop/inspect do, not the caller's object.
        delete launchOptions.extraEnvVars;
        this.result = executeDockerRunWithSpecNetwork(spec, () => executeDockerCommand('docker', args, {
            ...launchOptions,
            ...this.dockerClientOptions(),
            signal,
            agentRun: {
                spec,
                onOutput: (stream, chunk) => this.output.write(stream, chunk),
                onSpawn: () => {
                    this.spawned = true;
                    this.usageSampler ??= new DockerComputeUsageSampler(spec.name, { dockerEnvironment: this.dockerEnvironment });
                },
            },
        })).then(result => this.withComputeUsage(result), error => {
            this.usageSampler?.finish();
            throw error;
        });
        // Callers that only stop or inspect still observe the settlement through wait().
        this.kept = spec.workspace.mode === 'clone';
        const settle = (): void => {
            this.settled = true;
            this.output.end();
            if (this.kept && !this.released && !this.retained) {
                this.releaseTimer = setTimeout(() => { void this.release().catch(() => undefined); }, UNRELEASED_RUN_REMOVAL_MS);
                this.releaseTimer.unref();
            }
        };
        this.result.then(settle, settle);
    }

    /** The run's compute usage (cost is priced later by the dispatcher); a run that never spawned has none. */
    private withComputeUsage(result: ExecutionResult): ExecutionResult {
        const usage = this.usageSampler?.finish();
        return usage ? { ...result, computeUsage: usage } : result;
    }

    get stdout(): Readable { return this.output.get('stdout'); }
    get stderr(): Readable { return this.output.get('stderr'); }

    wait(): Promise<ExecutionResult> {
        return this.result;
    }

    /**
     * A started run gets `docker stop` with `signal`. A launch still preparing
     * (network policy, admission, container create) is cancelled instead, and
     * so is a run whose container Docker does not know yet or that has not
     * exited shortly after a successful stop (an admitted container can still
     * be in `created` while `docker start` is on its way): absence or a no-op
     * stop proves nothing while the launch can still start it. `stop()`
     * resolves only once the launch has settled, so no agent starts after it.
     */
    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
        if (this.settled) return;
        if (this.spawned) {
            const seconds = String(Math.max(0, Math.ceil(timeoutMs / 1000)));
            const stopped = await executeDockerCommand('docker', ['stop', '--signal', signal, '--time', seconds, this.spec.name], {
                timeout: timeoutMs + INSPECT_TIMEOUT_MS, ...this.dockerClientOptions(),
            });
            if (stopped.exitCode !== 0 && !/No such container/i.test(stopped.stderr)) {
                throw new Error(`Failed to stop agent run ${this.spec.name}: ${stopped.stderr.trim() || `exit ${stopped.exitCode}`}`);
            }
            if (stopped.exitCode === 0 && await this.settlesWithin(STOPPED_RUN_SETTLE_MS)) return;
        }
        if (!this.cancellation.signal.aborted) this.cancellation.abort(new AgentRunStoppedError(this.spec.name));
        if (!await this.settlesWithin(timeoutMs + INSPECT_TIMEOUT_MS)) {
            throw new Error(`Agent run ${this.spec.name} did not settle after it was stopped`);
        }
    }

    /**
     * Options addressing a Docker command (the launch, `stop`, `inspect`) to the
     * run's own daemon: a fresh copy of the start-time snapshot for each command.
     */
    private dockerClientOptions(): Pick<DockerCommandOptions, 'extraEnvVars'> {
        return this.dockerEnvironment ? { extraEnvVars: { ...this.dockerEnvironment } } : {};
    }

    private async settlesWithin(ms: number): Promise<boolean> {
        if (this.settled) return true;
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); });
        try {
            return await Promise.race([this.result.then(() => true, () => true), expired]);
        } finally {
            clearTimeout(timer);
        }
    }

    async inspect(): Promise<AgentRunInspection> {
        const name = this.spec.name;
        let inspected: ExecutionResult;
        try {
            inspected = await executeDockerCommand('docker', [
                'inspect', '--type', 'container', '--format', '{{.Id}} {{.State.Status}}', name,
            ], { timeout: INSPECT_TIMEOUT_MS, ...this.dockerClientOptions() });
        } catch {
            return { liveness: 'unavailable', name };
        }
        if (inspected.exitCode !== 0) {
            return { liveness: /No such (?:container|object)/i.test(inspected.stderr) ? 'not_found' : 'unavailable', name };
        }
        const [id, status] = inspected.stdout.trim().split(/\s+/);
        return { liveness: status === 'running' ? 'running' : 'stopped', ...(id ? { id } : {}), name };
    }

    async isAlive(): Promise<boolean> {
        return (await this.inspect()).liveness === 'running';
    }

    /** `docker cp` out of the finished container: only a kept (clone-mode) run still has one. */
    async readFile(filePath: string): Promise<Buffer | null> {
        if (!this.kept || !this.settled || this.released) return null;
        return readDockerContainerFile(this.spec.name, filePath, this.dockerEnvironment);
    }

    /** Cancels the automatic removal of the kept container (installed when the run settles). */
    retain(): void {
        if (!this.kept) return;
        this.retained = true;
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.releaseTimer = undefined;
    }

    release(): Promise<void> {
        if (!this.kept) return Promise.resolve();
        if (this.releaseTimer) clearTimeout(this.releaseTimer);
        this.released ??= (async () => {
            if (!this.settled) await this.stop();
            const removed = await executeDockerCommand('docker', ['rm', '-f', this.spec.name], {
                timeout: REMOVE_TIMEOUT_MS, ...this.dockerClientOptions(),
            });
            if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) {
                throw new Error(`Failed to remove agent run ${this.spec.name}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`);
            }
        })();
        return this.released;
    }
}

/**
 * The default runtime: renders the spec to the `docker run` argv ProPR has
 * always used and launches it through the Docker executor, which keeps
 * admission, the spend cap, network policy, logs and ownership teardown.
 */
export class DockerRuntime implements AgentRuntime<AgentRunOptions, ExecutionResult> {
    readonly kind = 'docker';
    readonly capabilities = DOCKER_RUNTIME_CAPABILITIES;

    start(spec: AgentRunSpec, options: AgentRunOptions = {}): AgentRunHandle<ExecutionResult> {
        return new DockerRunHandle(spec, options);
    }
}
