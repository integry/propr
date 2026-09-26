import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const goalId = 'goal-1';
const timestamp = '2026-09-23T09:00:00.000Z';
const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
const previews = [
  { type: 'image', title: 'Goal dashboard at desktop width', description: 'The published evidence for this goal.', url: asset('dashboard') },
  { type: 'video', title: 'Dashboard walkthrough', url: asset('walkthrough') },
  { type: 'image', title: 'Filter panel', description: 'The filter panel after the change.', url: asset('filters') },
];

const goal = {
  id: goalId, owner: 'operator', repository: 'acme/web',
  title: 'Launch Customer Analytics Dashboard',
  objective: 'Ship the dashboard with published visual evidence on the goal PR.',
  launchStrategy: 'orchestrate', initialPrompt: '/goal Ship the dashboard', attachments: [],
  baseBranch: null, branchName: 'goal/dashboard', worktreePath: '/tmp/goal-dashboard',
  agent: { id: 'agent-1', alias: 'codex', type: 'codex' },
  requestedModel: 'gpt-5.6-sol', effectiveModel: 'gpt-5.6-sol',
  maxParallelTasks: 3, ultrafix: true, desiredState: 'running', resultState: null,
  failureReason: null, pausePending: false,
  control: { requestGeneration: 0, acknowledgedGeneration: 0, pending: false },
  taskId: 'goal-task-1', sessionId: 'thread-1', conversationId: null,
  finalPr: { number: 42, url: 'https://github.com/acme/web/pull/42' },
  checkpoint: null, artifacts: [],
  artifactStats: { issues: 0, openIssues: 0, pullRequests: 1, openPullRequests: 1 },
  liveSummary: { currentTask: 'Publish evidence', todos: [], tokenUsage: { input_tokens: 1200, output_tokens: 400 }, nativeGoal: null },
  taskState: 'claude_execution', createdAt: timestamp, updatedAt: timestamp,
  startedAt: timestamp, pausedAt: null, completedAt: null,
  elapsedMs: 120_000, activeMs: 120_000, pausedMs: 0,
};

async function fixture(page: Page) {
  let image: Buffer | undefined;
  let showPreviews = false;
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('https://github.com/user-attachments/assets/**', route => image && !route.request().url().endsWith('walkthrough')
    ? route.fulfill({ contentType: 'image/png', body: image }) : route.abort());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      '/api/instance/catalog': { agents: [], repositories: [{ name: 'acme/web', enabled: true }] },
      '/api/goals/capabilities': { agents: [] },
      '/api/goals': { goals: [goal] },
      '/api/tasks': { tasks: [], total: 0 },
      [`/api/goals/${goalId}`]: { goal },
      [`/api/goals/${goalId}/previews`]: { previews: showPreviews ? previews : [] },
      '/api/task/goal-task-1/live-details': { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in goal preview fixture' } });
  });
  // Publish a real rendered application screen as the image fixture rather than invented artwork.
  // The goal queue, not this screen: evidence of previews must not be a picture of the page showing it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: goal.title })).toBeVisible();
  image = await page.screenshot();
  showPreviews = true;
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const width of [390, 1024, 1440]) {
  test(`stacks one full-width goal preview per row at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/goals/${goalId}`);
    const section = page.getByRole('region', { name: 'Visual previews' });
    await expect(section.getByAltText('Goal dashboard at desktop width')).toBeVisible();
    const figures = section.locator('figure');
    await expect(figures).toHaveCount(3);
    const column = await figures.first().evaluate(figure => figure.parentElement!.getBoundingClientRect().width);
    const boxes = await figures.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON() as DOMRect));
    for (const [index, box] of boxes.entries()) {
      expect(Math.abs(box.width - column)).toBeLessThanOrEqual(1);
      if (index) expect(box.top).toBeGreaterThanOrEqual(boxes[index - 1].bottom);
    }
    await expect(section.locator('video[controls]')).toHaveCount(1);
    // The stack stays in the goal reading column, between the context block and the execution queue.
    const placement = await page.evaluate(() => {
      const column = document.querySelector('main[aria-label="Goal monitor"]')!;
      const order = [...column.children].map(child => child.getAttribute('aria-labelledby'));
      const box = (selector: string) => {
        const rect = column.querySelector(selector)!.getBoundingClientRect();
        return { left: Math.round(rect.left), width: Math.round(rect.width) };
      };
      return { order: order.slice(0, 3), previews: box('[aria-labelledby="goal-visual-previews-heading"]'), context: box('[aria-labelledby="goal-context-heading"]') };
    });
    expect(placement.order).toEqual(['goal-context-heading', 'goal-visual-previews-heading', 'live-progress-heading']);
    expect(placement.previews).toEqual(placement.context);
    const imageBox = await section.getByAltText('Goal dashboard at desktop width').boundingBox();
    expect(imageBox!.height).toBeLessThanOrEqual(900 * 0.65 + 1);
    expect(await noHorizontalOverflow(page)).toBe(true);
    if (width === 390 || width === 1440) {
      // Frame the whole screen, so the evidence shows where the stack sits rather than one lone figure.
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(page, `goal-visual-previews-${width}`);
    }
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`opens goal previews in the shared lightbox at ${viewport.width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize(viewport);
    await page.goto(`/goals/${goalId}`);
    const section = page.getByRole('region', { name: 'Visual previews' });
    await section.getByRole('button', { name: 'Open full-size preview: Goal dashboard at desktop width' }).click();

    const dialog = page.getByRole('dialog', { name: 'Goal dashboard at desktop width' });
    await expect(dialog).toBeVisible();
    // Only the two images form the sequence; the video keeps its inline controls.
    await expect(dialog.getByText('1 / 2')).toBeVisible();
    const box = (await dialog.getByAltText('Goal dashboard at desktop width').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.height).toBeLessThanOrEqual(viewport.height + 1);
    if (viewport.width === 1440) await capture(page, 'goal-visual-previews-lightbox');

    await dialog.getByRole('button', { name: 'Next preview' }).click();
    await expect(page.getByRole('dialog', { name: 'Filter panel' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });
}
