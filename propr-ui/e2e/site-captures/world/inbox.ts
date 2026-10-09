import { area } from '../lib/world';
import { REPOS, minutesAgo } from './base';

const prLink = (repository: string, prNumber: number) => ({
  type: 'external_link', label: 'Open pull request', href: `https://github.com/${repository}/pull/${prNumber}`,
});

function item(id: string, minutes: number, fields: Record<string, unknown>) {
  const occurredAt = minutesAgo(minutes);
  return {
    id, deduplicationKey: id, severity: 'success', actions: ['follow_up', 'open_pr', 'dismiss'],
    occurredAt, createdAt: occurredAt, readAt: null, dismissedAt: null, ...fields,
  };
}

/** A morning's Inbox at Northwind: reviews with scores, a finished fix, a plan ready to approve. */
export const notifications = [
  item('review-182', 4, {
    kind: 'review', target: { type: 'review', repository: REPOS.api, prNumber: 182, taskId: 'nw-d1' },
    title: 'Retry webhook deliveries with backoff',
    body: 'Score 8/10 · 1 issue found: Jitter is applied twice',
    action: prLink(REPOS.api, 182),
  }),
  item('fix-406', 22, {
    kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: REPOS.web, prNumber: 406 },
    metadata: { completedImplementationTaskId: 'nw-d2', completionType: 'fix' },
    title: 'Keep the cart badge in sync across tabs',
    body: 'Fixed 2 review findings in 3 files; tests pass.',
    action: prLink(REPOS.web, 406),
  }),
  item('plan-giftcards', 31, {
    kind: 'plan', target: { type: 'plan', repository: REPOS.web, draftId: 'draft-giftcards' },
    title: 'Gift cards at checkout',
    body: 'Ready for review with 5 planned tasks.',
    actions: ['refine', 'approve_execute', 'dismiss'],
  }),
  item('review-57', 48, {
    kind: 'review', target: { type: 'review', repository: REPOS.infra, prNumber: 57, taskId: 'nw-57' },
    title: 'Pin the Terraform AWS provider to 6.x',
    body: 'Score 5/10 · 3 issues found: Lock file not updated; Module versions still float; Missing upgrade note',
    action: prLink(REPOS.infra, 57), readAt: minutesAgo(40),
  }),
  item('ready-55', 75, {
    kind: 'pull_request', severity: 'info', target: { type: 'pull_request', repository: REPOS.infra, prNumber: 55 },
    metadata: { completedImplementationTaskId: 'nw-d3' },
    title: 'Rotate staging database credentials monthly',
    body: '4 files changed; checks passing.',
    action: prLink(REPOS.infra, 55), readAt: minutesAgo(60),
  }),
  item('review-402', 140, {
    kind: 'review', target: { type: 'review', repository: REPOS.web, prNumber: 402, taskId: 'nw-d4' },
    title: 'Lazy-load product image carousels',
    body: 'Score 9/10 · 0 issues found',
    action: prLink(REPOS.web, 402), readAt: minutesAgo(120),
  }),
];

export const inbox = area('inbox', {
  '/api/notifications': { notifications, unreadCount: 3, nextCursor: null },
  '/api/notifications/unread-count': { unreadCount: 3 },
});
