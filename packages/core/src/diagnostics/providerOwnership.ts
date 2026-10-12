/** Dockerfile.agent entrypoints chown managed provider homes to `node` and drop
 * privileges to it, so provider-written files carry this UID. */
export const AGENT_CONTAINER_UID = 1000;

/** A provider root, or an entry inside one, whose owner the worker cannot
 * attest. Never read, exported or treated as a measured capacity. */
export class ProviderOwnershipError extends Error {
    readonly code = 'EOWNERSHIP';
    constructor() { super('provider file ownership unsupported'); this.name = 'ProviderOwnershipError'; }
}
export function isProviderOwnershipError(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === 'EOWNERSHIP';
}

/** Supported worker/provider UID mappings:
 * - native: the worker runs as the same UID that owns the provider root;
 * - hosted: a root worker reads homes owned by the agent container UID.
 * A non-root worker with a different container UID has no supported mapping. */
export function supportedProviderOwners(env: NodeJS.ProcessEnv = process.env, processUid: number | null = process.getuid?.() ?? null): number[] {
    if (processUid === null) return [];
    const configured = env.PROPR_AGENT_CONTAINER_UID;
    const container = configured === undefined || configured === '' ? AGENT_CONTAINER_UID
        : /^\d{1,10}$/.test(configured) && Number(configured) <= 0xfffffffe ? Number(configured) : undefined;
    if (processUid !== 0) return [processUid];
    return container === undefined ? [0] : [...new Set([0, container])];
}

/** Every entry must share the root owner; mixed ownership fails closed. */
export function assertProviderOwner(uid: number, rootOwner?: number): void {
    if (rootOwner === undefined ? !supportedProviderOwners().includes(uid) : uid !== rootOwner) throw new ProviderOwnershipError();
}

export function providerOwnershipStatus(): object {
    const processUid = process.getuid?.() ?? null;
    return { processUid, supportedOwners: supportedProviderOwners(), agentContainerUid: AGENT_CONTAINER_UID,
        mapping: processUid === 0 ? 'hosted-root-worker' : processUid === null ? 'unsupported-platform' : 'native-aligned-uid' };
}
