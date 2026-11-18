/** Measuring helpers and API stubs for `touch-hit-areas.pw.ts`. */
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** The least hit area, in CSS px, of a control on a touch layout. */
export const MIN_HIT = 32;

export const PHONE = { width: 390, height: 844 };

/** A phone: touch input, a coarse pointer and a mobile viewport. */
export async function touchContext(browser: Browser, viewport: { width: number; height: number } = PHONE, touch = true) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, baseURL: 'http://127.0.0.1:4173', serviceWorkers: 'block' });
  return { context, page: await context.newPage() };
}

/**
 * The box a tap on `target` lands in: its own box, grown to an absolutely positioned `::after`
 * hit box centred on it (`.touch-hit`), or for a checkbox the larger box of a label wrapping it.
 * Every edge of that box (1px in) and its centre are then hit-tested, so a box that something
 * covers or an ancestor clips counts as missed there.
 */
export const hitArea = (target: Locator) => target.evaluate(async element => {
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const boxOf = (node: Element) => {
    const rect = node.getBoundingClientRect();
    let { width, height } = rect;
    const after = getComputedStyle(node, '::after');
    if (after.content !== 'none' && after.content !== 'normal' && after.position === 'absolute') {
      width = Math.max(width, parseFloat(after.width) || 0);
      height = Math.max(height, parseFloat(after.height) || 0);
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { left: x - width / 2, top: y - height / 2, width, height };
  };
  const own = element.getBoundingClientRect();
  const centre = { x: own.left + own.width / 2, y: own.top + own.height / 2 };
  const owners: Element[] = [element, ...(element instanceof HTMLInputElement ? Array.from(element.labels ?? []) : [])];
  const boxes = owners.map(boxOf).filter(box => box.left <= centre.x && centre.x <= box.left + box.width
    && box.top <= centre.y && centre.y <= box.top + box.height);
  const box = boxes.reduce((best, next) => Math.min(next.width, next.height) > Math.min(best.width, best.height) ? next : best);
  const points: Record<string, [number, number]> = {
    centre: [box.left + box.width / 2, box.top + box.height / 2],
    top: [box.left + box.width / 2, box.top + 1],
    bottom: [box.left + box.width / 2, box.top + box.height - 1],
    left: [box.left + 1, box.top + box.height / 2],
    right: [box.left + box.width - 1, box.top + box.height / 2],
  };
  const missed = Object.entries(points).flatMap(([name, [x, y]]) => {
    const hit = document.elementFromPoint(x, y);
    if (hit && owners.some(owner => owner.contains(hit))) return [];
    return [`${name} → ${hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 60)}` : 'outside the viewport'}`];
  });
  return { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, missed };
});

/** Soft-asserts every control `target` matches (up to `limit`) answers taps across 32x32px. */
export async function expectTappable(target: Locator, name: string, limit = 3) {
  await expect(target.first(), `${name} is on the page`).toBeVisible();
  const controls = (await target.all()).slice(0, limit);
  for (const [index, control] of controls.entries()) {
    const area = await hitArea(control);
    const label = `${name}${controls.length > 1 ? ` #${index + 1}` : ''}: ${area.width}x${area.height}${area.missed.length ? `, missed ${area.missed.join('; ')}` : ''}`;
    expect.soft(Math.min(area.width, area.height), label).toBeGreaterThanOrEqual(MIN_HIT);
    expect.soft(area.missed, label).toEqual([]);
  }
}

/** Fails when the page scrolls sideways at its current width. */
export async function expectNoSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect.soft(overflow, `sideways scroll at ${page.viewportSize()?.width}px`).toBeLessThanOrEqual(0);
}

/** Screenshots go last in a test: one resets the touch emulation (`pointer: coarse`). */
export async function capture(page: Page, name: string, fullPage = false) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', fullPage, path: path.join(directory, `${name}.png`) });
}

type Responses = Record<string, unknown>;

/** Serves `responses` by pathname and a 503 for any other API path; the socket is closed. */
export async function stubApi(page: Page, responses: Responses, label: string) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill(pathname in responses
      ? { json: responses[pathname] }
      : { status: 503, json: { error: `Unavailable in the ${label} fixture` } });
  });
}

export const admin = {
  id: 'touch-user', login: 'operator', username: 'operator', displayName: 'Operator', email: null, avatarUrl: null,
  role: 'admin', permissions: ['instance.manage_settings', 'instance.manage_agents'], authorizationSource: 'local',
};

const shell: Responses = {
  '/api/auth/demo-mode': { demoMode: false },
  '/api/auth/user': admin,
  '/api/tasks': { tasks: [], total: 0 },
  '/api/notifications/unread-count': { unreadCount: 0 },
  '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
};

const at = Date.parse('2026-10-07T23:23:37.000Z');

/** A saved automation reading one of two repositories. */
export const automation = {
  id: 'def-1', ownerId: admin.id, name: 'User issue summary', description: 'Hourly digest of new user-reported issues.',
  repositories: ['integry/propr'], prompt: 'Summarize issues opened by users in the last hour and flag anything urgent.',
  attachments: [], agentAlias: 'codex-main', modelName: 'gpt-5.6-sol', capabilities: ['repository_read'],
  includePreviousReports: false, previousReportsLimit: 0, scheduleCron: '0 * * * *', scheduleTimezone: 'UTC',
  scheduleEnabled: true, nextRunAt: at + 36 * 60_000, autonomyMode: 'dry_run', enabled: true, revision: 1,
  createdAt: at - 86_400_000, updatedAt: at - 86_400_000,
};

export const stubAutomations = (page: Page) => stubApi(page, {
  ...shell,
  '/api/instance/catalog': {
    agents: [
      { alias: 'claude-main', type: 'claude', enabled: true, supportedModels: ['claude-opus-5-5'], defaultModel: 'claude-opus-5-5' },
      { alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' },
    ],
    defaultAgentAlias: 'claude-main',
    repositories: [{ name: 'integry/propr', enabled: true }, { name: 'integry/docs', enabled: true }],
  },
  '/api/automation-definitions': { definitions: [automation], total: 1, limit: 200, offset: 0 },
  [`/api/automation-definitions/${automation.id}`]: { definition: automation },
  [`/api/automation-definitions/${automation.id}/runs`]: { runs: [], total: 0, limit: 1, offset: 0 },
  [`/api/automation-definitions/${automation.id}/capacity`]: { capacity: { status: 'ok', sessionPercent: 20, provider: 'codex' }, threshold: 90 },
}, 'automations');

const repositories = ['integry/propr', 'integry/integration-sdk', 'integry/documentation'];

export const stubRepositories = (page: Page) => stubApi(page, {
  ...shell,
  '/api/config/repos': { success: true, repos_to_monitor: repositories.map(name => ({ id: name, name, enabled: true, visualPreview: { enabled: false, types: ['image'] } })) },
  '/api/instance/catalog': { repositories: repositories.map(name => ({ name, enabled: true })), agents: [] },
  '/api/github/repos': { repos: [] },
  '/api/config/settings': { auto_resolve_merge_conflicts: true },
  '/api/user/repo-preferences': { preferences: {} },
  '/api/repositories/indexing-status': { repositories: [] },
}, 'repositories');

const logEntry = (logId: number, success: boolean) => ({
  logId, executionType: logId % 2 ? 'claude_execution' : 'pr_review', modelName: 'claude-opus-5-5',
  startTime: new Date(at - logId * 600_000).toISOString(), endTime: new Date(at - logId * 600_000 + 95_000).toISOString(),
  durationMs: 95_000, success, inputTokens: 12_400, outputTokens: 3_100, cacheCreationInputTokens: null, cacheReadInputTokens: null,
  costUsd: 0.42, errorMessage: success ? null : 'Rate limited', sessionId: `session-${logId}`, correlationId: null, draftId: null,
  repository: 'integry/propr', agentAlias: 'claude', metadata: { prompt: 'Review the change' }, usageMetrics: null, usageMetricRecords: [],
  workType: 'task', taskId: `task-${logId}`, taskNumber: 3600 + logId, prNumber: null, planDraftId: null, planIssueId: null, workRepository: 'integry/propr',
});

export const stubLlmLogs = (page: Page) => stubApi(page, {
  ...shell,
  '/api/instance/catalog': { repositories: [], agents: [] },
  '/api/llm-logs': {
    logs: [logEntry(1, true), logEntry(2, false), logEntry(3, true)],
    pagination: { page: 1, limit: 50, total: 3, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
  },
}, 'LLM log');

const goalTime = '2026-09-10T00:00:00.000Z';

/** A running goal with a final pull request: Pause, Cancel and Review final PR all show. */
export const goal = {
  id: 'goal-1', owner: 'operator', repository: 'acme/web', title: 'Launch Customer Analytics Dashboard',
  objective: 'Ship the dashboard.', launchStrategy: 'orchestrate', initialPrompt: '/goal Ship the dashboard', attachments: [],
  baseBranch: null, branchName: 'goal/dashboard', worktreePath: '/tmp/goal-dashboard',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' }, requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null, failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null,
  finalPr: { url: 'https://github.com/acme/web/pull/77', number: 77 },
  checkpoint: null, artifacts: [], artifactStats: { issues: 2, openIssues: 1, pullRequests: 1, openPullRequests: 1 },
  liveSummary: {
    currentTask: 'Implement responsive queue', todos: [{ id: 'todo-1', content: 'Implement responsive queue', status: 'in_progress' }],
    tokenUsage: { input_tokens: 1200, output_tokens: 400 }, nativeGoal: null,
  },
  taskState: 'claude_execution', createdAt: goalTime, updatedAt: goalTime, startedAt: goalTime, pausedAt: null, completedAt: null,
  elapsedMs: 120_000, activeMs: 120_000, pausedMs: 0,
};

export const stubGoal = async (page: Page) => {
  await page.clock.install({ time: Date.parse(goalTime) + 120_000 });
  await stubApi(page, {
    ...shell,
    '/api/instance/catalog': {
      agents: [{ id: 'agent-1', alias: 'codex', type: 'codex', enabled: true, models: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' }],
      repositories: [{ name: 'acme/web', enabled: true }],
    },
    '/api/goals/capabilities': { agents: [{
      agentId: 'agent-1', agentAlias: 'codex', agentType: 'codex', goalCapable: true,
      lifecycle: { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' },
      controls: { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true },
      models: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol',
    }] },
    '/api/goals': { goals: [goal] },
    '/api/goals/goal-1': { goal },
    '/api/task/goal-task-1/live-details': {
      events: [{ id: 'thought-1', type: 'thought', content: 'The focused tests pass and the stable slice is ready.', timestamp: goalTime }],
      todos: [], currentTask: null, tokenUsage: { input_tokens: 1200, output_tokens: 400 },
    },
  }, 'goal');
};

/** One unread review with a pull request: a reference link and a Dismiss button in the list. */
export const stubInbox = (page: Page) => {
  const occurredAt = new Date().toISOString();
  return stubApi(page, {
    ...shell,
    '/api/notifications': { unreadCount: 1, nextCursor: null, notifications: [{
      id: 'review-77', deduplicationKey: 'review-77', kind: 'review', severity: 'success',
      target: { type: 'review', repository: 'integry/propr', prNumber: 77, taskId: 'review-task-77' },
      title: 'Guard Inbox recaps against empty metadata', body: 'Score 8/10 · 2 issues found',
      actions: ['follow_up', 'open_pr', 'dismiss'],
      action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/77' },
      occurredAt, createdAt: occurredAt, readAt: null, dismissedAt: null,
    }] },
    '/api/notifications/unread-count': { unreadCount: 1 },
    '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
    '/api/instance/catalog': { repositories: [], agents: [] },
  }, 'Inbox');
};
