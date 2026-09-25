import { describe, expect, it } from 'vitest';
import { splitWorkTitle } from './workTitle';

describe('splitWorkTitle', () => {
  it('moves a PR workflow verb into the type and drops the PR number', () => {
    expect(splitWorkTitle('Fix PR #2494: [Epic] MCP Operator Surface', 'pr-comment'))
      .toEqual({ type: 'Fix', title: '[Epic] MCP Operator Surface' });
    expect(splitWorkTitle('Review PR #7: Add retries', null)).toEqual({ type: 'Review', title: 'Add retries' });
    expect(splitWorkTitle('Follow-up PR #499: Update lesson', null)).toEqual({ type: 'Follow-up', title: 'Update lesson' });
  });

  it('drops the model tag along with the legacy prefixes', () => {
    expect(splitWorkTitle('Followup: [Fix by Claude Opus 4.6] Implement Feature Gating', 'issue'))
      .toEqual({ type: 'Follow-up', title: 'Implement Feature Gating' });
    expect(splitWorkTitle('New Issue: Add retries', 'issue')).toEqual({ type: 'Implement', title: 'Add retries' });
    expect(splitWorkTitle('[870 by Claude Opus] Update checkout', 'issue')).toEqual({ type: 'Implement', title: 'Update checkout' });
    expect(splitWorkTitle('Continue #12: Finish the migration', null)).toEqual({ type: 'Continue', title: 'Finish the migration' });
  });

  it('keeps ordinary bracketed text that is not a generated model tag', () => {
    expect(splitWorkTitle('New Issue: [Search by filename]', 'issue')).toEqual({ type: 'Implement', title: '[Search by filename]' });
    expect(splitWorkTitle('[Sort by date] Newest first', null)).toEqual({ type: null, title: '[Sort by date] Newest first' });
    expect(splitWorkTitle('Fix PR #12: [Group by repo] Dashboard', null)).toEqual({ type: 'Fix', title: '[Group by repo] Dashboard' });
    expect(splitWorkTitle('[Goal by GPT-5] Ship the dashboard', 'goal')).toEqual({ type: 'Goal', title: 'Ship the dashboard' });
  });

  it('falls back to the recorded task type and leaves a plain title alone', () => {
    expect(splitWorkTitle('Cache repository icons', 'pr-comment')).toEqual({ type: 'PR comment', title: 'Cache repository icons' });
    expect(splitWorkTitle('Cache repository icons', 'data_import')).toEqual({ type: 'Data import', title: 'Cache repository icons' });
    expect(splitWorkTitle('Cache repository icons', null)).toEqual({ type: null, title: 'Cache repository icons' });
  });

  it('returns no title when nothing is left once the prefix is gone', () => {
    expect(splitWorkTitle('Auto-followup for PR #88', null)).toEqual({ type: 'Follow-up', title: null });
    expect(splitWorkTitle(null, 'issue')).toEqual({ type: 'Implement', title: null });
  });
});
