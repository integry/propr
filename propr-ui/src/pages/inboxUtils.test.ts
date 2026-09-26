import { describe, expect, test } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import {
  isSystemNotification,
  mergeNotifications,
  notificationDisplayTitle,
  notificationHref,
  notificationKindLabel,
  notificationPullRequestUrl,
  notificationReference,
  notificationReviewOutcome,
  notificationStatus,
  repositoryParts,
} from './inboxUtils';

function item(overrides: Record<string, unknown>): Notification {
  return notificationSchema.parse({
    id: 'event-1',
    deduplicationKey: 'event-1-key',
    kind: 'task',
    severity: 'error',
    target: { type: 'task', repository: 'integry/propr', taskId: 'task-1' },
    title: 'Task failed',
    body: 'Work did not complete.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    ...overrides,
  });
}

describe('Inbox notification presentation', () => {
  test('covers every event kind with a visible label and keeps only system updates apart', () => {
    const notifications = [
      item({ kind: 'plan', target: { type: 'plan', repository: 'i/p', draftId: 'd1' } }),
      item({ id: 'task-ok', severity: 'success' }),
      item({ id: 'review', kind: 'review', severity: 'success', target: { type: 'review', repository: 'i/p', prNumber: 2 } }),
      item({ id: 'pr', kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: 'i/p', prNumber: 2 } }),
      item({ id: 'index', kind: 'indexing', target: { type: 'indexing', repository: 'i/p' } }),
      item({ id: 'system', kind: 'system_failure', target: { type: 'system_failure', component: 'redis' } }),
    ];

    expect(notifications.map(notificationKindLabel)).toEqual([
      'Plan ready',
      'Implementation completed',
      'Review completed',
      'PR ready',
      'Indexing failed',
      'System failure',
    ]);
    expect(notifications.map(isSystemNotification)).toEqual([false, false, false, false, true, true]);
  });

  test('keeps colour for what needs a human and quiets finished runs', () => {
    const colour = (overrides: Record<string, unknown>) => notificationStatus(item(overrides)).className;
    expect(colour({
      kind: 'system_failure', severity: 'error', target: { type: 'system_failure', component: 'redis' },
    })).toBe('bg-red-500');
    expect(colour({ severity: 'warning' })).toBe('bg-amber-500');
    expect(colour({ severity: 'success' })).toBe('bg-slate-400');
    expect(colour({ kind: 'plan', severity: 'info', target: { type: 'plan', repository: 'i/p', draftId: 'd1' } }))
      .toBe('bg-teal-500');
    const pullRequest = { kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: 'i/p', prNumber: 2 } };
    expect(colour(pullRequest)).toBe('bg-teal-500');
    expect(colour({ ...pullRequest, metadata: { completionType: 'merge' } })).toBe('bg-slate-400');
    expect(colour({ ...pullRequest, metadata: { completionType: 'fix' } })).toBe('bg-slate-400');
  });

  test('drops the PR or issue number from generated titles because the chip already shows it', () => {
    const pullRequest = { kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: 'i/p', prNumber: 2498 } };
    const title = (overrides: Record<string, unknown>) => notificationDisplayTitle(item(overrides));
    expect(title({ ...pullRequest, title: 'PR #2498 ready for review' })).toBe('Ready for review');
    expect(title({ ...pullRequest, title: 'Fix run completed for PR #2498' })).toBe('Fix run completed');
    expect(title({ target: { type: 'task', repository: 'i/p', taskId: 't', issueNumber: 12 }, title: 'Issue #12 implementation completed' }))
      .toBe('Implementation completed');
    expect(title({ ...pullRequest, title: 'Guard Inbox recaps against empty metadata' }))
      .toBe('Guard Inbox recaps against empty metadata');
    // Another PR's number is real content, and titles without a chip keep their number.
    expect(title({ ...pullRequest, title: 'Follow-up to PR #2400' })).toBe('Follow-up to PR #2400');
    expect(title({ title: 'PR #2498 ready for review' })).toBe('PR #2498 ready for review');
    expect(title({ ...pullRequest, title: 'PR #2498' })).toBe('PR #2498');
  });

  test('splits the repository owner off so phones can show just the name', () => {
    expect(repositoryParts('integry/propr')).toEqual({ owner: 'integry/', name: 'propr' });
    expect(repositoryParts('System · redis')).toEqual({ owner: '', name: 'System · redis' });
  });

  test('marks reviews by score and findings instead of calling every review green', () => {
    const review = (body: string) => item({
      kind: 'review', severity: 'success', body, target: { type: 'review', repository: 'i/p', prNumber: 81 },
    });
    const status = (body: string) => {
      const { shape, className, label } = notificationStatus(review(body));
      return { shape, className, label };
    };
    expect(notificationReviewOutcome(review('Scores 6/10, 8/10 · 3 issues found: A; B · 1 reviewer failed')))
      .toEqual({ score: 6, issueCount: 3, reviewerFailed: true });
    expect(status('Score 6/10 · 2 issues found: Check the head')).toEqual({
      shape: 'square', className: 'bg-amber-500', label: 'Score 6/10 · 2 issues',
    });
    expect(status('Score 3/10 · 4 issues found')).toMatchObject({ shape: 'triangle', className: 'bg-red-500' });
    expect(status('Score 8/10 · 1 issue found: Guard metadata')).toMatchObject({ className: 'bg-amber-500' });
    expect(status('Score 8/10 · 0 issues found')).toMatchObject({ shape: 'diamond', className: 'bg-slate-500' });
    expect(status('Score 10/10 · 0 issues found')).toMatchObject({ shape: 'circle', className: 'bg-teal-500' });
    expect(status('Review of PR #81 completed; open details for the full findings.'))
      .toMatchObject({ className: 'bg-slate-400' });
  });

  test('keeps the PR or issue number visible as a reference chip', () => {
    expect(notificationReference(item({
      kind: 'review', severity: 'success', target: { type: 'review', repository: 'i/p', prNumber: 81 },
    }))).toEqual({ label: 'PR #81', title: 'Pull request #81' });
    expect(notificationReference(item({
      target: { type: 'task', repository: 'i/p', taskId: 't', issueNumber: 12, prNumber: 42 },
    }))).toEqual({ label: 'PR #42', title: 'Pull request #42' });
    expect(notificationReference(item({
      target: { type: 'task', repository: 'i/p', taskId: 't', issueNumber: 12 },
    }))).toEqual({ label: 'Issue #12', title: 'Issue #12' });
    expect(notificationReference(item({
      kind: 'plan', target: { type: 'plan', repository: 'i/p', draftId: 'd1' },
    }))).toBeNull();
  });

  test('labels completed pull-request follow-ups by their persisted outcome type', () => {
    const pullRequest = {
      kind: 'pull_request', severity: 'info',
      target: { type: 'pull_request', repository: 'i/p', prNumber: 2 },
    };
    expect(notificationKindLabel(item({ ...pullRequest, metadata: { completionType: 'fix' } })))
      .toBe('Fix completed');
    expect(notificationKindLabel(item({ ...pullRequest, metadata: { completionType: 'merge' } })))
      .toBe('Merge completed');
  });

  test('prefers server actions and derives stable fallback destinations', () => {
    expect(notificationHref(item({ action: { type: 'navigate', label: 'Open', href: '/plans' } }))).toBe('/plans');
    expect(notificationHref(item({}))).toBe('/tasks/task-1');
    expect(notificationHref(item({
      kind: 'indexing',
      target: { type: 'indexing', repository: 'integry/propr', branch: 'release/2026' },
    }))).toBe('/summaries/integry/propr?branch=release%2F2026');
    expect(notificationHref(item({
      kind: 'indexing',
      target: { type: 'indexing', repository: 'integry/propr' },
      action: { type: 'navigate', label: 'Browse', href: '/summaries/integry/propr?branch=feature%2Fui' },
    }))).toBe('/summaries/integry/propr?branch=feature%2Fui');
  });

  test('carries the indexing branch into branchless Browse actions', () => {
    expect(notificationHref(item({
      kind: 'indexing',
      target: { type: 'indexing', repository: 'integry/propr', branch: 'release/2026' },
      action: { type: 'navigate', label: 'Browse', href: '/summaries/integry/propr' },
    }))).toBe('/summaries/integry/propr?branch=release%2F2026');
    expect(notificationHref(item({
      kind: 'indexing',
      target: { type: 'indexing', repository: 'integry/propr', branch: 'release/2026' },
      action: { type: 'navigate', label: 'Browse', href: '/summaries/integry/propr?branch=feature%2Fui' },
    }))).toBe('/summaries/integry/propr?branch=feature%2Fui');
    expect(notificationHref(item({
      kind: 'indexing',
      target: { type: 'indexing', repository: 'integry/propr', branch: 'release/2026' },
      action: { type: 'navigate', label: 'Retry', href: '/repositories' },
    }))).toBe('/repositories');
  });

  test('accepts only matching HTTPS GitHub pull-request actions', () => {
    const target = {
      type: 'task', repository: 'integry/propr', taskId: 'task-1', prNumber: 1724,
    };
    expect(notificationPullRequestUrl(item({
      target,
      action: { type: 'external_link', label: 'Open PR', href: 'https://github.com/integry/propr/pull/1724' },
    }))).toBe('https://github.com/integry/propr/pull/1724');
    expect(notificationPullRequestUrl(item({
      target,
      action: { type: 'external_link', label: 'Open PR', href: 'https://example.com/integry/propr/pull/1724' },
    }))).toBeNull();
    expect(notificationPullRequestUrl(item({
      target,
      action: { type: 'external_link', label: 'Open PR', href: 'https://github.com/integry/propr/pull/99' },
    }))).toBeNull();
  });

  test('de-duplicates cursor pages and retains newest ordering', () => {
    const older = item({ id: 'older', deduplicationKey: 'older', occurredAt: '2026-08-24T10:00:00.000Z' });
    const newer = item({
      id: 'newer',
      deduplicationKey: 'newer',
      occurredAt: '2026-08-24T13:00:00.000Z',
      createdAt: '2026-08-24T13:00:00.000Z',
    });
    expect(mergeNotifications([newer, older], [older]).map(notification => notification.id))
      .toEqual(['newer', 'older']);
  });
});
