import { PassThrough, type Readable } from 'node:stream';
import { executeDockerCommand, type DockerCommandOptions, type ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { ExecutionAbortedError } from '../../claude/docker/dockerExecutionOwnership.js';
import { renderDockerRunArgs } from './dockerRunArgs.js';
import type { AgentRunHandle, AgentRunInspection, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

export { renderDockerRunArgs } from './dockerRunArgs.js';

/** Launch options shared by every runtime: deadlines, stdin, streaming, callbacks, admission identity. */
export type AgentRunOptions = Omit<DockerCommandOptions, 'agentRun'>;

const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 15_000;
/** How long a run may take to exit after a successful `docker stop` before its launch is cancelled outright. */
const STOPPED_RUN_SETTLE_MS = 5_000;

export const DOCKER_RUNTIME_CAPABILITIES: AgentRuntimeCapabilities = Object.freeze({
    supportsBindMounts: true,
    supportsRestrictedNetwork: true,
    supportsMcpPrivateNetwork: true,
    // Runs use `--rm -i` with the worker holding stdin; a restarted worker cannot reattach.
    reattach: false,
});

type StreamName = 'stdout' | 'stderr';

/** Output streams that start forwarding when first read, so unread output is never buffered twice. */
class LazyOutputStreams {
    private readonly streams: Partial<Record<StreamName, PassThrough>> = {};
    private ended = false;

    get(name: StreamName): Readable {
        let stream = this.streams[name];
        if (!stream) {
            stream = new PassThrough();
            if (this.ended) stream.end();
            this.streams[name] = stream;
        }
        return stream;
    }

    write(name: StreamName, chunk: string): void {
        if (chunk) this.streams[name]?.write(chunk);
    }

    end(): void {
        this.ended = true;
        this.streams.stdout?.end();
        this.streams.stderr?.end();
    }
}

/** Why a run handle cancelled its launch: `wait()` rejects with it. */
export class AgentRunStoppedError extends ExecutionAbortedError {
    constructor(name: string) {
        super(`Agent run ${name} was stopped through its run handle`);
        this.name = 'AgentRunStoppedError';
    }
}

class DockerRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly result: Promise<ExecutionResult>;
    /** Reaches the executor's launch preparation (network, admission) and its final pre-spawn check. */
    private readonly cancellation = new AbortController();
    private spawned = false;
    private settled = false;

    constructor(readonly spec: AgentRunSpec, options: AgentRunOptions) {
        const args = renderDockerRunArgs(spec);
        const signal = options.signal ? AbortSignal.any([options.signal, this.cancellation.signal]) : this.cancellation.signal;
        this.result = executeDockerCommand('docker', args, {
            ...options,
            signal,
            agentRun: {
                spec,
                onOutput: (stream, chunk) => this.output.write(stream, chunk),
                onSpawn: () => { this.spawned = true; },
            },
        });
        // Callers that only stop or inspect still observe the settlement through wait().
        const settle = (): void => { this.settled = true; this.output.end(); };
        this.result.then(settle, settle);
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
                timeout: timeoutMs + INSPECT_TIMEOUT_MS,
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
            ], { timeout: INSPECT_TIMEOUT_MS });
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
