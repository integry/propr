import { expect, test, type Page } from '@playwright/test';
import { ago, capture, detailsHistory, fixture, historicalHistory, historicalRun, selectedRun, tag, tasks } from './task-list-desktop.fixture';

// PR #2664's review scores over its ultrafix cycles, and its merge.
const scores = [4, 6, 8].map((score, index) => ({
  cycle_number: index + 1, source: 'ultrafix', score, goal: 8, blocker_count: 0, suggestion_count: 0,
  reviewer_agent: 'codex', reviewer_model: 'gpt-6-astra', implementer_model: 'gpt-6-astra',
  head_sha: `${index + 1}a2b3c4d5e6f`, task_id: historicalRun, created_at: ago(40 - index * 10),
}));

// A merged PR's task is over: its last ultrafix cycle finished before the merge, so no run is still working.
const settledTasks = tasks.map(task => task.id === 'pr-2664-run-0'
  ? { ...task, status: 'completed', completedAt: ago(0.5), subtitle: 'Ultrafix cycle 3: lint clean' }
  : task);

async function taskScreen(page: Page, width: number) {
  await fixture(page);
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: { tasks: settledTasks, total: 1842, totalRuns: 14769 } }));
  await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
    history: [...detailsHistory, { state: 'COMPLETED', timestamp: ago(0.5), metadata: { model: 'gpt-6-astra' } }],
    taskInfo: {
      title: `Ultrafix PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Ultrafix cycle 3: lint clean',
      type: 'pr-comment', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
    },
  } }));
  await page.route('**/api/pull-requests/2664/scores**', route => route.fulfill({ json: {
    repository: 'integry/propr', pr_number: 2664, outcome: 'merged', merged_at: ago(0.2), closed_at: null, scores,
  } }));
  // A review of a PR, as the API names it, so the task reads the PR's scores and outcome.
  await page.route(`**/api/task/${historicalRun}/history`, route => route.fulfill({ json: {
    history: historicalHistory,
    taskInfo: {
      title: `Review PR #2664: ${tag(2659)} Stop work when an issue or PR withdraws intent`, subtitle: 'Found 2 issues',
      type: 'pr-comment', number: 2664, issueNumber: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra',
    },
  } }));
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 });
  // An earlier review run: its readable log has reasoning to lay out.
  await page.goto(`/tasks/${historicalRun}`);
  await expect(page.getByRole('list', { name: 'Runs' }).getByTestId('run-timeline-run')).toHaveCount(8);
}

for (const width of [390, 1280]) {
  const phone = width < 640;
  test(`${width}px task screen: merge status ends the timeline, scores in sequence, ${phone ? 'one-column' : 'two-column'} log without the raw switch`, async ({ page }) => {
    await taskScreen(page, width);

    // 1. Every run, then the review scores as a node on the trunk, then the merge status as the last entry.
    const timeline = page.getByRole('list', { name: 'Runs' });
    const entries = timeline.locator(':scope > li');
    await expect(entries).toHaveCount(10);
    expect(await entries.evaluateAll(items => items.map(item => item.getAttribute('data-testid')))).toEqual([
      ...Array(8).fill('run-timeline-run'), 'review-score-history', 'pr-outcome-entry',
    ]);
    await expect(entries.last()).toContainText('Merged');
    await expect(entries.last()).toContainText('PR #2664');
    // No run is still working beside the merge that ended the task, and the task reads as done.
    await expect(page.getByTestId('task-status-badge')).not.toHaveText(/Implementing|Reviewing|Fixing|Queued/);
    expect(await timeline.getByTestId('run-timeline-meta').allInnerTexts()).not.toContainEqual(expect.stringMatching(/Active|Running…|Queued/i));
    // The scores read as a connected progression in their grades' colours: a failing 4 red, a poor 6 amber, a good 8 slate.
    const sequence = page.getByRole('list', { name: 'Review scores: 4, 6, 8 out of 10' });
    await expect(sequence.getByRole('listitem')).toHaveText(['4', '6', '8']);
    expect(await sequence.getByTitle(/^Review score: /).evaluateAll(badges => badges.map(badge => getComputedStyle(badge).color)))
      .toEqual(['rgb(220, 38, 38)', 'rgb(217, 119, 6)', 'rgb(71, 85, 105)']);
    const scores = page.getByTestId('review-score-history');
    await expect(scores).not.toContainText('Merged');
    // A milestone on the trunk, not a bordered card dropped into it.
    expect(await scores.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
    if (phone) {
      // A phone scrolls the page, so no run hides above a nested scroll; each run's time and duration
      // take their own line, starting under `Run N` rather than pushed to the right.
      await expect(page.getByTestId('run-timeline-scroll')).toHaveCSS('overflow-y', 'visible');
      for (const row of await timeline.getByTestId('run-timeline-run').all()) {
        // Expanded runs also contain step disclosure buttons; measure only the run header.
        const layout = await row.locator(':scope > button').evaluate(button => ({
          label: [...button.querySelectorAll('span')].find(span => /^Run \d+$/.test(span.textContent!))!.getBoundingClientRect().left,
          time: button.querySelector('[data-testid="run-timeline-meta"] time')!.getBoundingClientRect().left,
        }));
        expect(layout.time).toBeCloseTo(layout.label, 0);
      }
    }

    // 2. Both layouts show the readable log without a view selector.
    const logView = page.getByRole('group', { name: 'Log view' });
    await expect(logView).toHaveCount(0);

    // 3. Each readable entry is one column on a phone: its label sits above the text, which keeps the full width.
    const entry = page.getByText('The label check also matches unrelated labels', { exact: false });
    // React can replace the Markdown paragraph during scrolling or before evaluation.
    // Retry the scroll and geometry together, resolving a connected row on each attempt.
    await expect(async () => {
      await entry.scrollIntoViewIfNeeded();
      const layout = await entry.evaluate(element => {
        if (!element.isConnected) return null;
        const content = element.closest('.flex-1');
        const row = content?.parentElement;
        const gutter = row?.firstElementChild;
        if (!content || !row || !gutter) return null;
        return { row: row.getBoundingClientRect().toJSON(), gutter: gutter.getBoundingClientRect().toJSON(), content: content.getBoundingClientRect().toJSON() };
      });
      if (!layout) throw new Error('Readable log entry must be connected to its content row and gutter');
      if (phone) {
        expect(layout.content.top).toBeGreaterThanOrEqual(layout.gutter.bottom - 1);
        expect(layout.content.width).toBeCloseTo(layout.row.width, 0);
      } else {
        expect(layout.gutter.width).toBe(100);
        expect(layout.content.left).toBeGreaterThan(layout.gutter.right);
        expect(layout.content.top).toBe(layout.gutter.top);
      }
    }).toPass({ timeout: 5_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      if (phone) {
        // Tall enough to show the whole timeline, Run 1 to the merge, under the page header.
        await page.setViewportSize({ width, height: 1400 });
        await timeline.evaluate(element => element.closest('[data-testid="task-timeline-scroll"]')?.scrollTo(0, 0));
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(page, `task-timeline-merge-status-${width}`);
        await page.setViewportSize({ width, height: 844 });
        await page.getByRole('region', { name: 'Task implementation log' }).scrollIntoViewIfNeeded();
        await capture(page, `task-readable-log-${width}`);
      } else {
        await capture(page, `task-screen-${width}`);
      }
    }
  });
}
