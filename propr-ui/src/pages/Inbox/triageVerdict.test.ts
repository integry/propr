import { describe, expect, test } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import type { FileChange } from '../../api/fileChangesApi';
import { notificationFindingReference } from '../inboxUtils';
import {
  MAX_TRIAGE_DIFF_FILES,
  MAX_TRIAGE_DIFF_LINES,
  reviewedRunId,
  reviewFindings,
  triageTaskId,
  trimDiffForTriage,
} from './triageVerdict';

function item(overrides: Record<string, unknown>): Notification {
  return notificationSchema.parse({
    id: 'event-1',
    deduplicationKey: 'event-1-key',
    kind: 'review',
    severity: 'success',
    target: { type: 'review', repository: 'integry/propr', prNumber: 3057, taskId: 'review-3057' },
    title: 'Draft validation',
    body: '',
    occurredAt: '2026-10-13T10:00:00.000Z',
    createdAt: '2026-10-13T10:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    actions: ['follow_up', 'dismiss'],
    ...overrides,
  });
}

const review = (body: string) => item({ body });

describe('reviewFindings', () => {
  test('enumerates findings with the path:line each one leads with', () => {
    expect(reviewFindings(review(
      'Score 6/10 · 2 issues found: packages/cli/test/model.test.ts:42 Uncaught layout expectation; '
      + '`packages/core/src/auth.ts:118`: Clear expiry feedback after successful auth handoff',
    ))).toEqual({
      score: 6,
      issueCount: 2,
      findings: [
        { index: 1, reference: 'packages/cli/test/model.test.ts:42', text: 'Uncaught layout expectation' },
        { index: 2, reference: 'packages/core/src/auth.ts:118', text: 'Clear expiry feedback after successful auth handoff' },
      ],
    });
  });

  test('takes the lowest score across reviewers and stops at the next recap part', () => {
    expect(reviewFindings(review('Scores 8/10, 5/10 · 3 issues found: Retries never back off; src/a.ts:7 - Ids reused · 1 reviewer failed')))
      .toEqual({
        score: 5,
        issueCount: 3,
        findings: [
          { index: 1, reference: null, text: 'Retries never back off' },
          { index: 2, reference: 'src/a.ts:7', text: 'Ids reused' },
        ],
      });
  });

  test('keeps the recap issue count when it lists fewer titles, and never reports fewer than it lists', () => {
    const truncated = reviewFindings(review('Score 3/10 · 4 issues found: Retries never back off; Delivery ids are reused'));
    expect(truncated.issueCount).toBe(4);
    expect(truncated.findings.map(finding => finding.text)).toEqual(['Retries never back off', 'Delivery ids are reused']);
    expect(reviewFindings(review('Score 5/10 · 1 issue found: A; B')).issueCount).toBe(2);
  });

  test('has no findings for a clean review or a notification that is not a review', () => {
    expect(reviewFindings(review('Score 9/10 · 0 issues found'))).toEqual({ score: 9, issueCount: 0, findings: [] });
    expect(reviewFindings(item({ kind: 'task', severity: 'error', target: { type: 'task', repository: 'integry/propr', taskId: 't' }, body: 'Failed' })))
      .toEqual({ score: null, issueCount: 0, findings: [] });
  });

  test('leaves prose that only looks like a reference alone', () => {
    expect(notificationFindingReference('Note: retries never back off')).toBeNull();
    expect(notificationFindingReference('Ratio 3:2 is wrong')).toBeNull();
    expect(notificationFindingReference('README.md:3 Typo')).toEqual({ reference: 'README.md:3', text: 'Typo' });
    expect(notificationFindingReference('src/a.ts:10-12 — Guard empty page')).toEqual({ reference: 'src/a.ts:10-12', text: 'Guard empty page' });
  });
});

