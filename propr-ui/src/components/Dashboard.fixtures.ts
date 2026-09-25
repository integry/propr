/**
 * Dashboard API fixtures shared by the dashboard test files.
 *
 * These are builders, not constants: every test overrides only the fields its
 * assertion is about, so a test reads as the one thing it is checking.
 */

import type {
  ActiveItem,
  AttentionItem,
  DashboardActiveResponse,
  DashboardAttentionResponse,
  DashboardOutcomesResponse,
  DashboardStatsResponse,
  DashboardSummaryResponse,
  OutcomeItem,
} from '../api/dashboardApi';

export const summaryResponse = (over: Partial<DashboardSummaryResponse> = {}): DashboardSummaryResponse => ({
  repository: 'all',
  needsAttention: 0,
  running: 0,
  queued: 0,
  completedRecently: 0,
  recentWindowHours: 24,
  ...over,
});

export const attentionItem = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'task:blocked-1',
  category: 'blocked',
  kind: 'task_failed',
  taskId: 'blocked-1',
  repository: 'acme/app',
  issueNumber: 42,
  prNumber: null,
  taskType: 'issue',
  title: 'Checkout retries never fire',
  state: 'failed',
  detail: 'Lint failed',
  since: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  ...over,
});

export const attentionResponse = (items: AttentionItem[] = []): DashboardAttentionResponse => ({
  repository: 'all',
  items,
  counts: { blocked: items.length, decisions: 0, total: items.length },
});

export const activeItem = (over: Partial<ActiveItem> = {}): ActiveItem => ({
  id: 'task:run-1',
  taskId: 'run-1',
  repository: 'acme/app',
  issueNumber: 7,
  prNumber: null,
  taskType: 'issue',
  title: 'Add retry budget',
  state: 'claude_execution',
  phase: 'Implementing',
  progressLine: 'Editing src/retry.ts',
  createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  ...over,
});

export const activeResponse = (running: ActiveItem[] = [], queued: ActiveItem[] = []): DashboardActiveResponse => ({
  repository: 'all',
  running,
  queued,
  queue: { queuedCount: queued.length, reason: queued.length ? 'All agents are busy' : null },
  counts: { running: running.length, queued: queued.length },
});

export const outcomeItem = (over: Partial<OutcomeItem> = {}): OutcomeItem => ({
  id: 'task:done-1:completed',
  taskId: 'done-1',
  repository: 'acme/app',
  issueNumber: 9,
  prNumber: 100,
  taskType: 'issue',
  title: 'Ship the retry budget',
  detail: null,
  score: null,
  occurredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  ...over,
});

export const outcomesResponse = (items: OutcomeItem[] = []): DashboardOutcomesResponse => ({
  repository: 'all',
  limit: 50,
  search: '',
  items,
});

export const statsResponse = (over: Partial<DashboardStatsResponse> = {}): DashboardStatsResponse => ({
  period: '7d',
  repository: 'all',
  completed: 12,
  successRate: 80,
  recordedSpend: 3.5,
  dailyCompleted: [{ date: '2026-09-22', count: 2 }],
  previous: { completed: 10, successRate: 75, recordedSpend: 2 },
  ...over,
});
