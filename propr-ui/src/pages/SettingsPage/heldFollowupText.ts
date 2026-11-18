import type { FollowupHandoffStatus } from '../../api/followupHandoffsApi';
import { formatDateTime, formatRelativeTime } from '../../utils/dateFormat';

/**
 * Plain words for held follow-ups. The API and CLI report raw phases, reasons
 * and an operator sentence written for the command line; Settings maps them
 * here instead of changing that output.
 */

const HELD = 'awaiting_operator';
const ACTIVE = 'active';
const RELEASED = 'released';

/** Held for a decision, or still being recovered: what the list shows by default. */
export const isOpenFollowup = (handoff: FollowupHandoffStatus): boolean => handoff.status !== RELEASED;
export const isHeldFollowup = (handoff: FollowupHandoffStatus): boolean => handoff.status === HELD;

/** Cancelled work that needs an explicit choice before Resume may publish it. */
export const needsCancelledChoice = (handoff: FollowupHandoffStatus): boolean =>
  isHeldFollowup(handoff) && handoff.statusReason === 'cancelled_by_user' && !handoff.operatorAuthorized;

const STATUS_LABELS: Record<string, string> = {
  [HELD]: 'Held',
  [ACTIVE]: 'In recovery',
  [RELEASED]: 'Released',
};

const PHASE_LABELS: Record<string, string> = {
  agent_running: 'Agent running',
  agent_exited: 'Agent finished',
  committed: 'Committed',
  pushed: 'Pushed',
  comment_published: 'Comment posted',
  cleanup_pending: 'Cleaning up',
};

const REASON_LABELS: Record<string, string> = {
  // Held for a decision.
  fork_publication_unsupported: 'The pull request comes from a fork, so its work can’t be published there.',
  usage_limit_retry_unconfirmed: 'A usage-limit retry may already be handling this request.',
  cancelled_by_user: 'The work was cancelled before it was published.',
  head_advanced_externally: 'Newer commits reached the pull request after this attempt.',
  recorded_commit_mismatch: 'The kept commit no longer matches the one recorded.',
  pr_binding_mismatch: 'The pull request no longer matches this follow-up.',
  worktree_missing: 'The kept work is gone from the server.',
  worktree_not_on_branch: 'The kept work is no longer on its branch.',
  worktree_restore_failed: 'The kept work could not be restored.',
  // In recovery.
  publication_failed: 'Publishing failed; it is retried automatically.',
  publication_settled: 'Published; the branch is being freed.',
  operator_resumed: 'Resumed by an administrator.',
  operator_authorized: 'An administrator chose to publish the cancelled work.',
  usage_limit_retry: 'The usage-limit retry is handling this request.',
  failure_delivered: 'The failure was reported on the pull request.',
  // Released.
  released_by_operator: 'Released by an administrator.',
  released_by_operator_force: 'Released by an administrator; unpublished commits kept.',
  auto_released_stale_hold: 'Released automatically (stale).',
  auto_released_for_new_request: 'Released for a newer request.',
  superseded_by_retry: 'Handed to the usage-limit retry.',
  released_pr_closed: 'Pull request closed.',
  released_pr_merged: 'Pull request merged.',
};

const humanize = (value: string): string => {
  const words = value.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
};

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? humanize(status);

/**
 * An active follow-up whose agent container the server saw running: the run is
 * in progress, not being recovered. The server only checks liveness for
 * active records (`not_checked` otherwise).
 */
export const isRunningFollowup = (handoff: FollowupHandoffStatus): boolean =>
  handoff.status === ACTIVE && handoff.liveness === 'running';

/** The row's state: "Running" while its agent runs, otherwise the status label. */
export const followupStateLabel = (handoff: FollowupHandoffStatus): string =>
  isRunningFollowup(handoff) ? 'Running' : statusLabel(handoff.status);
export const phaseLabel = (phase: string): string => PHASE_LABELS[phase] ?? humanize(phase);

/** Why it is held, what recovery is doing, or why it was released. */
export const reasonLabel = (handoff: FollowupHandoffStatus): string => {
  if (handoff.statusReason) return REASON_LABELS[handoff.statusReason] ?? `${humanize(handoff.statusReason)}.`;
  if (isHeldFollowup(handoff)) return 'It needs a decision.';
  if (handoff.status === RELEASED) return 'Released.';
  if (isRunningFollowup(handoff)) return 'Its agent is working on this request.';
  return 'Recovery is in progress.';
};

/**
 * The server's operator sentence (`src/jobs/followupHandoffOperator.ts`)
 * as a short next step, or null when there is nothing for anyone to do.
 */
export const nextStep = (handoff: FollowupHandoffStatus): string | null => {
  const action = handoff.nextAction;
  if (handoff.status === RELEASED || action === 'none') return null;
  if (isHeldFollowup(handoff)) {
    if (action.startsWith('resume --authorize-cancelled')) return 'Tick “Publish the cancelled work” and resume to publish it, or release it.';
    if (action.startsWith('resume to hand the request')) return 'Resume to hand it to the scheduled usage-limit retry (its edits are not published), or release it.';
    if (action.startsWith('check the issue queue')) return 'If a usage-limit retry is queued for it, release it; otherwise resume it.';
    return 'Fix the problem above, then resume it, or release it.';
  }
  if (action.startsWith('wait for the live agent')) return 'Wait for its agent to finish.';
  if (action.startsWith('restore container runtime')) return 'Recovery waits until the container runtime can be reached.';
  return null;
};

/** When it last changed: the task list's relative wording, with the full date for a tooltip. */
export const updatedLabel = (updatedAt: number): { relative: string; absolute: string; iso: string } => {
  const date = new Date(updatedAt);
  const iso = date.toISOString();
  return { relative: formatRelativeTime(iso), absolute: formatDateTime(date), iso };
};
