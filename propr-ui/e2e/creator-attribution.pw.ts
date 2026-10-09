import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Who created each plan, goal, automation and to-do: shown on each row's existing metadata line
// when more than one person's items are visible, and hidden when they all share one creator.

const now = Date.parse('2026-10-09T12:00:00.000Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const octocat = { id: '583231', login: 'octocat', displayName: 'The Octocat', avatarUrl: null };
const hubot = { id: '480938', login: 'hubot', displayName: null, avatarUrl: null };
type Creator = typeof octocat | typeof hubot | null;

/** The creators of the three rows on every surface; the last one has no cached profile. */
const MIXED: Creator[] = [octocat, hubot, null];
const SINGLE: Creator[] = [octocat, octocat, null];

const longTitle = 'Teach the repository indexer to resume an interrupted crawl without rescanning every tree';

const draft = (index: number, createdBy: Creator) => ({
  draft_id: `draft-${index}`, repository: index === 1 ? 'integry/api' : 'integry/propr',
  name: index === 0 ? longTitle : `Plan number ${index + 1}`, initial_prompt: 'Plan', status: 'review',
  updated_at: ago(30 + index), created_at: ago(90), created_by: createdBy,
});

const goal = (index: number, createdBy: Creator) => ({
  id: `goal-${index}`, owner: createdBy?.id ?? 'unknown', createdBy, repository: 'integry/propr',
  title: index === 0 ? longTitle : `Goal number ${index + 1}`,
  objective: 'Ship the change with every check green and a reviewed pull request ready to merge into the base branch.',
  launchStrategy: 'orchestrate', initialPrompt: '/goal Ship', attachments: [],
  baseBranch: null, branchName: `goal/${index}`, worktreePath: `/tmp/goal-${index}`,
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: `goal-task-${index}`, sessionId: null, conversationId: null, finalPr: null, checkpoint: null, artifacts: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 0, openPullRequests: 0 },
  liveSummary: { currentTask: null, todos: [], tokenUsage: { input_tokens: 1200, output_tokens: 400 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: ago(60), updatedAt: ago(5),
  startedAt: ago(60), pausedAt: null, completedAt: null,
  elapsedMs: 120_000, activeMs: 120_000, pausedMs: 0,
});

const definition = (index: number, createdBy: Creator) => ({
  id: `def-${index}`, ownerId: createdBy?.id ?? 'unknown', createdBy,
  name: index === 0 ? longTitle : `Automation number ${index + 1}`, description: null,
  repositories: ['integry/propr'], prompt: 'Summarize', attachments: [], agentAlias: 'codex-main', modelName: 'gpt-5.6-sol',
  capabilities: ['repository_read'], includePreviousReports: false, previousReportsLimit: 0,
  scheduleCron: '0 * * * *', scheduleTimezone: 'UTC', scheduleEnabled: true, nextRunAt: now + 36 * 60_000,
  autonomyMode: 'dry_run', enabled: true, revision: 1, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
});

const todo = (index: number, createdBy: Creator, categoryId: string | null = null) => ({
  todoId: `todo-${index}`, categoryId, content: index === 0 ? longTitle : `To-do number ${index + 1}`,
  orderIndex: index, isCompleted: false, linkedDraftId: index === 1 ? 'draft-1' : null, createdBy,
  createdAt: ago(60), updatedAt: ago(60),
});

const repos = [{ id: 'propr', name: 'integry/propr', enabled: true, visualPreview: { enabled: false, types: ['image'] } }];

/** `todoCategories[i]` names the category of to-do `i`; unnamed to-dos stay uncategorized. */
async function stub(page: Page, creators: Creator[], todoCategories: (string | null)[] = []) {
  await page.clock.install({ time: now });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const drafts = creators.map((creator, index) => draft(index, creator));
    const goals = creators.map((creator, index) => goal(index, creator));
    const definitions = creators.map((creator, index) => definition(index, creator));
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: octocat.id, login: 'octocat', username: 'octocat', displayName: 'The Octocat', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings'], authorizationSource: 'local' },
      '/api/instance/catalog': {
        agents: [{ alias: 'codex-main', type: 'codex', enabled: true, supportedModels: ['gpt-5.6-sol'], defaultModel: 'gpt-5.6-sol' }],
        defaultAgentAlias: 'codex-main', repositories: repos,
      },
      '/api/planner/drafts': { drafts, total: drafts.length, page: 1, limit: 50, hasMore: false },
      '/api/planner/drafts/repositories': { repositories: [{ repo: 'integry/propr', count: 2 }, { repo: 'integry/api', count: 1 }], total: 3 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/goals': { goals },
      '/api/goals/capabilities': { agents: [] },
      ...Object.fromEntries(goals.map(item => [`/api/goals/${item.id}`, { goal: item }])),
      ...Object.fromEntries(goals.map(item => [`/api/goals/${item.id}/previews`, { previews: [] }])),
      ...Object.fromEntries(goals.map(item => [`/api/task/${item.taskId}/live-details`, { events: [], todos: [], currentTask: null }])),
      '/api/agent-definitions': { definitions, total: definitions.length, limit: 200, offset: 0 },
      '/api/config/repos': { success: true, repos_to_monitor: repos },
      '/api/github/repos': { repos: [] },
      '/api/config/settings': {},
      '/api/user/repo-preferences': { preferences: {} },
      '/api/repositories/indexing-status': { repositories: [] },
      '/api/repos/chat/messages': { messages: [] },
      '/api/repos/todos': { todos: creators.map((creator, index) => todo(index, creator, todoCategories[index] ?? null)) },
      '/api/repos/todos/categories': {
        categories: [...new Set(todoCategories.filter(Boolean))].map((name, index) => ({
          categoryId: name, name, orderIndex: index, createdAt: ago(90), updatedAt: ago(90),
        })),
      },
      '/api/tasks': { tasks: [], total: 0 },
      '/api/queue/stats': { active: 0, waiting: 0, completed: 0, failed: 0 },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(pathname in responses ? { json: responses[pathname] } : { status: 503, json: { error: 'Unavailable in creator fixture' } });
  });
}

interface Surface {
  name: string;
  open: (page: Page) => Promise<void>;
  /** One element per row, in fixture order. */
  rows: (page: Page) => Locator;
  /** Whether the surface shows the creator below `sm` (the plans row drops it there). */
  mobile: boolean;
}

const surfaces: Surface[] = [
  {
    name: 'plans',
    open: async page => {
      await page.goto('/plans');
      await expect(page.getByText('Plan number 2')).toBeVisible();
    },
    rows: page => page.locator('div.group.border-b:has(a[href^="/studio/draft-"])'),
    mobile: false,
  },
  {
    name: 'goals',
    open: async page => {
      await page.goto('/goals');
      await expect(page.getByText('Goal number 2')).toBeVisible();
    },
    rows: page => page.getByRole('list', { name: 'Goal work queue' }).locator('> li'),
    mobile: true,
  },
  {
    name: 'automations',
    open: async page => {
      await page.goto('/automations');
      await expect(page.getByText('Automation number 2')).toBeVisible();
    },
    rows: page => page.getByTestId('agent-row'),
    mobile: true,
  },
  {
    name: 'to-dos',
    open: async page => {
      await page.goto('/repositories');
      await page.getByRole('button', { name: 'Select integry/propr', exact: true }).first().click();
      await page.getByRole('button', { name: 'To-Dos', exact: true }).click();
      await expect(page.getByText('To-do number 2')).toBeVisible();
    },
    rows: page => page.locator('div.group:has(> button[aria-label^="Select todo:"])'),
    mobile: true,
  },
];

async function capture(target: Page | Locator, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await target.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

const heights = (rows: Locator) => rows.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));

