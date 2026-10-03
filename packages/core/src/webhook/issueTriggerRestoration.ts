import type { IssuesLabeledEvent } from '@octokit/webhooks-types';
import { restoreIssueTrigger } from '../services/taskIntent.js';
import { isAuthorizedIssueTriggerActor } from '../daemon/issueTriggerAuthorization.js';
import { hasStaleTriggerLabels, readCurrentTriggerEvidence, type TriggerEvidence } from '../daemon/triggerApplicationEvidence.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';

/**
 * A stale delivery of the original application must not restart cancelled
 * work. Either the timeline shows an authorized application after the latest
 * stale marker, or this delivery's own event postdates that marker (the new
 * labeled event may not be visible in the timeline yet).
 */
function isRenewedApplication(evidence: TriggerEvidence, deliveredAt: string | undefined): boolean {
    if (evidence.actor && !evidence.staleSinceApplied) return isAuthorizedIssueTriggerActor(evidence.actor.login);
    const delivered = deliveredAt ? Date.parse(deliveredAt) : NaN;
    const marked = evidence.staleMarkedAt ? Date.parse(evidence.staleMarkedAt) : NaN;
    return delivered > marked;
}

/** Resolves the issue labels for a trigger-label event, restoring stale `-processing`/`-cancelled` labels first. */
export async function resolveIssueTriggerLabels(
    payload: IssuesLabeledEvent,
    owner: string,
    repo: string,
): Promise<{ labels: string[]; triggerReapplied: boolean } | DeliveryDisposition> {
    const labels = payload.issue.labels?.map(l => typeof l === 'string' ? l : l.name) ?? [];
    const labelName = payload.label?.name;
    if (payload.issue.pull_request || !labelName) return { labels, triggerReapplied: false };
    const triggers = await loadPrimaryProcessingLabels();
    if (!triggers.includes(labelName)) return { labels, triggerReapplied: false };
    const current = await readCurrentTriggerEvidence({ owner, repo, issueNumber: payload.issue.number }, labelName, triggers);
    if (!current.evidence && !hasStaleTriggerLabels(labels, labelName, triggers)) return { labels, triggerReapplied: true };
    if (!isAuthorizedIssueTriggerActor(payload.sender?.login)) return { status: 'ignored', reason: 'user_not_allowed' };
    if (!current.labels.includes(labelName) || current.evidence && !isRenewedApplication(current.evidence, payload.issue.updated_at)) {
        return { status: 'ignored', reason: 'intent_not_current' };
    }
    const restored = await restoreIssueTrigger({ repoOwner: owner, repoName: repo, number: payload.issue.number, kind: 'issue', triggeringLabel: labelName });
    return restored ? { labels: restored, triggerReapplied: true } : { status: 'ignored', reason: 'intent_not_current' };
}
