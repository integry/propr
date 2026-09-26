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
 * Record what one agent's snapshot looks like now.
 *
 * Returns true only when it moved away from a baseline this process had already
 * seen: an agent read for the first time is seeded silently, and a re-read of
 * the same values is not a change. Every read path shares this map, so a change
 * one path has already announced is not announced again by the next one.
 */
function recordUsageFingerprint(status: AgentStatusResponse): boolean {
    const fingerprint = agentTankUsageFingerprint(status);
    const previous = publishedUsageFingerprints.get(status.name);
    publishedUsageFingerprints.set(status.name, fingerprint);
    return previous !== undefined && previous !== fingerprint;
}

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
        if (!recordUsageFingerprint(status)) return;
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

/**
 * Announce a change observed in an aggregate `GET /status` snapshot.
 *
 * The aggregate read is the one that supplies the client's usage panel, so it
 * has to be a detection point in its own right: without it a changed percentage
 * is only announced when something else happens to read the same agent
 * one-by-one, and the other connected clients are told nothing.
 *
 * At most one trigger is published per snapshot however many agents moved. The
 * event carries no usage values, so a client re-reads this same endpoint once
 * either way, and the per-agent baselines are still seeded individually: a
 * newly appearing agent is not a change.
 *
 * Expects the ProPR-facing snapshot (`normalizeAgentTankAgents`), so its
 * fingerprints match the ones the single-agent path records.
 */
export async function observeAgentTankUsageSnapshot(
    agents: Record<string, AgentStatusResponse>,
    publish: UsageUpdatePublisher = defaultUsagePublisher
): Promise<void> {
    try {
        let changed = false;
        for (const [agent, status] of Object.entries(agents)) {
            // A status object that omits its own name is still about the agent
            // it is keyed by; without the fallback every such agent would share
            // one baseline.
            if (recordUsageFingerprint({ ...status, name: status.name || agent })) changed = true;
        }
        if (!changed) return;
        await publish();
    } catch (error) {
        // Best-effort, exactly as in the single-agent path: a failed publish
        // must not fail the usage read that observed the change.
        logger.warn(
            { agents: Object.keys(agents).length, error: (error as Error).message },
            'Could not publish Agent Tank usage change'
        );
    }
}

/** Forget the observed usage baselines. Test-only seam. */
export function resetAgentTankUsageTracking(): void {
    publishedUsageFingerprints.clear();
}
