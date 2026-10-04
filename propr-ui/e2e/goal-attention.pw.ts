import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { attention, captureTarget, openDashboard, user } from './dashboard-sections.fixture';

const goalId = 'goal-1';
const timestamp = '2026-10-03T09:00:00.000Z';

const question = {
  id: 'blocker-1', goalId, repository: 'acme/web', taskId: 'goal-task-1',
  attempt: { generation: 2, claim: 'claim-2', sessionId: 'thread-1', turnId: 'turn-7' },
  category: 'question', provider: 'codex',
  summary: 'Which database should the audit-log migration target?',
  questions: [{ id: 'db', header: 'Database', question: 'Which database should the audit-log migration target?',
    options: ['Postgres (production)', 'SQLite (local only)'], confidential: false }],
  detection: { kind: 'provider_event', source: 'codex_app_server:item/tool/requestUserInput' },
  firstObservedAt: '2026-10-03T09:12:00.000Z', lastObservedAt: '2026-10-03T09:12:00.000Z', status: 'open',
  actionable: true, responseActions: ['send_input', 'pause', 'cancel'],
  responseHint: 'Send goal input to answer; ProPR delivers it as the reply to this question. Sending alone does not resolve it — the provider does.',
};

const goal = {
  id: goalId, owner: 'operator', repository: 'acme/web',
  title: 'Add audit logging to the admin API',
  objective: 'Record every admin mutation in an append-only audit log and expose it in the admin console.',
  launchStrategy: 'direct', initialPrompt: '/goal Add audit logging', attachments: [],
  baseBranch: 'main', branchName: 'goal/audit-log', worktreePath: null,
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: null, ultrafix: false, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  attention: { waitingForOperator: true, reason: 'provider_question', blockers: [question] },
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null, finalPr: null,
  checkpoint: null, artifacts: [], inputs: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
  liveSummary: { currentTask: 'Waiting for an answer', todos: [], tokenUsage: { input_tokens: 48200, output_tokens: 9100 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: timestamp, updatedAt: timestamp,
  startedAt: timestamp, pausedAt: null, completedAt: null,
  elapsedMs: 780_000, activeMs: 780_000, pausedMs: 0,
};

async function goalFixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': { agents: [], repositories: [{ name: 'acme/web', enabled: true }] },
      '/api/goals/capabilities': { agents: [{ agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
        lifecycle: null, controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
        models: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol', objectiveMaxCharacters: null }] },
      '/api/goals': { goals: [goal] },
      [`/api/goals/${goalId}`]: { goal },
      [`/api/goals/${goalId}/previews`]: { previews: [] },
      '/api/task/goal-task-1/live-details': { events: [], todos: [], currentTask: null },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in goal attention fixture' } });
  });
}

async function capture(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

test('the goal console shows a provider question with its supported actions', async ({ page }) => {
  await goalFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/goals/${goalId}`);
  const panel = page.getByTestId('goal-attention');
  await expect(panel.getByText('The agent asked a question')).toBeVisible();
  await expect(panel.getByTestId('goal-blocker-summary')).toHaveText(question.summary);
  await expect(panel.getByRole('button', { name: 'Answer' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /approve/i })).toHaveCount(0);
  await capture(page, 'goal-console-question');
  await panel.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByRole('textbox', { name: 'Correction or follow-up' })).toBeFocused();
});

test('the goal console stacks the blocker cleanly on a phone', async ({ page }) => {
  await goalFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/goals/${goalId}`);
  const panel = page.getByTestId('goal-attention');
  await expect(panel.getByRole('button', { name: 'Answer' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(panel, 'goal-console-question-mobile');
});

test('the dashboard lists the goal blocker and links to its console', async ({ page }) => {
  const goalItem = {
    id: 'goal-blocker:blocker-1', category: 'blocked', kind: 'goal_blocker', taskId: 'goal-task-1', repository: 'example/workspace',
    issueNumber: null, prNumber: null, taskType: 'goal', title: 'Add audit logging to the admin API', state: 'question',
    detail: question.summary, since: new Date(Date.parse('2026-09-23T12:00:00Z') - 4 * 60_000).toISOString(), goalId,
    goalBlocker: { id: 'blocker-1', category: 'question', actionable: true, responseActions: ['send_input', 'pause', 'cancel'] },
  };
  await openDashboard(page, { width: 1440, height: 1000 }, [goalItem, ...attention] as typeof attention);
  const panel = page.getByTestId('needs-attention-panel');
  await expect(panel.getByText('Goal asked a question')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open goal' })).toHaveAttribute('href', `/goals/${goalId}`);
  await captureTarget(panel, 'dashboard-goal-attention');
});
