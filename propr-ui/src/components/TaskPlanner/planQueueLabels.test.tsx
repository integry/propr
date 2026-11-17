import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PlanExecutionQueueIssue, PlanIssue } from '../../api/planIssuesApi';
import { buildFooterStats } from './approvedPlanFooterStats';
import { PlanFooterStats } from './ApprovedPlanFooter';
import { StatusBadge } from './PlanIssueRowComponents';
import { describeBlocked, describeQueueHint, getRowQueueStatus, prerequisitesLabel, skipLabel } from './planQueueLabels';

const queueState = (overrides: Partial<PlanExecutionQueueIssue>): PlanExecutionQueueIssue => ({
  issue: 9, state: 'pending', blockedKind: null, blockedReason: null, ...overrides,
});
const issue = (issue_number: number, status: PlanIssue['status']) => ({ issue_number, status }) as PlanIssue;

describe('the queue status of a plan issue row', () => {
  it('reads Skipped for an issue the queue skipped, not Queued', () => {
    expect(getRowQueueStatus('pending', queueState({ state: 'skipped', schedule: 'skipped' }), true)).toBe('skipped');
    expect(getRowQueueStatus('pending', queueState({ state: 'blocked' }), true)).toBe('blocked');
    expect(getRowQueueStatus('pending', queueState({ state: 'pending' }), true)).toBe('queued');
    expect(getRowQueueStatus('pending', undefined, false)).toBeNull();
    // Only a pending issue takes its pill from the queue; running and merged rows keep their own.
    expect(getRowQueueStatus('under_review', queueState({ state: 'skipped' }), true)).toBeNull();
  });

  it('renders a Skipped pill', () => {
    render(<StatusBadge status="pending" queued queueStatus="skipped" />);
    expect(screen.getByTestId('plan-issue-status')).toHaveTextContent(/^Skipped$/);
  });
});

describe('queue labels', () => {
  it('names the prerequisites and the dependents a skip keeps waiting', () => {
    expect(prerequisitesLabel([])).toBeNull();
    expect(prerequisitesLabel([9])).toBe('After #9');
    expect(prerequisitesLabel([9, 10])).toBe('After #9, #10');
    expect(skipLabel([])).toBe('Skip');
    expect(skipLabel([12])).toBe('Skip (keep #12 waiting)');
  });

  it('keeps the server reason below a known blocker label', () => {
    expect(describeBlocked({ blockedKind: 'closed_unmerged', blockedReason: 'Issue #2 is closed.' }))
      .toEqual({ title: 'Blocked · Closed without merge', detail: 'Issue #2 is closed.' });
    expect(describeBlocked({ blockedKind: 'awaiting_human_merge', blockedReason: null }).title)
      .toBe('The pull request must be merged by a person. The queue continues after that.');
  });
});

describe('plan issue counts', () => {
  // The example plan: 14 merged, 1 in review, 4 queued and 1 skipped (the Plans list reads "1 in review • 5 pending • 14 merged").
  const issues = [
    ...Array.from({ length: 14 }, (_, index) => issue(index + 1, 'merged')),
    issue(15, 'under_review'),
    ...[16, 17, 18, 19, 20].map(number => issue(number, 'pending')),
  ];
  const queueStatusOf = (planIssue: PlanIssue) => (planIssue.status !== 'pending' ? null : planIssue.issue_number === 17 ? 'skipped' : 'queued');

  it('counts queued, skipped, in review, running and merged separately, adding up to the Plans list', () => {
    const stats = buildFooterStats(issues, queueStatusOf);
    expect(stats).toEqual({ total: 20, merged: 14, underReview: 1, processing: 0, queued: 4, blocked: 0, skipped: 1, pending: 0, closed: 0 });
    expect(stats.queued + stats.blocked + stats.skipped + stats.pending).toBe(5);
  });

  it('counts a follow-up in refinement as running, like the Plans list', () => {
    expect(buildFooterStats([issue(1, 'in_refinement'), issue(2, 'refinement_processing'), issue(3, 'processing')]).processing).toBe(3);
  });

  it('shows the in-review and skipped issues in the footer', () => {
    render(<PlanFooterStats stats={buildFooterStats(issues, queueStatusOf)} onRefresh={() => undefined} />);
    expect(screen.getByTestId('plan-footer-stats')).toHaveTextContent('20 Issues·1 In Review·4 Queued·1 Skipped·14 Merged');
  });

  it('summarises held tasks next to the queued ones', () => {
    expect(describeQueueHint(10, 0, 0)).toBe('10 tasks queued. Each starts automatically when the task ahead of it finishes.');
    expect(describeQueueHint(4, 0, 1)).toBe('5 tasks: 4 queued, 1 skipped. Each queued task starts automatically when the task ahead of it finishes.');
    expect(describeQueueHint(0, 1, 1)).toBe('2 tasks: 1 blocked, 1 skipped.');
    expect(describeQueueHint(0, 0, 1)).toBe('1 task skipped.');
  });
});
