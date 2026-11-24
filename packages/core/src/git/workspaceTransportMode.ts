import type { AgentRunSpec, AgentRuntimeCapabilities, WorkspaceTransportMode } from '../agents/runtime/types.js';

/** Instance-wide workspace transport override: `bind` or `clone`. */
export const WORKSPACE_TRANSPORT_ENV = 'PROPR_WORKSPACE_TRANSPORT';

export const WORKSPACE_TRANSPORT_MODES: readonly WorkspaceTransportMode[] = Object.freeze(['bind', 'clone']);

function parseMode(value: string, source: string): WorkspaceTransportMode {
    const mode = value.trim().toLowerCase();
    if (!(WORKSPACE_TRANSPORT_MODES as readonly string[]).includes(mode)) {
        throw new Error(`Unknown workspace transport "${value}" (set by ${source}); available: ${WORKSPACE_TRANSPORT_MODES.join(', ')}`);
    }
    return mode as WorkspaceTransportMode;
}

/** The transports a runtime can run. Runtimes that predate the field bind-mount when they can. */
export function runtimeWorkspaceTransports(capabilities: AgentRuntimeCapabilities): readonly WorkspaceTransportMode[] {
    return capabilities.workspaceTransports ?? (capabilities.supportsBindMounts ? ['bind'] : []);
}

/**
 * The run's workspace transport: the spec's own mode, else
 * `PROPR_WORKSPACE_TRANSPORT`, else `bind` on a runtime that bind-mounts and
 * `clone` on one that cannot. Unknown names fail loudly.
 */
export function resolveWorkspaceTransportMode(
    spec: Pick<AgentRunSpec, 'workspace'>,
    capabilities: AgentRuntimeCapabilities,
    environment: NodeJS.ProcessEnv = process.env,
): WorkspaceTransportMode {
    if (spec.workspace.mode) return parseMode(spec.workspace.mode, 'the agent run spec');
    const configured = environment[WORKSPACE_TRANSPORT_ENV]?.trim();
    if (configured) return parseMode(configured, WORKSPACE_TRANSPORT_ENV);
    return capabilities.supportsBindMounts ? 'bind' : 'clone';
}
