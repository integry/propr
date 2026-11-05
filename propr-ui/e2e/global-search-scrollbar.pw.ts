import { expect, test } from '@playwright/test';
import { captureTarget, fixture, minutesAgo } from './dashboard-sections.fixture';

// Headless Chromium hides scrollbars unless this default flag is dropped.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

const tasks = Array.from({ length: 16 }, (_, index) => ({
  id: `task-${index}`, title: `MCP follow-up task ${index + 1}`, status: 'completed', prNumber: 2480 + index, score: 9,
  repository: 'example/workspace', issueNumber: 2400 + index, model: 'gpt-6-astra',
  subtitle: 'Wire the MCP surface into the activity stream.', createdAt: minutesAgo((index + 1) * 24 * 60),
}));

const plans = Array.from({ length: 6 }, (_, index) => ({
  draft_id: `plan-${index}`, repository: 'example/workspace', name: `MCP observability plan ${index + 1}`,
  initial_prompt: 'Emit lifecycle events to connected MCP clients.', status: 'merged',
  created_at: minutesAgo((index + 1) * 24 * 60), updated_at: minutesAgo((index + 1) * 24 * 60),
  issue_summary: { total: 6, pending: 1, processing: 1, merged: 4, closed: 0 },
}));

test('palette scrollbars stay hidden at rest and reveal a thumb without stepper arrows on hover', async ({ page }) => {
  await fixture(page, { width: 1440, height: 900 }, [], []);
  await page.route('**/api/planner/drafts?**', route => route.fulfill({ json: { drafts: plans, total: plans.length, page: 1, limit: 5, hasMore: false } }));
  await page.route('**/api/tasks?**', route => route.fulfill({ json: { tasks, total: tasks.length } }));
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: { agents: [], repositories: [] } }));
  await page.goto('/');

  await page.getByRole('combobox', { name: 'Search' }).fill('mcp');
  const palette = page.getByTestId('global-search-palette');
  const list = palette.getByRole('listbox', { name: 'Search results' }).locator('xpath=..');
  await expect(list).toHaveClass(/scrollbar-subtle/);
  await expect(palette.getByTestId('global-search-preview').locator('.scrollbar-subtle')).toHaveCount(1);
  expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // Scroll mid-way so the thumb sits away from the ends, where stepper arrows would render.
  await list.evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  const box = (await list.boundingBox())!;
  // The 6px scrollbar gutter, clear of the highlighted row's background.
  const gutter = { x: box.x + box.width - 6, width: 6 };
  const strip = (y: number, height: number) => page.screenshot({ clip: { ...gutter, y, height }, animations: 'disabled' });
  const whole = () => strip(box.y, box.height);
  const ends = async () => [await strip(box.y, 16), await strip(box.y + box.height - 16, 16)];

  // Baseline: the same gutter with the scrollbar removed entirely.
  await list.evaluate(el => { el.style.overflowY = 'hidden'; });
  const [noScrollbar, noScrollbarEnds] = [await whole(), await ends()];
  await list.evaluate(el => { el.style.overflowY = ''; });

  await page.mouse.move(0, 0);
  expect((await whole()).equals(noScrollbar)).toBe(true);
  await captureTarget(palette, 'global-search-scrollbar-rest');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await whole()).equals(noScrollbar)).toBe(false);
  const hoveredEnds = await ends();
  expect(hoveredEnds.map((shot, index) => shot.equals(noScrollbarEnds[index]))).toEqual([true, true]);
  await captureTarget(palette, 'global-search-scrollbar-hover');
});
