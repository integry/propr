import { extensionLaunchForRun } from '../../extensions/extensionLaunchContext.js';
import type { ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import { createWorkspaceTransport, runWithWorkspaceTransport } from '../../git/workspaceTransport.js';
import { resolveWorkspaceTransportMode, runtimeWorkspaceTransports, WORKSPACE_TRANSPORT_ENV } from '../../git/workspaceTransportMode.js';
import { NetworkPolicyError, resolveAgentRunNetworkPolicy, sameNetworkPolicy } from '../../network/egressExecution.js';
import { stageAgentRunCredentials } from '../credentials/hostCredentialStaging.js';
import type { AgentConfig } from '../types.js';
import { agentRunNetworkPolicy, assertAgentRunNetworkRepresentationsAgree, isValidRestrictedAgentRunNetworkPolicy, sameAgentRunNetworkPolicy, withAgentRunNetworkPolicy } from './agentRunNetworkPolicy.js';
import { collectingHandle, uploadAgentRunFiles, type UploadedAgentRunFiles } from './agentRunFileUpload.js';
import { AgentRuntimeCapabilityError, assertExtensionLaunchSupported, restrictedNetworkRefusal, specNetworkRestriction } from './agentRuntimeCapabilityError.js';
import { withComputeCost } from './computeUsage.js';
import { DOCKER_RUNTIME_CAPABILITIES, DockerRuntime, type AgentRunOptions } from './dockerRuntime.js';
import { FLY_MACHINES_RUNTIME_KIND, flyMachinesCapabilities, FlyMachinesRuntime } from './flyMachinesRuntime.js';
import { AGENT_RUNTIME_ENV, DEFAULT_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME, selectedAgentRuntimeName } from './runtimeSelection.js';
import { SpritesRuntime } from './spritesRuntime.js';
import type { AgentRunConfigSelection, AgentRunNetworkRestriction, AgentRunSpec, AgentRuntime, AgentRuntimeCapabilities } from './types.js';

export { AgentRuntimeCapabilityError, restrictedNetworkRefusal, type AgentRuntimeCapability } from './agentRuntimeCapabilityError.js';
export { AGENT_RUNTIME_ENV, DEFAULT_AGENT_RUNTIME, SPRITES_AGENT_RUNTIME };

/** Every runtime accepts the same launch options and settles with the executor result shape. */
export type ProviderAgentRuntime = AgentRuntime<AgentRunOptions, ExecutionResult>;
export type AgentRuntimeFactory = () => ProviderAgentRuntime;

type ExtensionRuntime = { kind: string; capabilities: Pick<AgentRuntimeCapabilities, 'supportsExtensions'> };
const registrations = new Map<string, { factory: AgentRuntimeFactory; capabilities?: ExtensionRuntime['capabilities'] }>([
    [DEFAULT_AGENT_RUNTIME, { factory: () => new DockerRuntime(), capabilities: DOCKER_RUNTIME_CAPABILITIES }],
    [FLY_MACHINES_RUNTIME_KIND, { factory: () => new FlyMachinesRuntime(), capabilities: flyMachinesCapabilities() }],
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

export function configuredExtensionRefusal(kind: string): string | undefined {
    // The API has no worker capability report. A worker-selected or custom runtime checks at launch.
    const capabilities = registrations.get(kind)?.capabilities;
    if (capabilities) return extensionRuntimeRefusal({ kind, capabilities });
}

export function extensionRuntimeRefusal(runtime: ExtensionRuntime): string | undefined {
    if (runtime.capabilities.supportsExtensions ?? (runtime.kind === DEFAULT_AGENT_RUNTIME)) return undefined;
    return `Agent runtime "${runtime.kind}" does not support extensions. Choose a runtime that supports extensions (docker).`;
}

function assertRunLaunchSupported(
    runtime: ProviderAgentRuntime,
    config: AgentRunConfigSelection | null | undefined,
    spec: AgentRunSpec,
    options: AgentRunOptions,
): void {
    // e.g. a CLI version the runtime does not provide: refused, never run on another version.
    const configRefusal = runtime.unsupportedAgentConfig?.(config ?? null, spec);
    if (configRefusal) throw new Error(`Agent runtime "${runtime.kind}" cannot run ${spec.name}: ${configRefusal}`);
    if (runtime.kind === FLY_MACHINES_RUNTIME_KIND) assertExtensionLaunchSupported(runtime, options);
    const extensionRefusal = extensionRuntimeRefusal(runtime);
    if (extensionRefusal && extensionLaunchForRun(runtime.kind, [], { ...options, agentRun: { spec } })) {
        throw new AgentRuntimeCapabilityError(extensionRefusal, runtime.kind, 'extensions');
    }
}

/** Absent `supportsMcpReachableUrl` counts as supported. */
export function runtimeSupportsMcpReachableUrl(capabilities: AgentRuntimeCapabilities): boolean {
    return capabilities.supportsMcpReachableUrl !== false;
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
    const restricted = specNetworkRestriction(spec);
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
    assertRunLaunchSupported(runtime, config, spec, options);
    const resolved = await withAgentRunNetworkRequirement(spec, options);
    const mode = resolveWorkspaceTransportMode(resolved, runtime.capabilities);
    if (!runtimeWorkspaceTransports(runtime.capabilities).includes(mode)) {
        throw new Error(`Agent runtime "${runtime.kind}" cannot run the "${mode}" workspace transport for ${resolved.name}`);
    }
    // Workspace transport changes only the checkout and its git mounts. Runtimes
    // that can bind host credential paths still get per-run copies on the host;
    // runtimes that cannot receive them (and other bind sources) as uploaded files.
    const staged = runtime.capabilities.supportsBindMounts
        ? stageAgentRunCredentials(resolved, { launchEnvironment: options.extraEnvVars })
        : undefined;
    const uploaded: UploadedAgentRunFiles | undefined = !runtime.capabilities.supportsBindMounts && runtime.capabilities.supportsFileUpload
        ? uploadAgentRunFiles(resolved, { launchEnvironment: options.extraEnvVars })
        : undefined;
    try {
        const runSpec = staged?.spec ?? uploaded?.spec ?? resolved;
        const secretEnv = staged?.secretEnv ?? uploaded?.secretEnv ?? {};
        const runOptions = Object.keys(secretEnv).length > 0
            ? { ...options, extraEnvVars: { ...options.extraEnvVars, ...secretEnv } }
            : options;
        // Refreshed credentials are read back from the run before anything releases it.
        const runRuntime = uploaded ? withCredentialCollection(runtime, uploaded) : runtime;
        const startedAt = Date.now();
        if (mode === 'bind') {
            assertAgentRuntimeSupports(runtime, runSpec);
            const result = await runRuntime.start(runSpec, runOptions).wait();
            return finalizeRunResult(runtime.kind, startedAt, result);
        }
        const result = await runWithWorkspaceTransport(runRuntime, runSpec, runOptions, {
            transport: await createWorkspaceTransport(mode),
            assertSupported: prepared => assertAgentRuntimeSupports(runtime, prepared),
        });
        return finalizeRunResult(runtime.kind, startedAt, result);
    } finally {
        await staged?.complete();
    }
}

function withCredentialCollection(runtime: ProviderAgentRuntime, uploaded: UploadedAgentRunFiles): ProviderAgentRuntime {
    return {
        kind: runtime.kind,
        capabilities: runtime.capabilities,
        start: (spec, options) => collectingHandle(runtime.start(spec, options), handle => uploaded.collect(handle)),
    };
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
