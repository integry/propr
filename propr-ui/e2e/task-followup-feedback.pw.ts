import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';

const taskId = 'issue-3127-run-0';
const failure = 'Comment posted, but the command failed before submission.';
const longText = `Please address the following based on the previous task execution:\n\n${
  Array.from({ length: 60 }, (_, line) => `- detail ${line + 1}: keep the receipt visible`).join('\n')}`;

// The thread the API resolves for this task ID: the issue, as this run opened no pull request.
const issueTarget = { taskId, repository: 'integry/propr', kind: 'issue', number: 3127 };

async function stubTask(page: Page, posts: string[], completed: Record<string, unknown> = {}, followupTarget: unknown = issueTarget) {
  await fixture(page);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51), ...completed },
    ],
    taskInfo: { title: 'Follow Up failure feedback', type: 'issue', number: 3127, issueNumber: 3127, repoOwner: 'integry', repoName: 'propr', followupTarget },
  } }));
  await page.route(`**/api/task/${taskId}/live-details`, route => route.fulfill({ json: { events: [], todos: [], currentTask: null } }));
  // The real route answers 202 with a receipt when the comment posted but its dispatch failed.
  await page.route(`**/api/tasks/${taskId}/followup`, route => {
    posts.push(route.request().postDataJSON().body);
    return route.fulfill({ status: 202, json: {
      success: false, state: 'failed', posted: true, commentId: 4242001, sourceTaskId: taskId, message: failure,
    } });
  });
}

async function openFollowup(page: Page): Promise<Locator> {
  await page.goto(`/tasks/${taskId}`);
  const direct = page.locator('button[title^="Follow Up"]').filter({ visible: true });
  await expect(direct.or(page.getByRole('button', { name: /more actions/i }).filter({ visible: true })).first()).toBeVisible();
  if (await direct.count()) await direct.first().click();
  else {
    await page.getByRole('button', { name: /more actions/i }).filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: /Follow Up/ }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Follow Up on Task' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** True when the element's box lies inside the viewport and is not clipped by a scrolling part of its dialog. */
async function fullyOnScreen(locator: Locator): Promise<boolean> {
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > window.innerHeight + 0.5 || box.right > window.innerWidth + 0.5) return false;
    const dialog = element.closest('[role="dialog"]');
    for (let parent = element.parentElement; parent && dialog?.contains(parent); parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!/(auto|scroll|hidden)/.test(style.overflowY)) continue;
      const clip = parent.getBoundingClientRect();
      if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5) return false;
    }
    return true;
  });
}

const viewports = [
  { name: 'native-900x650', width: 900, height: 650 },
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'phone-320x640', width: 320, height: 640 },
  // 900x650 at 200% browser zoom lays out in half the CSS pixels.
  { name: 'zoom-200-900x650', width: 450, height: 325 },
];

for (const viewport of viewports) {
  test(`${viewport.name}: a failed follow-up shows its receipt in view and refuses a blind repost`, async ({ page }) => {
    const posts: string[] = [];
    await page.setViewportSize(viewport);
    await stubTask(page, posts);
    const dialog = await openFollowup(page);

    const textarea = dialog.getByRole('textbox', { name: 'Comment' });
    await textarea.fill(longText);
    const post = dialog.getByRole('button', { name: 'Post Comment' });
    await post.click();

    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText('Comment posted, but the command was not submitted');
    await expect(alert).toContainText(failure);
    await expect(alert).toContainText('4242001');
    await expect(alert).toBeFocused();
    // At the initial scroll position: the receipt and the actions are on screen without scrolling.
    if (viewport.height >= 640) {
      expect(await fullyOnScreen(alert.getByText('Comment posted, but the command was not submitted'))).toBe(true);
      expect(await fullyOnScreen(post)).toBe(true);
      expect(await fullyOnScreen(dialog.getByRole('button', { name: 'Close', exact: true }))).toBe(true);
    } else {
      // A very short viewport scrolls the whole dialog; focus brought the receipt into view.
      expect(await fullyOnScreen(alert.getByText('Comment posted, but the command was not submitted'))).toBe(true);
      await post.scrollIntoViewIfNeeded();
      expect(await fullyOnScreen(post)).toBe(true);
    }
    await expect(textarea).toHaveValue(longText);
    await capture(page, `task-followup-feedback-${viewport.name}`);

    // The comment is already on GitHub: the same text cannot be posted again.
    await expect(post).toBeDisabled();
    await expect(post).toHaveAccessibleDescription(/duplicate comment/);
    await post.click({ force: true });
    expect(posts).toHaveLength(1);

    // The comment field still scrolls by keyboard and touch-sized content.
    await textarea.focus();
    await page.keyboard.press('Control+End');
    await expect.poll(() => textarea.evaluate(el => el.scrollTop)).toBeGreaterThan(0);

    // An intentional edit is a new comment and may be posted.
    await textarea.press('End');
    await textarea.pressSequentially(' (edited)');
    await expect(post).toBeEnabled();
    await post.click();
    await expect(alert).toBeFocused();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(`${longText} (edited)`);
  });
}

