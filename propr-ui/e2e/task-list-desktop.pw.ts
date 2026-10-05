import { expect, test } from '@playwright/test';
import { capture, fixture, historicalRun, tasks } from './task-list-desktop.fixture';

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
      await expect(rows).toHaveCount(10);
      await expect(table).not.toContainText('by GPT-6 Astra]');
      await expect(table).not.toContainText('Ultrafix PR #2664');
      await expect(table.getByRole('link', { name: 'Update', exact: true })).toHaveCount(0);
      await expect(table.locator('img, canvas, video')).toHaveCount(0);
      // SCORE is the last column: the newest review's score, never a fix's, and a dash for a task no review scored.
      const lastCell = (text: string) => rows.filter({ hasText: text }).locator('[role="row"] > [role="cell"]:last-child');
      await expect(lastCell('Stop work when an issue or PR withdraws intent').getByTitle('Review score: 6/10')).toHaveText('[6]');
      await expect(lastCell('a-very-long-unbroken').getByLabel('No score')).toHaveText('—');
      await expect(table.getByTestId('preview-count').first()).toHaveText('2 previews');
      // The footer counts tasks, the unit the rows are: the 10 on this page, never their 32 runs.
      await expect(page.getByTestId('pagination-summary')).toHaveText('Showing 1–10 of 1,842 tasks');
      // The repository filter groups its digits like the footer.
      await expect(page.getByRole('button', { name: /All Repos/ })).toContainText('14,769');
      await expect(page.getByRole('button', { name: /All Repos/ })).not.toContainText('14769');

      // A single run with no summary is one line: the type leads the title and nothing hangs under it.
      const singleRun = rows.filter({ hasText: 'a-very-long-unbroken' });
      const titleLine = singleRun.getByRole('link', { name: /^Support configuration/ }).locator('xpath=..');
      await expect(titleLine.getByTestId('work-type-badge')).toHaveText('Implement');
      expect(await titleLine.evaluate(line => line.nextElementSibling)).toBeNull();
      // The repository shows without its owner and fits whole; the tooltip keeps the full slug.
      const repoChip = singleRun.getByTestId('repository-chip');
      await expect(repoChip).toHaveText('desktop-workspaces');
      await expect(repoChip).toHaveAttribute('title', 'integry/desktop-workspaces');
      expect(await repoChip.locator('.truncate').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);

      const layout = await table.evaluate(element => ({
        fits: element.getBoundingClientRect().right <= window.innerWidth,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        heights: [...element.querySelectorAll('[data-testid="task-row"] > [role="row"]')].map(row => row.getBoundingClientRect().height),
      }));
      expect(layout.fits).toBe(true);
      expect(layout.pageFits).toBe(true);
      for (const height of layout.heights) expect(height).toBeLessThanOrEqual(84);
      expect(await table.getByRole('link', { name: /^Stop work when/ }).evaluate(node => node.parentElement!.clientWidth)).toBeGreaterThan(200);
      // A long unbroken path in a title wraps inside its own cell: the metadata cells of that row
      // keep exactly their column widths, and REPO (10rem) and AGENT (190px) never shrink.
      const columnWidths = await table.evaluate(element => {
        const widths = (cells: Element[]) => cells.slice(1, 4).map(cell => Math.round(cell.getBoundingClientRect().width));
        const longRow = [...element.querySelectorAll('[data-testid="task-row"]')].find(row => row.textContent!.includes('a-very-long-unbroken'))!;
        return {
          header: widths([...element.querySelectorAll('[role="columnheader"]')]),
          longRow: widths([...longRow.querySelector('[role="row"]')!.children]),
        };
      });
      expect(columnWidths.longRow).toEqual(columnWidths.header);
      // Every row's metadata sits on the title's first line (25px tall), however many lines the
      // title or its rollup takes, instead of floating in the middle of a taller row.
      const offsets = await table.evaluate(element => [...element.querySelectorAll('[data-testid="task-row"] > [role="row"]')].flatMap(row => {
        const [title, ...metadata] = [...row.children];
        const firstLine = title.firstElementChild!.getBoundingClientRect().top + 12.5;
        return metadata.map(cell => (box => Math.abs((box.top + box.bottom) / 2 - firstLine))((cell.firstElementChild ?? cell).getBoundingClientRect()));
      }));
      for (const offset of offsets) expect(offset).toBeLessThanOrEqual(1);
      expect(columnWidths.header).toEqual(width === 1920 ? [160, 128, 190] : [160, 112, 190]);
      // The lead chips sit a full table inset (2rem) in from the list's left edge.
      const inset = await table.evaluate(element => {
        const chip = element.querySelector('[data-testid="task-row"] [title^="Pull request"]')!.getBoundingClientRect();
        return Math.round(chip.left - element.getBoundingClientRect().left);
      });
      expect(inset).toBe(32);
      // Titles wrap rather than being cut mid-word. The title column absorbs all the width the fixed
      // metadata columns leave, so a laptop-width list clamps a long title at two lines (the full
      // title stays in the tooltip); on a wide screen it fits on one line.
      const longTitle = table.getByRole('link', { name: 'Give implementation runs and direct goals a read-only GitHub token' });
      const clamp = await longTitle.locator('span').evaluate(node => ({ clipped: node.scrollHeight > node.clientHeight + 1, lines: Math.round(node.clientHeight / 20) }));
      expect(clamp.lines).toBe(width === 1920 ? 1 : 2);
      if (width === 1920) expect(clamp.clipped).toBe(false);
      await expect(longTitle).toHaveAttribute('title', 'Give implementation runs and direct goals a read-only GitHub token');
      // The footer is pinned to the bottom of the list pane, like the other sections' footers.
      const footerGap = await page.evaluate(() => {
        const footer = document.querySelector('[data-testid="task-list-footer"]')!.getBoundingClientRect();
        const pane = document.querySelector('[data-testid="task-split-list"]')!.getBoundingClientRect();
        return Math.round(pane.bottom - footer.bottom);
      });
      expect(footerGap).toBe(0);
      if (platform !== 'linux') await capture(page, `tasks-ledger-${platform ?? 'web'}-${width}`);

      // A row is the task: its runs show as a trend of at most four outcomes, never listed under
      // it, because the task pane's timeline moves between them.
      const runCount = rows.filter({ hasText: 'Give implementation runs' }).getByTestId('run-count');
      await expect(runCount).toHaveAttribute('aria-label', '7 runs');
      await expect(runCount.getByTestId('run-track-overflow')).toHaveText('+3');
      await expect(runCount.locator('[data-outcome]')).toHaveCount(4);
      await expect(table).not.toContainText(/earlier run/);
      await expect(table.getByRole('list', { name: 'Earlier runs' })).toHaveCount(0);
      expect(await runCount.evaluate(node => node.tagName)).toBe('SPAN');

      // The title is a link to the task page; on a split-capable screen activating it opens the
      // task beside the list instead of leaving it.
      const title = table.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' });
      await expect(title).toHaveAttribute('href', '/tasks/pr-2664-run-0');
      await title.focus();
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/tasks\?task=pr-2664-run-0$/);
      await expect(page.getByTestId('task-split-details')).toBeVisible();
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
    // A click leaves the list here, so the run chip is what opens a task's earlier runs.
    const rollup = page.getByRole('button', { name: '7 runs' });
    await rollup.click();
    await expect(rollup).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('list', { name: 'Earlier runs' }).getByRole('listitem')).toHaveCount(6);
    expect(new URL(page.url()).pathname).toBe('/tasks');
    if (platform !== 'linux') await capture(page, `tasks-ledger-${platform ?? 'web'}-880`);
  });
}

