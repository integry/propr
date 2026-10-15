import { describe, expect, it } from 'vitest';
import { AUTOMATION_REPORT_MODE, hasFollowupTarget, isAutomationReportTask, taskLabelMode } from './taskKind';

describe('task kind', () => {
  it('labels an automation report by its kind and every other task by its command mode', () => {
    expect(taskLabelMode({ taskKind: 'automation-report' })).toBe(AUTOMATION_REPORT_MODE);
    expect(taskLabelMode({ taskKind: 'automation-action' })).toBeUndefined();
    expect(taskLabelMode({ commandMode: 'review' })).toBe('review');
    expect(isAutomationReportTask(null)).toBe(false);
  });

  it('finds a follow-up target only on a real issue or pull request', () => {
    const repo = { repoOwner: 'integry', repoName: 'propr' };
    expect(hasFollowupTarget({ ...repo, number: 42 })).toBe(true);
    expect(hasFollowupTarget({ ...repo, number: 0 }, { number: 7 })).toBe(true);
    expect(hasFollowupTarget({ ...repo, number: 0 })).toBe(false);
    expect(hasFollowupTarget({ repoOwner: '', repoName: '', number: 0 })).toBe(false);
    expect(hasFollowupTarget({ ...repo, number: -1 })).toBe(false);
    expect(hasFollowupTarget({ ...repo, number: 1.5 })).toBe(false);
    expect(hasFollowupTarget(null)).toBe(false);
  });
});
