import { isRescueRef } from '../git/rescueRefPrefix.js';
import { isStatusBlockOnlyEdit } from '../services/pullRequestStatus/pullRequestStatusBlock.js';
import {
    requestPullRequestStatusSync, requestPullRequestStatusSyncForBase, requestPullRequestStatusSyncForCommit,
} from '../services/pullRequestStatus/pullRequestStatusSignal.js';
import { isBranchUpdatePush, PUSH_BRANCH_REF_PREFIX } from './webhookEventGates.js';

type Payload = Record<string, unknown> & {
    action?: string;
    repository?: { full_name?: string };
    pull_request?: { number?: number; body?: string | null };
    check_run?: { pull_requests?: Array<{ number?: number }> };
    check_suite?: { pull_requests?: Array<{ number?: number }> };
    /** `status` events name the commit; its pull requests are resolved later. */
    sha?: string;
    /** `push` events name the branch and its new tip. */
    ref?: string;
    after?: string;
    deleted?: boolean;
};

/** Pull request actions that can change the status (state, head, base or mergeability). */
const STATUS_PULL_REQUEST_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'closed', 'edited', 'ready_for_review', 'converted_to_draft']);

/**
 * ProPR's own status block edit comes back as a `pull_request` `edited`
 * event. It must not trigger another status update or any agent work.
 */
export function isOwnPullRequestStatusEdit(payload: unknown, eventType: string): boolean {
    return eventType === 'pull_request' && isStatusBlockOnlyEdit(payload as Payload);
}

/**
 * A push to a base branch can make the pull requests into it conflict, with
 * no pull request event: their pull requests are listed later. Push-salvage
 * rescue refs hold rejected work, never a base.
 */
function signalBasePush(event: Payload): void {
    const ref = typeof event?.ref === 'string' ? event.ref : '';
    if (!isBranchUpdatePush({ ref, deleted: event.deleted }) || isRescueRef(ref)) return;
    requestPullRequestStatusSyncForBase(event.repository?.full_name, ref.slice(PUSH_BRANCH_REF_PREFIX.length), event.after);
}

/** Signals a status update for the pull requests a webhook event concerns. */
export function signalPullRequestStatusFromWebhook(payload: unknown, eventType: string): void {
    const event = payload as Payload;
    const repository = event?.repository?.full_name;
    if (eventType === 'pull_request') {
        if (event.action && STATUS_PULL_REQUEST_ACTIONS.has(event.action)) requestPullRequestStatusSync(repository, event.pull_request?.number);
        return;
    }
    if (eventType === 'status') {
        requestPullRequestStatusSyncForCommit(repository, event?.sha);
        return;
    }
    if (eventType === 'push') {
        signalBasePush(event);
        return;
    }
    const pulls = eventType === 'check_run' ? event?.check_run?.pull_requests
        : eventType === 'check_suite' ? event?.check_suite?.pull_requests : undefined;
    for (const pull of pulls ?? []) requestPullRequestStatusSync(repository, pull?.number);
}
