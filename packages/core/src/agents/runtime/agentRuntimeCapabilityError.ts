import type { AgentRunSpec, AgentRuntimeCapabilities } from './types.js';

/**
 * Capability refusals, shared by the registry's pre-launch check and by
 * runtimes that refuse a spec on their own `start()` (a caller may use a
 * runtime directly, without the registry). Kept apart from the registry so
 * runtimes can import it without an import cycle.
 */

export type AgentRuntimeCapability = 'extensions' | 'workflow_markers' | 'bind_mounts' | 'restricted_network' | 'mcp_private_network' | 'mcp_reachable_url';

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

export function extensionRuntimeRefusal(runtime: { kind: string; capabilities: Pick<AgentRuntimeCapabilities, 'supportsExtensions'> }): string | undefined {
    if (runtime.capabilities.supportsExtensions === false) return `Agent runtime "${runtime.kind}" does not support extensions. Choose a runtime that supports extensions (docker).`;
}

export function assertExtensionLaunchSupported(runtime: { kind: string; capabilities: AgentRuntimeCapabilities }, options: { extensionAgentLaunch?: boolean }): void {
    if (!options.extensionAgentLaunch) return;
    const refusal = extensionRuntimeRefusal(runtime);
    if (refusal) throw new AgentRuntimeCapabilityError(refusal, runtime.kind, 'extensions');
}

/** The refusal a restricted run gets on this runtime, or undefined when it can enforce restricted mode. */
export function restrictedNetworkRefusal(
    runtime: { kind: string; capabilities: Pick<AgentRuntimeCapabilities, 'supportsRestrictedNetwork'> },
    source?: string,
): string | undefined {
    if (runtime.capabilities.supportsRestrictedNetwork) return undefined;
    return `Agent runtime "${runtime.kind}" cannot enforce the restricted network policy${source ? ` (${source})` : ''}: it declares no way to confine outbound traffic to the allowlist, so restricted runs are refused instead of running with open networking. Use a runtime that supports restricted networking (docker), or set the network mode to open.`;
}

/** The restriction the spec itself carries: its network restriction, else a restricted neutral policy. */
export function specNetworkRestriction(spec: Pick<AgentRunSpec, 'network'>): { source?: string } | undefined {
    return spec.network.restriction ?? (spec.network.policy?.mode === 'restricted' ? spec.network.policy : undefined);
}
