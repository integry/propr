/** Included in the daemon identity because legacy recovery compares that field
 * even across generation changes, but ignores unknown protocol fields. Never
 * change this identity while holders or old execution processes remain. */
export const ADMISSION_DAEMON_PREFIX = 'propr-agent-admission/nested-v1/';

/**
 * Whether the admission configuration stored in Redis lets this process admit.
 *
 * The global limit and generation are fenced: the first admission stores
 * them, and every acquire compares its own identity with the stored one. A
 * process whose limit differs at the same generation (or whose generation is
 * lower) is refused with `configuration/daemon mismatch` on every attempt,
 * draining or not. Within the same protocol, a higher generation is the
 * documented change: the next admission attempt fences every older reservation
 * and stores the new one.
 *
 * The protocol prefix is also checked. The Docker daemon identity is never
 * returned, and its actual daemon component is not compared:
 * the report does not query Docker, so a daemon change is not detected here.
 */
export type AgentAdmissionConfigurationStatus =
    /** Compatible protocol; stored limit and generation equal this process's. */
    | 'current'
    /** Nothing stored and no holders: the first admission stores this configuration. */
    | 'uninitialized'
    /** This process's generation is higher: the next admission attempt fences every older reservation, then switches. */
    | 'pending_generation'
    /** Incompatible protocol, same generation with another limit, a lower generation, or an unreadable stored record: every launch is refused. */
    | 'mismatch'
    /** Nothing stored while holder records remain: recovery, and so every launch, is refused. */
    | 'missing';

export interface AgentAdmissionConfigurationState {
    status: AgentAdmissionConfigurationStatus;
    /** False when admission refuses every launch with this process's configuration. */
    admitting: boolean;
    /** What the stored record says; null when nothing (readable) is stored. */
    stored: { limit: number; generation: number } | null;
}

function storedConfiguration(raw: string): { limit: number; generation: number; compatible: boolean } | null {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const { limit, generation = 0, daemon } = parsed as { limit?: unknown; generation?: unknown; daemon?: unknown };
    return Number.isSafeInteger(limit) && Number.isSafeInteger(generation)
        ? { limit: limit as number, generation: generation as number, compatible: typeof daemon === 'string' && daemon.startsWith(ADMISSION_DAEMON_PREFIX) } : null;
}

/**
 * Classifies the stored record (`''` when absent) against this process's
 * limit and generation. `holderRecords` counts every holder record, nested
 * ones included: recovery refuses a missing configuration while any remain.
 */
export function admissionConfigurationState(
    raw: string, configured: { limit: number; generation: number }, holderRecords: number,
): AgentAdmissionConfigurationState {
    if (!raw) return holderRecords ? { status: 'missing', admitting: false, stored: null } : { status: 'uninitialized', admitting: true, stored: null };
    const parsed = storedConfiguration(raw);
    if (!parsed) return { status: 'mismatch', admitting: false, stored: null };
    const { compatible, ...stored } = parsed;
    if (!compatible) return { status: 'mismatch', admitting: false, stored };
    if (configured.generation > stored.generation) return { status: 'pending_generation', admitting: true, stored };
    if (configured.generation === stored.generation && configured.limit === stored.limit) return { status: 'current', admitting: true, stored };
    return { status: 'mismatch', admitting: false, stored };
}