describe('triageTaskId', () => {
  test('resolves the task behind each kind of notification', () => {
    expect(triageTaskId(review('Score 6/10'))).toBe('review-3057');
    expect(triageTaskId(item({ kind: 'task', severity: 'error', target: { type: 'task', repository: 'integry/propr', taskId: 'task-1' } })))
      .toBe('task-1');
    expect(triageTaskId(item({
      kind: 'pull_request', severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 3063 },
      metadata: { completedImplementationTaskId: 'impl-3063' },
    }))).toBe('impl-3063');
  });

  test('is null when no task backs the notification', () => {
    expect(triageTaskId(item({ target: { type: 'review', repository: 'integry/propr', prNumber: 3057 } }))).toBeNull();
    expect(triageTaskId(item({
      kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: 'integry/propr', prNumber: 3063 },
    }))).toBeNull();
    expect(triageTaskId(item({
      kind: 'plan', target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-1' },
    }))).toBeNull();
  });
});

describe('trimDiffForTriage', () => {
  const file = (path: string, changed: number): FileChange => ({
    path, linesAdded: changed, linesRemoved: 0, status: 'modified',
    diff: [`--- a/${path}`, `+++ b/${path}`, '@@ -1,3 +1,3 @@', ' context', ...Array.from({ length: changed }, (_, i) => (i % 2 ? `-old ${i}` : `+new ${i}`))].join('\n'),
  });

  test('keeps only changed lines, without the file headers', () => {
    expect(trimDiffForTriage([file('src/a.ts', 2)])).toEqual({
      files: [{ path: 'src/a.ts', lines: [{ kind: 'added', text: 'new 0' }, { kind: 'removed', text: 'old 1' }], hiddenLines: 0 }],
      hiddenFiles: 0,
    });
  });

  test('strips headers by position, so a removed line that starts with -- is still a change', () => {
    const diff: FileChange = {
      path: 'schema.sql', linesAdded: 1, linesRemoved: 2, status: 'modified',
      diff: ['diff --git a/schema.sql b/schema.sql', 'index 1..2 100644', '--- a/schema.sql', '+++ b/schema.sql',
        '@@ -1,2 +1 @@', '--- legacy column', '-ALTER TABLE t DROP c;', '+++counter;', '@@ -9 +8 @@', ' unchanged'].join('\n'),
    };
    expect(trimDiffForTriage([diff]).files[0].lines).toEqual([
      { kind: 'removed', text: '-- legacy column' },
      { kind: 'removed', text: 'ALTER TABLE t DROP c;' },
      { kind: 'added', text: '++counter;' },
    ]);
    // Without a hunk header only the leading header lines are dropped.
    expect(trimDiffForTriage([{ ...diff, diff: '--- a/x\n+++ b/x\n--- removed\n+added' }]).files[0].lines).toEqual([
      { kind: 'removed', text: '-- removed' },
      { kind: 'added', text: 'added' },
    ]);
  });

  test('bounds the diff to the first files and changed lines', () => {
    const trimmed = trimDiffForTriage([file('a.ts', 30), file('empty.ts', 0), file('b.ts', 3), file('c.ts', 4)]);
    expect(trimmed.files.map(entry => entry.path)).toEqual(['a.ts', 'b.ts']);
    expect(trimmed.files).toHaveLength(MAX_TRIAGE_DIFF_FILES);
    expect(trimmed.files[0].lines).toHaveLength(MAX_TRIAGE_DIFF_LINES);
    expect(trimmed.files[0].hiddenLines).toBe(30 - MAX_TRIAGE_DIFF_LINES);
    expect(trimmed.hiddenFiles).toBe(1);
  });
});

describe('reviewedRunId', () => {
  test('is the newest earlier run that pushed a commit', () => {
    const runs = [
      { id: 'review-2', commitHash: null },
      { id: 'fix-2', commitHash: 'bbb' },
      { id: 'review-1', commitHash: null },
      { id: 'implementation', commitHash: 'aaa' },
    ];
    expect(reviewedRunId(runs, 'review-2')).toBe('fix-2');
    expect(reviewedRunId(runs, 'review-1')).toBe('implementation');
    expect(reviewedRunId(runs, 'implementation')).toBeNull();
    expect(reviewedRunId(runs, 'unknown')).toBeNull();
  });
});
