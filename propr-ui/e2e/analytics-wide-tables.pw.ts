/**
 * The Analytics tables at every width: no figure is clipped, model names stay
 * distinguishable on a phone, and a table wider than its pane says it scrolls.
 */

import { expect, test, type Page } from '@playwright/test';
import { fixture } from './dashboard-sections.fixture';

const scored = (prs: number) => ({
  prs_scored: prs, first_score: { mean: 6.1, median: 6, n: prs }, final_score: { mean: 8.4, n: prs },
  cycles_to_goal: { mean: 1.8, n: prs, attempted: prs }, merge_rate: { value: 0.8, merged: Math.round(prs * 0.8), n: prs },
  cost_per_merged_pr: { usd: 1.2, n: prs }, score_delta: { mean: 2.3, n: prs }, runs_to_merge: { mean: 2.4, n: prs },
});

async function stub(page: Page) {
  await page.route('**/api/stats/{tasks,repositories,overview,review-scores}*', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/stats/tasks') {
      return route.fulfill({ json: { dailyCounts: [], statusDistribution: [], avgProcessingTime: [], summary: { total: 4_400, completed: 3_900, failed: 245 } } });
    }
    if (pathname === '/api/stats/repositories') {
      return route.fulfill({ json: { repositories: [
        { repository: 'example/workspace', total: 4_393, completed: 3_810, failed: 239, inProgress: 3, other: 541, successRate: 94.1 },
      ] } });
    }
    if (pathname === '/api/stats/review-scores') {
      const models = ['claude-fable-5', 'claude-fable-5-1', 'antigravity-claude-opus-5-5', 'antigravity-gemini-4-pro']
        .map(model => ({ implementer_model: model, implementer_agent: 'claude', ...scored(12) }));
      return route.fulfill({ json: { period: '30d', repository: 'all', prs_scored: 48, scores_recorded: 90, models, by_effort: [] } });
    }
    return route.fulfill({ json: {
      tasks: { completed: 3_900, planned: 0, pr_iterations_avg: 1.4, merged_prs: 3_000, total_followups: 10 },
      usage: { total_tokens: 9_000_000_000, input_tokens: 8_000_000_000, output_tokens: 1_000_000_000, total_cost_usd: 4_811.2, models: {} },
      model_usage: [
        { model: 'claude-fable-5', runs: 12_034, tasks: 900, tokens: 4_200_000_000, cost_usd: 2_255.86 },
        { model: 'claude-fable-5-1', runs: 9_120, tasks: 700, tokens: 3_100_000_000, cost_usd: 1_904.31 },
        { model: 'antigravity-claude-opus-5-5', runs: 2_011, tasks: 100, tokens: 1_000_000_000, cost_usd: 651.03 },
        { model: '<synthetic>', runs: 41, tasks: 12, tokens: 0, cost_usd: 0 },
      ],
      system: { repos_indexed: 1 },
    } });
  });
}

/** Cells whose content is wider than the cell, or that reach the table's right edge without padding. */
const clippedCells = (page: Page, testId: string) => page.getByTestId(testId).evaluate(table => {
  const right = table.getBoundingClientRect().right;
  return [...table.querySelectorAll('td')].flatMap(cell => {
    if (cell.scrollWidth > cell.clientWidth + 1) return [`${cell.textContent} overflows`];
    const range = document.createRange();
    range.selectNodeContents(cell);
    const text = range.getBoundingClientRect();
    return text.width > 0 && text.right > right - 8 ? [`${cell.textContent} touches the edge`] : [];
  });
});

for (const width of [1440, 1280, 1024, 390, 320]) {
  test(`at ${width}px no model or repository figure is clipped, and model names stay apart`, async ({ page }) => {
    await fixture(page, { width, height: 900 });
    await stub(page);
    await page.goto('/analytics');
    const models = page.getByTestId('model-breakdown-table');
    await expect(models.getByTestId('model-cost').first()).toHaveText('$2,255.86');
    expect(await clippedCells(page, 'model-breakdown-table')).toEqual([]);
    expect(await clippedCells(page, 'repository-performance-table')).toEqual([]);

    const names = await models.getByTestId('model-name').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1,
    })));
    expect(names.map(name => name.text)).toEqual(['Claude Fable 5', 'Claude Fable 5.1', 'Antigravity Claude Opus 5.5', 'Synthetic']);
    expect(names.filter(name => name.clipped)).toEqual([]);
    await expect(page.getByTestId('repository-performance-table')).toContainText('4,393');
  });
}

test('on a phone the efficacy matrix scrolls sideways with its model column pinned and an edge fade', async ({ page }) => {
  await fixture(page, { width: 390, height: 900 });
  await stub(page);
  await page.goto('/analytics');
  const scroller = page.getByTestId('review-quality-scroller');
  await expect(page.getByTestId('review-quality-row')).toHaveCount(4);
  await expect(scroller).toHaveAttribute('data-overflows-right', 'true');
  await expect(page.getByTestId('review-quality-scroller-fade')).toHaveCSS('opacity', '1');

  const firstCell = page.getByTestId('review-quality-row').first().locator('td').first();
  const before = await firstCell.boundingBox();
  await scroller.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await expect(scroller).toHaveAttribute('data-scrolled', 'true');
  await expect(scroller).toHaveAttribute('data-overflows-right', 'false');
  // The model column stays where it was while the figures slide under it.
  expect((await firstCell.boundingBox())?.x).toBeCloseTo(before!.x, 0);
  // The last column, off-screen before, is now inside the pane.
  const lastCellRight = await page.getByTestId('review-quality-row').first().locator('td').last()
    .evaluate(cell => cell.getBoundingClientRect().right - cell.closest('[data-testid="review-quality-scroller"]')!.getBoundingClientRect().right);
  expect(lastCellRight).toBeLessThanOrEqual(1);
  // Names wrap rather than truncate, so the two Fable models read apart.
  const labels = await page.getByTestId('review-quality-row').evaluateAll(rows => rows.map(row => row.querySelector('td')!.textContent));
  expect(new Set(labels).size).toBe(4);
  // A long name wraps inside the pinned cell instead of spilling over the figures sliding under it.
  const spilled = await page.getByTestId('review-quality-row').evaluateAll(rows => rows
    .map(row => row.querySelector('td')!)
    .filter(cell => cell.scrollWidth > cell.clientWidth + 1)
    .map(cell => cell.textContent));
  expect(spilled).toEqual([]);
});