test('1920px opens a task beside the list and steps through rows from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixture(page);
  await page.goto('/tasks?repository=integry%2Fpropr');
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table).toBeVisible();
  // Nothing selected: the ledger keeps the full width.
  await expect(page.getByTestId('task-split-details')).toHaveCount(0);

  await table.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' }).click();
  await expect(page).toHaveURL(/\/tasks\?repository=integry%2Fpropr&task=pr-2664-run-0$/);
  const list = page.getByTestId('task-split-list');
  const details = page.getByTestId('task-split-details');
  await expect(details.getByTestId('task-details')).toBeVisible();
  await expect(details.getByRole('region', { name: 'Task timeline' })).toContainText('Restrict withdrawal labels to intent');
  await expect(details.getByRole('region', { name: 'Task implementation log' })).toBeVisible();
  await expect(details.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', '/tasks/pr-2664-run-0');
  // The list pane is narrower than the ledger, so it shows cards, and the selected one is marked.
  await expect(table).not.toBeVisible();
  const selectedCard = list.locator('[data-testid="task-card"][aria-current="true"]');
  await expect(selectedCard).toContainText('Stop work when an issue or PR withdraws intent');
  // The selection is the row's fill and rail; its title stays dark and bold, never a teal underlined link.
  const selectedTitle = selectedCard.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' });
  await selectedTitle.hover();
  await expect(selectedTitle).toHaveCSS('color', 'rgb(15, 23, 42)');
  await expect(selectedTitle).toHaveCSS('text-decoration-line', 'none');
  await expect(selectedTitle).toHaveCSS('font-weight', '600');
  // Cards scrolled up under the toolbar fade out at the top edge instead of being sliced against its border.
  const topFade = await list.getByTestId('task-list-scroll').evaluate(scroller => {
    scroller.scrollTop = 150;
    const fade = scroller.querySelector('[data-testid="task-cards-top-fade"]')!;
    const result = { scrolled: scroller.scrollTop, offset: Math.round(fade.getBoundingClientRect().top - scroller.getBoundingClientRect().top), height: fade.getBoundingClientRect().height };
    scroller.scrollTop = 0;
    return result;
  });
  expect(topFade.scrolled).toBeGreaterThan(0);
  expect(topFade).toMatchObject({ offset: 0, height: 8 });
  // The details heading is sanitized the same way as the row: no workflow verb, PR number or model tag.
  await expect(details.locator('h2:visible')).toHaveText('Stop work when an issue or PR withdraws intent');
  // Consumption stays on the context line after the runtime, set off by a bullet rather than a bordered pipe.
  const consumption = details.getByRole('group', { name: 'Consumption' });
  await expect(consumption).toHaveText(/3\.9M in · 30k out.*0\.4% weekly quota/);
  await expect(consumption).toHaveCSS('border-left-width', '0px');
  // The run line names the live run whose telemetry it shows.
  await expect(details.getByTestId('task-header-tiers').getByRole('group', { name: 'Run', exact: true })).toHaveText('Run 8/8 (Active) · Ultrafix cycle 3 (linting)');
  // Cards select in place, so none carries a drill-in chevron; purple is Merged's alone.
  await expect(list.locator('[data-testid="task-card"] svg.lucide-chevron-right')).toHaveCount(0);
  await expect(list.getByText('Pending', { exact: true }).first()).toHaveClass(/bg-slate-100/);
  // The toolbar gives its width to search: no separate filter icon, and the repository without its owner.
  await expect(list.locator('svg.lucide-filter, svg.lucide-funnel')).toHaveCount(0);
  const repoTrigger = list.getByRole('button', { name: /propr/ });
  await expect(repoTrigger).toContainText('propr');
  await expect(repoTrigger).not.toContainText('integry/');
  expect(await list.getByPlaceholder('Search tasks...').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(200);
  // Changed files read as a file tree: a quiet folder label over borderless file rows.
  const changedFiles = details.getByRole('region', { name: 'Changed files' });
  await expect(changedFiles).toHaveCSS('border-top-width', '0px');
  await expect(changedFiles.getByText('src/jobs/', { exact: true })).toHaveCSS('color', 'rgb(148, 163, 184)');
  await expect(changedFiles.getByRole('button', { name: 'View diff for src/jobs/withdrawalLabels.ts' })).toHaveCSS('border-top-width', '0px');
  const panes = await page.evaluate(() => ({
    list: document.querySelector('[data-testid="task-split-list"]')!.getBoundingClientRect().width,
    details: document.querySelector('[data-testid="task-split-details"]')!.getBoundingClientRect().width,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(panes.pageScrolls).toBe(false);
  expect(panes.list / (panes.list + panes.details)).toBeGreaterThan(0.4);
  expect(panes.list / (panes.list + panes.details)).toBeLessThan(0.5);
  // A pane is too narrow for the timeline/output split, so they stack in one column.
  const columns = await details.getByTestId('task-workspace-scroll').evaluate(node => getComputedStyle(node).flexDirection);
  expect(columns).toBe('column');
  // The timeline is the task's history: every run on one rail, oldest first, and only the run
  // shown is open, its steps branching off the rail.
  const timeline = details.getByRole('list', { name: 'Runs' });
  const runRows = timeline.getByTestId('run-timeline-run');
  await expect(runRows).toHaveCount(8);
  await expect(runRows.nth(0).getByRole('button')).toContainText(/Run 1.*Initial review/);
  // Only reviews are scored, though runs 6 and 7 carry the loop's score in the data; a fix shows its commit.
  expect(await timeline.getByTitle(/^(Review score|Commit)\b/).evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(['Review score: 4/10', 'Commit a81d3f56e0c2', 'Review score: 6/10', 'Commit 4be17c09d2f3']);
  await expect(runRows.nth(7).getByRole('button')).toContainText(/Run 8.*Ultrafix cycle 3 \(linting\).*Running….*Active/);
  await expect(timeline.getByRole('button', { expanded: true })).toHaveCount(1);
  await expect(runRows.nth(7).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(runRows.nth(7).getByRole('list', { name: 'Run steps' }).getByRole('listitem').first()).toContainText('Task Queued');
  // The card shows the newest four runs and counts the rest: [+4] ●─●─●─⟳, on a pill so it reads as a track, the count a badge of its own.
  const track = selectedCard.getByTestId('run-count');
  await expect(track).toHaveAttribute('aria-label', '8 runs');
  await expect(track.getByTestId('run-track-overflow')).toHaveText('+4');
  expect(await track.locator('[data-outcome]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-outcome')))).toEqual(['passed', 'passed', 'passed', 'active']);
  // Every run line leads with its type after the chip, including a follow-up whose summary names no action.
  const runLines = list.locator('[data-testid="task-card"]').filter({ has: page.getByTestId('run-count') });
  for (const card of await runLines.all()) await expect(card.getByTestId('work-type-badge')).toBeVisible();
  await expect(list.locator('[data-testid="task-card"]').filter({ hasText: 'Retry webhook deliveries' }).getByTestId('work-type-badge')).toHaveText('Fix');
  await capture(page, 'tasks-split-1920');
  // The list scrolls inside its pane: at the end the last card sits whole above the footer, with room to spare.
  const scroller = list.getByTestId('task-list-scroll');
  expect(await scroller.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const runOut = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid="task-split-list"] [data-testid="task-card"]')];
    const last = cards[cards.length - 1].getBoundingClientRect();
    const footer = document.querySelector('[data-testid="task-list-footer"]')!.getBoundingClientRect();
    return Math.round(footer.top - last.bottom);
  });
  expect(runOut).toBeGreaterThanOrEqual(32);
  await capture(page, 'tasks-split-1920-end');
  await scroller.evaluate(node => { node.scrollTop = 0; });
  // Choosing an earlier run opens it: its steps, files changed and execution log replace the newest run's.
  await runRows.nth(2).getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`task=${historicalRun}`));
  const historical = details.getByRole('list', { name: 'Runs' }).getByTestId('run-timeline-run');
  await expect(historical.nth(2).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(historical.nth(7).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(historical.nth(2).getByRole('list', { name: 'Run steps' })).toContainText('Review the withdrawal handlers');
  // Steps keep to their run's columns: times under `Run 3`, labels under its summary, durations ending on its duration.
  const stepColumns = await historical.nth(2).evaluate(run => {
    const [, , tag, summary, , duration] = Array.from(run.querySelector('button')!.children) as HTMLElement[];
    const step = run.querySelector('[aria-label="Run steps"] li')!;
    const [, time, label, stepDuration] = Array.from(step.children) as HTMLElement[];
    const box = (node: HTMLElement) => node.getBoundingClientRect();
    return {
      time: box(time).left - box(tag).left,
      label: box(label).left - box(summary).left,
      duration: box(stepDuration).right - box(duration).right,
    };
  });
  expect(stepColumns).toEqual({ time: 0, label: 0, duration: 0 });
  await expect(details.getByRole('region', { name: 'Changed files' })).toHaveText(/^(?!.*withdrawalLabels).*withdrawalHandlers\.ts/s);
  await expect(details.locator('#execution-event-log-section')).toContainText('src/jobs/withdrawalHandlers.ts:14');
  // The first tier stays on the task, which is working on Run 8; the run line follows Run 3, with Run 3's own spend.
  const header = details.getByTestId('task-header-tiers');
  await expect(header.getByTestId('task-header-identity')).toContainText('integry/propr');
  await expect(header.getByTestId('task-status-badge')).toHaveText('Implementing');
  // Tier 1 reads `integry/propr • #2664 ↗ • ● Implementing`: bullets only, and no empty icon between them.
  await expect(header.getByTestId('task-header-identity').getByRole('group', { name: 'Git context' })).toHaveText('integry/propr•#2664');
  await expect(header.getByTestId('task-status-badge').locator('svg')).toHaveCount(0);
  await expect(header.getByRole('group', { name: 'Run', exact: true })).toHaveText('Run 3/8 (Completed 36 mins ago) · Found 2 issues');
  // The run line keeps to one separator, the middle dot.
  expect(await header.locator('h2 + div').innerText()).not.toContain('•');
  await expect(header.getByRole('group', { name: 'Execution runtime' })).toHaveText(/gpt-6-astra.*3m 0?0s/);
  await expect(header.getByRole('group', { name: 'Consumption' })).toHaveText(/420k in · 12k out.*0\.1% weekly quota/);
  await expect(header).not.toContainText('3.9M');
  // No divider floats in front of Stop when nothing stands before it.
  await expect(header.getByTestId('task-header-identity').locator('.w-px')).toHaveCount(0);
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(120);
  // The pane's controls are icons in the header's first row, not a row of their own.
  await expect(header.getByTestId('task-header-identity').getByRole('button', { name: 'Close task details' })).toBeVisible();
  // The inspected run is named in the panels it changed; the way back to the live run sits at the right of the timeline's header, where the run was opened.
  const inspected = details.getByTestId('inspected-run-context').filter({ visible: true });
  await expect(inspected).toHaveText(/Run 3 of 8 · Completed/);
  await expect(inspected.getByRole('button')).toHaveCount(0);
  await expect(details.getByRole('heading', { name: 'FILES CHANGED (Run 3)' })).toBeVisible();
  await expect(details.locator('#execution-event-log-section')).toContainText(/(EXECUTION LOG|TERMINAL OUTPUT) \(Run 3 · /);
  const timelineHeader = details.getByText('TIMELINE', { exact: true }).filter({ visible: true }).locator('..');
  const backToNewest = timelineHeader.getByRole('button', { name: 'Return to live Run 8' });
  await expect(backToNewest).toBeVisible();
  const [headerBox, backBox] = [await timelineHeader.boundingBox(), await backToNewest.boundingBox()];
  expect(Math.round(headerBox!.x + headerBox!.width - (backBox!.x + backBox!.width))).toBeLessThanOrEqual(16);
  // The way out reads as a button, not metadata: a slate-300 border around dark slate-800 text.
  await expect(backToNewest).toHaveCSS('border-top-color', 'rgb(203, 213, 225)');
  await expect(backToNewest).toHaveCSS('color', 'rgb(30, 41, 59)');
  // The newest run is still working, so its Stop stays in the header while an earlier run is read.
  await expect(details.locator('header:visible').getByRole('button', { name: 'Stop' })).toHaveAttribute('title', 'Stop Run 8, which is still running');
  await expect(details.locator('header:visible').getByRole('button', { name: 'Follow Up' })).toHaveCount(0);
  // The trunk paints above the open run's tinted row and its steps, so it runs unbroken past them to Run 4.
  await expect(details.getByTestId('run-timeline-trunk')).toHaveCSS('z-index', '1');
  await capture(page, 'tasks-split-1920-run-3');
  // The run belongs to the same task, so its row stays selected.
  await expect(list.locator('[data-testid="task-card"][aria-current="true"]')).toContainText('Stop work when an issue or PR withdraws intent');
  // Stepping starts from the row the open run belongs to.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('j');
  await expect(page).toHaveURL(/task=pr-2661-run-0/);
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/task=pr-2663-run-0/);
  await page.keyboard.press('k');
  await expect(page).toHaveURL(/task=pr-2661-run-0/);
  await expect(page).toHaveURL(/repository=integry%2Fpropr/);

  // Typing in the search box is typing, not triage.
  const search = page.getByPlaceholder('Search tasks...');
  await search.click();
  await page.keyboard.press('j');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/task=pr-2661-run-0/);
  await search.fill('');
  await search.blur();

  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/task=/);
  await expect(details).toHaveCount(0);
  await expect(table).toBeVisible();
});

