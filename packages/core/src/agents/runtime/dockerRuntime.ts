import { PassThrough, type Readable } from 'node:stream';
import { executeDockerCommand, type DockerCommandOptions, type ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { renderDockerRunArgs } from './dockerRunArgs.js';
import type { AgentRunHandle, AgentRunInspection, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

export { renderDockerRunArgs } from './dockerRunArgs.js';

/** Launch options shared by every runtime: deadlines, stdin, streaming, callbacks, admission identity. */
export type AgentRunOptions = Omit<DockerCommandOptions, 'agentRun'>;

const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 15_000;

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

class DockerRunHandle implements AgentRunHandle<ExecutionResult> {
    private readonly output = new LazyOutputStreams();
    private readonly result: Promise<ExecutionResult>;

    constructor(readonly spec: AgentRunSpec, options: AgentRunOptions) {
        const args = renderDockerRunArgs(spec);
        this.result = executeDockerCommand('docker', args, {
            ...options,
            agentRun: { spec, onOutput: (stream, chunk) => this.output.write(stream, chunk) },
        });
        // Callers that only stop or inspect still observe the settlement through wait().
        this.result.then(() => this.output.end(), () => this.output.end());
    }

    get stdout(): Readable { return this.output.get('stdout'); }
    get stderr(): Readable { return this.output.get('stderr'); }

    wait(): Promise<ExecutionResult> {
        return this.result;
    }

    async stop(signal: NodeJS.Signals = 'SIGTERM', timeoutMs = DEFAULT_STOP_TIMEOUT_MS): Promise<void> {
        const seconds = String(Math.max(0, Math.ceil(timeoutMs / 1000)));
        const stopped = await executeDockerCommand('docker', ['stop', '--signal', signal, '--time', seconds, this.spec.name], {
            timeout: timeoutMs + INSPECT_TIMEOUT_MS,
        });
        if (stopped.exitCode !== 0 && !/No such container/i.test(stopped.stderr)) {
            throw new Error(`Failed to stop agent run ${this.spec.name}: ${stopped.stderr.trim() || `exit ${stopped.exitCode}`}`);
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
