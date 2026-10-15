import { expect, test, type Locator, type Page } from '@playwright/test';
import { ago, capture, fixture } from './task-list-desktop.fixture';

const taskId = 'issue-3127-run-0';
const failure = 'Comment posted, but the command failed before submission.';
const longText = `Please address the following based on the previous task execution:\n\n${
  Array.from({ length: 60 }, (_, line) => `- detail ${line + 1}: keep the receipt visible`).join('\n')}`;

async function stubTask(page: Page, posts: string[]) {
  await fixture(page);
  await page.route(`**/api/task/${taskId}/history`, route => route.fulfill({ json: {
    history: [
      { state: 'PENDING', timestamp: ago(60) },
      { state: 'CLAUDE_EXECUTION', timestamp: ago(59) },
      { state: 'COMPLETED', timestamp: ago(51) },
    ],
    taskInfo: { title: 'Follow Up failure feedback', type: 'issue', number: 3127, issueNumber: 3127, repoOwner: 'integry', repoName: 'propr' },
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
