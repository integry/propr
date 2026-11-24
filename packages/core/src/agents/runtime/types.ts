import type { Readable } from 'node:stream';
import type { ResolvedNetworkPolicy } from '../../network/networkPolicy.js';
import type { AgentType } from '../types.js';
import type { AgentRunComputeUsage } from './computeUsage.js';

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
    /**
     * Files and directories written into the run before it starts, on
     * runtimes without bind mounts: set at dispatch from the bind sources
     * the runtime cannot mount (see `agentRunFileUpload.ts`).
     */
    files?: AgentRunFile[];
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

/**
 * How the task workspace reaches the run:
 * - `bind`: the worker's worktree is bind-mounted at `containerPath` (identical paths on both sides);
 * - `clone`: the run clones the repository at the task base commit with a short-lived,
 *   repository-scoped token and returns its result through a temporary ref (or a bundle
 *   read back through the runtime file API). The worker applies it to its own worktree.
 */
export type WorkspaceTransportMode = 'bind' | 'clone';

export interface AgentRunWorkspace {
    /** Worker worktree. Bind-mounted in `bind` mode; the result lands here in `clone` mode. */
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
    /** Resolved at dispatch when omitted: `PROPR_WORKSPACE_TRANSPORT`, else `bind` on runtimes that bind-mount. */
    mode?: WorkspaceTransportMode;
    /** Set by the clone transport: what the run clones and where it returns the result. */
    clone?: AgentRunWorkspaceClone;
}

export interface AgentRunWorkspaceClone {
    /** Credential-free fetch URL of the repository. */
    remote: string;
    /** Ref the worker published the base commit to; the run fetches it. */
    baseRef: string;
    baseCommit: string;
    /** Branch name checked out in the sandbox (the worker's task branch). */
    branch: string;
    /** Ref the run pushes its result snapshot to; absent for read-only workspaces. */
    resultRef?: string;
    /** Sandbox directory holding the result status and the bundle fallback (runtime file API). */
    resultDir: string;
    /**
     * Bootstrap/finalize script run as the outermost wrapper: clones, runs the
     * repository setup wrapper and provider entrypoint, then returns the result.
     */
    script: string;
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

/** A file (or an empty directory) a runtime without bind mounts writes into the run before it starts. */
export interface AgentRunFile {
    type: 'file' | 'directory';
    /** Absolute path inside the run. */
    path: string;
    /** File content; absent for directories. */
    content?: Buffer;
    mode: number;
    purpose: AgentRunMountPurpose;
}

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
        /** Set when the source is a provider's canonical credential store (see the credential broker). */
        credentialStore?: AgentRunCredentialStore;
    }
    | {
        type: 'tmpfs';
        target: string;
        options: string;
        purpose: AgentRunMountPurpose;
        order: number;
    };

/**
 * Marks a bind of a provider's host credential store. With per-run
 * credentials enabled, the runtime layer replaces the source with a per-run
 * copy holding only the provider manifest's files and writes refreshed tokens
 * back afterwards; the legacy mode binds the canonical store directly.
 */
export interface AgentRunCredentialStore {
    provider: AgentType;
    store: 'config' | 'data';
    /**
     * `false` for runs that rely on provider state persisting in the store
     * between launches (goal sessions resumed by id): they keep the direct mount.
     */
    perRun: boolean;
}

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
    /**
     * Bind sources can be delivered as files written into the run before it
     * starts (credential stores, read-only seeds), and files the run leaves
     * can be read back through {@link AgentRunHandle.readFile} once it
     * finished. Lets a runtime without bind mounts use the credential broker.
     */
    supportsFileUpload?: boolean;
    /** A worker can reattach to a run it did not start (after restart). */
    reattach: boolean;
    /** Workspace transports the runtime can run; `['bind']` when bind mounts are supported and this is omitted. */
    workspaceTransports?: readonly WorkspaceTransportMode[];
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
    /** What the sandbox consumed: wall time, CPU, memory and (once priced) cost. */
    computeUsage?: AgentRunComputeUsage;
}

/** A file read back from a run, with its modification time there (milliseconds since the epoch). */
export interface AgentRunFileRead {
    content: Buffer;
    mtimeMs: number;
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
    /**
     * Runtime file API: a file from the run's filesystem after it finished, or
     * null when it does not exist. Offered by runtimes that keep a finished
     * clone-mode run until {@link AgentRunHandle.release}.
     */
    readFile?(path: string): Promise<Buffer | null>;
    /**
     * Like {@link AgentRunHandle.readFile}, with the file's modification time in
     * the run's filesystem. A file larger than `maxBytes` is refused as
     * `'oversized'` before any of its content is transferred.
     */
    readFileWithStat?(path: string, options: { maxBytes: number }): Promise<AgentRunFileRead | 'oversized' | null>;
    /** Discards what the runtime kept of a finished run (e.g. the stopped container). Idempotent. */
    release?(): Promise<void>;
    /**
     * Keeps what the runtime kept of the run until {@link AgentRunHandle.release} is
     * called explicitly, cancelling any automatic removal of an unreleased run. A
     * runtime that removes unreleased runs on its own must offer this, so a caller
     * holding the only copy of a result there can keep it. Idempotent.
     */
    retain?(): void;
}

export interface AgentRuntime<Options = unknown, Result extends AgentRunResult = AgentRunResult> {
    readonly kind: string;
    readonly capabilities: AgentRuntimeCapabilities;
    start(spec: AgentRunSpec, options?: Options): AgentRunHandle<Result>;
}
