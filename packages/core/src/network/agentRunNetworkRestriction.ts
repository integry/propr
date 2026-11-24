import logger from '../utils/logger.js';
import {
    currentAgentNetworkPolicy, executeWithNetworkPolicy, networkEgressReportFromError, NetworkPolicyError, resolveAgentRunNetworkPolicy,
    sameNetworkPolicy, type NetworkEgressReport,
} from './egressExecution.js';
import type { ResolvedNetworkPolicy } from './networkPolicy.js';

/**
 * Runs `execute` (a Docker launch whose network the executor's policy
 * boundary prepares) under the restricted policy an agent run spec carries,
 * so the spec alone confines the container instead of relying on the policy
 * being ambient at launch. The policy applying at launch (an enclosing
 * restricted run, or the enforced instance policy outside any run) is never
 * replaced: the same policy joins it, and a different one is refused rather
 * than guessing which allowlist is narrower. An unreadable instance policy
 * rejects too. An enclosing open scope is narrowed to the spec's policy.
 */
export async function executeWithAgentRunNetworkRestriction<T>(
    restriction: ResolvedNetworkPolicy | undefined,
    name: string,
    execute: () => Promise<T>,
): Promise<T> {
    if (!restriction) return execute();
    if (restriction.mode !== 'restricted') {
        throw new NetworkPolicyError(`Agent run ${name} carries a network restriction whose mode is ${String(restriction.mode)}, not restricted`);
    }
    const applicable = await resolveAgentRunNetworkPolicy();
    if (applicable && !sameNetworkPolicy(applicable, restriction)) {
        throw new NetworkPolicyError(`Agent run ${name} carries a restricted network policy (${restriction.source}) that differs from the policy applying at launch (${applicable.source})`);
    }
    // Inside an enclosing scope with this policy the launch joins it, and that scope reports.
    const current = currentAgentNetworkPolicy();
    if (current && sameNetworkPolicy(current, restriction)) return execute();
    const log = (report: NetworkEgressReport | undefined): void => {
        if (report) logger.warn({ networkEgress: report }, 'Network policy report for an agent run restricted by its spec outside a matching run network policy');
    };
    try {
        const { result, report } = await executeWithNetworkPolicy(restriction, execute);
        log(report);
        return result;
    } catch (error) {
        log(networkEgressReportFromError(error));
        throw error;
    }
}
