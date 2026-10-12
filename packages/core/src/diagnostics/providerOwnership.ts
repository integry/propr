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

function configuredContainerUid(env: NodeJS.ProcessEnv): number | undefined {
    const configured = env.PROPR_AGENT_CONTAINER_UID;
    if (configured === undefined || configured === '') return AGENT_CONTAINER_UID;
    return /^\d{1,10}$/.test(configured) && Number(configured) <= 0xfffffffe ? Number(configured) : undefined;
}
export const INVALID_CONTAINER_UID_REASON = 'invalid PROPR_AGENT_CONTAINER_UID (expected an unsigned UID); operator action required (docs/operations/managed-diagnostics.md)';
/** Only a root worker consults the container UID; a malformed value narrows it
 * to root-owned homes, and is surfaced instead of an "align UIDs" refusal. */
export function containerUidConfigurationError(env: NodeJS.ProcessEnv = process.env, processUid: number | null = process.getuid?.() ?? null): string | null {
    return processUid === 0 && configuredContainerUid(env) === undefined ? INVALID_CONTAINER_UID_REASON : null;
}

/** Supported worker/provider UID mappings:
 * - native: the worker runs as the same UID that owns the provider root;
 * - hosted: a root worker reads homes owned by the agent container UID.
 * A non-root worker with a different container UID has no supported mapping. */
export function supportedProviderOwners(env: NodeJS.ProcessEnv = process.env, processUid: number | null = process.getuid?.() ?? null): number[] {
    if (processUid === null) return [];
    if (processUid !== 0) return [processUid];
    const container = configuredContainerUid(env);
    return container === undefined ? [0] : [...new Set([0, container])];
}

/** An entry whose owner differs from its supported root. This may be a missed
 * `chown` or a planted file, so it is an unsafe entry, never a UID-mapping
 * signal: aligning the container UID to a foreign owner is not a remedy. */
export class ProviderEntryOwnershipError extends Error {
    readonly code = 'EMIXEDOWNER';
    constructor() { super('unsafe provider entry ownership'); this.name = 'ProviderEntryOwnershipError'; }
}

/** Roots must have a supported owner; every entry must share the root owner,
 * and mixed ownership fails closed as an unsafe entry. */
export function assertProviderOwner(uid: number, rootOwner?: number): void {
    if (rootOwner === undefined) { if (!supportedProviderOwners().includes(uid)) throw new ProviderOwnershipError(); }
    else if (uid !== rootOwner) throw new ProviderEntryOwnershipError();
}

export function providerOwnershipStatus(env: NodeJS.ProcessEnv = process.env, processUid: number | null = process.getuid?.() ?? null): object {
    return { processUid, supportedOwners: supportedProviderOwners(env, processUid), agentContainerUid: configuredContainerUid(env) ?? null,
        configurationError: containerUidConfigurationError(env, processUid),
        mapping: processUid === 0 ? 'hosted-root-worker' : processUid === null ? 'unsupported-platform' : 'native-aligned-uid' };
}
