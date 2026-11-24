import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { NetworkPolicyError, resolveAgentRunNetworkPolicy, sameNetworkPolicy } from '../../network/egressExecution.js';
import type { AgentConfig } from '../types.js';
import { DockerRuntime, type AgentRunOptions } from './dockerRuntime.js';
import type { AgentRunNetworkRestriction, AgentRunSpec, AgentRuntime } from './types.js';

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
    if (!capabilities.supportsRestrictedNetwork && spec.network.restriction) {
        throw new Error(`Agent runtime "${runtime.kind}" cannot enforce the restricted network policy (${spec.network.restriction.source}) for ${spec.name}`);
    }
}

/**
 * The spec with the effective network requirement attached: the run's
 * restricted policy, or the enforced instance policy outside any run. Resolved
 * before dispatch so every runtime sees it, not only the Docker executor.
 *
 * A restriction the spec already carries stays binding: it is kept as is when
 * no policy applies or the applying policy is the same, and a different
 * applying policy refuses the run rather than replacing either allowlist. As
 * at launch, an exemption reason does not lift a spec's own restriction, so
 * the comparison uses the policy that applies without it.
 */
export async function withAgentRunNetworkRequirement(spec: AgentRunSpec, options: Pick<AgentRunOptions, 'networkPolicyExempt'> = {}): Promise<AgentRunSpec> {
    const explicit = spec.network.restriction;
    if (explicit) {
        const applicable = await resolveAgentRunNetworkPolicy();
        if (applicable && !sameNetworkPolicy(applicable, explicit)) {
            throw new NetworkPolicyError(`Agent run ${spec.name} carries a restricted network policy (${explicit.source}) that differs from the policy applying at launch (${applicable.source})`);
        }
        return spec;
    }
    const policy = await resolveAgentRunNetworkPolicy(options.networkPolicyExempt);
    if (!policy) return spec;
    return { ...spec, network: { ...spec.network, restriction: policy as AgentRunNetworkRestriction } };
}

/** Start a provider run on the agent's runtime and wait for its outcome. */
export async function runAgent(
    config: Pick<AgentConfig, 'runtime'> | null | undefined,
    spec: AgentRunSpec,
    options: AgentRunOptions,
): Promise<ExecutionResult> {
    const runtime = getAgentRuntime(config);
    const resolved = await withAgentRunNetworkRequirement(spec, options);
    assertAgentRuntimeSupports(runtime, resolved);
    return runtime.start(resolved, options).wait();
}

/**
 * Native goal sessions keep stdin open for steering and still launch Docker
 * directly from rendered argv. Until runtimes offer an interactive handle,
 * resolve the selection before every launch (unknown names fail here too) and
 * refuse any runtime other than Docker rather than silently using Docker.
 */
export function assertNativeGoalRuntime(
    config?: Pick<AgentConfig, 'runtime'> | null,
    environment: NodeJS.ProcessEnv = process.env,
): void {
    const kind = resolveAgentRuntimeKind(config, environment);
    if (kind !== DEFAULT_AGENT_RUNTIME) {
        throw new Error(`Native goal sessions support only the "${DEFAULT_AGENT_RUNTIME}" agent runtime; "${kind}" is selected`);
    }
}
