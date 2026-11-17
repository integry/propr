import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { user } from './dashboard-sections.fixture';

// Automations, Goals and Plans share one list header: same height, title size
// and filter placement at desktop and laptop sizes, and the phone pattern
// (title and filters, then search) without horizontal scroll at 390px.

const now = Date.parse('2026-11-17T09:00:00.000Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const definition = (id: string, name: string, repositories: string[]) => ({
  id, ownerId: user.id, name, description: null, repositories, prompt: 'Summarize the week.', attachments: [],
  agentAlias: 'codex-main', modelName: 'gpt-5.6-sol', capabilities: ['repository_read'], includePreviousReports: false,
  previousReportsLimit: 0, scheduleCron: '0 9 * * 1', scheduleTimezone: 'UTC', scheduleEnabled: true, nextRunAt: now + 3_600_000,
  autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
});
const definitions = [
  definition('def-1', 'User issue summary', ['integry/propr']),
  definition('def-2', 'Dependency review', ['integry/propr', 'integry/api']),
  definition('def-3', 'Release notes draft', ['integry/api']),
  definition('def-4', 'Weekly cost digest', []),
];

const goal = (id: string, title: string, repository: string) => ({
  id, owner: 'operator', repository, title, objective: `${title} for the release.`,
  launchStrategy: 'orchestrate', initialPrompt: `/goal ${title}`, attachments: [],
  baseBranch: null, branchName: `goal/${id}`, worktreePath: `/tmp/${id}`,
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-6-astra', effectiveModel: 'gpt-6-astra',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: `${id}-task`, sessionId: null, conversationId: null, finalPr: null,
  checkpoint: null, artifacts: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
  liveSummary: { currentTask: null, todos: [], tokenUsage: { input_tokens: 0, output_tokens: 0 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: ago(60), updatedAt: ago(5),
  startedAt: ago(60), pausedAt: null, completedAt: null,
  elapsedMs: 60_000, activeMs: 60_000, pausedMs: 0,
});
const goals = [goal('goal-1', 'Launch Customer Analytics Dashboard', 'integry/propr'), goal('goal-2', 'Prepare Billing API', 'integry/api')];
const drafts = [
  { draft_id: 'draft-1', repository: 'integry/propr', name: 'Mobile search for list pages', initial_prompt: 'Mobile search', status: 'draft', updated_at: ago(30), created_at: ago(90) },
  { draft_id: 'draft-2', repository: 'integry/api', name: 'Retry webhook deliveries', initial_prompt: 'Retry', status: 'review', updated_at: ago(40), created_at: ago(90) },
];

async function stub(page: Page) {
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': user,
      '/api/instance/catalog': {
        agents: [{ alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' }],
        defaultAgentAlias: 'codex-main',
        repositories: [{ name: 'integry/propr', enabled: true }, { name: 'integry/api', enabled: true }],
      },
      '/api/automation-definitions': { definitions, total: definitions.length, limit: 200, offset: 0 },
      '/api/goals': { goals },
      '/api/planner/drafts': { drafts, total: drafts.length, page: 1, limit: 50, hasMore: false },
      '/api/planner/drafts/repositories': { repositories: [{ repo: 'integry/propr', count: 1 }, { repo: 'integry/api', count: 1 }], total: 2 },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    if (/^\/api\/automation-definitions\/[^/]+\/runs$/.test(pathname)) return route.fulfill({ json: { runs: [], total: 0, limit: 1, offset: 0 } });
    if (/^\/api\/automation-definitions\/[^/]+\/capacity$/.test(pathname)) return route.fulfill({ json: { capacity: { status: 'ok', sessionPercent: 20, provider: 'codex' }, threshold: 90 } });
    const opened = definitions.find(candidate => pathname === `/api/automation-definitions/${candidate.id}`);
    if (opened) return route.fulfill({ json: { definition: opened } });
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in list header fixture' } });
  });
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve(process.cwd(), '..', '.propr', 'previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

/** Geometry of a list header, relative to the header box. */
async function measureHeader(page: Page, title: string) {
  const heading = page.getByRole('heading', { level: 1, name: title, exact: true });
  await expect(heading).toBeVisible();
  // The repository filter has loaded once its trigger names a selection.
  await expect(page.locator('header').filter({ has: heading }).getByRole('button', { name: /All Repos/ })).toBeVisible();
  return heading.evaluate(node => {
    const header = node.closest('header')!;
    const box = header.getBoundingClientRect();
    const title = node.getBoundingClientRect();
    const search = header.querySelector('input[aria-label^="Search"]')!.getBoundingClientRect();
    const triggers = [...header.querySelectorAll('button')].filter(button => /All Repos/.test(button.textContent ?? ''));
    const filter = triggers.at(-1)!.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      height: Math.round(box.height),
      titleFont: `${style.fontSize}/${style.fontWeight}`,
      titleLeft: Math.round(title.left - box.left),
      titleTop: Math.round(title.top - box.top),
      filterRightInset: Math.round(box.right - filter.right),
      filterTop: Math.round(filter.top - box.top),
      searchTop: Math.round(search.top - box.top),
      searchHeight: Math.round(search.height),
      overflows: header.scrollWidth > header.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

const viewports = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '390', width: 390, height: 844 },
];

for (const viewport of viewports) {
  test(`the Automations header matches Goals and Plans at ${viewport.name}`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    await page.goto('/goals');
    const goalsHeader = await measureHeader(page, 'Goals');
    await capture(page, `goals-header-${viewport.name}`);
    await page.goto('/plans');
    const plansHeader = await measureHeader(page, 'Plans');
    await capture(page, `plans-header-${viewport.name}`);
    await page.goto('/automations');
    const automationsHeader = await measureHeader(page, 'Automations');
    await capture(page, `automations-header-${viewport.name}`);

    for (const other of [goalsHeader, plansHeader]) {
      expect(automationsHeader).toEqual({ ...other, overflows: false });
    }
  });
}

test('the Automations header stays in the list pane beside an open automation', async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/automations?repository=integry%2Fapi');
  await expect(page.getByTestId('agent-row')).toHaveCount(2);
  await page.getByRole('link', { name: /Dependency review/ }).click();
  await expect(page).toHaveURL(/\/automations\/def-2\?repository=integry%2Fapi$/);

  const pane = page.getByTestId('agent-split-list');
  const header = pane.locator('header');
  await expect(header.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByTestId('agent-row')).toHaveCount(2);
  // In the narrow pane the search and filter take a row under the title, inside the pane.
  const fits = await header.evaluate(node => {
    const paneBox = node.parentElement!.getBoundingClientRect();
    const controls = [...node.querySelectorAll('input, button')].map(element => element.getBoundingClientRect());
    const title = node.querySelector('h1')!.getBoundingClientRect();
    return {
      inside: controls.every(box => box.left >= paneBox.left && box.right <= paneBox.right + 0.5),
      below: controls.every(box => box.top >= title.bottom),
      overflows: node.scrollWidth > node.clientWidth,
    };
  });
  expect(fits).toEqual({ inside: true, below: true, overflows: false });

  await page.getByRole('textbox', { name: 'Search automations' }).fill('dependency');
  await expect(page).toHaveURL(/search=dependency/);
  await expect(page.getByTestId('agent-row')).toHaveCount(1);
  await capture(page, 'automations-header-split-pane');

  await page.getByRole('textbox', { name: 'Search automations' }).fill('nothing here');
  await expect(pane.getByText('No automations match “nothing here”')).toBeVisible();
  await capture(page, 'automations-filtered-empty');
  await pane.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByTestId('agent-row')).toHaveCount(4);
  await expect(page).toHaveURL(/\/automations\/def-2$/);
});
