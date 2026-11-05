import { PlanIssue } from '../../api/planIssuesApi';
import type { IssueCreationProgress } from './planIssuesManagerUtils';

export interface FooterStats {
  total: number;
  merged: number;
  underReview: number;
  pending: number;
  processing: number;
}

export function buildFooterStats(issues: PlanIssue[]): FooterStats {
  const underReviewStatuses = new Set(['under_review', 'in_refinement', 'pr_open', 'pr_review']);
  return {
    total: issues.length,
    merged: issues.filter(i => i.status === 'merged').length,
    underReview: issues.filter(i => underReviewStatuses.has(i.status as string)).length,
    pending: issues.filter(i => i.status === 'pending').length,
    processing: issues.filter(i => i.status === 'processing' || i.status === 'refinement_processing').length,
  };
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
