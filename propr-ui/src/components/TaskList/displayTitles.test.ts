import { describe, expect, it } from 'vitest';
import { getTaskTypeInfo, getChildDisplayTitle, getParentDisplayTitle } from './utils.tsx';
import type { Task } from './types';

const base: Task = { id: 'task-1', status: 'completed', createdAt: '2026-09-15T10:00:00Z' };
const prTitle = 'Fix PR #2393: Fix follow-up implementations for fork PRs';

describe('getTaskTypeInfo', () => {
  it('recognises backend PR workflow titles and exposes the verb', () => {
    expect(getTaskTypeInfo({ ...base, title: prTitle })).toEqual({
      type: 'pr-workflow', cleanTitle: prTitle, workflowLabel: 'Fix', workflowPrNumber: 2393,
    });
    expect(getTaskTypeInfo({ ...base, title: 'Follow-up PR #499: Update Lesson 1.4' }).workflowLabel).toBe('Follow-up');
    expect(getTaskTypeInfo({ ...base, title: 'Review PR #7: Untitled pull request' }).workflowLabel).toBe('Review');
  });

  it('keeps legacy prefixes unchanged', () => {
    expect(getTaskTypeInfo({ ...base, title: 'Followup: Update 3' })).toEqual({ type: 'followup', cleanTitle: 'Update 3' });
    expect(getTaskTypeInfo({ ...base, title: 'New Issue: Add retries' })).toEqual({ type: 'new-issue', cleanTitle: 'Add retries' });
  });
});

describe('display titles', () => {
  it('parent rows keep the pull request entity title', () => {
    expect(getParentDisplayTitle({ ...base, title: prTitle, subtitle: 'Update permissions check in handler.ts' })).toBe(prTitle);
  });

  it('child rows show the execution summary instead of repeating the PR title', () => {
    expect(getChildDisplayTitle({ ...base, title: prTitle, subtitle: 'Update permissions check in handler.ts' }))
      .toBe('Update permissions check in handler.ts');
  });

  it('child rows fall back to the workflow verb when no summary exists', () => {
    expect(getChildDisplayTitle({ ...base, title: prTitle, subtitle: null })).toBe('Fix requested');
    expect(getChildDisplayTitle({ ...base, title: prTitle, subtitle: prTitle })).toBe('Fix requested');
  });

  it('issue children keep their issue title because the subtitle is a placeholder', () => {
    expect(getChildDisplayTitle({ ...base, title: 'New Issue: Add retries', subtitle: 'Preparing a PR for issue #12' })).toBe('Add retries');
  });

  it('legacy followups prefer the subtitle and otherwise the cleaned title', () => {
    expect(getChildDisplayTitle({ ...base, title: 'Followup: Update 3', subtitle: 'Tighten the null check' })).toBe('Tighten the null check');
    expect(getChildDisplayTitle({ ...base, title: 'Followup: Update 3' })).toBe('Update 3');
  });
});
