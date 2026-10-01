import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const now = Date.parse('2026-10-01T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const preview = (name: string, type: 'image' | 'video' = 'image') => ({ type, title: name, url: `https://github.com/user-attachments/assets/${name}` });

interface FixtureRun { title: string; subtitle?: string | null; status?: string; minutes: number; took?: number; score?: number | null; previewMedia?: ReturnType<typeof preview>[]; planIssueStatus?: string; commitHash?: string | null; failedReason?: string | null }

// Runs of four pull requests, written the way the backend titles them: workflow verb, repeated
// PR number and model tag in front of what the work is about, plus legacy "Update" follow-ups.
const pullRequest = (prNumber: number, issueNumber: number, runs: FixtureRun[]) => runs.map((run, index) => ({
  id: `pr-${prNumber}-run-${index}`, repository: 'integry/propr', repositoryOwner: 'integry', repositoryName: 'propr',
  issueNumber: prNumber, prNumber, linkedIssueNumber: issueNumber,
  title: run.title, subtitle: run.subtitle ?? null, status: run.status ?? 'completed',
  createdAt: ago(run.minutes), processedAt: ago(run.minutes),
  completedAt: run.status === 'processing' ? null : new Date(Date.parse(ago(run.minutes)) + (run.took ?? 5) * 60_000).toISOString(),
  llmProvider: 'codex', model: 'gpt-6-astra', critiqueScore: run.score ?? null,
  previewMedia: run.previewMedia, planIssueStatus: run.planIssueStatus ?? null,
  commitHash: run.commitHash ?? null, failedReason: run.failedReason ?? null,
}));
const tag = (issue: number) => `[${issue} by GPT-6 Astra]`;
const tasks = [
  ...pullRequest(2664, 2659, [
    { title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Ultrafix cycle 3 (linting)', status: 'processing', minutes: 1 },
    { title: 'Followup: Update', subtitle: 'Update', minutes: 13, took: 1 },
    { title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Restrict issue-level withdrawal labels to actual intent withdrawal', minutes: 19, score: 9 },
    { title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Replace `cancelled_issue_closed` error code with human-readable UI text', minutes: 24, took: 4 },
    ...Array.from({ length: 4 }, (_, index) => ({ title: `Followup: Update ${index + 1}`, minutes: 30 + index * 9 })),
  ]),
  ...pullRequest(2661, 2658, [
    { title: `Review PR #2661: ${tag(2658)} Give implementation runs and direct goals a read-only GitHub token`, subtitle: 'No blocking findings; token scope verified', minutes: 50, took: 8, score: 8 },
    ...Array.from({ length: 6 }, (_, index) => ({
      title: `Follow-up PR #2661: ${tag(2658)} Give implementation runs and direct goals a read-only GitHub token`,
      subtitle: ['Fix seedCommit test failure by updating repoBranching', 'Resolve AntigravityAgent git access conflicts', 'Update repoBranching.ts for read-only tokens', null, 'Tighten token scope checks', null][index],
      minutes: 60 + index * 30, score: index < 3 ? 8 : null,
      // Two runs recorded no summary: one pushed a commit, the other changed nothing.
      commitHash: index === 5 ? null : `9f3c2${index}e81a4d`,
    })),
  ]),
  ...pullRequest(2663, 2660, [
    { title: `Fix PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, subtitle: 'Include validation reports in PR follow-up completion comments', minutes: 51, took: 6, score: 9, previewMedia: [preview('workflow-desktop'), preview('workflow-mobile')] },
    { title: `Review PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, subtitle: 'Multi-model review with Opus and Astra', minutes: 60 },
    { title: `Fix PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, subtitle: 'Address review findings F1 and F2', minutes: 120, score: 9, previewMedia: [preview('findings-desktop'), preview('findings-mobile')] },
    { title: `Review PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`, minutes: 125, took: 3 },
  ]),
  ...pullRequest(2662, 2657, [
    { title: `Merge PR #2662: ${tag(2657)} Create a self-hosted GitHub App in one command (propr github-app create)`, minutes: 62, took: 2, score: 8, planIssueStatus: 'merged' },
    { title: 'Followup: Update', minutes: 120, took: 1 },
    { title: `Ultrafix PR #2662: ${tag(2657)} Create a self-hosted GitHub App in one command (propr github-app create)`, subtitle: 'Fix GitHub App creation callback handling and review findings F1-F3', minutes: 130, took: 8, score: 8, previewMedia: [preview('callback-walkthrough', 'video')] },
  ]),
  {
    id: 'long-title', repository: 'integry/desktop-workspace-with-long-repository-name', issueNumber: 86,
    title: `New Issue: ${tag(86)} Support configuration/desktop/workspaces/a-very-long-unbroken-configuration-filename.json in the task history`,
    status: 'failed', createdAt: ago(300), processedAt: ago(300), completedAt: ago(262),
    llmProvider: 'claude', model: 'a-long-model-identifier-for-desktop-layout-verification', critiqueScore: 4,
  },
];

async function fixture(page: Page, platform?: 'macos' | 'linux') {
  await page.clock.install({ time: now });
  if (platform) await page.addInitScript(platform => {
    const profile = { id: 'layout-fixture', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true, platform,
      app: { onDeepLink: () => () => undefined },
      profiles: { list: async () => [profile], getActiveId: async () => profile.id, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    };
  }, platform);
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/tasks': { tasks, total: 14769 },
      '/api/instance/catalog': { agents: [{ id: 'fixture', name: 'Fixture agent', defaultModel: 'gpt-6-astra' }], repositories: [{ name: 'integry/propr' }] },
      '/api/queue/stats': { active: 1, waiting: 1, completed: 3, failed: 1 },
      '/api/stats/generating-plans': { count: 0 },
      '/api/stats/tasks': { summary: { total: 7, completed: 3, failed: 1, active: 1, waiting: 1 }, dailyCounts: [], statusDistribution: [], avgProcessingTime: [] },
      '/api/stats/overview': { usage: { total_cost_usd: 0, total_tokens: 0, models: {} }, tasks: { completed: 3, planned: 7, pr_iterations_avg: 1, merged_prs: 1, total_followups: 5 }, system: { repos_indexed: 2 } },
      '/api/stats/repositories': { repositories: [{ repository: 'integry/propr', total: 14768, completed: 3, failed: 1, inProgress: 1, successRate: 43 }, { repository: 'integry/desktop-workspace-with-long-repository-name', total: 1, completed: 0, failed: 1, inProgress: 0, successRate: 0 }] },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in privacy-safe layout fixture' } });
  });
}

const capture = async (page: Page, name: string) => {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
};

for (const platform of [undefined, 'macos', 'linux'] as const) {
  for (const width of [1280, 1920]) {
    test(`${platform ?? 'web'} ${width}px Tasks is a flat, navigable ledger`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1920 ? 1080 : 820 });
      await fixture(page, platform);
      await page.goto('/tasks');
      const table = page.getByRole('table', { name: 'Tasks' });
      await expect(table).toBeVisible();
      // The column schema is the same at every width and in every row state.
      const headers = table.getByRole('columnheader');
      const columns = ['Task / PR', 'Repo', 'Status', 'Agent', 'Duration', 'Updated', 'Score'];
      await expect(headers).toHaveText(columns);
      for (const header of await headers.all()) await expect(header).toBeVisible();

      // One row per pull request, sanitized titles, no thumbnails and no nested threads.
      const rows = table.getByTestId('task-row');
      await expect(rows).toHaveCount(5);
      await expect(table).not.toContainText('by GPT-6 Astra]');
      await expect(table).not.toContainText('Ultrafix PR #2664');
      await expect(table.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
      await expect(table.locator('img, canvas, video')).toHaveCount(0);
      await expect(table.getByTestId('preview-count').first()).toHaveText('2 previews');
      await expect(page.getByText('Showing 1–50 of 14,769 tasks')).toBeVisible();

      const layout = await table.evaluate(element => ({
        fits: element.getBoundingClientRect().right <= window.innerWidth,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        heights: [...element.querySelectorAll('[data-testid="task-row"] > [role="row"]')].map(row => row.getBoundingClientRect().height),
      }));
      expect(layout.fits).toBe(true);
      expect(layout.pageFits).toBe(true);
      for (const height of layout.heights) expect(height).toBeLessThanOrEqual(84);
      expect(await table.getByRole('button', { name: /^Stop work when/ }).evaluate(node => node.parentElement!.clientWidth)).toBeGreaterThan(200);
      // A long unbroken path in a title wraps inside its own cell: the metadata cells of that row
      // keep exactly their column widths, and REPO (10rem) and AGENT (11rem) never shrink.
      const columnWidths = await table.evaluate(element => {
        const widths = (cells: Element[]) => cells.slice(1, 4).map(cell => Math.round(cell.getBoundingClientRect().width));
        const longRow = [...element.querySelectorAll('[data-testid="task-row"]')].find(row => row.textContent!.includes('a-very-long-unbroken'))!;
        return {
          header: widths([...element.querySelectorAll('[role="columnheader"]')]),
          longRow: widths([...longRow.querySelector('[role="row"]')!.children]),
        };
      });
      expect(columnWidths.longRow).toEqual(columnWidths.header);
      expect(columnWidths.header).toEqual(width === 1920 ? [160, 128, 176] : [160, 112, 176]);
      // The lead chips sit a full table inset (2rem) in from the list's left edge.
      const inset = await table.evaluate(element => {
        const chip = element.querySelector('[data-testid="task-row"] [title^="Pull request"]')!.getBoundingClientRect();
        return Math.round(chip.left - element.getBoundingClientRect().left);
      });
      expect(inset).toBe(32);
      // Titles wrap rather than being cut mid-word. The title column absorbs all the width the fixed
      // metadata columns leave, so a laptop-width list clamps a long title at two lines (the full
      // title stays in the tooltip); on a wide screen it fits on one line.
      const longTitle = table.getByRole('button', { name: 'Give implementation runs and direct goals a read-only GitHub token' });
      const clamp = await longTitle.locator('span').evaluate(node => ({ clipped: node.scrollHeight > node.clientHeight + 1, lines: Math.round(node.clientHeight / 20) }));
      expect(clamp.lines).toBe(width === 1920 ? 1 : 2);
      if (width === 1920) expect(clamp.clipped).toBe(false);
      await expect(longTitle).toHaveAttribute('title', 'Give implementation runs and direct goals a read-only GitHub token');
      if (platform !== 'linux') await capture(page, `tasks-ledger-${platform ?? 'web'}-${width}`);

      // The rollup opens in place, never navigates, and a mouse click leaves no focus frame behind.
      const rollup = table.getByRole('button', { name: /6 earlier runs/ });
      await rollup.click();
      await expect(rollup).toHaveAttribute('aria-expanded', 'true');
      await expect(rollup).toHaveCSS('outline-style', 'none');
      await expect(rollup).toHaveCSS('box-shadow', 'none');
      await expect(rollup).toHaveCSS('text-decoration-line', 'none');
      await expect(headers).toHaveText(columns);
      const runs = table.getByRole('list', { name: 'Earlier runs' });
      await expect(runs.getByRole('listitem')).toHaveCount(6);
      await expect(runs).toContainText('Resolve AntigravityAgent git access conflicts');
      expect(new URL(page.url()).pathname).toBe('/tasks');
      // Runs are one timeline block over TASK / PR through STATUS, each labelled by what it did
      // rather than "Follow-up", and a run with no summary states its outcome instead of filler.
      await expect(runs.locator('xpath=ancestor::*[@role="cell"][1]')).toHaveAttribute('aria-colspan', '3');
      await expect(runs.getByTestId('work-type-badge').first()).toHaveText('Fix');
      await expect(runs.getByTestId('work-type-badge').filter({ hasText: /follow-up/i })).toHaveCount(0);
      await expect(runs).not.toContainText(/follow-up run/i);
      await expect(runs).toContainText('Pushed commit 9f3c23e');
      await expect(runs).toContainText('No code changes: finished without a commit');
      // Run timestamps are secondary but legible: slate-500 (#64748b), 4.76:1 on white.
      await expect(runs.locator('time').first()).toHaveCSS('color', 'rgb(100, 116, 139)');
      const timeline = await table.evaluate(element => {
        const headers = [...element.querySelectorAll('[role="columnheader"]')].map(header => header.getBoundingClientRect());
        const list = element.querySelector('[aria-label="Earlier runs"]')!;
        const caret = element.querySelector(`[aria-controls="${list.id}"] .task-rollup-caret`)!.getBoundingClientRect();
        const rail = getComputedStyle(list, '::before');
        const listBox = list.getBoundingClientRect();
        return {
          blockRight: list.closest('[role="cell"]')!.getBoundingClientRect().right,
          statusRight: headers[2].right,
          // Each score sits right after the summary it grades, not out on the SCORE rail.
          scoreGaps: [...list.querySelectorAll('.task-run')].flatMap(run => {
            const score = run.querySelector('[title^="Code Quality Score"]');
            const summary = run.querySelector('.task-run-summary');
            return score && summary ? [score.getBoundingClientRect().left - summary.getBoundingClientRect().right] : [];
          }),
          railCentre: listBox.left + parseFloat(rail.borderLeftWidth) / 2,
          caretCentre: caret.left + caret.width / 2,
          railTop: listBox.top + parseFloat(rail.top),
          caretTop: caret.top,
          caretBottom: caret.bottom,
        };
      });
      expect(timeline.blockRight).toBeLessThanOrEqual(timeline.statusRight + 1);
      expect(timeline.scoreGaps).toHaveLength(3);
      for (const gap of timeline.scoreGaps) expect(gap).toBeLessThanOrEqual(12);
      // The rail is threaded from the caret: it starts inside the caret's box, on its centre line.
      expect(Math.abs(timeline.railCentre - timeline.caretCentre)).toBeLessThanOrEqual(1);
      expect(timeline.railTop).toBeGreaterThanOrEqual(timeline.caretTop);
      expect(timeline.railTop).toBeLessThanOrEqual(timeline.caretBottom);
      if (platform === undefined && width === 1920) await capture(page, 'tasks-ledger-rollup-expanded');
      if (platform === undefined && width === 1280) await capture(page, 'tasks-ledger-rollup-expanded-1280');

      // Keyboard focus is still visible on the toggle.
      await rollup.focus();
      await page.keyboard.press('Enter');
      await expect(rollup).toHaveAttribute('aria-expanded', 'false');
      await expect(rollup).toHaveCSS('text-decoration-line', 'underline');

      const title = table.getByRole('button', { name: 'Stop work when an issue or PR withdraws intent' });
      await title.focus();
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/tasks\/pr-2664-run-0$/);
    });
  }
}

for (const platform of [undefined, 'macos', 'linux'] as const) {
  test(`${platform ?? 'web'} 880px narrow list shows cards instead of squeezing the ledger`, async ({ page }) => {
    await page.setViewportSize({ width: 880, height: 820 });
    await fixture(page, platform);
    await page.goto('/tasks');
    // Too narrow for the fixed metadata columns plus a readable title, so no squeezed table.
    await expect(page.getByText('Stop work when an issue or PR withdraws intent').first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Tasks' })).not.toBeVisible();
    await expect(page.locator('body')).not.toContainText('by GPT-6 Astra]');
    await expect(page.getByTestId('preview-count').first()).toHaveText('2 previews');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const rollup = page.getByRole('button', { name: /6 earlier runs/ });
    await rollup.click();
    await expect(rollup).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('list', { name: 'Earlier runs' }).getByRole('listitem')).toHaveCount(6);
    expect(new URL(page.url()).pathname).toBe('/tasks');
    if (platform !== 'linux') await capture(page, `tasks-ledger-${platform ?? 'web'}-880`);
  });
}

test('mobile renders one card per pull request', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tasks');
  await expect(page.getByRole('table', { name: 'Tasks' })).not.toBeVisible();
  await expect(page.getByText('Stop work when an issue or PR withdraws intent').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('by GPT-6 Astra]');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, 'tasks-ledger-mobile');
});

test('desktop task list does not present an empty state while its scoped read is pending', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await fixture(page, 'macos');
  let releaseTasks!: () => void;
  const tasksPending = new Promise<void>(resolve => { releaseTasks = resolve; });
  await page.route('**/api/tasks*', async route => {
    await tasksPending;
    await route.fulfill({ json: { tasks: [], total: 0 } });
  });

  await page.goto('/tasks');
  await expect(page.getByText('Loading tasks...')).toBeVisible();
  await expect(page.getByText(/No tasks found/)).toHaveCount(0);

  releaseTasks();
  await expect(page.getByText(/No tasks found/)).toBeVisible();
  await expect(page.getByText('Loading tasks...')).toHaveCount(0);
});