test('1920px the footer stays pinned to the bottom with only a few tasks', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixture(page);
  const few = tasks.filter(task => task.id.startsWith('pr-2661') || task.id.startsWith('pr-2663'));
  await page.route('**/api/tasks?*', route => route.fulfill({ json: { tasks: few, total: 2, totalRuns: few.length } }));
  await page.goto('/tasks?repository=integry%2Fpropr');
  const footer = page.getByTestId('task-list-footer');
  await expect(footer.getByTestId('pagination-summary')).toHaveText('Showing 1–2 of 2 tasks');
  const box = (await footer.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(1080);
  await expect(footer.getByRole('button', { name: 'Next' })).toBeDisabled();
  await capture(page, 'tasks-few-1920');
});

test('1920px reload restores the selected task and the filter', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixture(page);
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/tasks') requests.push(request.url()); });
  await page.goto('/tasks?task=pr-2664-run-0&repository=integry%2Fpropr');
  await expect(page.getByTestId('task-split-details').getByTestId('task-details')).toBeVisible();
  await expect(page.getByTestId('task-split-list').locator('[data-testid="task-card"][aria-current="true"]')).toBeVisible();
  expect(requests.some(url => new URL(url).searchParams.get('repository') === 'integry/propr')).toBe(true);
  // The list pages by task, so a task's runs never split across two pages.
  const listRequests = requests.filter(url => new URL(url).searchParams.get('limit') === '25');
  expect(listRequests.length).toBeGreaterThan(0);
  expect(listRequests.every(url => new URL(url).searchParams.get('groupBy') === 'task')).toBe(true);
});

