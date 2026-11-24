import type { AgentRunSpec } from './types.js';

/** What the executor receives when a runtime launches an {@link AgentRunSpec}. */
export interface AgentRunLaunch {
    spec: AgentRunSpec;
    /** Decoded (and redacted) output chunks, forwarded to the run handle's streams. */
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

/**
 * - `agent`: a provider run started through an agent runtime (it carries its spec);
 * - `container`: a container started from raw `docker run` argv by a helper
 *   (capability probes, package verification) that is not an agent run but
 *   still occupies a container slot;
 * - `command`: any other subprocess (`docker inspect`, `sudo chown`, ...).
 */
export type ContainerLaunchKind = 'agent' | 'container' | 'command';

export function containerLaunchKind(
    command: string,
    args: readonly string[],
    options: { agentRun?: AgentRunLaunch },
): ContainerLaunchKind {
    if (options.agentRun) return 'agent';
    return command === 'docker' && args[0] === 'run' ? 'container' : 'command';
}

/**
 * Whether the launch starts a container, which admission, the spend cap, the
 * native-log gate and container detection govern. Agent runs are recognised
 * from their spec; only helper containers still assembled as argv fall back
 * to the `docker run` shape.
 */
export function startsContainer(
    command: string,
    args: readonly string[],
    options: { agentRun?: AgentRunLaunch },
): boolean {
    return containerLaunchKind(command, args, options) !== 'command';
}
