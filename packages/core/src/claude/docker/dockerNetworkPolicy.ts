import type { ChildProcess } from 'node:child_process';
import {
    dockerRunNeedsNetworkPolicy, executeWithNetworkPolicy, mayNeedUnscopedNetworkPolicy, networkEgressReportFromError, prepareDockerRunNetwork,
    resolveUnscopedNetworkPolicy, type NetworkEgressReport,
} from '../../network/egressExecution.js';
import logger from '../../utils/logger.js';
import { getExecutionAbortError, getExecutionOwnershipContext } from './dockerExecutionOwnership.js';

export interface NetworkPolicyOptions {
    /** Why a container that runs only ProPR's own code (e.g. a usage probe) keeps its network inside a restricted run. */
    networkPolicyExempt?: string;
}

/**
 * An agent container that some code path started outside any run's network
 * policy: when the instance enforces restricted mode it runs under that
 * policy, not open. Nothing records it on a timeline, so its report is logged.
 */
async function withUnscopedNetworkPolicy<T>(command: string, args: string[], exemptReason: string | undefined, run: () => Promise<T>): Promise<T> {
    const policy = await resolveUnscopedNetworkPolicy(command, args, exemptReason);
    if (!policy) return run();
    logger.warn('Agent container started outside a run network policy; applying the enforced instance policy');
    const log = (report: NetworkEgressReport | undefined) => {
        if (report) logger.warn({ networkEgress: report }, 'Network policy report for an agent container started outside a run network policy');
    };
    try {
        const { result, report } = await executeWithNetworkPolicy(policy, run);
        log(report);
        return result;
    } catch (error) {
        log(networkEgressReportFromError(error));
        throw error;
    }
}

/**
 * A restricted-network run gets its own egress proxy, which lives exactly as
 * long as this container's `docker run` process. `start` launches the
 * container with the (possibly rewritten) arguments.
 */
export function startWithNetworkPolicy<T>(
    command: string,
    args: string[],
    options: NetworkPolicyOptions & { executionSignal?: AbortSignal },
    start: (args: string[]) => Promise<T>,
): Promise<T> {
    if (mayNeedUnscopedNetworkPolicy(command, args, options.networkPolicyExempt)) {
        return withUnscopedNetworkPolicy(command, args, options.networkPolicyExempt, () => startWithScopedNetworkPolicy(command, args, options, start));
    }
    return startWithScopedNetworkPolicy(command, args, options, start);
}

function startWithScopedNetworkPolicy<T>(
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
    // The proxy keeps the run's recorder, so a session started outside any policy is still bounded by it;
    // its logged report covers the launch only.
    if (mayNeedUnscopedNetworkPolicy('docker', args)) return withUnscopedNetworkPolicy('docker', args, undefined, () => spawnWithScopedNetworkPolicy(args, spawnChild));
    return spawnWithScopedNetworkPolicy(args, spawnChild);
}

async function spawnWithScopedNetworkPolicy(args: string[], spawnChild: (args: string[]) => ChildProcess): Promise<ChildProcess> {
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
