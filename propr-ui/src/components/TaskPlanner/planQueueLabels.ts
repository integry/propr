import type { PlanExecutionQueueBlockedKind, PlanExecutionQueueIssue, PlanIssueStatus } from '../../api/planIssuesApi';

/** How each reason kind that holds an issue of the execution queue reads in Planner Studio. */
export const BLOCKED_KIND_LABELS: Record<PlanExecutionQueueBlockedKind, string> = {
  closed_unmerged: 'Closed without merge',
  missing_from_plan: 'Missing from plan',
  dispatch_failed: 'Could not start',
  agent_blocked: 'Agent reported a blocker',
  awaiting_human_merge: 'Waiting for a human merge',
  label_handoff: 'Labels not released',
  setup_not_ready: 'Setup not finished',
};

/** The reason the server stores while a queued issue's model and branch labels are still being written. */
const SETUP_PENDING_REASON_PREFIX = 'Preparing queued issue';

export const issueList = (issues: number[]): string => issues.map(issue => `#${issue}`).join(', ');

export interface BlockedDescription {
  /** The one line a person reads first. */
  title: string;
  /** The server's own reason, shown below the title when it adds something. */
  detail: string | null;
  /** The queue is still working on it (setup in progress); nothing for a person to do yet. */
  inProgress?: boolean;
}

/**
 * What a blocked issue's notice says. The server reasons are written for operators and logs
 * (and some are matched by prefix), so the UI maps the ones a person cannot act on as written.
 * An unknown kind reads "Blocked" with the server reason below.
 */
export function describeBlocked(state: Pick<PlanExecutionQueueIssue, 'blockedKind' | 'blockedReason'>): BlockedDescription {
  const kind = state.blockedKind;
  const reason = state.blockedReason?.trim() || null;
  if (kind === 'setup_not_ready') {
    if (!reason || reason.startsWith(SETUP_PENDING_REASON_PREFIX)) return { title: 'Setting up the issue…', detail: null, inProgress: true };
    return { title: 'The first issue could not be set up. Open its task to see why.', detail: null };
  }
  if (kind === 'awaiting_human_merge') {
    const pr = reason?.match(/\bPR #(\d+)/)?.[1];
    return { title: `${pr ? `PR #${pr}` : 'The pull request'} must be merged by a person. The queue continues after that.`, detail: null };
  }
  const label = kind ? BLOCKED_KIND_LABELS[kind] : undefined;
  return { title: label ? `Blocked · ${label}` : 'Blocked', detail: reason };
}

/** How a pending issue stands in the plan's active execution queue, for its status pill. */
export type RowQueueStatus = 'queued' | 'skipped' | 'blocked';

/**
 * The queue status a row shows. A plan issue stays `pending` on the server while the queue
 * skips or holds it, so the queue state decides between Queued, Skipped and Blocked.
 */
export function getRowQueueStatus(status: PlanIssueStatus, queueState: PlanExecutionQueueIssue | undefined, queued: boolean): RowQueueStatus | null {
  if (status !== 'pending') return null;
  if (queueState?.state === 'skipped') return 'skipped';
  if (queueState?.state === 'blocked') return 'blocked';
  return queued ? 'queued' : null;
}

/** "Skip" alone, or "Skip (keep #12 waiting)" when graph dependents keep waiting on the skipped issue. */
export const skipLabel = (dependents: number[]): string =>
  dependents.length > 0 ? `Skip (keep ${issueList(dependents)} waiting)` : 'Skip';

/** "After #9" or "After #9, #10": the prerequisites an issue starts after. */
export const prerequisitesLabel = (dependsOn: number[]): string | null =>
  dependsOn.length > 0 ? `After ${issueList(dependsOn)}` : null;

export const pluralTasks = (count: number): string => `${count} ${count === 1 ? 'task' : 'tasks'}`;

/**
 * The hint once every remaining task is the queue's: "10 tasks queued. Each starts …", or with
 * held tasks "6 tasks: 4 queued, 1 blocked, 1 skipped. Each queued task starts …".
 */
export function describeQueueHint(queued: number, blocked: number, skipped: number): string {
  const parts = ([[queued, 'queued'], [blocked, 'blocked'], [skipped, 'skipped']] as const).filter(([count]) => count > 0);
  const total = queued + blocked + skipped;
  const counts = parts.length === 1
    ? `${pluralTasks(total)} ${parts[0][1]}.`
    : `${pluralTasks(total)}: ${parts.map(([count, label]) => `${count} ${label}`).join(', ')}.`;
  if (queued === 0) return counts;
  const subject = parts.length === 1 ? 'Each' : queued === 1 ? 'The queued task' : 'Each queued task';
  return `${counts} ${subject} starts automatically when the task ahead of it finishes.`;
}
