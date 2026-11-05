/**
 * The payload gates the webhook handlers use to decide whether a CI or push
 * delivery can lead to any work. They are shared with the routing relay's
 * delivery-interest declaration (intake/routingDeliveryInterest.ts), so the
 * relay is only ever asked to drop deliveries these exact gates already ignore.
 * Widening a handler means widening its gate here, which widens the declaration.
 */
import type { CheckRunEvent, CheckSuiteEvent, StatusEvent } from '@octokit/webhooks-types';

/** check_run: the only action handleCheckRunEvent and extractCheckRunFailure read. */
export const CHECK_RUN_ACTED_ACTIONS = ['completed'] as const satisfies readonly CheckRunEvent['action'][];

/** check_suite: the only action handleCheckSuiteEvent reads. */
export const CHECK_SUITE_ACTED_ACTIONS = ['completed'] as const satisfies readonly CheckSuiteEvent['action'][];

/**
 * check_suite conclusions treated as green. Skipped counts as passing, as it
 * does for individual check runs (GitHub sends it even though the payload
 * types omit it).
 */
export const CHECK_SUITE_PASSING_CONCLUSIONS = ['success', 'neutral', 'skipped'] as const;

/** status: a success wakes the Ultrafix hook. */
export const STATUS_SUCCESS_STATE = 'success' satisfies StatusEvent['state'];

/** status: states that can post an automatic failed-CI follow-up. */
export const STATUS_FAILURE_STATES = ['failure', 'error'] as const satisfies readonly StatusEvent['state'][];

/** status: every state the status handler acts on (GitHub's enum minus `pending`). */
export const STATUS_ACTED_STATES = [STATUS_SUCCESS_STATE, ...STATUS_FAILURE_STATES] as const;

/** push: only branch pushes can conflict an open pull request. */
export const PUSH_BRANCH_REF_PREFIX = 'refs/heads/';

export function isActedCheckRunAction(action: string): boolean {
    return (CHECK_RUN_ACTED_ACTIONS as readonly string[]).includes(action);
}

export function isActedCheckSuiteAction(action: string): boolean {
    return (CHECK_SUITE_ACTED_ACTIONS as readonly string[]).includes(action);
}

export function isPassingCheckSuiteConclusion(conclusion: string | null | undefined): boolean {
    return conclusion != null && (CHECK_SUITE_PASSING_CONCLUSIONS as readonly string[]).includes(conclusion);
}

/** GitHub sends lowercase states; the comparison stays case-insensitive as before. */
export function isFailureStatusState(state: string): boolean {
    return (STATUS_FAILURE_STATES as readonly string[]).includes(state.toLowerCase());
}

/** A push that created or moved a branch (not a tag, not a deletion). */
export function isBranchUpdatePush(payload: { ref: string; deleted?: boolean | null }): boolean {
    return payload.ref.startsWith(PUSH_BRANCH_REF_PREFIX) && !payload.deleted;
}
