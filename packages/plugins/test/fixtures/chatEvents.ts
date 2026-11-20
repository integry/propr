import type { PluginEventInput, RepositoryEvent } from '@propr/shared';
import type { NotificationKind } from '../../_shared/notifications.js';

/**
 * One hand-written journal event per notification kind, as the dispatcher
 * delivers it. Each plugin's `fixtures/messages.json` holds the request body
 * its service receives for these events, with the settings of
 * `CHAT_FIXTURE_SETTINGS`.
 */
export const CHAT_FIXTURE_SETTINGS = { proprUrl: 'https://propr.example.com/' };

const base = (seq: number, overrides: Partial<RepositoryEvent>): RepositoryEvent => ({
  seq, repository: 'acme/api', domain: 'pull_request', type: 'opened', entityId: '12', prNumber: 12, issueNumber: 9, planId: null,
  headSha: '0123456789abcdef0123456789abcdef01234567', payload: {}, occurredAt: '2026-11-16T12:00:00.000Z', ...overrides,
});

export const CHAT_FIXTURE_EVENTS: Record<NotificationKind, RepositoryEvent> = {
  'pull_request.opened': base(201, { payload: { draft: false, baseRef: 'main' } }),
  'review.below_threshold': base(202, { type: 'review_scored', payload: { score: 72.5, goal: 90, goalReached: false, source: 'review', cycle: 1, reviewerModel: 'claude-opus-5-5' } }),
  'review.at_or_above_threshold': base(203, { type: 'review_scored', payload: { score: 94, goal: 90, goalReached: true, source: 'ultrafix', cycle: 3, reviewerModel: 'claude-opus-5-5' } }),
  'pull_request.ultrafix_ended': base(204, { type: 'ultrafix_ended', payload: { outcome: 'goal_reached', finalScore: 92, reason: 'Done', workEpoch: 2 } }),
  'pull_request.merged': base(205, { type: 'merged' }),
  'pull_request.closed': base(206, { type: 'closed', issueNumber: null }),
  'task.failed': base(207, {
    domain: 'task', type: 'failed', entityId: 'task-42', prNumber: null, issueNumber: 9, headSha: null,
    payload: { taskId: 'task-42', kind: 'implementation', issueNumber: 9, prNumber: null, agent: 'claude', model: 'claude-opus-5-5', attempts: 2, status: 'failed', terminalReason: 'timed_out', durationMs: 1_830_000, pullRequest: null, failureCategory: 'timed_out' },
  }),
  'epic_queue.blocked': base(208, { domain: 'epic_queue', type: 'blocked', entityId: '7', prNumber: null, issueNumber: 30, planId: 'plan-1', headSha: null, payload: { headIssue: 31, blockedReason: 'Waiting for review' } }),
  'epic_queue.completed': base(209, { domain: 'epic_queue', type: 'completed', entityId: '7', prNumber: null, issueNumber: 30, planId: 'plan-1', headSha: null, payload: { fromIssue: 30, cursor: 4 } }),
};

export const eventInput = (event: RepositoryEvent, attempt = 1): PluginEventInput => ({ kind: 'event', event, deliveryId: `evt-${event.seq}-notify`, attempt });
