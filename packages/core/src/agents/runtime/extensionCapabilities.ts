import type { AgentRuntimeCapabilities, AgentRuntimeExtensionCapabilities } from './types.js';
import { DEFAULT_AGENT_RUNTIME } from './runtimeSelection.js';

export type AgentRuntimeExtensionClass = keyof AgentRuntimeExtensionCapabilities;

export type AgentRuntimeCapability = 'skills' | 'remote_mcp' | 'package_mcp' | 'catalog_mcp' | 'bind_mounts' | 'restricted_network' | 'mcp_private_network' | 'mcp_reachable_url' | 'mcp_reverse_forward' | 'agent_config';

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

export const EXTENSION_CLASSES: readonly AgentRuntimeExtensionClass[] = ['skills', 'remoteMcp', 'packageMcp', 'catalogMcp'];

/** The refusal capability and the operator-facing name of each extension class. */
export const EXTENSION_CLASS_INFO: Record<AgentRuntimeExtensionClass, { capability: AgentRuntimeCapability; label: string }> = {
    skills: { capability: 'skills', label: 'library skill bundles' },
    remoteMcp: { capability: 'remote_mcp', label: 'URL MCP servers' },
    packageMcp: { capability: 'package_mcp', label: 'package (stdio) MCP servers' },
    catalogMcp: { capability: 'catalog_mcp', label: 'operator catalog stdio MCP servers' },
};

export type ResolvedExtensionCapabilities = Required<AgentRuntimeExtensionCapabilities>;
const ALL: ResolvedExtensionCapabilities = Object.freeze({ skills: true, remoteMcp: true, packageMcp: true, catalogMcp: true });
const NONE: ResolvedExtensionCapabilities = Object.freeze({ skills: false, remoteMcp: false, packageMcp: false, catalogMcp: false });

export type ExtensionRuntime = { kind: string; capabilities: Pick<AgentRuntimeCapabilities, 'extensions'> };

/** What the runtime applies: its declared classes, else everything on Docker and nothing elsewhere. */
export function runtimeExtensionCapabilities(runtime: ExtensionRuntime): ResolvedExtensionCapabilities {
    const declared = runtime.capabilities.extensions;
    if (!declared) return runtime.kind === DEFAULT_AGENT_RUNTIME ? ALL : NONE;
    return { ...declared, catalogMcp: declared.catalogMcp ?? declared.packageMcp };
}

/** Runtimes that apply every class, for refusal messages. */
const SUGGESTION = 'docker';

/** The refusal of one class on this runtime, or undefined when the runtime applies it. */
export function extensionClassRefusal(runtime: ExtensionRuntime, extensionClass: AgentRuntimeExtensionClass, names: readonly string[] = []): AgentRuntimeCapabilityError | undefined {
    if (runtimeExtensionCapabilities(runtime)[extensionClass]) return undefined;
    const { capability, label } = EXTENSION_CLASS_INFO[extensionClass];
    const named = names.length ? ` (${names.map(name => `"${name}"`).join(', ')})` : '';
    return new AgentRuntimeCapabilityError(`Agent runtime "${runtime.kind}" cannot run ${label}${named}. Remove them from the run or choose a runtime that supports them (${SUGGESTION}).`, runtime.kind, capability);
}

/**
 * What a prepared extension launch carries, by class. A launch that does not
 * say (an older or test context) is treated as carrying every class.
 */
export type ExtensionLaunchRequirements = Partial<Record<AgentRuntimeExtensionClass, readonly string[]>>;

/** The first class the launch needs and the runtime lacks, as the refusal to throw. */
export function extensionLaunchRefusal(runtime: ExtensionRuntime, requires: ExtensionLaunchRequirements | undefined): AgentRuntimeCapabilityError | undefined {
    for (const extensionClass of EXTENSION_CLASSES) {
        const names = requires ? requires[extensionClass] : [];
        if (requires && !names?.length) continue;
        const refusal = extensionClassRefusal(runtime, extensionClass, names);
        if (refusal) return refusal;
    }
    return undefined;
}

/** Whether the runtime applies at least one class (the API cannot tell which classes a library run will need). */
export function runtimeAppliesAnyExtension(runtime: ExtensionRuntime): boolean {
    const capabilities = runtimeExtensionCapabilities(runtime);
    return EXTENSION_CLASSES.some(extensionClass => capabilities[extensionClass]);
}
