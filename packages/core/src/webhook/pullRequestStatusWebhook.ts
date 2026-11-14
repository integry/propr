import { stripStatusSlot } from '@propr/shared';
import { isRescueRef } from '../git/rescueRefPrefix.js';
import { isStatusBlockOnlyEdit } from '../services/pullRequestStatus/pullRequestStatusBlock.js';
import { isRecordedPullRequestStatusWrite } from '../services/pullRequestStatus/pullRequestStatusProvenance.js';
import { isRecordedPullRequestTitleSlot } from '../services/pullRequestStatus/pullRequestStatusTitle.js';
import {
    pullRequestStatusRedis, requestEpicPullRequestStatusSync, requestPullRequestStatusSync, requestPullRequestStatusSyncForBase, requestPullRequestStatusSyncForCommit,
} from '../services/pullRequestStatus/pullRequestStatusSignal.js';
import { isBranchUpdatePush, PUSH_BRANCH_REF_PREFIX } from './webhookEventGates.js';

type Payload = Record<string, unknown> & {
    action?: string;
    repository?: { full_name?: string };
    pull_request?: { number?: number; body?: string | null; title?: string | null; base?: { ref?: string } };
    changes?: Record<string, unknown> & { body?: { from?: string | null }; title?: { from?: string | null }; base?: { ref?: { from?: string } } };
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
 * Which status surfaces an `edited` event changed, when it changed nothing
 * else: the body only inside the status block, the title only in its leading
 * status slot. Null for any other event.
 */
function statusOnlyChanges(event: Payload): { body: boolean; title: boolean } | null {
    if (event.action !== 'edited' || !event.changes) return null;
    const keys = Object.keys(event.changes);
    if (keys.length === 0 || keys.some(key => key !== 'body' && key !== 'title')) return null;
    const body = keys.includes('body');
    const title = keys.includes('title');
    if (body && !isStatusBlockOnlyEdit({ action: event.action, changes: { body: event.changes.body }, pull_request: event.pull_request })) return null;
    if (title && stripStatusSlot(event.changes.title?.from ?? '') !== stripStatusSlot(event.pull_request?.title ?? '')) return null;
    return { body, title };
}

/**
 * What a `pull_request` `edited` event that changed nothing outside the status
 * block and the title's status slot is. `own`: ProPR's status update coming back, which must trigger no
 * further work. `foreign`: someone else deleted or rewrote the block, so the
 * status must be reconciled; it is still no work for the other handlers.
 * Null for every other event.
 */
export type PullRequestStatusEdit = 'own' | 'foreign' | null;

/**
 * Only a block and a title slot ProPR recorded writing (pullRequestStatusProvenance,
 * pullRequestStatusTitle) prove the edit is ProPR's own; the body lock cannot
 * keep a person from editing the block or the title in GitHub, and the event
 * names no author ProPR could trust. A person removing the title slot is
 * `foreign`: the status is read again, which leaves the slot out until it changes.
 */
export async function classifyPullRequestStatusEdit(payload: unknown, eventType: string): Promise<PullRequestStatusEdit> {
    const event = payload as Payload;
    const changed = eventType === 'pull_request' ? statusOnlyChanges(event) : null;
    if (!changed) return null;
    const repository = event.repository?.full_name;
    const prNumber = event.pull_request?.number;
    if (typeof repository !== 'string' || typeof prNumber !== 'number') return 'foreign';
    const redis = pullRequestStatusRedis();
    if (changed.body && !await isRecordedPullRequestStatusWrite(redis, repository, prNumber, event.pull_request?.body)) return 'foreign';
    if (changed.title && !await isRecordedPullRequestTitleSlot(redis, repository, prNumber, event.pull_request?.title)) return 'foreign';
    return 'own';
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

/** Actions on a pull request into an epic branch that change its epic: a sub-PR opened, merged, closed or retargeted. */
const EPIC_CHILD_ACTIONS = new Set(['opened', 'reopened', 'closed', 'edited', 'ready_for_review', 'converted_to_draft']);

/**
 * A sub-PR's own event also concerns its epic PR, whose status and progress
 * comment list it. Retargeting a pull request concerns the epic it left too.
 */
function signalEpicOfPullRequest(event: Payload, repository: string | undefined): void {
    if (!event.action || !EPIC_CHILD_ACTIONS.has(event.action)) return;
    requestEpicPullRequestStatusSync(repository, event.pull_request?.base?.ref);
    if (event.action === 'edited') requestEpicPullRequestStatusSync(repository, event.changes?.base?.ref?.from);
}

/** Signals a status update for the pull requests a webhook event concerns. */
export function signalPullRequestStatusFromWebhook(payload: unknown, eventType: string): void {
    const event = payload as Payload;
    const repository = event?.repository?.full_name;
    if (eventType === 'pull_request') {
        if (event.action && STATUS_PULL_REQUEST_ACTIONS.has(event.action)) requestPullRequestStatusSync(repository, event.pull_request?.number);
        signalEpicOfPullRequest(event, repository);
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
