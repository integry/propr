import { extensionLaunchForRun } from '../../extensions/extensionLaunchContext.js';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { createWorkspaceTransport, runWithWorkspaceTransport } from '../../git/workspaceTransport.js';
import { resolveWorkspaceTransportMode, runtimeWorkspaceTransports, WORKSPACE_TRANSPORT_ENV } from '../../git/workspaceTransportMode.js';
import { NetworkPolicyError, resolveAgentRunNetworkPolicy, sameNetworkPolicy } from '../../network/egressExecution.js';
import { stageAgentRunCredentials } from '../credentials/hostCredentialStaging.js';
import type { AgentConfig } from '../types.js';
import { agentRunNetworkPolicy, assertAgentRunNetworkRepresentationsAgree, isValidRestrictedAgentRunNetworkPolicy, sameAgentRunNetworkPolicy, withAgentRunNetworkPolicy } from './agentRunNetworkPolicy.js';
import { withComputeCost } from './computeUsage.js';
import { DOCKER_RUNTIME_CAPABILITIES, DockerRuntime, type AgentRunOptions } from './dockerRuntime.js';
import { FlyMachinesRuntime } from './flyMachinesRuntime.js';
import { SpritesRuntime } from './spritesRuntime.js';
import type { AgentRunConfigSelection, AgentRunNetworkRestriction, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

import { AGENT_RUNTIME_ENV, DEFAULT_AGENT_RUNTIME, FLY_MACHINES_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME, selectedAgentRuntimeName } from './runtimeSelection.js';
export { AGENT_RUNTIME_ENV, DEFAULT_AGENT_RUNTIME, FLY_MACHINES_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME };

/** Every runtime accepts the same launch options and settles with the executor result shape. */
export type ProviderAgentRuntime = AgentRuntime<AgentRunOptions, ExecutionResult>;
export type AgentRuntimeFactory = () => ProviderAgentRuntime;

type ExtensionRuntime = { kind: string; capabilities: Pick<AgentRuntimeCapabilities, 'supportsExtensions' | 'supportsRuntimePackages'> };
const registrations = new Map<string, { factory: AgentRuntimeFactory; capabilities?: ExtensionRuntime['capabilities'] }>([
    [DEFAULT_AGENT_RUNTIME, { factory: () => new DockerRuntime(), capabilities: DOCKER_RUNTIME_CAPABILITIES }],
    [FLY_MACHINES_AGENT_RUNTIME, { factory: () => new FlyMachinesRuntime(), capabilities: FlyMachinesRuntime.capabilities }],
    [SPRITES_AGENT_RUNTIME, { factory: () => new SpritesRuntime(), capabilities: SpritesRuntime.capabilities }],
]);
const instances = new Map<string, ProviderAgentRuntime>();

const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Register (or replace) a runtime implementation under `kind`. */
export function registerAgentRuntime(kind: string, factory: AgentRuntimeFactory): void {
    if (!RUNTIME_NAME_PATTERN.test(kind)) throw new Error(`Invalid agent runtime name: ${kind}`);
    registrations.set(kind, { factory });
    instances.delete(kind);
}

export async function closeAgentRuntimes(): Promise<void> {
    const runtimes = [...instances.values()];
    instances.clear();
    await Promise.all(runtimes.map(runtime => runtime.close?.()));
}

export function registeredAgentRuntimes(): string[] {
    return [...registrations.keys()];
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
    const kind = selectedAgentRuntimeName(config, environment);
    if (!registrations.has(kind)) {
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
        runtime = registrations.get(kind)!.factory();
        instances.set(kind, runtime);
    }
    return runtime;
}

export type AgentRuntimeCapability = 'extensions' | 'runtime_packages' | 'bind_mounts' | 'restricted_network' | 'mcp_private_network' | 'mcp_reachable_url' | 'mcp_reverse_forward' | 'agent_config';

/**
 * A run refused before launch because its runtime cannot provide what the
 * spec requires. Never retried onto weaker isolation: the operator chooses a
 * runtime that can, or changes the policy.
 */
export class AgentRuntimeCapabilityError extends Error {
    readonly code = 'AGENT_RUNTIME_CAPABILITY_UNSUPPORTED';
    constructor(message: string, readonly runtime: string, readonly capability: AgentRuntimeCapability) {
        super(message);
        this.name = 'AgentRuntimeCapabilityError';
    }
}

export function configuredExtensionRefusal(kind: string): string | undefined {
    // The API has no worker capability report. A worker-selected or custom runtime checks at launch.
    const capabilities = registrations.get(kind)?.capabilities;
    if (capabilities) return extensionRuntimeRefusal({ kind, capabilities });
}

export function extensionRuntimeRefusal(runtime: ExtensionRuntime): string | undefined {
    if (runtime.capabilities.supportsExtensions ?? (runtime.kind === DEFAULT_AGENT_RUNTIME)) return undefined;
    return `Agent runtime "${runtime.kind}" does not support extensions. Choose a runtime that supports extensions (docker).`;
}

/** Runtimes that install the configured runtime packages, for refusal messages. */
function runtimePackageRuntimes(): string[] {
    return [...registrations].filter(([kind, { capabilities }]) => capabilities?.supportsRuntimePackages ?? kind === DEFAULT_AGENT_RUNTIME).map(([kind]) => kind);
}

/**
 * The refusal a run gets when instance runtime packages are configured and its
 * runtime cannot install them, or undefined. Refused rather than started
 * without the packages, which would fail mid-task instead.
 */
export function runtimePackagesRefusal(runtime: ExtensionRuntime, packages: readonly string[]): string | undefined {
    if (packages.length === 0) return undefined;
    if (runtime.capabilities.supportsRuntimePackages ?? (runtime.kind === DEFAULT_AGENT_RUNTIME)) return undefined;
    const shown = packages.slice(0, 5).join(', ') + (packages.length > 5 ? `, and ${packages.length - 5} more` : '');
    return `Agent runtime "${runtime.kind}" cannot install the configured runtime packages (${shown}). Choose a runtime that applies runtime packages (${runtimePackageRuntimes().join(', ')}), remove the packages in Settings, or install them per repository in .propr/setup.sh.`;
}

/** Refuse a run whose runtime cannot install the configured runtime packages; reads them only for such runtimes. */
export async function assertRuntimePackagesSupported(
    runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>, spec: Pick<AgentRunSpec, 'name'>,
    loadPackages?: () => Promise<readonly string[]>,
): Promise<void> {
    if (runtime.capabilities.supportsRuntimePackages ?? (runtime.kind === DEFAULT_AGENT_RUNTIME)) return;
    const load = loadPackages ?? (await import('./agentRuntimePackageProfile.js')).loadConfiguredAgentRuntimePackages;
    const refusal = runtimePackagesRefusal(runtime, await load());
    if (refusal) throw new AgentRuntimeCapabilityError(`${refusal} (run ${spec.name})`, runtime.kind, 'runtime_packages');
}

/** Absent `supportsMcpReachableUrl` counts as supported. */
export function runtimeSupportsMcpReachableUrl(capabilities: AgentRuntimeCapabilities): boolean {
    return capabilities.supportsMcpReachableUrl !== false;
}

/** The refusal a restricted run gets on this runtime, or undefined when it can enforce restricted mode. */
export function restrictedNetworkRefusal(runtime: Pick<ProviderAgentRuntime, 'kind' | 'capabilities'>, source?: string): string | undefined {
    if (runtime.capabilities.supportsRestrictedNetwork) return undefined;
    return `Agent runtime "${runtime.kind}" cannot enforce the restricted network policy${source ? ` (${source})` : ''}: it declares no way to confine outbound traffic to the allowlist, so restricted runs are refused instead of running with open networking. Use a runtime that supports restricted networking (docker or sprites), or set the network mode to open.`;
}

/** A runtime without bind mounts must provide every bind another way (uploads, broker copies), or the run is refused. */
function assertMountsProvided(runtime: ProviderAgentRuntime, spec: AgentRunSpec): void {
    for (const mount of spec.mounts) {
        if (mount.type !== 'bind') continue;
        const reason = runtime.unsupportedMount ? runtime.unsupportedMount(mount) : 'cannot bind-mount the workspace or credentials';
        if (reason) throw new AgentRuntimeCapabilityError(`Agent runtime "${runtime.kind}" ${reason} for ${spec.name}`, runtime.kind, 'bind_mounts');
    }
}

/** Refuse a spec the runtime cannot honour instead of running it with weaker isolation. */
export function assertAgentRuntimeSupports(runtime: ProviderAgentRuntime, spec: AgentRunSpec): void {
    const { capabilities, kind } = runtime;
    if (!capabilities.supportsBindMounts) assertMountsProvided(runtime, spec);
    const transport = spec.workspace.mode;
    if (transport && !runtimeWorkspaceTransports(capabilities).includes(transport)) {
        throw new Error(`Agent runtime "${kind}" cannot run the "${transport}" workspace transport for ${spec.name}`);
    }
    const grant = spec.mcpGrant;
    if (grant && (grant.network || grant.transport === 'private-network') && !capabilities.supportsMcpPrivateNetwork) {
        throw new AgentRuntimeCapabilityError(`Agent runtime "${kind}" cannot join MCP network "${grant.network ?? 'unnamed'}" for ${spec.name}; set PROPR_AGENT_MCP_URL (without PROPR_AGENT_DOCKER_NETWORK) or API_PUBLIC_URL so the run reaches ProPR MCP at a reachable URL with its per-run token`, kind, 'mcp_private_network');
    }
    if (grant && grant.transport === 'reachable-url' && !runtimeSupportsMcpReachableUrl(capabilities)) {
        throw new AgentRuntimeCapabilityError(`Agent runtime "${kind}" cannot reach the ProPR MCP endpoint at a reachable URL for ${spec.name}`, kind, 'mcp_reachable_url');
    }
    if (grant && grant.transport === 'ssh-reverse-forward' && !capabilities.supportsMcpReverseForward) {
        throw new AgentRuntimeCapabilityError(`Agent runtime "${kind}" cannot carry ProPR MCP over an SSH reverse forward for ${spec.name}`, kind, 'mcp_reverse_forward');
    }
    const restricted = spec.network.restriction ?? (spec.network.policy?.mode === 'restricted' ? spec.network.policy : undefined);
    const refusal = restricted ? restrictedNetworkRefusal(runtime, restricted.source) : undefined;
    if (refusal) throw new AgentRuntimeCapabilityError(`${refusal} (run ${spec.name})`, kind, 'restricted_network');
}

/**
 * The spec with the effective network requirement attached: the run's
 * restricted policy, or the enforced instance policy outside any run, plus
 * the runtime-neutral `spec.network.policy` (mode and complete
 * host/port allowlist) derived from it. Resolved
 * before dispatch so every runtime sees it, not only the Docker executor.
 *
 * A restriction the spec already carries stays binding: a restricted
 * `network.policy` beside it must be the policy derived from it, or the run is
 * refused. The restriction is kept as is when
 * no policy applies or the applying policy is the same, and a different
 * applying policy refuses the run rather than replacing either allowlist. As
 * at launch, an exemption reason does not lift a spec's own restriction, so
 * the comparison uses the policy that applies without it.
 *
 * A spec carrying only a restricted `network.policy` (no restriction) is
 * binding the same way: it is validated and kept, never normalized to open.
 * When a policy applies at launch it must produce the same allowlist (the
 * restriction is then attached so Docker's proxy can enforce it); a
 * different one refuses the run.
 */
export async function withAgentRunNetworkRequirement(spec: AgentRunSpec, options: Pick<AgentRunOptions, 'networkPolicyExempt'> = {}): Promise<AgentRunSpec> {
    const explicit = spec.network.restriction;
    if (explicit) {
        assertAgentRunNetworkRepresentationsAgree(spec);
        const applicable = await resolveAgentRunNetworkPolicy();
        if (applicable && !sameNetworkPolicy(applicable, explicit)) {
            throw new NetworkPolicyError(`Agent run ${spec.name} carries a restricted network policy (${explicit.source}) that differs from the policy applying at launch (${applicable.source})`);
        }
        return withAgentRunNetworkPolicy(spec);
    }
    const supplied = spec.network.policy;
    if (supplied?.mode === 'restricted') {
        if (!isValidRestrictedAgentRunNetworkPolicy(supplied)) {
            throw new NetworkPolicyError(`Agent run ${spec.name} carries a malformed restricted network policy`);
        }
        const applicable = await resolveAgentRunNetworkPolicy();
        if (!applicable) return spec;
        if (!sameAgentRunNetworkPolicy(agentRunNetworkPolicy(spec.profile.agentType, applicable as AgentRunNetworkRestriction), supplied)) {
            throw new NetworkPolicyError(`Agent run ${spec.name} carries a restricted network policy${supplied.source ? ` (${supplied.source})` : ''} that differs from the policy applying at launch (${applicable.source})`);
        }
        return { ...spec, network: { ...spec.network, restriction: applicable as AgentRunNetworkRestriction } };
    }
    const policy = await resolveAgentRunNetworkPolicy(options.networkPolicyExempt);
    if (!policy) return withAgentRunNetworkPolicy(spec);
    return withAgentRunNetworkPolicy({ ...spec, network: { ...spec.network, restriction: policy as AgentRunNetworkRestriction } });
}

/**
 * Start a provider run on the agent's runtime and wait for its outcome. The
 * workspace reaches the run through its transport: bind-mounted (the
 * default where the runtime can), or cloned in the sandbox with the result
 * applied back to the worker worktree before this resolves.
 */
export async function runAgent(
    config: AgentRunConfigSelection | null | undefined,
    spec: AgentRunSpec,
    options: AgentRunOptions,
): Promise<ExecutionResult> {
    const runtime = getAgentRuntime(config);
    // e.g. a CLI version the runtime does not provide: refused, never run on another version.
    const configRefusal = runtime.unsupportedAgentConfig?.(config ?? null, spec);
    if (configRefusal) throw new AgentRuntimeCapabilityError(`Agent runtime "${runtime.kind}" cannot run ${spec.name}: ${configRefusal}`, runtime.kind, 'agent_config');
    const extensionRefusal = extensionRuntimeRefusal(runtime);
    if (extensionRefusal && extensionLaunchForRun(runtime.kind, [], { ...options, agentRun: { spec } })) {
        throw new AgentRuntimeCapabilityError(extensionRefusal, runtime.kind, 'extensions');
    }
    await assertRuntimePackagesSupported(runtime, spec);
    const resolved = await withAgentRunNetworkRequirement(spec, options);
    const mode = resolveWorkspaceTransportMode(resolved, runtime.capabilities);
    if (!runtimeWorkspaceTransports(runtime.capabilities).includes(mode)) {
        throw new Error(`Agent runtime "${runtime.kind}" cannot run the "${mode}" workspace transport for ${resolved.name}`);
    }
    // Workspace transport changes only the checkout and its git mounts. Runtimes
    // that can bind host credential paths still get per-run copies on the host.
    const staged = runtime.capabilities.supportsBindMounts
        ? stageAgentRunCredentials(resolved, { launchEnvironment: options.extraEnvVars })
        : undefined;
    try {
        const runSpec = staged?.spec ?? resolved;
        const runOptions = staged && Object.keys(staged.secretEnv).length > 0
            ? { ...options, extraEnvVars: { ...options.extraEnvVars, ...staged.secretEnv } }
            : options;
        const startedAt = Date.now();
        if (mode === 'bind') {
            assertAgentRuntimeSupports(runtime, runSpec);
            return finalizeRunResult(runtime.kind, startedAt, await runtime.start(runSpec, runOptions).wait());
        }
        return finalizeRunResult(runtime.kind, startedAt, await runWithWorkspaceTransport(runtime, runSpec, runOptions, {
            transport: await createWorkspaceTransport(mode),
            assertSupported: prepared => assertAgentRuntimeSupports(runtime, prepared),
        }));
    } finally {
        await staged?.complete();
    }
}

/**
 * The result with its compute usage priced: the runtime's own report, or for a
 * runtime that reports none, the wall time the dispatcher observed. The cost is
 * the runtime's, else the `PROPR_COMPUTE_RATES` rate for its kind, else unknown.
 */
function finalizeRunResult(kind: string, startedAt: number, result: ExecutionResult): ExecutionResult {
    if (result.outputIncomplete) throw new Error(result.outputIncomplete);
    const usage = result.computeUsage ?? {
        runtime: kind, wallTimeMs: Date.now() - startedAt,
        cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null, costUsd: null, costSource: null,
    };
    return { ...result, computeUsage: withComputeCost({ ...usage, runtime: usage.runtime || kind }) };
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
    // They bind-mount the worktree directly; refuse rather than silently ignore a clone transport.
    if (environment[WORKSPACE_TRANSPORT_ENV]?.trim() && environment[WORKSPACE_TRANSPORT_ENV]!.trim().toLowerCase() !== 'bind') {
        throw new Error(`Native goal sessions support only the "bind" workspace transport; ${WORKSPACE_TRANSPORT_ENV}=${environment[WORKSPACE_TRANSPORT_ENV]} is set`);
    }
}
