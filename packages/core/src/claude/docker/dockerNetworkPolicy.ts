import { dockerRunNeedsNetworkPolicy, prepareDockerRunNetwork } from '../../network/egressExecution.js';
import { getExecutionAbortError } from './dockerExecutionOwnership.js';

/**
 * A restricted-network run gets its own egress proxy, which lives exactly as
 * long as this container's `docker run` process. `start` launches the
 * container with the (possibly rewritten) arguments.
 */
export function startWithNetworkPolicy<T>(
    command: string,
    args: string[],
    executionSignal: AbortSignal | undefined,
    start: (args: string[]) => Promise<T>,
): Promise<T> {
    if (!dockerRunNeedsNetworkPolicy(command, args)) return start(args);
    return prepareDockerRunNetwork(command, args).then(async network => {
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
