import type { ChildProcess } from 'node:child_process';
import { dockerRunNeedsNetworkPolicy, prepareDockerRunNetwork } from '../../network/egressExecution.js';
import { getExecutionAbortError, getExecutionOwnershipContext } from './dockerExecutionOwnership.js';

export interface NetworkPolicyOptions {
    /** Why a container that runs only ProPR's own code (e.g. a usage probe) keeps its network inside a restricted run. */
    networkPolicyExempt?: string;
}

/**
 * A restricted-network run gets its own egress proxy, which lives exactly as
 * long as this container's `docker run` process. `start` launches the
 * container with the (possibly rewritten) arguments.
 */
export function startWithNetworkPolicy<T>(
    command: string,
    args: string[],
    { executionSignal, networkPolicyExempt }: NetworkPolicyOptions & { executionSignal?: AbortSignal },
    start: (args: string[]) => Promise<T>,
): Promise<T> {
    if (!dockerRunNeedsNetworkPolicy(command, args, networkPolicyExempt)) return start(args);
    return prepareDockerRunNetwork(command, args, networkPolicyExempt).then(async network => {
        if (!network) return start(args);
        try {
            const abortError = getExecutionAbortError(executionSignal);
            if (abortError) throw abortError;
            return await start(network.args);
        } finally {
            await network.release();
        }
    });
}

/**
 * The same policy for an agent container spawned directly (a long-lived native
 * goal session): its proxy lives until the `docker run` process closes, which
 * Node also reports after a failed spawn.
 */
export async function spawnWithNetworkPolicy(args: string[], spawnChild: (args: string[]) => ChildProcess): Promise<ChildProcess> {
    if (!dockerRunNeedsNetworkPolicy('docker', args)) return spawnChild(args);
    const network = await prepareDockerRunNetwork('docker', args);
    if (!network) return spawnChild(args);
    let child: ChildProcess;
    try {
        // Starting the proxy is asynchronous: cancellation may have won meanwhile.
        const abortError = getExecutionAbortError(getExecutionOwnershipContext()?.signal);
        if (abortError) throw abortError;
        child = spawnChild(network.args);
    } catch (error) {
        await network.release();
        throw error;
    }
    child.once('close', () => { void network.release(); });
    return child;
}
