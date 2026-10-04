import type { Page, Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export const now = Date.parse('2026-09-23T12:00:00Z');
export const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

// Newest first, as the API lists running work.
export const running: import('../src/api/dashboardApi').ActiveItem[] = [
  // Seven, not six: one row over the visible five is simply drawn, so the
  // expand control only appears — and only has to be tested — past that.
  { id: 'task:run-7', taskId: 'run-7', repository: 'example/design-system', issueNumber: 119, prNumber: null, taskType: 'issue', title: 'New Issue: Unify the empty and unavailable states across panels', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(1), updatedAt: minutesAgo(1) },
  { id: 'task:run-6', taskId: 'run-6', repository: 'example/docs', issueNumber: 62, prNumber: null, taskType: 'issue', title: 'Explain the attention rules in the operations guide', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(2), updatedAt: minutesAgo(1) },
  { id: 'task:run-5', taskId: 'run-5', repository: 'example/docs', issueNumber: 61, prNumber: null, taskType: 'issue', title: 'Document the dashboard data contracts', state: 'claude_execution', phase: 'Implementing', progressLine: null, activity: 'Reading dashboardApi.ts', step: null, lastActivityAt: minutesAgo(0.2), createdAt: minutesAgo(4), updatedAt: minutesAgo(1) },
  { id: 'task:run-4', taskId: 'run-4', repository: 'example/workspace', issueNumber: 2455, prNumber: 2456, taskType: 'pr-comment', title: 'Review PR #2456: Cache repository icons across dashboard sections', state: 'claude_execution', phase: 'Implementing', progressLine: 'Running tests', activity: 'Running npx vitest run src/components/Dashboard', step: { current: 3, total: 5 }, lastActivityAt: minutesAgo(0.1), createdAt: minutesAgo(7), updatedAt: minutesAgo(1) },
  { id: 'task:run-3', taskId: 'run-3', repository: 'example/design-system', issueNumber: 118, prNumber: null, taskType: 'issue', title: 'Align the score badge with the completed feed', state: 'processing', phase: 'Preparing', progressLine: null, createdAt: minutesAgo(9), updatedAt: minutesAgo(3) },
  { id: 'task:run-2', taskId: 'run-2', repository: 'example/workspace', issueNumber: 2480, prNumber: 2481, taskType: 'pr-comment', title: 'Fix PR #2481: keep the queue summary honest when no reason is known', state: 'post_processing', phase: 'Finishing up', progressLine: 'Pushing branch', createdAt: minutesAgo(14), updatedAt: minutesAgo(2) },
  { id: 'task:run-1', taskId: 'run-1', repository: 'example/workspace', issueNumber: 2479, prNumber: null, taskType: 'issue', title: 'Followup: [2479 by Claude Opus 4.6] Rebuild the dashboard into five sections with a shared repository filter', state: 'claude_execution', phase: 'Implementing', progressLine: 'Editing propr-ui/src/components/Dashboard.tsx', activity: 'Editing Dashboard.tsx', step: { current: 2, total: 6 }, lastActivityAt: minutesAgo(18), createdAt: minutesAgo(26), updatedAt: minutesAgo(1) },
];

// Newest first, whatever the kind.
export const attention = [
  { id: 'plan-issue:32', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/docs', issueNumber: 58, prNumber: 59, taskType: null, title: 'feature/icon-cache', state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(20) },
  // A review decision carries the title of the run behind it, and where that
  // run recorded no title, the branch it works on. Neither row may fall back
  // to `Pull request #2469`, which is the chip beside it read twice.
  { id: 'plan-issue:31', category: 'decision', kind: 'plan_review', taskId: null, repository: 'example/workspace', issueNumber: 2468, prNumber: 2469, taskType: null, title: 'New Issue: Cache repository icons across dashboard sections', state: 'under_review', detail: 'Pull request is awaiting review', since: minutesAgo(52) },
  { id: 'task:blocked-2', category: 'blocked', kind: 'task_action_required', taskId: 'blocked-2', repository: 'example/design-system', issueNumber: 117, prNumber: null, taskType: 'issue', title: 'Choose between the compact and comfortable row density', state: 'action_required', detail: 'Waiting for a decision on row density', since: minutesAgo(95) },
  { id: 'task:blocked-1', category: 'blocked', kind: 'task_failed', taskId: 'blocked-1', repository: 'example/workspace', issueNumber: 2470, prNumber: 2471, taskType: 'pr-comment', title: 'Fix PR #2471: Retry budget never applies to post-processing', state: 'failed', detail: 'Lint failed on propr-ui/src/api/dashboardApi.ts', since: minutesAgo(190) },
];

// Completed runs only, newest first. Only the review carries a score.
export const outcomes = [
  { id: 'task:done-1:completed', taskId: 'done-1', repository: 'example/workspace', issueNumber: 2466, prNumber: 2467, taskType: 'pr-comment', title: 'Review PR #2467: Show corrective operator messages verbatim in the goal timeline', detail: '2 issues found: Missing timeline test; Unescaped operator markup', score: 8, occurredAt: minutesAgo(5) },
  { id: 'task:done-2:completed', taskId: 'done-2', repository: 'example/workspace', issueNumber: 2494, prNumber: 2494, taskType: 'pr-comment', title: 'Fix PR #2494: [Epic] MCP Operator Surface: Activity, Control And Observability', detail: 'Applied the requested review fixes across 4 files.', score: null, occurredAt: minutesAgo(6) },
  { id: 'task:done-3:completed', taskId: 'done-3', repository: 'example/docs', issueNumber: 57, prNumber: 60, taskType: 'issue', title: 'New Issue: Describe the recorded-spend metric', detail: null, score: null, occurredAt: minutesAgo(140) },
  { id: 'task:done-4:completed', taskId: 'done-4', repository: 'example/workspace', issueNumber: 2460, prNumber: null, taskType: 'issue', title: 'Reduce duplicate startup reads on the dashboard route', detail: 'Implemented the requested work across 3 files and opened a pull request.', score: null, occurredAt: minutesAgo(300) },
];

/**
 * The shell around the dashboard.
 *
 * The fixture signs a user in and serves Agent Tank usage so the left
 * navigation renders whole — nav, the USAGE telemetry widget and the account
 * block — instead of ending at Settings above a column of dead space. The user
 * is a plain member on purpose: the admin-only banners (onboarding, missing
 * default model, Agent Tank detection) would otherwise push the dashboard
 * itself down the page and out of the capture.
 */
export const user = {
  id: 'preview-user', login: 'operator', username: 'operator', displayName: 'Dana Okonkwo',
  email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local',
};

const agentTankUsage = { enabled: true, agents: {
  claude: { name: 'claude', usage: { session: { percent: 34, resetsIn: '2h 10m' }, weeklyAll: { percent: 61, resetsIn: '3d 4h' }, weeklySonnet: { percent: 22, resetsIn: '3d 4h' } } },
  codex: { name: 'codex', usage: { fiveHour: { percentUsed: 12, resetsIn: '1h 05m' }, weekly: { percentUsed: 47, resetsIn: '4d 2h' } } },
} };

export const dashboardResponses = (attentionItems: typeof attention, runningItems: typeof running): Record<string, unknown> => ({
  '/api/dashboard/narrative': { repository: 'all', enabled: true, summary: 'Dashboard improvements are being tested, while recent fixes await review.' },
  '/api/dashboard/summary': { repository: 'all', needsAttention: attentionItems.length,
    running: runningItems.length, queued: 2, completedRecently: 4, recentWindowHours: 24 },
  '/api/dashboard/attention': { repository: 'all', items: attentionItems,
    counts: { blocked: attentionItems.filter(item => item.category === 'blocked').length,
      decisions: attentionItems.filter(item => item.category === 'decision').length,
      total: attentionItems.length } },
  '/api/dashboard/active': { repository: 'all', running: runningItems, queued: [],
    queue: { queuedCount: 2, reason: 'All agents are busy' },
    counts: { running: runningItems.length, queued: 2 } },
  '/api/dashboard/outcomes': { repository: 'all', limit: 50, items: outcomes },
  '/api/stats/dashboard': { period: '7d', repository: 'all', completed: 34, successRate: 87.5, recordedSpend: 12.42,
    dailyCompleted: [4, 7, 3, 6, 2, 8, 4].map((count, index) => ({ date: `2026-09-${17 + index}`, count })),
    previous: { completed: 29, successRate: 81.2, recordedSpend: 9.8 } },
});

export async function fixture(page: Page, viewport: { width: number; height: number }, attentionItems = attention, runningItems = running) {
  await page.setViewportSize(viewport);
  await page.clock.install({ time: now });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true }, '/api/auth/user': user,
      '/api/config/agent-tank/usage': agentTankUsage,
      '/api/tasks': { tasks: [], total: 0 },
      '/api/instance/catalog': {
        agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }],
        repositories: ['example/workspace', 'example/design-system', 'example/docs']
          .map(name => ({ name, enabled: true, baseBranch: 'main' })),
      },
      '/api/queue/stats': { active: 6, waiting: 2, completed: 34, failed: 3 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
      '/api/status': { status: 'ok' }, ...dashboardResponses(attentionItems, runningItems),
    };
    return pathname in responses
      ? route.fulfill({ json: responses[pathname] })
      : route.fulfill({ status: 503, json: { error: 'Unavailable in the dashboard layout fixture' } });
  });
}

export async function respond(page: Page, endpoint: string, body: Record<string, unknown>) {
  await page.route(`**/api/${endpoint}?**`, route => route.fulfill({ json: { repository: 'all', ...body } }));
}

export async function openDashboard(page: Page, viewport: { width: number; height: number },
  attentionItems = attention, runningItems = running) {
  await fixture(page, viewport, attentionItems, runningItems);
  await page.goto('/');
}

export async function captureTarget(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`), fullPage: true });
}

export async function capture(page: Page, name: string, dashboardOnly = false) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  // The daily chart draws after its container is measured.
  await page.locator('.recharts-surface').first().waitFor({ state: 'visible' }).catch(() => undefined);
  await captureTarget(dashboardOnly ? page.locator('main') : page, name);
}

