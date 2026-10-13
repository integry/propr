import { expect, test, type Page } from '@playwright/test';
import { ago, capture, fixture, tag } from './task-list-desktop.fixture';

// PR #2663's newest run is a finished fix; the run before it is a review.
const newest = 'pr-2663-run-0';
const earlier = 'pr-2663-run-1';
const title = `Fix PR #2663: ${tag(2660)} Repo-owned workflow file with lifecycle hooks (.propr/workflow.yml)`;

async function stubRuns(page: Page, followups: string[]) {
  await fixture(page);
  for (const [taskId, subtitle] of [[newest, 'Include validation reports in PR follow-up completion comments'], [earlier, 'Multi-model review with Opus and Astra']]) {
    await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
      history: [
        { state: 'PENDING', timestamp: ago(60) },
        { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
        { state: 'COMPLETED', timestamp: ago(51) },
      ],
      taskInfo: { title, subtitle, type: 'pr', number: 2663, issueNumber: 2663, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
    } }));
    await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  }
  await page.route('**/api/tasks/*/followup', route => {
    followups.push(`${decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)!)} ${route.request().postDataJSON().body}`);
    return route.fulfill({ json: { success: true, message: 'Posted' } });
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px the newest run offers its follow-up commands and an earlier run offers none`, async ({ page }) => {
    const followups: string[] = [];
    await page.setViewportSize(viewport);
    await stubRuns(page, followups);
    await page.goto(`/tasks/${earlier}`);
    await expect(page.getByTestId('run-timeline-run')).toHaveCount(4);
    await expect(page.getByRole('button', { name: /^Send \// })).toHaveCount(0);

    await page.goto(`/tasks/${newest}`);
    const review = page.getByRole('button', { name: 'Send /review to PR #2663' }).filter({ visible: true });
    await expect(review).toHaveCount(1);
    if (viewport.width >= 1280) await expect(page.getByRole('button', { name: 'Send /ultrafix to PR #2663' }).filter({ visible: true })).toHaveCount(1);
    else {
      const more = page.getByRole('button', { name: 'More commands for PR #2663' }).filter({ visible: true });
      await expect(more).toHaveCount(1);
      // The commands sit near the top of a phone's screen, so the menu opens downward and stays on it.
      await more.click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'Send /ultrafix to PR #2663' })).toBeVisible();
      const [trigger, opened] = [await more.boundingBox(), await menu.boundingBox()];
      expect(opened!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
      expect(opened!.x).toBeGreaterThanOrEqual(0);
      await capture(page, 'task-latest-run-commands-390-menu');
      await page.keyboard.press('Escape');
    }
    await capture(page, `task-latest-run-commands-${viewport.width}`);

    await review.click();
    await expect(page.getByText('Sent /review to PR #2663.')).toBeVisible();
    await expect(review).toBeDisabled();
    await review.click({ force: true });
    expect(followups).toEqual([`${newest} /review`]);
  });
}

test('1440px the /tasks split pane offers the newest run its commands and withdraws them on an earlier run', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubRuns(page, []);
  await page.goto(`/tasks?task=${newest}`);
  const pane = page.getByTestId('task-details');
  await expect(pane).toHaveAttribute('data-embedded', 'true');
  await expect(pane.getByRole('button', { name: 'Send /review to PR #2663' }).filter({ visible: true })).toHaveCount(1);
  await expect(pane.getByRole('button', { name: 'Send /ultrafix to PR #2663' }).filter({ visible: true })).toHaveCount(1);
  await capture(page, 'task-latest-run-commands-split-1440');

  // Opening the earlier run from the pane's own timeline withdraws the commands.
  await pane.getByRole('button', { name: /Multi-model review/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`task=${earlier}`));
  await expect(pane.getByRole('button', { name: /^Send \// })).toHaveCount(0);
});
