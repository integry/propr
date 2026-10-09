import { area } from '../lib/world';
import { REPOS, minutesAgo } from './base';

/** Running work, newest first, as the API lists it. */
export const running = [
  { id: 'task:nw-412', taskId: 'nw-412', repository: REPOS.web, issueNumber: 412, prNumber: null, taskType: 'issue', title: 'Show delivery windows on the checkout summary', state: 'claude_execution', phase: 'Implementing', progressLine: 'Editing CheckoutSummary.tsx', activity: 'Editing src/checkout/CheckoutSummary.tsx', step: { current: 3, total: 5 }, lastActivityAt: minutesAgo(0.2), createdAt: minutesAgo(11), updatedAt: minutesAgo(0.2) },
  { id: 'task:nw-188', taskId: 'nw-188', repository: REPOS.api, issueNumber: 187, prNumber: 188, taskType: 'pr-comment', title: 'Review PR #188: Idempotent refunds for partial captures', state: 'claude_execution', phase: 'Implementing', progressLine: 'Running tests', activity: 'Running pytest tests/refunds', step: null, lastActivityAt: minutesAgo(0.1), createdAt: minutesAgo(6), updatedAt: minutesAgo(0.1) },
  { id: 'task:nw-96', taskId: 'nw-96', repository: REPOS.mobile, issueNumber: 96, prNumber: null, taskType: 'issue', title: 'Offline queue for proof-of-delivery photos', state: 'claude_execution', phase: 'Implementing', progressLine: null, activity: 'Reading src/sync/uploadQueue.ts', step: { current: 1, total: 4 }, lastActivityAt: minutesAgo(0.5), createdAt: minutesAgo(24), updatedAt: minutesAgo(0.5) },
  { id: 'task:nw-415', taskId: 'nw-415', repository: REPOS.web, issueNumber: 415, prNumber: null, taskType: 'issue', title: 'Add a courier tip field to the order review step', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(1), updatedAt: minutesAgo(1) },
  { id: 'task:nw-57', taskId: 'nw-57', repository: REPOS.infra, issueNumber: 56, prNumber: 57, taskType: 'pr-comment', title: 'Fix PR #57: Pin the Terraform AWS provider to 6.x', state: 'post_processing', phase: 'Finishing up', progressLine: 'Pushing branch', createdAt: minutesAgo(15), updatedAt: minutesAgo(1) },
];

export const attention = [
  { id: 'goal-blocker:nw-g1', category: 'decision', kind: 'goal_blocker', taskId: null, goalId: 'goal-nw-1', repository: REPOS.api, issueNumber: null, prNumber: null, taskType: null, title: 'Move order totals to integer cents', state: 'waiting_for_input', detail: 'Keep the legacy float column until the mobile app ships 4.2?', since: minutesAgo(9), goalBlocker: { id: 'q-1', category: 'question', actionable: true, responseActions: ['send_input', 'pause', 'cancel'] } },
  { id: 'plan-issue:nw-1', category: 'decision', kind: 'plan_review', taskId: null, repository: REPOS.web, issueNumber: 409, prNumber: 410, taskType: null, title: 'Gift cards at checkout', state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(18) },
  { id: 'task:nw-blocked-2', category: 'blocked', kind: 'task_failed', taskId: 'nw-blocked-2', repository: REPOS.api, issueNumber: 183, prNumber: 184, taskType: 'pr-comment', title: 'Fix PR #184: Paginate the order export endpoint', state: 'failed', detail: 'Lint failed on app/exports/orders.py', since: minutesAgo(130) },
];