// The issue run that created PR #3128 is followed up on that PR, as the API routes it.
const prTarget = { taskId, repository: 'integry/propr', kind: 'pull_request', number: 3128 };
const createdPr = { metadata: { pr: { number: 3128, url: 'https://github.com/integry/propr/pull/3128' } } };

for (const viewport of viewports.filter(({ name }) => name.startsWith('phone'))) {
  test(`${viewport.name}: the dialog names the thread the API posts the follow-up to`, async ({ page }) => {
    const posts: string[] = [];
    await page.setViewportSize(viewport);
    await stubTask(page, posts, createdPr, prTarget);
    // The PR is open, so the run takes a follow-up.
    await page.route('**/api/pull-requests/3128/scores**', route => route.fulfill({ json: {
      repository: 'integry/propr', pr_number: 3128, outcome: null, merged_at: null, closed_at: null, scores: [] } }));
    const dialog = await openFollowup(page);

    await expect(dialog).toHaveAccessibleDescription('Post a comment to PR integry/propr#3128');
    await expect(dialog).not.toContainText('#3127');
    // Neither the dialog nor the page scrolls sideways, and the full repository stays readable.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(await fullyOnScreen(dialog.getByText('Post a comment to PR integry/propr#3128'))).toBe(true);
    for (const target of [dialog.getByRole('button', { name: 'Close follow-up dialog' }), dialog.getByRole('button', { name: 'Cancel' }), dialog.getByRole('button', { name: 'Post Comment' })]) {
      const box = await target.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await fullyOnScreen(target)).toBe(true);
    }
    await capture(page, `task-followup-destination-${viewport.name}`);

    await dialog.getByRole('textbox', { name: 'Comment' }).fill('Please also cover the empty state.');
    const submitted = page.waitForRequest(`**/api/tasks/${taskId}/followup`);
    await dialog.getByRole('button', { name: 'Post Comment' }).click();
    expect((await submitted).url()).toContain(`/api/tasks/${taskId}/followup`);
    expect(posts).toEqual(['Please also cover the empty state.']);
  });

  test(`${viewport.name}: without a resolved thread the dialog names none and does not post`, async ({ page }) => {
    const posts: string[] = [];
    await page.setViewportSize(viewport);
    await stubTask(page, posts, {}, null);
    const dialog = await openFollowup(page);

    await expect(dialog).toHaveAccessibleDescription(/thread for this follow-up is not available/);
    await expect(dialog).not.toContainText('#3127');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const post = dialog.getByRole('button', { name: 'Post Comment' });
    await dialog.getByRole('textbox', { name: 'Comment' }).fill('Retry');
    await expect(post).toBeDisabled();
    await post.click({ force: true });
    expect(posts).toEqual([]);
    const close = dialog.getByRole('button', { name: 'Close follow-up dialog' });
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await capture(page, `task-followup-destination-unavailable-${viewport.name}`);
  });
}
