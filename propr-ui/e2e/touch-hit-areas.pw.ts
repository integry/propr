/**
 * Phone and small-window touch rules (#3609).
 *
 * On a touch layout every control answers a tap across at least 32x32 CSS px,
 * whatever it looks like: a small icon or a line of link text keeps its
 * visual size and takes the tap in an invisible box around it. The box is
 * measured, then hit-tested at its edges, so a box another layer covers or an
 * ancestor clips fails here too.
 *
 * Beside that rule: a phone hides the keyboard hints that only a keyboard can
 * use, a short landscape window opens a task on a one-line header that leaves
 * the timeline room, and the goal and navigation layouts fit 320px.
 *
 * Every route runs against stubbed HTTP and a closed socket.
 */
import { expect, test, type Page } from '@playwright/test';
import { fixture as dashboardFixture, user as dashboardUser } from './dashboard-sections.fixture';
import { openSearchFromMenu, openPhone } from './mobile-menu-search.fixture';
import { installSettingsFixture } from './settings-layout.fixture';
import { fixture as studioFixture } from './planner-studio.fixture';
import { fixture as taskFixture, selectedRun } from './task-list-desktop.fixture';
import {
  automation, capture, expectTappable, PHONE, stubApi, stubAutomations, stubGoal, stubLlmLogs, stubRepositories, touchContext,
} from './touch-hit-areas.fixture';

/** Opens `route` on a 390px phone after `stub` installs its API. */
async function openOnPhone(page: Page, stub: (page: Page) => Promise<unknown>, route: string) {
  await stub(page);
  await page.goto(route);
  await expect(page.getByRole('main').first()).toBeVisible();
}

test('the automation form: capabilities, repository chips and the repository picker', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await openOnPhone(page, stubAutomations, `/automations/${automation.id}`);
  const form = page.getByTestId('agent-editor');
  await expectTappable(form.locator('input[id^="agent-capability-"]'), 'Capability checkbox');
  await expectTappable(form.getByRole('button', { name: 'Remove integry/propr' }), 'Remove repository chip');
  await expectTappable(form.getByRole('button', { name: /Add repository/ }), 'Add repository…');
  await capture(page, 'touch-automation-form-390');
  await context.close();
});

test('Settings: workflow tags and the Integrations controls', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await installSettingsFixture(page);
  await page.goto('/settings?tab=workflow');
  await expectTappable(page.getByRole('button', { name: /^Remove /, disabled: false }), 'Workflow tag Remove');

  await page.goto('/settings?tab=integrations');
  await expectTappable(page.getByRole('checkbox', { name: /^(read|plan|execute)$/ }), 'MCP scope checkbox');
  await expectTappable(page.getByRole('button', { name: 'Copy', exact: true }), 'Copy connection URL');
  const apps = page.getByRole('link', { name: 'View connected apps →' });
  const revoke = page.getByRole('button', { name: 'Revoke all connections' });
  await expectTappable(apps, 'View connected apps');
  await expectTappable(revoke, 'Revoke all connections');
  // The destructive action sits on its own row, well apart from the navigation link.
  const [appsBox, revokeBox] = [await apps.boundingBox(), await revoke.boundingBox()];
  expect(revokeBox!.y - (appsBox!.y + appsBox!.height)).toBeGreaterThanOrEqual(16);
  await expectTappable(page.getByRole('button', { name: 'Refresh status' }), 'Refresh status');
  await revoke.scrollIntoViewIfNeeded();
  await capture(page, 'touch-settings-integrations-390');
  await context.close();
});

test('Repositories: the View on GitHub links', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await openOnPhone(page, stubRepositories, '/repositories');
  await expectTappable(page.getByRole('link', { name: /^View .* on GitHub$/ }), 'View on GitHub');
  await capture(page, 'touch-repositories-390');
  await context.close();
});

test('LLM Log: the row expand buttons', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await openOnPhone(page, stubLlmLogs, '/llm-logs');
  await expectTappable(page.getByRole('button', { name: 'Show details' }), 'LLM log expand');
  await capture(page, 'touch-llm-log-390');
  await context.close();
});