export const outcomes = [
  { id: 'task:nw-d1:completed', taskId: 'nw-d1', repository: REPOS.api, issueNumber: 181, prNumber: 182, taskType: 'pr-comment', title: 'Review PR #182: Retry webhook deliveries with backoff', detail: '1 issue found: Jitter is applied twice', score: 8, occurredAt: minutesAgo(4) },
  { id: 'task:nw-d2:completed', taskId: 'nw-d2', repository: REPOS.web, issueNumber: 405, prNumber: 406, taskType: 'pr-comment', title: 'Fix PR #406: Keep the cart badge in sync across tabs', detail: 'Applied the requested review fixes across 3 files.', score: null, occurredAt: minutesAgo(22) },
  { id: 'task:nw-d3:completed', taskId: 'nw-d3', repository: REPOS.infra, issueNumber: 54, prNumber: 55, taskType: 'issue', title: 'Rotate staging database credentials monthly', detail: 'Implemented the requested work across 4 files and opened a pull request.', score: null, occurredAt: minutesAgo(75) },
  { id: 'task:nw-d4:completed', taskId: 'nw-d4', repository: REPOS.web, issueNumber: 401, prNumber: 402, taskType: 'pr-comment', title: 'Review PR #402: Lazy-load product image carousels', detail: '0 issues found', score: 9, occurredAt: minutesAgo(140) },
];

export const dashboard = area('dashboard', {
  '/api/dashboard/narrative': { repository: 'all', enabled: true, summary: 'Checkout delivery windows are in progress, and the gift-card plan is waiting for your review.' },
  '/api/dashboard/summary': { repository: 'all', needsAttention: attention.length, running: running.length, queued: 1, completedRecently: outcomes.length, recentWindowHours: 24 },
  '/api/dashboard/attention': { repository: 'all', items: attention, counts: { blocked: 1, decisions: 2, total: attention.length } },
  '/api/dashboard/active': { repository: 'all', running, queued: [], queue: { queuedCount: 1, reason: 'All agents are busy' }, counts: { running: running.length, queued: 1 } },
  '/api/dashboard/outcomes': { repository: 'all', limit: 50, items: outcomes },
});

/** Search results for "refund" across plans and tasks (the Cmd/Ctrl+K palette). */
const plans = ([
  ['Partial refunds for split shipments', 'Refund individual shipments of an order without cancelling the rest.', 'review', 2 * 1440],
  ['Refund reasons in the support console', 'Let support agents pick a reason code when issuing a refund.', 'merged', 6 * 1440],
] as Array<[string, string, string, number]>).map(([name, initial_prompt, status, minutes], index) => ({
  draft_id: `nw-plan-${index}`, repository: REPOS.api, name, initial_prompt, status,
  created_at: minutesAgo(minutes), updated_at: minutesAgo(minutes),
  issue_summary: status === 'merged' ? { total: 4, pending: 0, processing: 0, merged: 4, closed: 0 } : null,
}));
const tasks = [
  { id: 'nw-188', title: 'Idempotent refunds for partial captures', status: 'processing', prNumber: 188, score: null },
  { id: 'nw-171', title: 'Email the customer when a refund settles', status: 'completed', prNumber: 172, score: 9 },
  { id: 'nw-165', title: 'Reconcile refunds against the payment provider ledger', status: 'failed', prNumber: 166, score: 5, failedReason: 'Tests failed in tests/refunds/test_ledger.py' },
].map((task, index) => ({
  ...task, repository: REPOS.api, issueNumber: 187 - index * 8, model: 'claude-opus-5-5',
  subtitle: 'Refund handling in the orders service.', createdAt: minutesAgo((1 + index * 3) * 1440),
}));

export const search = area('search', {
  'GET /api/planner/drafts': { drafts: plans, total: plans.length, page: 1, limit: 5, hasMore: false },
  'GET /api/tasks': request => request.query.get('search') ? { tasks, total: tasks.length } : undefined,
});

/** To-do categories for the toolbar's Quick add to-do popover. */
export const todos = area('todos', {
  '/api/repos/todos/categories': { categories: [
    { categoryId: 'bugs', name: 'Bugs', orderIndex: 0 }, { categoryId: 'ideas', name: 'Ideas', orderIndex: 1 },
  ] },
  '/api/user/repo-preferences': { preferences: {} },
  '/api/repositories/indexing-status': { repositories: [] },
});
