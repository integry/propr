/**
 * Moved to the Docker runtime (`runtime/dockerNetwork.ts`), which owns how a
 * spec's network becomes Docker networking. Re-exported for existing imports.
 */
export { AGENT_CONTAINER_DEFAULT_NETWORK, agentContainerNetwork, isValidDockerNetworkName } from './runtime/dockerNetwork.js';