test('Dashboard: section links, Show more and the stats period', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await dashboardFixture(page, PHONE);
  await page.goto('/');
  await expectTappable(page.getByRole('link', { name: /^View (all|tasks)$/ }), 'Section link');
  await expectTappable(page.getByRole('button', { name: /^Show \d+ more$/ }), 'Show more');
  await expectTappable(page.getByRole('group', { name: 'Stats period' }).getByRole('button'), 'Stats period');
  await capture(page, 'touch-dashboard-390', true);
  await context.close();
});

test('Analytics: the usage range and the table toggle', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await dashboardFixture(page, PHONE);
  await page.route('**/api/auth/user', route => route.fulfill({ json: { ...dashboardUser, permissions: ['instance.manage_agents'] } }));
  await page.route('**/api/config/agent-tank/history?**', route => route.fulfill({ json: { enabled: true, source: 'propr', retentionDays: 15, agents: [{
    agent: 'claude', series: [{ key: 'session', label: 'Current session', model: null, cycle: 'session',
      points: [0, 1, 2, 3].map(hour => ({ t: new Date(Date.parse('2026-09-23T08:00:00Z') + hour * 3_600_000).toISOString(), percent: hour * 10 })) }],
  }] } }));
  await page.goto('/analytics');
  const usage = page.getByTestId('analytics-usage-history');
  await expectTappable(usage.getByRole('button', { name: /^Quota usage,/ }), 'Usage range', 4);
  await expectTappable(usage.getByRole('button', { name: /^(Table|Chart)$/ }), 'Table toggle');
  await capture(page, 'touch-analytics-390');
  await context.close();
});

test('Studio: issue links and the execution mode', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await studioFixture(page);
  await page.goto('/studio/plan-agents-exec');
  const matrix = page.getByTestId('plan-execution-matrix');
  await expectTappable(matrix.locator('a[href*="/issues/"]'), 'Studio issue link');
  await expectTappable(page.getByRole('radiogroup', { name: 'Execution mode' }).getByRole('radio'), 'Execution mode');
  await capture(page, 'touch-studio-390');
  await context.close();
});

test('Inbox: pull request reference links', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  const occurredAt = new Date().toISOString();
  await stubApi(page, {
    '/api/auth/demo-mode': { demoMode: false }, '/api/auth/user': dashboardUser,
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
    '/api/notifications/preferences': { preferences: {}, quietHours: { start: null, end: null, timezone: 'UTC' }, badgeEnabled: false },
    '/api/instance/catalog': { repositories: [], agents: [] },
  }, 'Inbox');
  await page.goto('/inbox');
  await expectTappable(page.getByRole('link', { name: /PR #77 on GitHub/ }), 'Inbox PR link');
  await capture(page, 'touch-inbox-390');
  await context.close();
});

test('Global search on a phone: no keyboard hints, and tappable tabs and footer links', async ({ browser }) => {
  const { context, page } = await openPhone(browser, PHONE);
  const { sheet, input } = await openSearchFromMenu(page);
  await input.fill('mcp');
  const palette = page.getByTestId('global-search-palette');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await expect(palette.getByTestId('global-search-key-hints')).toBeHidden();
  await expect(palette.getByText(/navigate$/)).toBeHidden();
  await expectTappable(palette.getByRole('tab'), 'Search result tab', 6);
  await expectTappable(palette.getByRole('button', { name: /^Search all plans for/ }), 'Search all plans');
  await expectTappable(palette.getByRole('button', { name: /^Search all tasks for/ }), 'Search all tasks');
  await expect(sheet).toBeVisible();
  await capture(page, 'touch-global-search-390');
  await context.close();
});

test('Global search on a desktop keeps its keyboard hints', async ({ browser }) => {
  const { context, page } = await touchContext(browser, { width: 1280, height: 820 }, false);
  await dashboardFixture(page, { width: 1280, height: 820 }, [], []);
  const created = new Date().toISOString();
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { total: 1, page: 1, limit: 5, hasMore: false, drafts: [{
    draft_id: 'plan-1', repository: 'example/workspace', name: 'MCP observability', initial_prompt: 'Report MCP progress.',
    status: 'review', created_at: created, updated_at: created, issue_summary: { total: 2, pending: 1, processing: 0, merged: 1, closed: 0 },
  }] } }));
  await page.route('**/api/tasks?**', route => route.fulfill({ json: { total: 1, tasks: [{
    id: 'task-1', title: 'Expose MCP activity', status: 'completed', prNumber: 2480, score: 9, repository: 'example/workspace',
    issueNumber: 2400, model: 'gpt-6-astra', subtitle: 'Wire the MCP surface.', createdAt: created,
  }] } }));
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Search' }).fill('mcp');
  await expect(page.getByTestId('global-search-key-hints')).toContainText('navigate');
  await expect(page.getByText(/navigate$/)).toBeVisible();
  await context.close();
});