/** Every element whose content is wider than its box and is not allowed to scroll or clip it. */
const overflowing = (page: Page) => page.evaluate(() => {
  const root = document.documentElement;
  const found: string[] = [];
  if (root.scrollWidth > root.clientWidth) found.push(`document ${root.scrollWidth} > ${root.clientWidth}`);
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="creator-marker"]'))) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.right > root.clientWidth + 0.5) found.push(`creator marker at ${box.right}`);
  }
  return found;
});

for (const surface of surfaces) {
  test.describe(surface.name, () => {
    test('shows each known creator as avatar plus login without growing a row', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await stub(page, SINGLE);
      await surface.open(page);
      const before = await heights(surface.rows(page));
      await expect(page.getByTestId('creator-marker')).toHaveCount(0);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await stub(page, MIXED);
      await surface.open(page);
      const rows = surface.rows(page);
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0).getByRole('group', { name: 'Created by @octocat' })).toBeVisible();
      await expect(rows.nth(1).getByRole('group', { name: 'Created by @hubot' })).toBeVisible();
      // The row whose creator is unknown renders no marker, so it leaves no gap either.
      await expect(rows.nth(2).getByTestId('creator-marker')).toHaveCount(0);
      if (surface.name === 'to-dos') {
        // Avatar only: the login is in the tooltip and the accessible name, never in the dense row.
        await expect(rows.nth(0).getByText('@octocat')).toHaveCount(0);
      } else {
        await expect(rows.nth(0).getByText('@octocat')).toBeVisible();
      }
      expect(await heights(rows)).toEqual(before);
      await capture(page, `creator-${surface.name}-desktop`);
    });

    test('hides the creator when every visible item shares one', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await stub(page, SINGLE);
      await surface.open(page);
      await expect(surface.rows(page)).toHaveCount(3);
      await expect(page.getByTestId('creator-marker')).toHaveCount(0);
    });

    for (const width of [320, 390, 1024, 1920]) {
      test(`has no horizontal overflow at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await stub(page, MIXED);
        await surface.open(page);
        const markers = page.getByTestId('creator-marker');
        if (width < 640 && !surface.mobile) await expect(markers.first()).toBeHidden();
        else await expect(markers.first()).toBeVisible();
        expect(await overflowing(page)).toEqual([]);
        if (width === 390) await capture(page, `creator-${surface.name}-mobile`);
      });
    }
  });
}

test('to-dos hide the creator once the only category with a second creator is collapsed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, [octocat, octocat, hubot], ['Alpha', 'Alpha', 'Beta']);
  await surfaces[3].open(page);
  await expect(page.getByText('To-do number 3')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Created by @hubot' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Created by @octocat' })).toHaveCount(2);
  await capture(page, 'creator-to-dos-categories-expanded');

  // The header's first <button> is the expand toggle; the drag handle before it is a div with role="button".
  const beta = page.locator('div.group', { has: page.locator('> span', { hasText: /^Beta$/ }) });
  await beta.locator('> button').first().click();
  await expect(page.getByText('To-do number 3')).toHaveCount(0);
  // Only octocat's to-dos are on screen now, so no row carries a marker.
  await expect(page.getByText('To-do number 2')).toBeVisible();
  await expect(page.getByTestId('creator-marker')).toHaveCount(0);
  await capture(page, 'creator-to-dos-category-collapsed');

  await beta.locator('> button').first().click();
  await expect(page.getByRole('group', { name: 'Created by @hubot' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Created by @octocat' })).toHaveCount(2);
});

test('the plans row stays one line on desktop with the creator in the status strip', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await stub(page, MIXED);
  await surfaces[0].open(page);
  const strip = page.getByRole('group', { name: 'Created by @octocat' }).locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]');
  const stripBox = await strip.boundingBox();
  const markerBox = await page.getByRole('group', { name: 'Created by @octocat' }).boundingBox();
  // The marker shares the strip's single line rather than wrapping beneath it.
  expect(stripBox!.height).toBeLessThan(30);
  expect(Math.abs((markerBox!.y + markerBox!.height / 2) - (stripBox!.y + stripBox!.height / 2))).toBeLessThan(2);
});

test('the goals queue keeps its column widths and its truncated second line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stub(page, SINGLE);
  await surfaces[1].open(page);
  const columns = () => page.getByTestId('goal-queue-columns').locator('> span').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().width)));
  const before = await columns();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stub(page, MIXED);
  await surfaces[1].open(page);
  expect(await columns()).toEqual(before);
  const line = page.getByRole('list', { name: 'Goal work queue' }).locator('> li').first().locator('p');
  await expect(line.getByRole('group', { name: 'Created by @octocat' })).toBeVisible();
  // One 20px line, and the objective truncates instead of wrapping.
  expect(Math.round((await line.boundingBox())!.height)).toBe(20);
  const objective = line.locator('span.truncate').last();
  expect(await objective.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
});

test('the goal detail header aligns the creator on the repository chip baseline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, MIXED);
  await page.goto('/goals/goal-1');
  const chip = page.getByRole('group', { name: 'Created by @hubot' });
  await expect(chip).toBeVisible();
  const baseline = (locator: Locator) => locator.evaluate(node => {
    // The bottom of a text run's glyph box sits a fixed distance below its baseline for one font and size.
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().bottom;
  });
  const login = chip.getByText('@hubot');
  const repository = page.getByTestId('repository-chip').locator('span.truncate').first();
  expect(Math.abs(await baseline(login) - await baseline(repository))).toBeLessThan(1);
  await capture(page.locator('header').filter({ has: chip }), 'creator-goal-detail-header');
});
