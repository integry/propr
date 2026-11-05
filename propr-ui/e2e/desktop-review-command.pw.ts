import { expect, test } from '@playwright/test';
import { fixture, tasks, selectedRun, detailsHistory, ago, capture } from './task-list-desktop.fixture';

for (const outcome of ['unavailable', 'accepted', 'rejected'] as const) {
  test(`desktop review ${outcome} receipt`, async ({ page }) => {
    const accepted = outcome === 'accepted';
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture(page, 'linux');
    await page.route('**/api/tasks?**', route => route.fulfill({ json: {
      tasks: tasks.filter(task => task.id.startsWith('pr-2664-')).map(task => task.id === selectedRun
        ? { ...task, title: 'Implement PR #2664: Stop work when an issue or PR withdraws intent', status: 'completed', completedAt: ago(0.1) }
        : task), total: 1,
    } }));
    await page.route(`**/api/task/${selectedRun}/history`, route => route.fulfill({ json: {
      history: [...detailsHistory, { state: 'COMPLETED', timestamp: ago(0.1) }],
      taskInfo: { title: 'Implement PR #2664: Stop work when an issue or PR withdraws intent',
        type: 'pr', number: 2664, repoOwner: 'integry', repoName: 'propr', modelName: 'gpt-6-astra' },
    } }));
    let reviews = 0;
    let followups = 0;
    await page.route('**/api/tasks/*/followup', route => { followups++; return route.fulfill({ json: { success: true } }); });
    await page.route('**/api/tasks/*/review', route => {
      reviews++;
      return route.fulfill(accepted || (outcome === 'rejected' && reviews > 1)
        ? { status: 202, json: { success: true, commandMode: 'review', state: 'queued', commentId: 42, jobId: 'review-42' } }
        : outcome === 'rejected'
        ? { status: 503, json: { success: false, state: 'failed', posted: false, commandMode: 'review',
          error: 'GitHub rejected the review comment. No review was submitted. Try again shortly.' } }
        : { status: 404, json: { error: 'Not found' } });
    });
    await page.goto(`/tasks?task=${selectedRun}`);
    const review = page.getByRole('button', { name: 'Send /review to PR #2664' }).first();
    await expect(review).toBeVisible();
    await review.click();
    if (accepted) {
      await expect(page.getByText('Queued /review for PR #2664.')).toBeVisible();
      await expect(review).toBeDisabled();
    } else {
      await expect(page.getByText(outcome === 'rejected'
        ? /Couldn't send \/review.*HTTP 503.*Please try again/
        : /Couldn't send \/review.*Review is unavailable/)).toBeVisible();
      await expect(review).toBeEnabled();
    }
    expect(reviews).toBe(1);
    expect(followups).toBe(0);
    if (outcome === 'rejected') {
      await expect(page.getByText(/Couldn't send \/review.*HTTP 503/).locator('..')).toHaveCSS('opacity', '1');
    }
    await capture(page, `desktop-review-${outcome === 'rejected' ? 'rejected-retry' : accepted ? 'queued' : 'unavailable'}`);
    if (outcome === 'rejected') {
      await review.click();
      await expect(page.getByText('Queued /review for PR #2664.')).toBeVisible();
      await expect(review).toBeDisabled();
      expect(reviews).toBe(2);
      expect(followups).toBe(0);
    }
  });
}
