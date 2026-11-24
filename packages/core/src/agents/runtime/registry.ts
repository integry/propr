import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import type { AgentConfig } from '../types.js';
import { DockerRuntime, type AgentRunOptions } from './dockerRuntime.js';
import type { AgentRunSpec, AgentRuntime } from './types.js';

export const AGENT_RUNTIME_ENV = 'PROPR_AGENT_RUNTIME';
export const DEFAULT_AGENT_RUNTIME = 'docker';

/** Every runtime accepts the same launch options and settles with the executor result shape. */
export type ProviderAgentRuntime = AgentRuntime<AgentRunOptions, ExecutionResult>;
export type AgentRuntimeFactory = () => ProviderAgentRuntime;

const factories = new Map<string, AgentRuntimeFactory>([[DEFAULT_AGENT_RUNTIME, () => new DockerRuntime()]]);
const instances = new Map<string, ProviderAgentRuntime>();

const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Register (or replace) a runtime implementation under `kind`. */
export function registerAgentRuntime(kind: string, factory: AgentRuntimeFactory): void {
    if (!RUNTIME_NAME_PATTERN.test(kind)) throw new Error(`Invalid agent runtime name: ${kind}`);
    factories.set(kind, factory);
    instances.delete(kind);
}

export function registeredAgentRuntimes(): string[] {
    return [...factories.keys()];
}

/**
 * The runtime an agent runs on: its own `runtime` setting, else
 * `PROPR_AGENT_RUNTIME`, else Docker. Unknown names fail loudly rather than
 * silently falling back to a different isolation boundary.
 */
export function resolveAgentRuntimeKind(
    config?: Pick<AgentConfig, 'runtime'> | null,
    environment: NodeJS.ProcessEnv = process.env,
): string {
    const kind = (config?.runtime?.trim() || environment[AGENT_RUNTIME_ENV]?.trim() || DEFAULT_AGENT_RUNTIME).toLowerCase();
    if (!factories.has(kind)) {
        throw new Error(`Unknown agent runtime "${kind}" (set by ${config?.runtime?.trim() ? 'agent configuration' : AGENT_RUNTIME_ENV}); available: ${registeredAgentRuntimes().join(', ')}`);
    }
    return kind;
}

export function getAgentRuntime(
    config?: Pick<AgentConfig, 'runtime'> | null,
    environment: NodeJS.ProcessEnv = process.env,
): ProviderAgentRuntime {
    const kind = resolveAgentRuntimeKind(config, environment);
    let runtime = instances.get(kind);
    if (!runtime) {
        runtime = factories.get(kind)!();
        instances.set(kind, runtime);
    }
    return runtime;
}

/** Refuse a spec the runtime cannot honour instead of running it with weaker isolation. */
export function assertAgentRuntimeSupports(runtime: ProviderAgentRuntime, spec: AgentRunSpec): void {
    const { capabilities } = runtime;
    if (!capabilities.supportsBindMounts && spec.mounts.some(mount => mount.type === 'bind')) {
        throw new Error(`Agent runtime "${runtime.kind}" cannot bind-mount the workspace or credentials for ${spec.name}`);
    }
    if (!capabilities.supportsMcpPrivateNetwork && spec.mcpGrant?.network) {
        throw new Error(`Agent runtime "${runtime.kind}" cannot join MCP network "${spec.mcpGrant.network}" for ${spec.name}`);
    }
}

/** Start a provider run on the agent's runtime and wait for its outcome. */
export function runAgent(
    config: Pick<AgentConfig, 'runtime'> | null | undefined,
    spec: AgentRunSpec,
    options: AgentRunOptions,
): Promise<ExecutionResult> {
    const runtime = getAgentRuntime(config);
    assertAgentRuntimeSupports(runtime, spec);
    return runtime.start(spec, options).wait();
}
