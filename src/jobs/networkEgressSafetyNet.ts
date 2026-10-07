import { setUnscopedNetworkPolicyResolver } from '@propr/core';
import { resolveRunNetworkPolicy } from './networkEgress.js';

/**
 * Safety net for a worker process: an agent container that a job path starts
 * without `runWithNetworkPolicy` follows the instance policy when it enforces
 * restricted mode, instead of running open.
 */
export function enforceInstanceNetworkPolicyOutsideRuns(): void {
    setUnscopedNetworkPolicyResolver(() => resolveRunNetworkPolicy());
}
