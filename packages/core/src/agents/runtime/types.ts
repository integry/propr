import type { Readable } from 'node:stream';
import type { ResolvedNetworkPolicy } from '../../network/networkPolicy.js';
import type { AgentType } from '../types.js';

/**
 * Runtime-neutral description of one coding-agent run.
 *
 * Providers describe *what* to run (image, command, environment, mounts,
 * resources, network) and an {@link AgentRuntime} decides *how*: the Docker
 * runtime renders it to `docker run` argv, other runtimes (remote Docker,
 * Podman, Fly Machines, Sprites) map the same fields to their own APIs.
 *
 * `env`, `mounts` and `envFiles` carry a shared `order` so a runtime whose
 * flags are positional (Docker: later `-e` wins) reproduces the provider's
 * declaration order exactly. Runtimes without positional semantics can ignore it.
 */
export interface AgentRunSpec {
    profile: AgentRunProfile;
    /** Stable run name (Docker container name). */
    name: string;
    /** Command line after the image: the provider CLI and its switches. */
    args: string[];
    /** Overrides the image entrypoint. Usually set through {@link AgentRunSpec.repoSetup}. */
    entrypoint?: string;
    /** Keep stdin open: the prompt (or a stream-json control channel) arrives on it. */
    stdin: boolean;
    workdir: string;
    /** `uid:gid` the entry process starts as; the image user when omitted. */
    user?: string;
    workspace: AgentRunWorkspace;
    env: AgentRunEnvVar[];
    mounts: AgentRunMount[];
    /** Host env files whose variables the runtime loads into the run. */
    envFiles: AgentRunEnvFile[];
    resources?: AgentRunResources;
    network: AgentRunNetwork;
    security: AgentRunSecurity;
    /** MCP servers the run is granted (tokens travel through `env` by name only). */
    mcpGrant?: AgentRunMcpGrant;
    labels: Record<string, string>;
    /** Wraps the provider entrypoint with the repository setup hook / workflow wrapper. */
    repoSetup?: AgentRunRepoSetup;
}

export interface AgentRunProfile {
    agentType: AgentType;
    image: string;
    /** Agent alias the run is charged to, when it has one. */
    alias?: string;
}

export interface AgentRunWorkspace {
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
}

/** A variable without `value` is inherited from the launching process environment. */
export interface AgentRunEnvVar {
    name: string;
    value?: string;
    order: number;
}

export interface AgentRunEnvFile {
    path: string;
    order: number;
}

export type AgentRunMountPurpose =
    | 'workspace' | 'git' | 'credential' | 'logs' | 'prompt' | 'runtime-home' | 'data' | 'scratch';

export type AgentRunMount =
    | {
        type: 'bind';
        source: string;
        target: string;
        readOnly: boolean;
        purpose: AgentRunMountPurpose;
        order: number;
        /** Docker spelling: `-v src:dst:mode` (default) or `--mount type=bind,...`. */
        syntax?: 'volume' | 'mount';
    }
    | {
        type: 'tmpfs';
        target: string;
        options: string;
        purpose: AgentRunMountPurpose;
        order: number;
    };

export interface AgentRunResources {
    /** Run an init process as PID 1 that reaps zombies. */
    init: boolean;
    memory: string;
    memorySwap: string;
    cpus: string;
    pidsLimit: string;
}

export interface AgentRunNetwork {
    /** `bridge`: the runtime's default outbound network; `named`: a specific network (e.g. a Compose network for an MCP grant). */
    mode: 'bridge' | 'named';
    name: string;
    /**
     * Set at dispatch when the effective network policy (the run's, or the
     * enforced instance policy) restricts outbound traffic. A runtime given
     * this must confine the run to it; one that cannot is refused before launch.
     */
    restriction?: AgentRunNetworkRestriction;
}

export type AgentRunNetworkRestriction = ResolvedNetworkPolicy & { mode: 'restricted' };

export interface AgentRunSecurity {
    noNewPrivileges: boolean;
    /** Additional runtime security options in declaration order (e.g. `seccomp=unconfined`). */
    securityOpts: string[];
    capAdd: string[];
    capDrop: string[];
    readOnlyRootFilesystem: boolean;
}

export interface AgentRunMcpGrant {
    servers: string[];
    /** Network the run must join to reach the granted servers. */
    network?: string;
}

export interface AgentRunRepoSetup {
    agentType: AgentType;
    /** Shell the wrapper runs (`/bin/bash`). */
    shell: string;
    /** Wrapper script: the setup hook or the repository workflow wrapper. */
    script: string;
    /** Image entrypoint the wrapper `exec`s after setup. */
    providerEntrypoint: string;
    env: Array<Omit<AgentRunEnvVar, 'order'>>;
}

export interface AgentRuntimeCapabilities {
    /** Host paths can be bind-mounted (workspace, git metadata, credentials). */
    supportsBindMounts: boolean;
    /** Outbound traffic can be confined to the ProPR egress proxy. */
    supportsRestrictedNetwork: boolean;
    /** The run can join a private network that reaches ProPR MCP services. */
    supportsMcpPrivateNetwork: boolean;
    /** A worker can reattach to a run it did not start (after restart). */
    reattach: boolean;
}

export type AgentRunLiveness = 'running' | 'stopped' | 'not_found' | 'unavailable';

export interface AgentRunInspection {
    liveness: AgentRunLiveness;
    id?: string;
    name: string;
}

/** Outcome of a finished run. Mirrors the executor result so callers keep their parsing. */
export interface AgentRunResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    messageTimestamps: Map<string, string>;
    timedOut?: boolean;
    timeoutMs?: number;
    costCapExceeded?: boolean;
    watchdogTrip?: unknown;
}

export interface AgentRunHandle<Result extends AgentRunResult = AgentRunResult> {
    readonly spec: AgentRunSpec;
    /**
     * Live output from the moment the stream is first read. A runtime bounds
     * what it holds for a slow reader: output past its limit is dropped (with
     * a notice in the stream), never applied as backpressure on the agent.
     */
    readonly stdout: Readable;
    readonly stderr: Readable;
    /** Settles with the run's outcome; rejects like the executor (abort, ownership loss). */
    wait(): Promise<Result>;
    /** Asks the run to exit with `signal`, forcing it after `timeoutMs`. */
    stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<void>;
    inspect(): Promise<AgentRunInspection>;
    isAlive(): Promise<boolean>;
}

export interface AgentRuntime<Options = unknown, Result extends AgentRunResult = AgentRunResult> {
    readonly kind: string;
    readonly capabilities: AgentRuntimeCapabilities;
    start(spec: AgentRunSpec, options?: Options): AgentRunHandle<Result>;
}