test('1920px modified and middle clicks still open the task page in a new tab', async ({ page, context }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fixture(page);
  await page.goto('/tasks');
  const title = page.getByRole('table', { name: 'Tasks' }).getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' });
  for (const click of [() => title.click({ modifiers: ['ControlOrMeta'] }), () => title.click({ button: 'middle' })]) {
    // A click that lands while the list re-renders after its first read opens nothing, so try again.
    await expect(async () => {
      const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 3_000 }), click()]);
      await expect(tab).toHaveURL(/\/tasks\/pr-2664-run-0$/);
      await tab.close();
    }).toPass({ timeout: 20_000 });
  }
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByTestId('task-split-details')).toHaveCount(0);
});

test('1200px a task\'s run chip opens its earlier runs as a timeline in the ledger', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await fixture(page);
  await page.goto('/tasks');
  const table = page.getByRole('table', { name: 'Tasks' });
  await expect(table).toBeVisible();
  const headers = table.getByRole('columnheader');
  const columns = ['Task / PR', 'Repo', 'Status', 'Agent', 'Duration', 'Updated', 'Score'];
  // Below the split breakpoint a click leaves the list, so the chip opens the runs in place,
  // never navigates, and a mouse click leaves no focus frame behind.
  const rollup = table.getByRole('button', { name: '7 runs' });
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
      railCentre: listBox.left + parseFloat(rail.borderLeftWidth) / 2,
      caretCentre: caret.left + caret.width / 2,
      railTop: listBox.top + parseFloat(rail.top),
      caretTop: caret.top,
      caretBottom: caret.bottom,
    };
  });
  expect(timeline.blockRight).toBeLessThanOrEqual(timeline.statusRight + 1);
  await expect(table.locator('[title^="Code Quality Score"]')).toHaveCount(0);
  // The rail is threaded from the caret: it starts inside the caret's box, on its centre line.
  expect(Math.abs(timeline.railCentre - timeline.caretCentre)).toBeLessThanOrEqual(1);
  expect(timeline.railTop).toBeGreaterThanOrEqual(timeline.caretTop);
  expect(timeline.railTop).toBeLessThanOrEqual(timeline.caretBottom);

  // Keyboard focus is still visible on the chip.
  await rollup.focus();
  await page.keyboard.press('Enter');
  await expect(rollup).toHaveAttribute('aria-expanded', 'false');
  await expect(rollup).toHaveCSS('text-decoration-line', 'underline');
});

test('1024px a plain click still navigates to the task page', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await fixture(page);
  await page.goto('/tasks');
  await page.getByRole('link', { name: 'Stop work when an issue or PR withdraws intent' }).first().click();
  await expect(page).toHaveURL(/\/tasks\/pr-2664-run-0$/);
});

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
  await expect(page.getByTestId('tasks-skeleton')).toBeVisible();
  await expect(page.getByText('Loading tasks…')).toHaveCount(1);
  await expect(page.getByText(/No tasks found/)).toHaveCount(0);

  releaseTasks();
  await expect(page.getByText(/No tasks found/)).toBeVisible();
  await expect(page.getByTestId('tasks-skeleton')).toHaveCount(0);
});
