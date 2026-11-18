import { describe, expect, it } from 'vitest';
import { AUTOMATION_REPORT_MODE, appliedExtensions, hasFollowupTarget, isAutomationReportTask, resolvedNoExtensions, taskLabelMode } from './taskKind';

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

describe('resolvedNoExtensions', () => {
  const event = (extra: Record<string, unknown> = {}) => ({ event: 'extensions.resolved', servers: [], skills: [], skipped: [], omitted: [], ...extra });

  it('hides only an entry that applied nothing and explains nothing', () => {
    expect(resolvedNoExtensions(event())).toBe(true);
    expect(resolvedNoExtensions({ event: 'network.egress' })).toBe(false);
  });

  it.each([
    ['omitted items', { omitted: [{ kind: 'server', name: 'github', reason: 'not_allowed' }] }],
    ['skipped items', { skipped: [{ kind: 'skill', name: 'review', reason: 'disabled' }] }],
    ['an opt-out label', { labelOptOut: { labels: ['no-mcp'], removed: { servers: ['github'], skills: [] } } }],
    ['skipped auto-apply', { autoApplySkipped: { reason: 'codex_workspace_config', message: 'refused' } }],
  ])('keeps an entry with %s', (_name, extra) => {
    expect(resolvedNoExtensions(event(extra))).toBe(false);
    expect(appliedExtensions(event(extra))).toBe(false);
  });

  it('counts servers or skills as applied', () => {
    expect(appliedExtensions(event({ servers: ['github'] }))).toBe(true);
    expect(appliedExtensions(event({ skills: [{ id: 's', name: 'review' }] }))).toBe(true);
  });
});
