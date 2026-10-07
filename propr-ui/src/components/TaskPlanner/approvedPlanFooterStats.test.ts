import { describe, expect, it } from 'vitest';
import { buildCreationFooterStats } from './approvedPlanFooterStats';
import { IDLE_PROGRESS, withCreatedIssues, type IssueCreationProgress } from './planIssuesManagerUtils';

const progress = (createdCount: number, failedCount = 0, number?: number): IssueCreationProgress => ({
  status: 'in_progress', createdCount, totalCount: 17, failedCount,
  lastCreatedIssue: number ? { number, url: `https://github.com/o/r/issues/${number}`, title: `Task ${number}` } : undefined,
});

describe('buildCreationFooterStats', () => {
  it('matches the progress bar: created of total, one creating, the rest queued', () => {
    expect(buildCreationFooterStats(progress(6), 17)).toEqual({ created: 6, total: 17, creating: 1, queued: 10, failed: 0 });
  });

  it('counts failures and stops creating once every task is settled', () => {
    expect(buildCreationFooterStats(progress(15, 2), 17)).toEqual({ created: 15, total: 17, creating: 0, queued: 0, failed: 2 });
  });

  it('falls back to the plan size before the first event reports a total', () => {
    expect(buildCreationFooterStats({ ...IDLE_PROGRESS, status: 'in_progress' }, 4)).toEqual({ created: 0, total: 4, creating: 1, queued: 3, failed: 0 });
  });
});

describe('withCreatedIssues', () => {
  it('keeps every issue created in the run, not just the latest', () => {
    let state = IDLE_PROGRESS;
    for (const [count, number] of [[1, 2900], [2, 2901], [2, 2901], [3, 2902]]) state = withCreatedIssues(progress(count, 0, number), state);
    expect(state.createdIssues?.map(issue => issue.number)).toEqual([2900, 2901, 2902]);
  });

  it('starts over when a fresh run reports zero created issues', () => {
    const earlier = withCreatedIssues(progress(1, 0, 2900), IDLE_PROGRESS);
    expect(withCreatedIssues(progress(0), earlier).createdIssues).toEqual([]);
  });
});
