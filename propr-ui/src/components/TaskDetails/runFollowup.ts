import type { Notification } from '@propr/shared';
import { isIssueFreeReviewRecap, notificationFollowupCommand, reviewRecapOutcome } from '../../pages/inboxUtils';
import { isReviewRun, type TaskRunEntry } from '../TaskList/rowModel';
import { getDisplayStatus } from '../TaskList/utils.tsx';

export interface RunFollowup {
  /** The run the commands are sent through. */
  taskId: string;
  prNumber: number;
  commands: string[];
}

/**
 * A review that found nothing has nothing to fix; its summary is read as the
 * Inbox reads the review's recap. Findings or a failed reviewer in the recap
 * outweigh a perfect score, which only decides when the recap says neither.
 */
const isCleanReview = (run: TaskRunEntry): boolean => {
  const recap = reviewRecapOutcome(run.summary);
  if (recap.reviewerFailed || recap.issueCount > 0 || recap.findings.length > 0) return false;
  return isIssueFreeReviewRecap(run.summary) || (run.task.score ?? 0) >= 10;
};

/** The task's newest run when it is `taskId`, finished and has a pull request; else null. */
function newestFinishedRun(runs: readonly TaskRunEntry[] | null | undefined, taskId: string | undefined) {
  const head = runs?.[runs.length - 1];
  if (!head || head.task.id !== taskId || getDisplayStatus(head.task) !== 'completed') return null;
  const prNumber = head.task.prNumber;
  return prNumber ? { head, prNumber } : null;
}

/**
 * The follow-up commands offered for a run, on the task's newest run
 * only: a review with findings offers /fix, a finished run with a pull request
 * offers /review and /ultrafix. An earlier run, one still working, a failed or
 * merged one, or a run the list has not read yet offers nothing, so a command
 * is never replayed against a run that newer work has already superseded.
 */
export function latestRunFollowup(runs: readonly TaskRunEntry[] | null | undefined, taskId: string | undefined): RunFollowup | null {
  const newest = newestFinishedRun(runs, taskId);
  if (!newest) return null;
  const { head, prNumber } = newest;
  if (!isReviewRun(head.type)) return { taskId: head.task.id, prNumber, commands: ['/review', '/ultrafix'] };
  return isCleanReview(head) ? null : { taskId: head.task.id, prNumber, commands: ['/fix'] };
}

/**
 * A notification's follow-up commands, offered only while the run it reports
 * on is still its task's newest and would offer them in Tasks too, so the
 * Inbox never replays a command against a run newer work has superseded.
 * The notification knows what it reports, so it names the commands rather
 * than the run's type read from its title; a review's run summary is still
 * read as Tasks reads it. Null until the task's runs are read.
 */
export function notificationRunFollowup(notification: Notification, runs: readonly TaskRunEntry[] | null): RunFollowup | null {
  const followup = notificationFollowupCommand(notification);
  const newest = followup ? newestFinishedRun(runs, followup.taskId) : null;
  if (!followup || !newest) return null;
  if (notification.target.type === 'review' && isCleanReview(newest.head)) return null;
  return { taskId: newest.head.task.id, prNumber: newest.prNumber, commands: [...followup.commands] };
}
