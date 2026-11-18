import { PlanIssue } from '../../api/planIssuesApi';
import type { IssueCreationProgress } from './planIssuesManagerUtils';
import type { RowQueueStatus } from './planQueueLabels';

/**
 * How the plan's issues stand, each issue counted once. Running, in review, merged and closed follow
 * the Plans list (the server's issue summary); its "pending" is split here by the execution queue into
 * queued, blocked, skipped and plain pending, so the two views always add up to the same totals.
 */
export interface FooterStats {
  total: number;
  merged: number;
  underReview: number;
  processing: number;
  queued: number;
  blocked: number;
  skipped: number;
  /** Pending issues the execution queue does not hold. */
  pending: number;
  closed: number;
}

/** Same buckets as the server's issue summary: a follow-up in refinement counts as running. */
const RUNNING_STATUSES = new Set<string>(['processing', 'in_refinement', 'refinement_processing']);

export function buildFooterStats(issues: PlanIssue[], queueStatusOf: (issue: PlanIssue) => RowQueueStatus | null = () => null): FooterStats {
  const stats: FooterStats = { total: issues.length, merged: 0, underReview: 0, processing: 0, queued: 0, blocked: 0, skipped: 0, pending: 0, closed: 0 };
  for (const issue of issues) {
    if (issue.status === 'merged') stats.merged++;
    else if (issue.status === 'closed') stats.closed++;
    else if (issue.status === 'under_review') stats.underReview++;
    else if (RUNNING_STATUSES.has(issue.status)) stats.processing++;
    else if (issue.status === 'pending') stats[queueStatusOf(issue) ?? 'pending']++;
  }
  return stats;
}

export interface CreationFooterStats {
  created: number;
  total: number;
  creating: number;
  queued: number;
  failed: number;
}

/** Counts for the footer while issues are being written to GitHub, matching the progress bar and rows. */
export function buildCreationFooterStats(progress: IssueCreationProgress, taskCount: number): CreationFooterStats {
  const total = progress.totalCount || taskCount;
  const created = progress.createdCount;
  const failed = progress.failedCount;
  const remaining = Math.max(0, total - created - failed);
  const creating = remaining > 0 ? 1 : 0;
  return { created, total, creating, queued: remaining - creating, failed };
}
