import { enableEgressSocketMountPreflight, setUnscopedNetworkPolicyResolver } from '@propr/core';
import { resolveRunNetworkPolicy } from './networkEgress.js';

/**
 * Safety net for a worker process: an agent container that a job path starts
 * without `runWithNetworkPolicy` follows the instance policy when it enforces
 * restricted mode, instead of running open. The process also checks once,
 * with a throwaway container before its first restricted run, that the Docker
 * host shares the egress socket directory, so a host that cannot bind-mount
 * the sockets (Docker Desktop, an unshared directory) gets one actionable
 * warning instead of only silent runs without a network.
 */
export function enforceInstanceNetworkPolicyOutsideRuns(): void {
    setUnscopedNetworkPolicyResolver(() => resolveRunNetworkPolicy());
    enableEgressSocketMountPreflight();
}
