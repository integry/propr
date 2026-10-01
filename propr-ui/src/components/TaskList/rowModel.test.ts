import { describe, expect, it } from 'vitest';
import { buildTaskRow, sanitizeTaskTitle } from './rowModel';
import type { Task, TaskGroup } from './types';

const base: Task = { id: 'task-1', status: 'completed', createdAt: '2026-09-15T10:00:00Z' };
const group = (tasks: Array<Partial<Task>>): TaskGroup => ({
  key: 'integry/propr-pr-2664', repoOwner: 'integry', repoName: 'propr', prNumber: 2664,
  tasks: tasks.map((task, index) => ({ ...base, id: `task-${index}`, ...task })),
});
const image = (index: number) => ({ type: 'image', title: `Preview ${index}`, url: `https://github.com/user-attachments/assets/${index}` });

describe('sanitizeTaskTitle', () => {
  it('drops the workflow prefix, the repeated PR number and the model tag', () => {
    expect(sanitizeTaskTitle('Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when an issue or PR withdraws intent'))
      .toEqual({ type: 'Ultrafix', title: 'Stop work when an issue or PR withdraws intent' });
    expect(sanitizeTaskTitle('Followup: [870 by Claude Opus 4.6] Update checkout'))
      .toEqual({ type: 'Follow-up', title: 'Update checkout' });
    expect(sanitizeTaskTitle('New Issue: Add retries')).toEqual({ type: 'Implement', title: 'Add retries' });
  });

  it('removes bare entity prefixes and model tags that are not at the start', () => {
    expect(sanitizeTaskTitle('PR #2664: Stop work').title).toBe('Stop work');
    expect(sanitizeTaskTitle('Stop work [2659 by GPT-6 Astra] on withdrawal').title).toBe('Stop work on withdrawal');
  });

  it('keeps ordinary bracketed titles', () => {
    expect(sanitizeTaskTitle('[Search by filename] Add fuzzy matching').title).toBe('[Search by filename] Add fuzzy matching');
  });
});

describe('buildTaskRow', () => {
  it('rolls every earlier run into one row named after the entity', () => {
    const row = buildTaskRow(group([
      { title: 'Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when intent is withdrawn', subtitle: 'Ultrafix cycle 3 (linting)' },
      { title: 'Followup: Update 3', subtitle: 'Update' },
      { title: 'Fix PR #2664: [2659 by GPT-6 Astra] Stop work when intent is withdrawn', subtitle: 'Restrict withdrawal labels' },
      { title: 'Review PR #2664: [2659 by GPT-6 Astra] Stop work when intent is withdrawn', subtitle: null, critiqueScore: 9 },
    ]));
    expect(row.title).toBe('Stop work when intent is withdrawn');
    expect(row.type).toBe('Ultrafix');
    expect(row.detail).toBe('Ultrafix cycle 3 (linting)');
    expect(row.earlierRuns.map(run => [run.type, run.delta])).toEqual([
      ['Follow-up', 'Follow-up run'],
      ['Fix', 'Restrict withdrawal labels'],
      ['Review', 'Review run'],
    ]);
  });

  it('never names a row with a meaningless title', () => {
    const row = buildTaskRow(group([
      { title: 'Followup: Update 3', subtitle: 'Tighten the null check' },
      { title: 'New Issue: Add retries', subtitle: 'Preparing a PR for issue #12' },
    ]));
    expect(row.title).toBe('Add retries');
    expect(row.detail).toBe('Tighten the null check');
    expect(row.earlierRuns[0].delta).toBe('Implement run');
  });

  it('counts only trusted previews', () => {
    const row = buildTaskRow(group([{ title: 'Fix PR #1: A', previewMedia: [image(1), image(2), { type: 'image', url: 'javascript:alert(1)', title: 'x' }] as Task['previewMedia'] }]));
    expect(row.previewCount).toBe(2);
  });
});
