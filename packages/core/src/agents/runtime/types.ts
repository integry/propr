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
    /**
     * The runtime-neutral network policy, attached at dispatch: `open`, or
     * `restricted` with the complete host/port allowlist (the agent's base
     * list plus instance and repository additions). Runtimes other than
     * Docker enforce this; Docker derives the same allowlist from
     * {@link AgentRunNetwork.restriction} inside its egress proxy.
     */
    policy?: AgentRunNetworkPolicy;
}

export type AgentRunNetworkRestriction = ResolvedNetworkPolicy & { mode: 'restricted' };

export type AgentRunNetworkMode = 'open' | 'restricted';

/** One allowed destination: an exact host, a `*.` wildcard zone or an IP literal, and the ports it may use. */
export interface AgentRunEgressRule {
    host: string;
    /** `*.example.com`: subdomains of `host`, never `host` itself. */
    wildcard: boolean;
    ports: number[];
}

export interface AgentRunNetworkPolicy {
    mode: AgentRunNetworkMode;
    /** Every destination a `restricted` run may reach; empty for `open`. */
    allow: AgentRunEgressRule[];
    /**
     * IP literals that may be private, loopback or link-local addresses
     * (only the instance's own entries); every other rule reaches public
     * addresses only.
     */
    privateAddressAllow: AgentRunEgressRule[];
    /** Where a restricted policy came from. */
    source?: ResolvedNetworkPolicy['source'];
}

export interface AgentRunSecurity {
    noNewPrivileges: boolean;
    /** Additional runtime security options in declaration order (e.g. `seccomp=unconfined`). */
    securityOpts: string[];
    capAdd: string[];
    capDrop: string[];
    readOnlyRootFilesystem: boolean;
}

/**
 * How a run reaches its granted ProPR MCP servers:
 * - `private-network`: it joins a private network (the API-only Compose
 *   network) where the MCP URL resolves;
 * - `reachable-url`: the URL is reachable from the runtime's default network
 *   (a public or explicitly configured endpoint) and the run authenticates
 *   with its per-run grant token only.
 */
export type AgentRunMcpTransport = 'private-network' | 'reachable-url';

export interface AgentRunMcpGrant {
    servers: string[];
    /** Network the run must join to reach the granted servers. */
    network?: string;
    transport: AgentRunMcpTransport;
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

/** How a runtime confines a restricted run's outbound traffic to its allowlist. */
export interface AgentRuntimeRestrictedNetworkEnforcement {
    /** Stable identifier, e.g. `egress-proxy-socket` for Docker. */
    method: string;
    /** One sentence for operators: what the run gets and what it cannot reach. */
    description: string;
}

export interface AgentRuntimeCapabilities {
    /** Host paths can be bind-mounted (workspace, git metadata, credentials). */
    supportsBindMounts: boolean;
    /**
     * Outbound traffic can be confined to {@link AgentRunNetwork.policy}. A
     * runtime without it is refused every restricted run before launch.
     */
    supportsRestrictedNetwork: boolean;
    /** How restricted runs are confined; set whenever `supportsRestrictedNetwork` is. */
    restrictedNetworkEnforcement?: AgentRuntimeRestrictedNetworkEnforcement;
    /** The run can join a private network that reaches ProPR MCP services. */
    supportsMcpPrivateNetwork: boolean;
    /**
     * The run can reach an MCP endpoint at a reachable URL with its per-run
     * grant token: the fallback when private networking is unavailable.
     * Absent counts as supported (any runtime with outbound HTTP has it).
     */
    supportsMcpReachableUrl?: boolean;
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
