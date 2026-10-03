import type { IssuesLabeledEvent } from '@octokit/webhooks-types';
import { restoreIssueTrigger } from '../services/taskIntent.js';
import { isAuthorizedIssueTriggerActor } from '../daemon/issueTriggerAuthorization.js';
import { loadPrimaryProcessingLabels } from '../config/configManager.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';

function hasStaleTriggerLabels(labels: string[], trigger: string, triggers: string[]): boolean {
    return labels.includes(`${trigger}-processing`) || triggers.some(label => labels.includes(`${label}-cancelled`));
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
    if (!hasStaleTriggerLabels(labels, labelName, triggers)) return { labels, triggerReapplied: true };
    if (!isAuthorizedIssueTriggerActor(payload.sender?.login)) return { status: 'ignored', reason: 'user_not_allowed' };
    const restored = await restoreIssueTrigger({ repoOwner: owner, repoName: repo, number: payload.issue.number, kind: 'issue', triggeringLabel: labelName });
    return restored ? { labels: restored, triggerReapplied: true } : { status: 'ignored', reason: 'intent_not_current' };
}
