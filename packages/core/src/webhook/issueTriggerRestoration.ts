import type { IssuesLabeledEvent } from '@octokit/webhooks-types';
import { restoreIssueTrigger } from '../services/taskIntent.js';
import { isAuthorizedIssueTriggerActor } from '../daemon/issueTriggerAuthorization.js';
import { hasStaleTriggerLabels, readCurrentIssueLabels, readCurrentTriggerEvidence, type TriggerEvidence } from '../daemon/triggerApplicationEvidence.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';

/**
 * A stale delivery of the original application must not restart cancelled
 * work. Either the timeline shows an authorized application after the latest
 * stale marker, or this delivery's own event postdates that marker (the new
 * labeled event may not be visible in the timeline yet). An application found
 * only across an unscanned timeline gap does not establish that ordering, and
 * neither timeline nor delivery time can be ordered against a currently
 * applied marker whose application the timeline does not show yet.
 */
function isRenewedApplication(evidence: TriggerEvidence, deliveredAt: string | undefined): boolean {
    if (evidence.appliedMarkerUnseen) return false;
    if (evidence.actor && !evidence.staleSinceApplied && !evidence.orderingUnverified) return isAuthorizedIssueTriggerActor(evidence.actor.login);
    const delivered = deliveredAt ? Date.parse(deliveredAt) : NaN;
    const marked = evidence.staleMarkedAt ? Date.parse(evidence.staleMarkedAt) : NaN;
    return delivered > marked;
}

/** Resolves current issue labels for a label event, restoring stale `-processing`/`-cancelled` labels first for a trigger event. */
export async function resolveIssueTriggerLabels(
    payload: IssuesLabeledEvent,
    owner: string,
    repo: string,
): Promise<{ labels: string[]; triggerReapplied: boolean; renewedTrigger?: string } | DeliveryDisposition> {
    const labels = payload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) ?? [];
    const labelName = payload.label?.name;
    if (payload.issue.pull_request) return { labels, triggerReapplied: false };
    const triggers = await loadPrimaryProcessingLabels();
    if (!labelName || !triggers.includes(labelName)) {
        // Unrelated label events are not renewed intent, but they can still
        // reach admission. A delayed payload may predate a cancellation, so
        // admission must see the current state and exclusion markers.
        const current = await readCurrentIssueLabels({ owner, repo, issueNumber: payload.issue.number });
        if (!current.open) return { status: 'ignored', reason: 'intent_not_current' };
        return { labels: current.labels, triggerReapplied: false };
    }
    const current = await readCurrentTriggerEvidence({ owner, repo, issueNumber: payload.issue.number }, labelName, triggers);
    // The applied trigger is the one this request stands on: admission records
    // it, so removing it later cancels the work even when another configured
    // trigger is also present.
    if (!current.evidence && !hasStaleTriggerLabels(labels, labelName, triggers)) return { labels, triggerReapplied: true, renewedTrigger: labelName };
    if (!isAuthorizedIssueTriggerActor(payload.sender?.login)) return { status: 'ignored', reason: 'user_not_allowed' };
    if (!current.labels.includes(labelName) || current.evidence && !isRenewedApplication(current.evidence, payload.issue.updated_at)) {
        return { status: 'ignored', reason: 'intent_not_current' };
    }
    const restored = await restoreIssueTrigger({ repoOwner: owner, repoName: repo, number: payload.issue.number, kind: 'issue', triggeringLabel: labelName });
    return restored ? { labels: restored, triggerReapplied: true, renewedTrigger: labelName } : { status: 'ignored', reason: 'intent_not_current' };
}