test('goal detail at 320: the output switch fits and nothing scrolls sideways', async ({ browser }) => {
  const { context, page } = await touchContext(browser, { width: 320, height: 568 });
  await stubGoal(page);
  await page.goto('/goals/goal-1');
  for (const name of ['Human readable', 'Raw terminal']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.x, `${name} starts inside the window`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} ends inside the window`).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Human readable', exact: true }).scrollIntoViewIfNeeded();
  await capture(page, 'touch-goal-switch-320');
  await context.close();
});

test('goal detail at 390: the actions menu shares a row with another action', async ({ browser }) => {
  const { context, page } = await touchContext(browser);
  await stubGoal(page);
  await page.goto('/goals/goal-1');
  const more = page.getByLabel('More goal actions');
  await expect(more).toBeVisible();
  const centre = (box: { y: number; height: number } | null) => box!.y + box!.height / 2;
  const menuCentre = centre(await more.boundingBox());
  const actions = page.locator('header').filter({ has: more }).locator('button, a').filter({ hasText: /Pause|Cancel|Review final PR/ });
  const centres = await Promise.all((await actions.all()).map(async action => centre(await action.boundingBox())));
  expect(centres.length).toBeGreaterThan(0);
  expect(centres.some(value => Math.abs(value - menuCentre) <= 4), `menu at ${menuCentre}, actions at ${centres.join(', ')}`).toBe(true);
  await capture(page, 'touch-goal-header-390');
  await context.close();
});

test('goal detail at 1024: the composer leaves the Metrics uncovered', async ({ browser }) => {
  const { context, page } = await touchContext(browser, { width: 1024, height: 768 }, false);
  await stubGoal(page);
  await page.goto('/goals/goal-1');
  const metrics = page.locator('section[aria-labelledby="goal-metrics-heading"]');
  const composer = page.locator('section[aria-labelledby="correction-heading"]');
  await expect(composer).toBeVisible();
  const [m, c] = [(await metrics.boundingBox())!, (await composer.boundingBox())!];
  const overlaps = m.x < c.x + c.width && c.x < m.x + m.width && m.y < c.y + c.height && c.y < m.y + m.height;
  expect(overlaps, `metrics ${JSON.stringify(m)}, composer ${JSON.stringify(c)}`).toBe(false);
  await capture(page, 'goal-composer-1024');
  await context.close();
});

test('the bottom navigation labels fit at 320', async ({ browser }) => {
  const { context, page } = await touchContext(browser, { width: 320, height: 568 });
  await dashboardFixture(page, { width: 320, height: 568 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav).toBeVisible();
  const clipped = await nav.locator('a > span:last-child, button > span:last-child').evaluateAll(labels => labels
    .filter(label => label.scrollWidth > label.clientWidth).map(label => label.textContent));
  expect(clipped).toEqual([]);
  await capture(page, 'touch-bottom-navigation-320');
  await context.close();
});

test('a task in a landscape phone opens on a one-line header over 150px of timeline', async ({ browser }) => {
  const { context, page } = await touchContext(browser, { width: 844, height: 390 });
  await taskFixture(page);
  await page.goto(`/tasks/${selectedRun}`);
  await expect(page.getByTestId('run-timeline-run').first()).toBeVisible();
  const header = page.getByTestId('task-short-header');
  await expect(header).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48);
  const heading = (await page.getByTestId('task-timeline-heading').boundingBox())!;
  const logBar = (await page.locator('button[aria-controls="execution-event-log-content"]').boundingBox())!;
  expect(logBar.y - (heading.y + heading.height)).toBeGreaterThanOrEqual(150);
  await capture(page, 'touch-task-short-844x390');
  await context.close();
});
