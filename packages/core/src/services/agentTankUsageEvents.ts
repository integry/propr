import logger from '../utils/logger.js';
import { getEventPublisher } from '../utils/eventPublisher.js';
import type { AgentStatusResponse } from './agentTankTypes.js';

/**
 * Change detection for Agent Tank usage snapshots.
 *
 * Split out of agentTankService so it carries no configuration or HTTP
 * dependencies: the rule that decides whether a poll is a change is the part
 * worth testing on its own, and the part a reader needs to trust.
 */

/**
 * Usage fields that move on every read without the quota having changed.
 *
 * Agent Tank reports countdowns to the next reset and its own refresh
 * timestamps alongside the percentages. Fingerprinting the raw response would
 * make every poll look like a change and turn the push event back into a timer.
 */
const VOLATILE_USAGE_FIELD = /reset|refresh|updated|expires|timestamp|seconds/i;

/** Last published usage fingerprint per agent, keyed by ProPR-facing name. */
const publishedUsageFingerprints = new Map<string, string>();

/** Canonical, order-independent projection of the usage values that matter. */
function stableUsageProjection(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableUsageProjection);
    if (!value || typeof value !== 'object') return value;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_USAGE_FIELD.test(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableUsageProjection(nested)] as const);
    return Object.fromEntries(entries);
}

/** Fingerprint of the usage snapshot a client would actually see. */
export function agentTankUsageFingerprint(status: AgentStatusResponse): string {
    return JSON.stringify({
        name: status.name,
        error: status.error ?? null,
        usage: stableUsageProjection(status.usage)
    });
}

/** Publishes a usage change trigger. Injected in tests; failures are swallowed. */
export type UsageUpdatePublisher = () => Promise<void>;

const defaultUsagePublisher: UsageUpdatePublisher = () =>
    getEventPublisher().publishUsageUpdate({
        source: 'agent-tank',
        occurredAt: new Date().toISOString()
    });

/**
 * Announce a usage snapshot only when it differs from the last one observed.
 *
 * The first snapshot a process sees only seeds the fingerprint: it is the
 * baseline, not a change, and publishing it would wake every sidebar whenever a
 * worker starts. The event carries no usage values - the client re-reads
 * `/api/config/agent-tank/usage`, which already owns that projection and its
 * permission check.
 *
 * The fingerprint is process-local on purpose. A duplicate event from a second
 * process is harmless (the client coalesces a re-read), while sharing it would
 * add a Redis round trip to every status read.
 */
export async function observeAgentTankUsage(
    status: AgentStatusResponse,
    publish: UsageUpdatePublisher = defaultUsagePublisher
): Promise<void> {
    try {
        const fingerprint = agentTankUsageFingerprint(status);
        const previous = publishedUsageFingerprints.get(status.name);
        publishedUsageFingerprints.set(status.name, fingerprint);
        if (previous === undefined || previous === fingerprint) return;
        await publish();
    } catch (error) {
        // Usage tracking is best-effort around real work; a failed publish must
        // never fail the status read that observed the change.
        logger.warn(
            { agent: status.name, error: (error as Error).message },
            'Could not publish Agent Tank usage change'
        );
    }
}

/** Forget the observed usage baselines. Test-only seam. */
export function resetAgentTankUsageTracking(): void {
    publishedUsageFingerprints.clear();
}
